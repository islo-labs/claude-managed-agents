import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import { asManagedAgentsClient } from "../anthropic-client.js";
import { ANTHROPIC_BETA, bearerAnthropicClient, resolveAnthropicBaseURL } from "../anthropic.js";
import { runCustomToolDispatcher } from "../dispatcher/custom-dispatch.js";
import { runHeartbeatLoop } from "../dispatcher/heartbeat.js";
import { buildStockTools } from "../dispatcher/stock-tools.js";
import { IsloClient } from "../islo/client.js";
import type { SessionStore } from "../storage/db.js";

export interface DrainResult {
  session_id: string;
  work_id: string;
  created: boolean;
}

export interface DispatchOpts {
  sessionId: string;
  workId: string;
  environmentId: string;
  baseURL: string;
}

const MAX_DRAIN = 25;

export class SessionCoordinator {
  private readonly islo: IsloClient;
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly config: Config,
    private readonly store: SessionStore,
  ) {
    this.islo = new IsloClient(config);
  }

  private envClient(): Anthropic {
    return bearerAnthropicClient(
      Anthropic,
      this.config.ANTHROPIC_ENVIRONMENT_KEY,
      this.config.ANTHROPIC_BASE_URL,
    );
  }

  async drainWork(): Promise<DrainResult[]> {
    const poll = asManagedAgentsClient(this.envClient());
    const spawned: DrainResult[] = [];

    for (let i = 0; i < MAX_DRAIN; i++) {
      const work = await poll.beta.environments.work.poll(this.config.ENVIRONMENT_ID, {
        reclaim_older_than_ms: 2000,
        betas: [ANTHROPIC_BETA],
      });
      if (!work) break;
      if (work.data.type !== "session") continue;

      const sessionId = work.data.id;
      console.log(`[work] work=${work.id} session=${sessionId}`);

      const created = await this.ensureDispatch({
        sessionId,
        workId: work.id,
        environmentId: this.config.ENVIRONMENT_ID,
        baseURL: resolveAnthropicBaseURL(this.config.ANTHROPIC_BASE_URL),
      });

      spawned.push({ session_id: sessionId, work_id: work.id, created });
    }

    return spawned;
  }

  async ensureDispatch(opts: DispatchOpts): Promise<boolean> {
    if (this.running.has(opts.sessionId)) {
      return false;
    }

    const row = this.store.getSession(opts.sessionId);
    const snapshotName = row?.snapshot_name ?? undefined;
    const sandboxName = this.islo.sandboxNameForSession(opts.sessionId);

    let sandboxId: string;
    let resolvedSandboxName: string;

    const existing = await this.islo.getSandboxByName(sandboxName);
    if (!existing) {
      const created = await this.islo.createSandbox({
        sessionId: opts.sessionId,
        snapshotName,
        env: {
          ANTHROPIC_SESSION_ID: opts.sessionId,
          ANTHROPIC_WORK_ID: opts.workId,
          ANTHROPIC_ENVIRONMENT_ID: opts.environmentId,
          ANTHROPIC_BASE_URL: opts.baseURL,
        },
      });
      resolvedSandboxName = created.name;
      sandboxId = created.id;
      console.log(
        `[session] created sandbox=${resolvedSandboxName} id=${sandboxId} session=${opts.sessionId}`,
      );
    } else {
      resolvedSandboxName = existing.name;
      sandboxId = String(existing.id);
      console.log(
        `[session] reusing sandbox=${resolvedSandboxName} session=${opts.sessionId}`,
      );
    }

    this.store.upsertSession(opts.sessionId, "session.status_run_started");
    this.store.bindSandbox(opts.sessionId, resolvedSandboxName, sandboxId, opts.workId);
    this.startRunner(opts, resolvedSandboxName);
    return true;
  }

  private startRunner(opts: DispatchOpts, sandboxName: string): void {
    const existing = this.running.get(opts.sessionId);
    if (existing) existing.abort();

    const ctrl = new AbortController();
    this.running.set(opts.sessionId, ctrl);

    const client = this.envClient();
    const stockTools = buildStockTools(this.islo, sandboxName);

    void (async () => {
      try {
        await Promise.allSettled([
          runCustomToolDispatcher({
            client,
            sessionId: opts.sessionId,
            stockTools,
            signal: ctrl.signal,
          }),
          runHeartbeatLoop({
            client,
            workId: opts.workId,
            environmentId: opts.environmentId,
            signal: ctrl.signal,
            abort: () => ctrl.abort(),
            logPrefix: "[session]",
          }),
        ]);
      } finally {
        if (this.running.get(opts.sessionId) === ctrl) {
          this.running.delete(opts.sessionId);
        }
        try {
          await asManagedAgentsClient(client).beta.environments.work.stop(opts.workId, {
            environment_id: opts.environmentId,
            force: true,
            betas: [ANTHROPIC_BETA],
          });
        } catch (error) {
          console.warn(
            `[session] force-stop failed session=${opts.sessionId} work=${opts.workId}: ${errStr(error)}`,
          );
        }
        console.log(`[session] dispatcher exited session=${opts.sessionId}`);
      }
    })();
  }

  async snapshotSession(sessionId: string): Promise<void> {
    const row = this.store.getSession(sessionId);
    if (!row?.sandbox_id) {
      console.log(`[snapshot] skipped session=${sessionId} - no sandbox bound`);
      return;
    }
    const snapshotName = `cma-${sessionId.slice(0, 32)}`;
    try {
      const snapshot = await this.islo.createSnapshot(row.sandbox_id, snapshotName);
      this.store.setSnapshot(sessionId, snapshot.name);
      console.log(
        `[snapshot] saved session=${sessionId} snapshot=${snapshot.name} status=${snapshot.status}`,
      );
    } catch (error) {
      console.warn(
        `[snapshot] failed session=${sessionId}: ${errStr(error)}`,
      );
    }
  }

  async maybeDeleteSandbox(sessionId: string): Promise<void> {
    const row = this.store.getSession(sessionId);
    if (!row?.sandbox_name) return;
    try {
      await this.islo.deleteSandbox(row.sandbox_name);
      this.store.clearSandbox(sessionId);
      console.log(`[session] deleted sandbox=${row.sandbox_name} session=${sessionId}`);
    } catch (error) {
      console.warn(
        `[session] delete sandbox failed session=${sessionId}: ${errStr(error)}`,
      );
    }
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
