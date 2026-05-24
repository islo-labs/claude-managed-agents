import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { Config } from "../src/config.js";
import { SessionStore } from "../src/storage/db.js";
import type { SessionCoordinator } from "../src/sessions/coordinator.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    ENVIRONMENT_ID: "env",
    ANTHROPIC_ENVIRONMENT_KEY: "env-key",
    WEBHOOK_SECRET: "secret",
    ISLO_API_KEY: "islo-key",
    ISLO_API_BASE_URL: "https://api.islo.dev",
    ISLO_RUNNER_IMAGE: "ghcr.io/islo-labs/islo-runner:latest",
    ISLO_SANDBOX_CPUS: 2,
    ISLO_SANDBOX_MEMORY_MB: 4096,
    ISLO_SANDBOX_DISK_GB: 20,
    PORT: 8787,
    DATABASE_PATH: ":memory:",
    WEBHOOK_MAX_BODY_BYTES: 1048576,
    LOG_LEVEL: "info",
    ...overrides,
  };
}

describe("createApp", () => {
  it("does not expose session state without an admin token", async () => {
    const store = new SessionStore(":memory:");
    const app = createApp(config(), store, {} as SessionCoordinator);

    const response = await app.request("/sessions");

    expect(response.status).toBe(404);
    store.close();
  });

  it("requires the configured bearer token for session state", async () => {
    const store = new SessionStore(":memory:");
    store.upsertSession("sess_123", "session.status_run_started");
    const app = createApp(
      config({ ADMIN_TOKEN: "a-secure-admin-token" }),
      store,
      {} as SessionCoordinator,
    );

    expect((await app.request("/sessions")).status).toBe(401);

    const authorized = await app.request("/sessions", {
      headers: { authorization: "Bearer a-secure-admin-token" },
    });

    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      items: [expect.objectContaining({ session_id: "sess_123" })],
    });
    store.close();
  });
});
