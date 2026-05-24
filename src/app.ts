import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { Config } from "./config.js";
import type { SessionCoordinator } from "./sessions/coordinator.js";
import type { SessionStore } from "./storage/db.js";
import { handleWebhook } from "./webhooks/handler.js";

export function createApp(
  config: Config,
  store: SessionStore,
  coordinator: SessionCoordinator,
): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
    }),
  );

  app.use("/sessions/*", requireAdmin(config));
  app.use("/sessions", requireAdmin(config));
  app.get("/sessions", (c) => c.json({ items: store.listSessions() }));

  app.post("/webhooks", (c) => handleWebhook(c, config, store, coordinator));

  app.get("/", (c) =>
    c.json({
      name: "claude-managed-agents",
      description: "Self-hosted Claude Managed Agents control plane on Islo",
      endpoints: {
        health: "/health",
        webhooks: "/webhooks",
        sessions: config.ADMIN_TOKEN ? "/sessions" : "disabled",
      },
    }),
  );

  return app;
}

function requireAdmin(config: Config) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!config.ADMIN_TOKEN) {
      return c.json({ error: "admin endpoints disabled" }, 404);
    }
    const auth = c.req.header("authorization");
    if (auth !== `Bearer ${config.ADMIN_TOKEN}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
