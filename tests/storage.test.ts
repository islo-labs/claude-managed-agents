import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/storage/db.js";

describe("SessionStore", () => {
  it("reports whether webhook events are new", () => {
    const store = new SessionStore(":memory:");

    expect(store.recordWebhookEvent("evt_1", "event.type", null, {})).toBe(true);
    expect(store.recordWebhookEvent("evt_1", "event.type", null, {})).toBe(false);

    store.close();
  });
});
