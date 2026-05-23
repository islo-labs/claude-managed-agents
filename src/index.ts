import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { loadConfig } from "./config.js";
import { SessionCoordinator } from "./sessions/coordinator.js";
import { SessionStore } from "./storage/db.js";
import { handleWebhook } from "./webhooks/handler.js";

const config = loadConfig();
const store = new SessionStore(config.DATABASE_PATH);
const coordinator = new SessionCoordinator(config, store);

const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    environment_id: config.ENVIRONMENT_ID,
    runner_image: config.ISLO_RUNNER_IMAGE,
  }),
);

app.get("/sessions", (c) => c.json({ items: store.listSessions() }));

app.post("/webhooks", (c) => handleWebhook(c, config, store, coordinator));

app.get("/", (c) =>
  c.json({
    name: "claude-managed-agents",
    description: "Self-hosted Claude Managed Agents control plane on Islo",
    endpoints: {
      health: "/health",
      webhooks: "/webhooks",
      sessions: "/sessions",
    },
  }),
);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`claude-managed-agents listening on http://localhost:${info.port}`);
});

function shutdown(): void {
  console.log("shutting down...");
  store.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
