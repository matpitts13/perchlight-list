import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/scheduled.js";
import { MAX_ATTEMPTS } from "../src/lib/announce.js";
import {
  addSubscriber,
  ageInProgress,
  announcement,
  deliveryStatuses,
  mockOutbound,
  queueAnnouncement,
  resetDb,
} from "./helpers.js";

const recipients = (emails) => emails.map((e) => e.to[0]).sort();
const bulk = { ...env, SEND_MODE: "bulk" };
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("announcements: standard mode (one email per request)", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("sends once to every confirmed subscriber, with a per-email key, footer and headers", async () => {
    const { delivered, calls } = mockOutbound();
    const tokenA = await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();

    await runScheduled(env);
    expect(recipients(delivered)).toEqual(["a@example.com", "b@example.com"]);
    for (const e of delivered) {
      expect(e.subject).toBe("Big news");
      expect(e.text).toContain("1 Test Street, Testville");
      expect(e.html).toContain("1 Test Street, Testville");
      expect(e.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(e.text).not.toContain("\u0000");
    }
    const a = delivered.find((e) => e.to[0] === "a@example.com");
    expect(a.text).toContain(`/api/unsubscribe?token=${tokenA}`);
    expect(a.html).toContain(`/api/unsubscribe?token=${tokenA}`);
    expect(calls.every((c) => c.path === "/emails" && /^perchlight-a\d+-s\d+$/.test(c.key))).toBe(true);
    expect((await announcement(id)).status).toBe("sent");

    await runScheduled(env);
    expect(delivered).toHaveLength(2);
  });

  it("never sends the announcement to a pending address (it gets its confirmation instead)", async () => {
    const { delivered } = mockOutbound();
    await addSubscriber("member@example.com");
    await addSubscriber("pending@example.com", "pending");
    await queueAnnouncement();
    await runScheduled(env);
    expect(recipients(delivered.filter((e) => e.subject === "Big news"))).toEqual(["member@example.com"]);
    expect(delivered.find((e) => e.to[0] === "pending@example.com").subject).toContain("Confirm");
  });

  it("sends at most EMAILS_PER_RUN per run", async () => {
    const { delivered } = mockOutbound();
    for (let i = 0; i < 5; i++) await addSubscriber(`s${i}@example.com`);
    await queueAnnouncement();
    await runScheduled({ ...env, EMAILS_PER_RUN: "2" });
    expect(delivered).toHaveLength(2);
    await runScheduled({ ...env, EMAILS_PER_RUN: "2" });
    expect(delivered).toHaveLength(4);
  });

  it("stays under the daily limit and continues the next day; 0 means no limit", async () => {
    const { delivered } = mockOutbound();
    for (let i = 0; i < 5; i++) await addSubscriber(`s${i}@example.com`);
    const id = await queueAnnouncement();
    const limited = { ...env, DAILY_SEND_LIMIT: "3" };

    await runScheduled(limited);
    await runScheduled(limited);
    expect(delivered).toHaveLength(3);
    expect((await announcement(id)).status).toBe("sending");

    await runScheduled({ ...env, DAILY_SEND_LIMIT: "0" });
    expect(delivered).toHaveLength(5);
    expect((await announcement(id)).status).toBe("sent");
  });

  it("skips anyone who unsubscribed after the announcement was queued", async () => {
    const { delivered } = mockOutbound();
    await addSubscriber("leave@example.com");
    await addSubscriber("stay@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'leave@example.com'").run();

    await runScheduled(env);
    expect(recipients(delivered)).toEqual(["stay@example.com"]);
    expect(await deliveryStatuses(id)).toEqual(["skipped", "sent"]);
  });

  it("sends nothing while MAIL_POSTAL_ADDRESS is missing", async () => {
    const { calls } = mockOutbound();
    const errors = quiet();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await runScheduled({ ...env, MAIL_POSTAL_ADDRESS: "" });
    expect(calls).toHaveLength(0);
    expect((await announcement(id)).status).toBe("queued");
    expect(errors.mock.calls.some(([m]) => String(m).includes("MAIL_POSTAL_ADDRESS"))).toBe(true);
  });

  it("Resend timeout after delivery: retried with the same key next run, delivered once", async () => {
    const { calls, delivered } = mockOutbound({ timeoutAfterDelivery: true });
    quiet();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();

    await runScheduled(env);
    expect(delivered).toHaveLength(1);
    expect(await deliveryStatuses(id)).toEqual(["pending"]);

    await runScheduled(env);
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(calls[0].key);
    expect(delivered).toHaveLength(1);
    expect(await deliveryStatuses(id)).toEqual(["sent"]);
  });

  it("a retry re-checks the person: someone who unsubscribed meanwhile is skipped", async () => {
    mockOutbound({ timeoutAfterDelivery: true });
    quiet();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await runScheduled(env); // outcome unknown -> pending (Resend standard)
    await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed'").run();
    vi.restoreAllMocks();
    const { calls } = mockOutbound();
    await runScheduled(env);
    expect(calls).toHaveLength(0);
    expect(await deliveryStatuses(id)).toEqual(["skipped"]);
  });

  it("a run that died mid-send: Resend standard retries (same key); claimed-but-unsent rows go back to the queue", async () => {
    const { calls, delivered } = mockOutbound();
    await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run();
    await env.DB.prepare(
      `UPDATE deliveries SET status = CASE WHEN subscriber_id = (SELECT id FROM subscribers WHERE email = 'a@example.com') THEN 'sending' ELSE 'claimed' END,
         claimed_at = datetime('now'), claim_id = 'dead-run', attempts = 1,
         idempotent_send = CASE WHEN subscriber_id = (SELECT id FROM subscribers WHERE email = 'a@example.com') THEN 1 ELSE 0 END,
         send_started_at = CASE WHEN subscriber_id = (SELECT id FROM subscribers WHERE email = 'a@example.com') THEN datetime('now') END`,
    ).run();
    await ageInProgress();

    await runScheduled(env);
    expect(recipients(delivered)).toEqual(["a@example.com", "b@example.com"]);
    expect(calls.every((c) => c.key)).toBe(true);
    expect(await deliveryStatuses(id)).toEqual(["sent", "sent"]);
  });

  it("throttling uses no attempts and stops the run; sending resumes when it clears", async () => {
    mockOutbound({ status: 429, errorName: "rate_limit_exceeded" });
    quiet();
    await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await runScheduled({ ...env, MAX_PARALLEL: "1" });
    expect(await deliveryStatuses(id)).toEqual(["pending", "pending"]);
    const { n } = await env.DB.prepare("SELECT MAX(attempts) AS n FROM deliveries").first();
    expect(n).toBe(0);

    vi.restoreAllMocks();
    const { delivered } = mockOutbound();
    await runScheduled(env);
    expect(delivered).toHaveLength(2);
  });

  it("a setup problem (bad API key) pauses the announcement until it's resumed", async () => {
    mockOutbound({ status: 401, errorName: "invalid_api_key" });
    quiet();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await runScheduled(env);
    const paused = await announcement(id);
    expect(paused.status).toBe("paused");
    expect(paused.last_error).toContain("401");
    expect(await deliveryStatuses(id)).toEqual(["pending"]);

    vi.restoreAllMocks();
    const { delivered } = mockOutbound();
    await runScheduled(env);
    expect(delivered).toHaveLength(0); // still paused

    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run(); // the owner clicks Resume
    await runScheduled(env);
    expect(delivered).toHaveLength(1);
  });

  it("every email refused with the same error (e.g. bad From address) pauses instead of failing the list", async () => {
    mockOutbound({ rejectAddresses: Array.from({ length: 6 }, (_, i) => `s${i}@example.com`) });
    quiet();
    for (let i = 0; i < 6; i++) await addSubscriber(`s${i}@example.com`);
    const id = await queueAnnouncement();
    await runScheduled(env);
    expect((await announcement(id)).status).toBe("paused");
    expect(await deliveryStatuses(id)).toEqual(Array(6).fill("pending"));
  });

  it("…and after the owner resumes, the same refusals are just recorded (it never pauses twice)", async () => {
    const bad = Array.from({ length: 6 }, (_, i) => `s${i}@example.com`);
    mockOutbound({ rejectAddresses: bad });
    quiet();
    for (const b of bad) await addSubscriber(b);
    const id = await queueAnnouncement();
    await runScheduled(env);
    expect((await announcement(id)).status).toBe("paused");
    await env.DB.prepare("UPDATE announcements SET status = 'sending' WHERE id = ?1").bind(id).run();
    await runScheduled(env);
    expect((await announcement(id)).status).toBe("sent");
    expect(await deliveryStatuses(id)).toEqual(Array(6).fill("failed"));
  });

  it("the final check is right before each send: someone who unsubscribes mid-run isn't emailed", async () => {
    const { delivered } = mockOutbound({
      // While the first email goes out, the second person unsubscribes.
      onDeliver: async () => env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed' WHERE email = 'b@example.com'").run(),
    });
    await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();
    await runScheduled({ ...env, MAX_PARALLEL: "1" });
    expect(recipients(delivered)).toEqual(["a@example.com"]);
    expect(await deliveryStatuses(id)).toEqual(["sent", "skipped"]);
  });

  it("an announcement paused mid-run keeps its unsent rows queued for when it resumes", async () => {
    let first = true;
    mockOutbound({
      onDeliver: async () => {
        if (first) await env.DB.prepare("UPDATE announcements SET status = 'paused'").run();
        first = false;
      },
    });
    await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();
    await runScheduled({ ...env, MAX_PARALLEL: "1" });
    expect(await deliveryStatuses(id)).toEqual(["sent", "pending"]);
  });

  it("rows claimed by another, still-running run are left alone", async () => {
    const { calls } = mockOutbound();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run();
    await env.DB.prepare("UPDATE deliveries SET status = 'claimed', claim_id = 'other-run', claimed_at = datetime('now')").run();
    await runScheduled(env);
    expect(calls).toHaveLength(0);
    const row = await env.DB.prepare("SELECT status, claim_id FROM deliveries").first();
    expect(row).toEqual({ status: "claimed", claim_id: "other-run" });
    expect((await announcement(id)).status).toBe("sending");
  });

  it("Resend retries an unclear outcome at most MAX_ATTEMPTS times, then marks it unknown", async () => {
    mockOutbound({ unknownFor: new Set(["a@example.com"]) });
    quiet();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) await runScheduled(env);
    expect(await deliveryStatuses(id)).toEqual(["unknown"]);
    const { attempts } = await env.DB.prepare("SELECT attempts FROM deliveries").first();
    expect(attempts).toBe(MAX_ATTEMPTS);
  });

  it("re-queuing unknown rows re-opens a finished announcement and sends them", async () => {
    const { delivered } = mockOutbound();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'sent', finished_at = datetime('now')").run();
    await env.DB.prepare("UPDATE deliveries SET status = 'unknown'").run();
    await env.DB.prepare("UPDATE deliveries SET status = 'pending' WHERE status = 'unknown'").run(); // the owner re-queues
    await runScheduled(env);
    expect(delivered).toHaveLength(1);
    expect((await announcement(id)).status).toBe("sent");
  });

  it("an email-service outage pauses the announcement instead of marking the whole list unknown", async () => {
    const binding = { send: vi.fn().mockRejectedValue(new Error("connection lost")) }; // no code: may have been sent
    quiet();
    for (let i = 0; i < 6; i++) await addSubscriber(`s${i}@example.com`);
    const id = await queueAnnouncement();
    await runScheduled({ ...env, MAIL_PROVIDER: "cloudflare", EMAIL: binding, MAX_PARALLEL: "1" });
    expect(binding.send).toHaveBeenCalledTimes(3);
    const a = await announcement(id);
    expect(a.status).toBe("paused");
    expect(a.last_error).toContain("may be down");
    const statuses = await deliveryStatuses(id);
    expect(statuses.filter((s) => s === "unknown")).toHaveLength(3);
    expect(statuses.filter((s) => s === "pending")).toHaveLength(3);
  });

  it("a mode switch can't turn a bulk row's interrupted send into an automatic retry", async () => {
    const { calls } = mockOutbound();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run();
    // Left "sending" by a bulk request (no idempotency key), now running in standard mode.
    await env.DB.prepare("UPDATE deliveries SET status = 'sending', attempts = 1, idempotent_send = 0, claimed_at = datetime('now'), send_started_at = datetime('now')").run();
    await ageInProgress();
    await runScheduled(env);
    expect(calls).toHaveLength(0);
    expect(await deliveryStatuses(id)).toEqual(["unknown"]);
  });

  it("…but bad addresses on an announcement that already delivered are just failed", async () => {
    const bad = Array.from({ length: 6 }, (_, i) => `s${i}@example.com`);
    mockOutbound({ rejectAddresses: bad });
    quiet();
    await addSubscriber("good@example.com");
    for (const b of bad) await addSubscriber(b);
    const id = await queueAnnouncement();
    await runScheduled({ ...env, EMAILS_PER_RUN: "1" }); // good@ goes first
    await runScheduled(env);
    expect((await announcement(id)).status).toBe("sent");
    expect((await deliveryStatuses(id)).filter((s) => s === "failed")).toHaveLength(6);
  });

  it("per-person temporary failures (Cloudflare Email) retry, then fail after the attempt limit", async () => {
    const binding = { send: vi.fn().mockRejectedValue(Object.assign(new Error("try later"), { code: "E_RATE" })) };
    quiet();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    const cf = { ...env, MAIL_PROVIDER: "cloudflare", EMAIL: binding };
    for (let i = 0; i < MAX_ATTEMPTS; i++) await runScheduled(cf);
    expect(binding.send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(await deliveryStatuses(id)).toEqual(["failed"]);
    expect((await announcement(id)).status).toBe("sent");
  });

  it("a run that died mid-send with a service without idempotency marks the row unknown", async () => {
    const binding = { send: vi.fn().mockResolvedValue({ messageId: "x" }) };
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run();
    await env.DB.prepare("UPDATE deliveries SET status = 'sending', claimed_at = datetime('now'), send_started_at = datetime('now')").run();
    await ageInProgress();
    await runScheduled({ ...env, MAIL_PROVIDER: "cloudflare", EMAIL: binding });
    expect(binding.send).not.toHaveBeenCalled();
    expect(await deliveryStatuses(id)).toEqual(["unknown"]);
    expect((await announcement(id)).status).toBe("sent");
  });

  it("ignores cancelled announcements", async () => {
    const { calls } = mockOutbound();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'cancelled' WHERE id = ?1").bind(id).run();
    await runScheduled(env);
    expect(calls).toHaveLength(0);
  });

  it("uses the HTML body when one is given", async () => {
    const { delivered } = mockOutbound();
    await addSubscriber("a@example.com");
    const { id } = await env.DB.prepare(
      "INSERT INTO announcements (subject, body_text, body_html, status) VALUES ('Hi', 'plain', '<h1>Fancy</h1>', 'queued') RETURNING id",
    ).first();
    await env.DB.prepare("INSERT INTO deliveries (announcement_id, subscriber_id) SELECT ?1, id FROM subscribers").bind(id).run();
    await runScheduled(env);
    expect(delivered[0].html).toContain("<h1>Fancy</h1>");
    expect(delivered[0].text).toContain("plain");
  });

  it("retries confirmation emails that were never sent", async () => {
    const { delivered } = mockOutbound();
    await addSubscriber("waiting@example.com", "pending");
    await runScheduled(env);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].subject).toContain("Confirm");
  });

  it("clears signup rate-limit counters older than a day", async () => {
    mockOutbound();
    await env.DB.prepare("INSERT INTO signup_attempts (ip_hash, hour, attempts) VALUES ('old', '2000-01-01T00', 5)").run();
    await runScheduled(env);
    expect(await env.DB.prepare("SELECT 1 FROM signup_attempts WHERE ip_hash = 'old'").first()).toBeNull();
  });
});

