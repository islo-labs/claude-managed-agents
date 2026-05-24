import type Anthropic from "@anthropic-ai/sdk";

export { ANTHROPIC_BETA } from "./anthropic.js";

/** Managed-agents beta surface is provided by @anthropic-ai/sdk >= 0.98. */
export type ManagedAgentsClient = Anthropic;

export function asManagedAgentsClient(client: Anthropic): ManagedAgentsClient {
  return client;
}
