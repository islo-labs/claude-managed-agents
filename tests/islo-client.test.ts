import { describe, expect, it } from "vitest";
import { IsloClient } from "../src/islo/client.js";
import { resetConfigCache } from "../src/config.js";

describe("IsloClient", () => {
  it("derives stable sandbox names from session ids", () => {
    resetConfigCache();
    const client = new IsloClient({
      ENVIRONMENT_ID: "env",
      ANTHROPIC_ENVIRONMENT_KEY: "key",
      WEBHOOK_SECRET: "secret",
      ISLO_API_KEY: "islo",
      ISLO_API_BASE_URL: "https://api.islo.dev",
      ISLO_RUNNER_IMAGE: "ghcr.io/islo-labs/islo-runner-cma:latest",
      ISLO_SANDBOX_CPUS: 2,
      ISLO_SANDBOX_MEMORY_MB: 4096,
      ISLO_SANDBOX_DISK_GB: 20,
      PORT: 8787,
      DATABASE_PATH: ":memory:",
      WEBHOOK_MAX_BODY_BYTES: 1048576,
      LOG_LEVEL: "info",
    });
    expect(client.sandboxNameForSession("sess_ABC-123")).toBe("cma-sess-abc-123");
  });
});
