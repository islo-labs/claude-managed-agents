import type Anthropic from "@anthropic-ai/sdk";
import { asManagedAgentsClient } from "../anthropic-client.js";
import { ANTHROPIC_BETA } from "../anthropic.js";

export const HEARTBEAT_INTERVAL_MS = 20_000;

export interface HeartbeatLoopOpts {
  client: Anthropic;
  workId: string;
  environmentId: string;
  signal: AbortSignal;
  abort: () => void;
  logPrefix: string;
}

export async function runHeartbeatLoop(opts: HeartbeatLoopOpts): Promise<void> {
  let lastHeartbeat: string | null = null;
  while (!opts.signal.aborted) {
    try {
      const managed = asManagedAgentsClient(opts.client);
      const response = await managed.beta.environments.work.heartbeat(
        opts.workId,
        {
          environment_id: opts.environmentId,
          expected_last_heartbeat: lastHeartbeat ?? "NO_HEARTBEAT",
          betas: [ANTHROPIC_BETA],
        },
        { signal: opts.signal },
      );
      lastHeartbeat = response.last_heartbeat;
      if (response.state === "stopping" || response.state === "stopped") {
        console.log(
          `${opts.logPrefix} heartbeat state=${response.state} work=${opts.workId} - aborting runner`,
        );
        opts.abort();
        return;
      }
      if (response.lease_extended === false) {
        console.warn(
          `${opts.logPrefix} heartbeat lease not extended work=${opts.workId} - aborting runner`,
        );
        opts.abort();
        return;
      }
    } catch (error) {
      if (opts.signal.aborted) return;
      const status = (error as { status?: number })?.status;
      if (status === 412) {
        // Server has a different lastHeartbeat than we expect (e.g. after a restart).
        // Extract the actual last_heartbeat from the error body and resync.
        const body = (error as { error?: unknown })?.error;
        const actualHeartbeat =
          (body as { error?: { details?: { current_state?: { last_heartbeat?: string } } } })
            ?.error?.details?.current_state?.last_heartbeat;
        if (typeof actualHeartbeat === "string") {
          console.log(
            `${opts.logPrefix} heartbeat resync work=${opts.workId} last_heartbeat=${actualHeartbeat}`,
          );
          lastHeartbeat = actualHeartbeat;
          continue;
        }
      }
      if (typeof status === "number" && status >= 400 && status < 500) {
        console.warn(
          `${opts.logPrefix} heartbeat ${status} work=${opts.workId} - aborting runner: ${errStr(error)}`,
        );
        opts.abort();
        return;
      }
      console.warn(
        `${opts.logPrefix} heartbeat transient error work=${opts.workId}: ${errStr(error)}`,
      );
    }
    await sleep(HEARTBEAT_INTERVAL_MS, opts.signal);
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
