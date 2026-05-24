import { describe, expect, it } from "vitest";
import { verifyStandardWebhook } from "../src/webhooks/verify.js";

describe("verifyStandardWebhook", () => {
  it("accepts a valid signature among multiple signatures", async () => {
    const body = new TextEncoder().encode('{"data":{"type":"ping"}}').buffer;
    const now = Math.floor(Date.now() / 1000).toString();
    const signature = await signWebhook("msg_123", now, body, "plain-secret");

    const ok = await verifyStandardWebhook(
      `v1,invalid ${signature}`,
      "msg_123",
      now,
      body,
      "plain-secret",
    );

    expect(ok).toBe(true);
  });

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

async function signWebhook(
  webhookId: string,
  webhookTimestamp: string,
  rawBody: ArrayBuffer,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prefix = new TextEncoder().encode(`${webhookId}.${webhookTimestamp}.`);
  const body = new Uint8Array(rawBody);
  const signedInput = new Uint8Array(prefix.length + body.length);
  signedInput.set(prefix, 0);
  signedInput.set(body, prefix.length);
  const mac = await crypto.subtle.sign("HMAC", key, signedInput);
  return `v1,${Buffer.from(mac).toString("base64")}`;
}
