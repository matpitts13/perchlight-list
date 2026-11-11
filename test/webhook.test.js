import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyWebhookSignature, base64ToBytes, bytesToBase64 } from "../src/lib/webhook-signature.js";
import { addSubscriber, call, resetDb, subscriber } from "./helpers.js";

async function sign(body, id = "msg_test", ts = Math.floor(Date.now() / 1000)) {
  const secret = env.RESEND_WEBHOOK_SECRET.slice("whsec_".length);
  const key = await crypto.subtle.importKey("raw", base64ToBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${bytesToBase64(new Uint8Array(mac))}` };
}

async function postEvent(event, headersOverride) {
  const body = JSON.stringify(event);
  const headers = headersOverride ?? (await sign(body));
  return call("/api/webhooks/resend", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

describe("webhook signature", () => {
  it("accepts the example from the Svix documentation", async () => {
    const headers = new Headers({
      "svix-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
      "svix-timestamp": "1614265330",
      "svix-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });
    expect(await verifyWebhookSignature(env.RESEND_WEBHOOK_SECRET, headers, '{"test": 2432232314}', 1614265330)).toBe(true);
  });

  it("rejects a changed body, a wrong signature, and an old timestamp", async () => {
    const good = new Headers(await sign("{}", "msg_1", 1000));
    expect(await verifyWebhookSignature(env.RESEND_WEBHOOK_SECRET, good, "{}", 1000)).toBe(true);
    expect(await verifyWebhookSignature(env.RESEND_WEBHOOK_SECRET, good, '{"x":1}', 1000)).toBe(false);
    expect(await verifyWebhookSignature(env.RESEND_WEBHOOK_SECRET, good, "{}", 1000 + 301)).toBe(false);
    const bad = new Headers({ ...Object.fromEntries(good), "svix-signature": "v1,AAAA" });
    expect(await verifyWebhookSignature(env.RESEND_WEBHOOK_SECRET, bad, "{}", 1000)).toBe(false);
  });
});

describe("POST /api/webhooks/resend", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("marks a hard bounce and never touches other addresses", async () => {
    await addSubscriber("bounce@example.com");
    await addSubscriber("fine@example.com");
    const res = await postEvent({ type: "email.bounced", data: { email_id: "msg_1", to: ["Bounce@Example.com"], bounce: { type: "Permanent" } } });
    expect(res.status).toBe(200);
    expect((await subscriber("bounce@example.com")).status).toBe("bounced");
    expect((await subscriber("fine@example.com")).status).toBe("confirmed");
  });

  it("ignores temporary and undetermined bounces", async () => {
    await addSubscriber("full@example.com");
    await postEvent({ type: "email.bounced", data: { to: ["full@example.com"], bounce: { type: "Transient" } } });
    await postEvent({ type: "email.bounced", data: { to: ["full@example.com"], bounce: { type: "Undetermined" } } });
    expect((await subscriber("full@example.com")).status).toBe("confirmed");
  });

  it("a bounce doesn't lock out someone who had already unsubscribed", async () => {
    await addSubscriber("left@example.com", "unsubscribed");
    await postEvent({ type: "email.bounced", data: { to: ["left@example.com"], bounce: { type: "Permanent" } } });
    expect((await subscriber("left@example.com")).status).toBe("unsubscribed");
  });

  it("a spam complaint outranks a bounce, and not the other way round", async () => {
    await addSubscriber("x@example.com", "bounced");
    await postEvent({ type: "email.complained", data: { to: ["x@example.com"] } });
    expect((await subscriber("x@example.com")).status).toBe("complained");
    await postEvent({ type: "email.bounced", data: { to: ["x@example.com"], bounce: { type: "Permanent" } } });
    expect((await subscriber("x@example.com")).status).toBe("complained");
  });

  it("rejects an unsigned or wrongly signed event", async () => {
    await addSubscriber("x@example.com");
    const res = await postEvent({ type: "email.complained", data: { to: ["x@example.com"] } }, { "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,AAAA" });
    expect(res.status).toBe(401);
    expect((await subscriber("x@example.com")).status).toBe("confirmed");
  });

  it("refuses everything when no webhook secret is set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/api/webhooks/resend", { method: "POST", body: "{}" }, { RESEND_WEBHOOK_SECRET: "" });
    expect(res.status).toBe(503);
  });
});
