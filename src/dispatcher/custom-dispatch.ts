import type Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsEventParams } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { asManagedAgentsClient } from "../anthropic-client.js";
import { ANTHROPIC_BETA } from "../anthropic.js";
import type { RunnableTool } from "./stock-tools.js";

const TOOL_TIMEOUT_MS = 120_000;
const STREAM_BACKOFF_START_MS = 500;
const STREAM_BACKOFF_CAP_MS = 10_000;
const SEND_RETRIES = 3;

interface ToolUseEvent {
  type: "agent.tool_use" | "agent.custom_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ResultEvent {
  type: "user.tool_result" | "user.custom_tool_result";
  tool_use_id?: string;
  custom_tool_use_id?: string;
}

type SessionEvent = ToolUseEvent | ResultEvent | { type: string };

export interface CustomDispatchOpts {
  client: Anthropic;
  sessionId: string;
  tools?: RunnableTool[];
  stockTools?: RunnableTool[];
  signal: AbortSignal;
}

function classifyEvent(ev: SessionEvent): {
  toolUse?: ToolUseEvent;
  answeredId?: string;
} | null {
  if (ev.type === "agent.tool_use" || ev.type === "agent.custom_tool_use") {
    return { toolUse: ev as ToolUseEvent };
  }
  if (ev.type === "user.tool_result") {
    return { answeredId: (ev as ResultEvent).tool_use_id };
  }
  if (ev.type === "user.custom_tool_result") {
    return { answeredId: (ev as ResultEvent).custom_tool_use_id };
  }
  return null;
}

export async function runCustomToolDispatcher(opts: CustomDispatchOpts): Promise<void> {
  const ctx = {
    client: opts.client,
    sessionId: opts.sessionId,
    signal: opts.signal,
    customToolByName: new Map((opts.tools ?? []).map((t) => [t.name, t])),
    stockToolByName: new Map((opts.stockTools ?? []).map((t) => [t.name, t])),
    seen: new Set<string>(),
    answered: new Set<string>(),
  };

  await reconcile(ctx);

  let backoff = STREAM_BACKOFF_START_MS;
  while (!ctx.signal.aborted) {
    try {
      const managed = asManagedAgentsClient(ctx.client);
      const stream = await managed.beta.sessions.events.stream(
        ctx.sessionId,
        { betas: [ANTHROPIC_BETA] },
        { signal: ctx.signal },
      );
      for await (const ev of stream) {
        if (ctx.signal.aborted) return;
        backoff = STREAM_BACKOFF_START_MS;
        await handleEvent(ctx, ev);
      }
    } catch (error) {
      if (ctx.signal.aborted) return;
      console.warn(
        `[dispatch] stream disconnected session=${ctx.sessionId}, reconnecting in ${backoff}ms: ${errStr(error)}`,
      );
    }
    if (ctx.signal.aborted) return;
    await reconcile(ctx);
    await sleep(backoff, ctx.signal);
    backoff = Math.min(backoff * 2, STREAM_BACKOFF_CAP_MS);
  }
}

type Ctx = {
  client: Anthropic;
  sessionId: string;
  signal: AbortSignal;
  customToolByName: Map<string, RunnableTool>;
  stockToolByName: Map<string, RunnableTool>;
  seen: Set<string>;
  answered: Set<string>;
};

async function reconcile(ctx: Ctx): Promise<void> {
  const pending: ToolUseEvent[] = [];
  try {
    const managed = asManagedAgentsClient(ctx.client);
    for await (const ev of await managed.beta.sessions.events.list(
      ctx.sessionId,
      { limit: 1000, betas: [ANTHROPIC_BETA] },
      { signal: ctx.signal },
    )) {
      const c = classifyEvent(ev);
      if (!c) continue;
      if (c.toolUse && !ctx.seen.has(c.toolUse.id)) {
        ctx.seen.add(c.toolUse.id);
        pending.push(c.toolUse);
      } else if (c.answeredId) {
        ctx.answered.add(c.answeredId);
      }
    }
  } catch (error) {
    if (!ctx.signal.aborted) {
      console.warn(
        `[dispatch] reconcile failed session=${ctx.sessionId}: ${errStr(error)}`,
      );
    }
    return;
  }
  for (const ev of pending) {
    if (ctx.signal.aborted) return;
    if (ctx.answered.has(ev.id)) continue;
    await execute(ctx, ev);
  }
}

