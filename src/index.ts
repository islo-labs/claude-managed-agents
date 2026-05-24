import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SessionCoordinator } from "./sessions/coordinator.js";
import { SessionStore } from "./storage/db.js";

const config = loadConfig();
const store = new SessionStore(config.DATABASE_PATH);
const coordinator = new SessionCoordinator(config, store);
const app = createApp(config, store, coordinator);

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`claude-managed-agents listening on http://localhost:${info.port}`);
});

function shutdown(): void {
  console.log("shutting down...");
  server.close((error?: Error) => {
    store.close();
    if (error) {
      console.error(`shutdown failed: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