describe("announcements: bulk mode", () => {
  beforeEach(resetDb);
  afterEach(() => vi.restoreAllMocks());

  it("sends one permissive batch; a bad address fails only itself", async () => {
    const { calls, delivered } = mockOutbound({ rejectAddresses: ["bad@example.com"] });
    quiet();
    await addSubscriber("a@example.com");
    await addSubscriber("bad@example.com");
    await addSubscriber("c@example.com");
    const id = await queueAnnouncement();

    await runScheduled(bulk);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/emails/batch");
    expect(calls[0].validation).toBe("permissive");
    expect(recipients(delivered)).toEqual(["a@example.com", "c@example.com"]);
    expect(await deliveryStatuses(id)).toEqual(["sent", "failed", "sent"]);
    const failed = await env.DB.prepare("SELECT error FROM deliveries WHERE status = 'failed'").first();
    expect(failed.error).not.toContain("bad@example.com");
    expect((await announcement(id)).status).toBe("sent");
  });

  it("each person's batch email has their own unsubscribe link and headers", async () => {
    const { delivered } = mockOutbound();
    const ta = await addSubscriber("a@example.com");
    const tb = await addSubscriber("b@example.com");
    await queueAnnouncement();
    await runScheduled(bulk);
    const byTo = Object.fromEntries(delivered.map((e) => [e.to[0], e]));
    expect(byTo["a@example.com"].headers["List-Unsubscribe"]).toContain(ta);
    expect(byTo["b@example.com"].text).toContain(tb);
    expect(byTo["b@example.com"].text).not.toContain(ta);
  });

  it("a batch refused as a whole is retried one email at a time", async () => {
    mockOutbound({ batchStatus: 422, errorName: "validation_error" });
    quiet();
    await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();
    await runScheduled(bulk);
    expect(await deliveryStatuses(id)).toEqual(["pending", "pending"]);
    const { solo } = await env.DB.prepare("SELECT MIN(solo) AS solo FROM deliveries").first();
    expect(solo).toBe(1);

    vi.restoreAllMocks();
    const { calls, delivered } = mockOutbound();
    await runScheduled(bulk);
    expect(calls.every((c) => c.path === "/emails")).toBe(true);
    expect(delivered).toHaveLength(2);
  });

  it("an unclear batch outcome is marked unknown and never re-sent automatically", async () => {
    const { calls } = mockOutbound({ timeoutAfterDelivery: true });
    quiet();
    await addSubscriber("a@example.com");
    await addSubscriber("b@example.com");
    const id = await queueAnnouncement();
    await runScheduled(bulk);
    await runScheduled(bulk);
    expect(calls).toHaveLength(1);
    expect(await deliveryStatuses(id)).toEqual(["unknown", "unknown"]);
    expect((await announcement(id)).status).toBe("paused"); // an unclear bulk request pauses until checked

    // The owner checks, re-queues them and resumes from the admin app.
    await env.DB.prepare("UPDATE deliveries SET status = 'pending' WHERE status = 'unknown'").run();
    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run();
    await runScheduled(bulk);
    expect(calls).toHaveLength(2);
  });

  it("a bulk run that died mid-send marks its rows unknown", async () => {
    const { calls } = mockOutbound();
    await addSubscriber("a@example.com");
    const id = await queueAnnouncement();
    await env.DB.prepare("UPDATE announcements SET status = 'sending'").run();
    await env.DB.prepare("UPDATE deliveries SET status = 'sending', claimed_at = datetime('now'), send_started_at = datetime('now')").run();
    await ageInProgress();
    await runScheduled(bulk);
    expect(calls).toHaveLength(0);
    expect(await deliveryStatuses(id)).toEqual(["unknown"]);
  });

  it("splits large lists into batches of the service's maximum size", async () => {
    const { calls } = mockOutbound();
    for (let i = 0; i < 150; i++) await addSubscriber(`p${String(i).padStart(3, "0")}@example.com`);
    await queueAnnouncement();
    await runScheduled({ ...bulk, EMAILS_PER_RUN: "1000", DAILY_SEND_LIMIT: "0" });
    expect(calls.map((c) => c.body.length)).toEqual([100, 50]);
  });
});
