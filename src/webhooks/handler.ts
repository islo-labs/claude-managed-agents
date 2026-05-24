import type { Context } from "hono";
import type { Config } from "../config.js";
import type { SessionCoordinator } from "../sessions/coordinator.js";
import type { SessionStore } from "../storage/db.js";
import {
  parseWebhookEvent,
  verifyStandardWebhook,
  type WebhookEvent,
} from "./verify.js";

export async function handleWebhook(
  c: Context,
  config: Config,
  store: SessionStore,
  coordinator: SessionCoordinator,
): Promise<Response> {
  const webhookId = c.req.header("webhook-id");
  const webhookTimestamp = c.req.header("webhook-timestamp");
  const signature = c.req.header("webhook-signature");

  if (!webhookId || !webhookTimestamp || !signature) {
    return c.json({ error: "missing signature" }, 401);
  }

  const contentLength = c.req.header("content-length");
  if (
    contentLength &&
    Number.parseInt(contentLength, 10) > config.WEBHOOK_MAX_BODY_BYTES
  ) {
    return c.json({ error: "payload too large" }, 413);
  }

  const rawBody = await c.req.arrayBuffer();
  if (rawBody.byteLength > config.WEBHOOK_MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }

  const valid = await verifyStandardWebhook(
    signature,
    webhookId,
    webhookTimestamp,
    rawBody,
    config.WEBHOOK_SECRET,
  );
  if (!valid) {
    return c.json({ error: "invalid signature" }, 401);
  }

  let event: WebhookEvent;
  try {
    event = parseWebhookEvent(rawBody);
  } catch {
    return c.json({ error: "invalid JSON" }, 400);
  }

  const evData = event.data;
  const evType = typeof evData?.type === "string" ? evData.type : "unknown";
  const sessionId = typeof evData?.id === "string" ? evData.id : "";
  const eventId = typeof event.id === "string" ? event.id : webhookId;

  console.log(
    `[webhook] id=${eventId} type=${evType} session=${sessionId || "(none)"}`,
  );

  const isNewEvent = store.recordWebhookEvent(eventId, evType, sessionId || null, event);
  if (!isNewEvent) {
    return c.body(null, 204);
  }
  if (sessionId) {
    store.upsertSession(sessionId, evType);
  }

  switch (evType) {
    case "session.status_run_started": {
      try {
        const spawned = await coordinator.drainWork();
        return c.json({ status: "ok", spawned });
      } catch (error) {
        console.error(`[webhook] drainWork failed: ${errStr(error)}`);
        return c.json({ status: "ok", drainError: true });
      }
    }
    case "session.status_terminated":
    case "session.status_idled": {
      if (sessionId) {
        try {
          await coordinator.snapshotSession(sessionId);
        } catch (error) {
          console.warn(
            `[webhook] snapshot-on-idle failed session=${sessionId}: ${errStr(error)}`,
          );
        }
      }
      return c.body(null, 204);
    }
    default:
      console.log(`[webhook] ignored type=${evType}`);
      return c.body(null, 204);
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