async function handleEvent(ctx: Ctx, ev: SessionEvent): Promise<void> {
  const c = classifyEvent(ev);
  if (!c) return;
  if (c.toolUse) {
    if (ctx.seen.has(c.toolUse.id)) return;
    ctx.seen.add(c.toolUse.id);
    await execute(ctx, c.toolUse);
  } else if (c.answeredId) {
    ctx.answered.add(c.answeredId);
  }
}

async function execute(ctx: Ctx, ev: ToolUseEvent): Promise<void> {
  const isStock = ev.type === "agent.tool_use";
  const lookup = isStock ? ctx.stockToolByName : ctx.customToolByName;
  const kind = isStock ? "stock" : "custom";
  const tool = lookup.get(ev.name);
  console.log(
    `[dispatch] kind=${kind} tool=${ev.name} session=${ctx.sessionId} use_id=${ev.id}`,
  );

  let content: string | unknown[];
  let isError: boolean;
  if (!tool) {
    const known = [...lookup.keys()].sort().join(",") || "(none)";
    content = `Error: Tool '${ev.name}' not found. Registered ${kind} tools: ${known}`;
    isError = true;
  } else {
    ({ content, isError } = await runTool(ctx, tool, ev));
  }
  const preview = typeof content === "string"
    ? content.slice(0, 120).replace(/\n/g, "↵")
    : JSON.stringify(content).slice(0, 120);
  console.log(
    `[dispatch] result kind=${kind} tool=${ev.name} session=${ctx.sessionId} use_id=${ev.id} isError=${isError} preview=${JSON.stringify(preview)}`,
  );
  await postResult(ctx, ev, content, isError);
}

async function runTool(
  ctx: Ctx,
  tool: RunnableTool,
  ev: ToolUseEvent,
): Promise<{ content: string | unknown[]; isError: boolean }> {
  const toolCtrl = new AbortController();
  const onParentAbort = () => toolCtrl.abort();
  ctx.signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => toolCtrl.abort(), TOOL_TIMEOUT_MS);
  try {
    const input = tool.parse ? tool.parse(ev.input) : ev.input;
    const content = await tool.run(input, { signal: toolCtrl.signal });
    return { content, isError: false };
  } catch (err) {
    return { content: `Error: ${errStr(err)}`, isError: true };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onParentAbort);
  }
}

async function postResult(
  ctx: Ctx,
  ev: ToolUseEvent,
  content: string | unknown[],
  isError: boolean,
): Promise<void> {
  const blocks = toContentBlocks(content);
  const resultEvent =
    ev.type === "agent.tool_use"
      ? {
          type: "user.tool_result" as const,
          tool_use_id: ev.id,
          is_error: isError,
          content: blocks,
        }
      : {
          type: "user.custom_tool_result" as const,
          custom_tool_use_id: ev.id,
          is_error: isError,
          content: blocks,
        };

  let lastErr: unknown;
  for (let i = 0; i < SEND_RETRIES; i++) {
    if (ctx.signal.aborted) return;
    try {
      const managed = asManagedAgentsClient(ctx.client);
      await managed.beta.sessions.events.send(
        ctx.sessionId,
        { betas: [ANTHROPIC_BETA], events: [resultEvent as BetaManagedAgentsEventParams] },
        { signal: ctx.signal },
      );
      ctx.answered.add(ev.id);
      return;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      if (
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        break;
      }
      await sleep((i + 1) * 1000, ctx.signal);
    }
  }
  console.error(
    `[dispatch] failed to send tool result session=${ctx.sessionId} use_id=${ev.id}: ${errStr(lastErr)}`,
  );
}

function toContentBlocks(content: string | unknown[]): unknown[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content || "(no output)" }];
  }
  const out = content.map((b) => {
    const blk = b as { type?: string; text?: string };
    if (blk.type === "text") return { type: "text", text: blk.text || "(no output)" };
    return { type: "text", text: JSON.stringify(b) };
  });
  return out.length > 0 ? out : [{ type: "text", text: "(no output)" }];
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
