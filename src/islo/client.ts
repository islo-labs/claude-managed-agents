import { Islo } from "@islo-labs/sdk";
import type { Config } from "../config.js";

export interface SandboxResponse {
  id: string;
  name: string;
  status: string;
  image: string;
}

export interface ExecResultResponse {
  exec_id: string;
  status: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface SnapshotResponse {
  id: string;
  name: string;
  status: string;
  sandbox_id: string | null;
}

export interface IsloSandboxHandle {
  name: string;
  id: string;
}

export class IsloClient {
  private readonly sdk: Islo;

  constructor(private readonly config: Config) {
    this.sdk = new Islo({
      apiKey: config.ISLO_API_KEY,
      baseUrl: config.ISLO_API_BASE_URL,
    });
  }

  sandboxNameForSession(sessionId: string): string {
    const slug = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 200);
    return `cma-${slug}`;
  }

  async createSandbox(opts: {
    sessionId: string;
    env?: Record<string, string>;
    snapshotName?: string;
  }): Promise<IsloSandboxHandle> {
    const name = this.sandboxNameForSession(opts.sessionId);
    const sandbox = await this.sdk.sandboxes.createSandbox({
      name,
      image: this.config.ISLO_RUNNER_IMAGE,
      vcpus: this.config.ISLO_SANDBOX_CPUS,
      memory_mb: this.config.ISLO_SANDBOX_MEMORY_MB,
      disk_gb: this.config.ISLO_SANDBOX_DISK_GB,
      env: opts.env,
      gateway_profile: this.config.ISLO_GATEWAY_PROFILE ?? null,
      snapshot_name: opts.snapshotName ?? null,
    });
    return { name: sandbox.name, id: sandbox.id };
  }

  async deleteSandbox(name: string): Promise<void> {
    await this.sdk.sandboxes.deleteSandbox({ sandbox_name: name });
  }

  async exec(
    sandboxName: string,
    command: string[],
    opts?: { workdir?: string; timeoutSecs?: number },
  ): Promise<ExecResultResponse> {
    const started = await this.sdk.sandboxes.execInSandbox({
      sandbox_name: sandboxName,
      body: {
        command,
        workdir: opts?.workdir ?? "/workspace",
        timeout_secs: opts?.timeoutSecs,
      },
    });
    return this.pollExec(sandboxName, started.exec_id, opts?.timeoutSecs ?? 120);
  }

  async pollExec(
    sandboxName: string,
    execId: string,
    timeoutSecs = 120,
  ): Promise<ExecResultResponse> {
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      const result = await this.sdk.sandboxes.getExecResult({
        sandbox_name: sandboxName,
        exec_id: execId,
      });
      if (
        result.status === "completed" ||
        result.status === "failed" ||
        result.status === "timeout"
      ) {
        return result as ExecResultResponse;
      }
      await sleep(250);
    }
    throw new Error(`Exec ${execId} timed out after ${timeoutSecs}s`);
  }

  async readFile(sandboxName: string, filePath: string): Promise<string> {
    const result = await this.exec(sandboxName, ["cat", filePath], { timeoutSecs: 30 });
    if (result.exit_code !== 0) {
      throw new Error(`readFile ${filePath} failed (exit ${result.exit_code}): ${result.stderr}`);
    }
    return result.stdout;
  }

  async writeFile(sandboxName: string, filePath: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const dir = filePath.includes("/") ? filePath.replace(/\/[^/]+$/, "") : ".";
    const result = await this.exec(
      sandboxName,
      ["sh", "-c", `mkdir -p ${dir} && printf %s ${b64} | base64 -d > ${filePath}`],
      { timeoutSecs: 30 },
    );
    if (result.exit_code !== 0) {
      throw new Error(`writeFile ${filePath} failed (exit ${result.exit_code}): ${result.stderr}`);
    }
  }

  async mkdir(sandboxName: string, dirPath: string): Promise<void> {
    await this.exec(sandboxName, ["mkdir", "-p", dirPath], { timeoutSecs: 30 });
  }

  async createSnapshot(sandboxId: string, name?: string): Promise<SnapshotResponse> {
    const snap = await this.sdk.snapshots.createSnapshot({
      sandbox_id: sandboxId,
      name,
    });
    return {
      id: snap.id,
      name: snap.name,
      status: snap.status,
      sandbox_id: snap.sandbox_id ?? null,
    };
  }

  async deleteSnapshot(name: string): Promise<void> {
    await this.sdk.snapshots.deleteSnapshot({ name });
  }

  async getSandboxByName(name: string): Promise<SandboxResponse | null> {
    try {
      const sb = await this.sdk.sandboxes.getSandbox({ sandbox_name: name });
      return {
        id: sb.id,
        name: sb.name,
        status: sb.status,
        image: sb.image ?? "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("not found") || msg.includes("Not Found")) {
        return null;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
