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
  constructor(private readonly config: Config) {}

  private base(): string {
    return this.config.ISLO_API_BASE_URL.replace(/\/$/, "");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.ISLO_API_KEY}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Islo API ${method} ${path} failed (${res.status}): ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
    const body: Record<string, unknown> = {
      name,
      image: this.config.ISLO_RUNNER_IMAGE,
      vcpus: this.config.ISLO_SANDBOX_CPUS,
      memory_mb: this.config.ISLO_SANDBOX_MEMORY_MB,
      disk_gb: this.config.ISLO_SANDBOX_DISK_GB,
      env: opts.env,
    };
    if (this.config.ISLO_GATEWAY_PROFILE) {
      body.gateway_profile = this.config.ISLO_GATEWAY_PROFILE;
    }
    if (opts.snapshotName) {
      body.snapshot_name = opts.snapshotName;
    }
    const sandbox = await this.request<SandboxResponse>("POST", "/sandboxes", body);
    return { name: sandbox.name, id: String(sandbox.id) };
  }

  async deleteSandbox(name: string): Promise<void> {
    await this.request("DELETE", `/sandboxes/${encodeURIComponent(name)}`);
  }

  async exec(
    sandboxName: string,
    command: string[],
    opts?: { workdir?: string; timeoutSecs?: number },
  ): Promise<ExecResultResponse> {
    const started = await this.request<{ exec_id: string }>(
      "POST",
      `/sandboxes/${encodeURIComponent(sandboxName)}/exec`,
      {
        command,
        workdir: opts?.workdir ?? "/workspace",
        timeout_secs: opts?.timeoutSecs,
      },
    );
    return this.pollExec(sandboxName, started.exec_id, opts?.timeoutSecs ?? 120);
  }

  async pollExec(
    sandboxName: string,
    execId: string,
    timeoutSecs = 120,
  ): Promise<ExecResultResponse> {
    const deadline = Date.now() + timeoutSecs * 1000;
    while (Date.now() < deadline) {
      const result = await this.request<ExecResultResponse>(
        "GET",
        `/sandboxes/${encodeURIComponent(sandboxName)}/exec/${encodeURIComponent(execId)}`,
      );
      if (result.status === "completed" || result.status === "failed" || result.status === "timeout") {
        return result;
      }
      await sleep(250);
    }
    throw new Error(`Exec ${execId} timed out after ${timeoutSecs}s`);
  }

  async readFile(sandboxName: string, filePath: string): Promise<string> {
    const res = await fetch(
      `${this.base()}/sandboxes/${encodeURIComponent(sandboxName)}/files?${new URLSearchParams({ path: filePath })}`,
      { headers: { Authorization: `Bearer ${this.config.ISLO_API_KEY}` } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`readFile ${filePath} failed (${res.status}): ${text}`);
    }
    return res.text();
  }

  async writeFile(sandboxName: string, filePath: string, content: string): Promise<void> {
    const res = await fetch(
      `${this.base()}/sandboxes/${encodeURIComponent(sandboxName)}/files?${new URLSearchParams({ path: filePath })}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.ISLO_API_KEY}`,
          "Content-Type": "application/octet-stream",
        },
        body: content,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`writeFile ${filePath} failed (${res.status}): ${text}`);
    }
  }

  async mkdir(sandboxName: string, dirPath: string): Promise<void> {
    await this.exec(sandboxName, ["mkdir", "-p", dirPath], { timeoutSecs: 30 });
  }

  async createSnapshot(sandboxId: string, name?: string): Promise<SnapshotResponse> {
    return this.request<SnapshotResponse>("POST", "/snapshots", {
      sandbox_id: sandboxId,
      name,
    });
  }

  async getSandboxByName(name: string): Promise<SandboxResponse | null> {
    try {
      return await this.request<SandboxResponse>(
        "GET",
        `/sandboxes/${encodeURIComponent(name)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) return null;
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
