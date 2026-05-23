import { describe, expect, it } from "vitest";
import { verifyStandardWebhook } from "../src/webhooks/verify.js";

describe("verifyStandardWebhook", () => {
  it("rejects missing tolerance window signatures", async () => {
    const body = new TextEncoder().encode('{"data":{"type":"ping"}}').buffer;
    const ok = await verifyStandardWebhook(
      "v1,invalid",
      "msg_123",
      "1",
      body,
      "whsec_test",
    );
    expect(ok).toBe(false);
  });

  it("rejects tampered payload", async () => {
    const body = new TextEncoder().encode('{"data":{"type":"ping"}}').buffer;
    const now = Math.floor(Date.now() / 1000).toString();
    const ok = await verifyStandardWebhook(
      "v1,aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
      "msg_123",
      now,
      body,
      "not-a-real-secret",
    );
    expect(ok).toBe(false);
  });
});
