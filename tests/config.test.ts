import { describe, expect, it } from "vitest";
import { loadConfig, resetConfigCache } from "../src/config.js";

const requiredEnv = {
  ENVIRONMENT_ID: "env",
  ANTHROPIC_ENVIRONMENT_KEY: "env-key",
  WEBHOOK_SECRET: "whsec_secret",
  ISLO_API_KEY: "islo-key",
  ISLO_API_BASE_URL: "https://api.islo.dev",
};

describe("loadConfig", () => {
  it("treats optional empty strings as unset", () => {
    resetConfigCache();

    const config = loadConfig({
      ...requiredEnv,
      ADMIN_TOKEN: "",
      ISLO_GATEWAY_PROFILE: "",
    });

    expect(config.ADMIN_TOKEN).toBeUndefined();
    expect(config.ISLO_GATEWAY_PROFILE).toBeUndefined();
  });

  it("rejects short admin tokens", () => {
    resetConfigCache();

    expect(() =>
      loadConfig({
        ...requiredEnv,
        ADMIN_TOKEN: "too-short",
      }),
    ).toThrow();
  });
});
