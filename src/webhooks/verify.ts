const TOLERANCE_SECONDS = 300;

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyStandardWebhook(
  signatureHeader: string,
  webhookId: string,
  webhookTimestamp: string,
  rawBody: ArrayBuffer,
  secret: string,
): Promise<boolean> {
  const ts = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;

  let keyBytes: Uint8Array;
  if (secret.startsWith("whsec_")) {
    keyBytes = base64ToBytes(secret.slice("whsec_".length));
  } else {
    try {
      keyBytes = base64ToBytes(secret);
    } catch {
      keyBytes = new TextEncoder().encode(secret);
    }
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${webhookId}.${webhookTimestamp}.`);
  const body = new Uint8Array(rawBody);
  const signedInput = new Uint8Array(prefix.length + body.length);
  signedInput.set(prefix, 0);
  signedInput.set(body, prefix.length);

  const mac = await crypto.subtle.sign("HMAC", key, signedInput);
  const expected = bytesToBase64(new Uint8Array(mac));

  for (const sig of signatureHeader.split(" ")) {
    const [ver, mac64] = sig.split(",", 2);
    if (ver !== "v1" || !mac64) continue;
    if (constantTimeEq(mac64, expected)) return true;
  }
  return false;
}

export interface WebhookEvent {
  id?: string;
  timestamp?: string;
  data?: {
    type?: string;
    id?: string;
    [key: string]: unknown;
  };
}

export function parseWebhookEvent(rawBody: ArrayBuffer): WebhookEvent {
  return JSON.parse(new TextDecoder().decode(rawBody)) as WebhookEvent;
}
