import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSubscriber, call, mockOutbound, resetDb, signupRequest, subscriber } from "./helpers.js";

const OK_MESSAGE = "Almost done - check your inbox to confirm your address.";

describe("POST /api/subscribe", () => {
  let delivered, calls;
  beforeEach(async () => {
    await resetDb();
    ({ delivered, calls } = mockOutbound());
  });
  afterEach(() => vi.restoreAllMocks());

  it("stores a pending signup and sends one confirmation email with unsubscribe headers", async () => {
    const res = await call("/api/subscribe", signupRequest("Person@Example.com"));
    expect(await res.json()).toEqual({ ok: true, message: OK_MESSAGE });

    const row = await subscriber("person@example.com");
    expect(row.status).toBe("pending");
    expect(row.confirm_sends).toBe(1);
    expect(row.confirm_sent_at).not.toBeNull();

    expect(delivered).toHaveLength(1);
    const sent = delivered[0];
    expect(sent.to).toEqual(["person@example.com"]);
    expect(sent.text).toContain(`https://list.test/api/confirm?token=${row.token}`);
    expect(sent.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(sent.headers["List-Unsubscribe"]).toContain(`/api/unsubscribe?token=${row.token}`);
    expect(calls[0].key).toBe(`perchlight-confirm-${row.token}-0-${new Date().toISOString().slice(0, 10)}`);
  });

  it("redirects to a page when the form is posted without JavaScript", async () => {
    const form = new FormData();
    form.set("email", "formuser@example.com");
    const res = await call("/api/subscribe", { method: "POST", body: form });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/list/check-inbox/");
  });

  it("answers a bot that fills in the honeypot like a person, but stores nothing", async () => {
    const res = await call("/api/subscribe", signupRequest("bot@example.com", { website: "http://spam" }));
    expect((await res.json()).ok).toBe(true);
    expect(await subscriber("bot@example.com")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("rejects an oversized request", async () => {
    const res = await call("/api/subscribe", signupRequest(`${"a".repeat(20000)}@example.com`));
    expect(res.status).toBe(413);
  });

  it("rejects an invalid address", async () => {
    const res = await call("/api/subscribe", signupRequest("not-an-email"));
    expect(res.status).toBe(400);
  });

  it("blocks a disposable domain, records it unsubscribed, and sends nothing", async () => {
    const res = await call("/api/subscribe", signupRequest("someone@mailinator.com"));
    expect(res.status).toBe(400);
    const row = await subscriber("someone@mailinator.com");
    expect(row.status).toBe("unsubscribed");
    expect(row.block_reason).toBe("BURNER-EMAIL");
    expect(calls).toHaveLength(0);
  });

  it("a stranger can't unsubscribe a confirmed member by submitting their newly blocked address", async () => {
    await addSubscriber("member@spam.test", "confirmed");
    await env.DB.prepare("INSERT INTO blocked_domains (domain, reason) VALUES ('spam.test', 'SPAM')").run();
    await call("/api/subscribe", signupRequest("member@spam.test"));
    const row = await subscriber("member@spam.test");
    expect(row.status).toBe("confirmed");
    expect(row.block_reason).toBeNull();
  });

  it("lets allowed_domains override the bundled disposable list", async () => {
    await env.DB.prepare("INSERT INTO allowed_domains (domain) VALUES ('mailinator.com')").run();
    const res = await call("/api/subscribe", signupRequest("someone@mailinator.com"));
    expect(res.status).toBe(200);
    expect((await subscriber("someone@mailinator.com")).status).toBe("pending");
  });

  it("blocks subdomains of a hand-blocked domain", async () => {
    await env.DB.prepare("INSERT INTO blocked_domains (domain, reason) VALUES ('spam.test', 'SPAM')").run();
    const res = await call("/api/subscribe", signupRequest("x@mail.spam.test"));
    expect(res.status).toBe(400);
    expect((await subscriber("x@mail.spam.test")).block_reason).toBe("SPAM");
  });

  it("rejects a domain that can't receive email, storing nothing", async () => {
    const res = await call("/api/subscribe", signupRequest("x@no-such-domain.test"));
    expect(res.status).toBe(400);
    expect(await subscriber("x@no-such-domain.test")).toBeNull();
  });

  it("gives an already-confirmed address the same answer and sends nothing", async () => {
    await addSubscriber("member@example.com", "confirmed");
    const res = await call("/api/subscribe", signupRequest("member@example.com"));
    expect(await res.json()).toEqual({ ok: true, message: OK_MESSAGE });
    expect(calls).toHaveLength(0);
  });

  it("never re-emails an address that reported spam", async () => {
    await addSubscriber("angry@example.com", "complained");
    await call("/api/subscribe", signupRequest("angry@example.com"));
    expect((await subscriber("angry@example.com")).status).toBe("complained");
    expect(calls).toHaveLength(0);
  });

  it("doesn't resend to a pending address within the cooldown", async () => {
    await call("/api/subscribe", signupRequest("twice@example.com"));
    await call("/api/subscribe", signupRequest("twice@example.com"));
    expect(delivered).toHaveLength(1);
  });

  it("re-signing up after the cooldown resends the same link, with a fresh idempotency key", async () => {
    await call("/api/subscribe", signupRequest("again@example.com"));
    const first = await subscriber("again@example.com");
    await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = datetime('now', '-1 hour') WHERE email = 'again@example.com'").run();
    await call("/api/subscribe", signupRequest("again@example.com"));
    const second = await subscriber("again@example.com");
    expect(second.token).toBe(first.token); // the link already in the inbox keeps working
    expect(delivered).toHaveLength(2);
    expect(calls[1].key).toBe(`perchlight-confirm-${first.token}-1-${new Date().toISOString().slice(0, 10)}`);
  });

  it("doesn't send a signup's confirmation once the daily limit is reached (the scheduled job sends it later)", async () => {
    await call("/api/subscribe", signupRequest("late@example.com"), { DAILY_SEND_LIMIT: "1" });
    await call("/api/subscribe", signupRequest("later@example.com"), { DAILY_SEND_LIMIT: "1" });
    expect(delivered).toHaveLength(1);
    expect((await subscriber("later@example.com")).confirm_sent_at).toBeNull();
  });

  it("limits signups per network per hour", async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await call("/api/subscribe", signupRequest(`u${i}@example.com`, { ip: "198.51.100.9" }));
    expect(last.status).toBe(429);
  });

  it("stores the signup without sending when no email service is set up", async () => {
    const res = await call("/api/subscribe", signupRequest("early@example.com"), { RESEND_API_KEY: "" });
    expect((await res.json()).message).toContain("We'll email you shortly");
    const row = await subscriber("early@example.com");
    expect(row.status).toBe("pending");
    expect(row.confirm_sent_at).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
