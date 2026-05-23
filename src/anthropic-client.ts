import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_BETA } from "./anthropic.js";

/** Anthropic managed-agents beta surface (not yet in published SDK types). */
export type ManagedAgentsClient = Anthropic & {
  beta: {
    environments: {
      work: {
        poll: (
          environmentId: string,
          params: { reclaim_older_than_ms: number; betas: string[] },
        ) => Promise<
          | {
              id: string;
              data: { type: string; id: string };
            }
          | null
          | undefined
        >;
        heartbeat: (
          workId: string,
          params: {
            environment_id: string;
            expected_last_heartbeat: string;
            betas: string[];
          },
          opts?: { signal?: AbortSignal },
        ) => Promise<{
          last_heartbeat: string;
          state?: string;
          lease_extended?: boolean;
        }>;
        stop: (
          workId: string,
          params: { environment_id: string; force: boolean; betas: string[] },
        ) => Promise<unknown>;
      };
    };
    sessions: {
      events: {
        stream: (
          sessionId: string,
          params: { betas: string[] },
          opts?: { signal?: AbortSignal },
        ) => Promise<AsyncIterable<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>>;
        list: (
          sessionId: string,
          params: { limit: number; betas: string[] },
          opts?: { signal?: AbortSignal },
        ) => Promise<AsyncIterable<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }>>;
        send: (
          sessionId: string,
          params: { betas: string[]; events: unknown[] },
          opts?: { signal?: AbortSignal },
        ) => Promise<unknown>;
      };
    };
  };
};

export function asManagedAgentsClient(client: Anthropic): ManagedAgentsClient {
  return client as ManagedAgentsClient;
}

export { ANTHROPIC_BETA };
