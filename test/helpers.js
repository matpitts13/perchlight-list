import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../src/index.js";

/** Domains the fake DNS says don't exist. */
export const NO_SUCH_DOMAINS = new Set(["no-such-domain.test"]);

/**
 * Replaces outbound fetch with a fake DNS-over-HTTPS resolver and a fake
 * Resend that behaves like the real one:
 * - POST /emails honours Idempotency-Key: a repeated key returns the first
 *   reply and delivers nothing new;
 * - POST /emails/batch uses permissive validation (rejectAddresses come back in errors[]);
 * Options:
 * - status / errorName: answer every send with this HTTP status and error name;
 * - batchStatus: answer only batch requests with this status;
 * - rejectAddresses: addresses Resend refuses (422 on /emails, errors[] on batch);
 * - timeoutAfterDelivery: deliver, then throw as if the reply timed out (once).
 * Returns { calls, delivered, other }.
 */
export function mockOutbound(opts = {}) {
  const calls = [];
  const delivered = [];
  const seenKeys = new Map();
  let timeoutPending = Boolean(opts.timeoutAfterDelivery);
  const reject = new Set(opts.rejectAddresses ?? []);
  const maybeTimeout = () => {
    if (!timeoutPending) return;
    timeoutPending = false;
    throw new DOMException("The operation timed out.", "TimeoutError");
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "cloudflare-dns.com") {
      const name = url.searchParams.get("name");
      if (NO_SUCH_DOMAINS.has(name)) return Response.json({ Status: 3 });
      return Response.json({ Status: 0, Answer: [{ type: 15, data: `10 mx.${name}.` }] });
    }
    if (url.hostname !== "api.resend.com") throw new Error(`unexpected fetch in test: ${url}`);

    const headers = new Headers(init.headers);
    const body = JSON.parse(init.body);
    const key = headers.get("Idempotency-Key");
    const batch = url.pathname === "/emails/batch";
    calls.push({ path: url.pathname, body, key, validation: headers.get("x-batch-validation") });

    const status = batch ? (opts.batchStatus ?? opts.status) : opts.status;
    if (status) return Response.json({ name: opts.errorName ?? "error", message: `refused (${status})` }, { status });

    if (!batch) {
      if (key && seenKeys.has(key)) return Response.json(seenKeys.get(key));
      if (reject.has(body.to[0])) return Response.json({ name: "validation_error", message: `Invalid to: ${body.to[0]}` }, { status: 422 });
      if (opts.unknownFor?.has(body.to[0])) return new Response("bad gateway", { status: 502 });
      delivered.push(body);
      await opts.onDeliver?.(body);
      const reply = { id: `msg_${delivered.length}` };
      if (key) seenKeys.set(key, reply);
      maybeTimeout();
      return Response.json(reply);
    }

    const data = [];
    const errors = [];
    body.forEach((email, index) => {
      if (reject.has(email.to[0])) errors.push({ index, message: `Invalid to: ${email.to[0]}` });
      else {
        delivered.push(email);
        data.push({ id: `msg_${delivered.length}` });
      }
    });
    maybeTimeout();
    return Response.json(errors.length ? { data, errors } : { data });
  });
  return { calls, delivered };
}

/** Sends a request through the Worker and waits for its background work. */
export async function call(path, init = {}, envOverrides = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://list.test${path}`, init), { ...env, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function signupRequest(email, extra = {}) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "CF-Connecting-IP": extra.ip ?? "203.0.113.7" },
    body: JSON.stringify({ email, ...extra }),
  };
}

export async function resetDb() {
  await env.DB.batch(
    ["deliveries", "announcements", "subscribers", "signup_attempts", "blocked_domains", "allowed_domains", "send_log_daily"].map(
      (t) => env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
}

export async function subscriber(email) {
  return env.DB.prepare("SELECT * FROM subscribers WHERE email = ?1").bind(email).first();
}

/** Adds a subscriber. Non-pending rows are marked as already sent a
 *  confirmation, so the scheduled job doesn't retry one. */
export async function addSubscriber(email, status = "confirmed", token = undefined) {
  const t = token ?? `tok_${email.replace(/[^a-z0-9]/gi, "_")}`.padEnd(43, "x");
  await env.DB.prepare(
    `INSERT INTO subscribers (email, token, status, confirm_sent_at)
     VALUES (?1, ?2, ?3, CASE WHEN ?3 = 'pending' THEN NULL ELSE datetime('now', '-1 day') END)`,
  ).bind(email, t, status).run();
  return t;
}

/** Makes in-progress deliveries look abandoned by a run that died 3 minutes ago. */
export async function ageInProgress() {
  await env.DB.prepare(
    `UPDATE deliveries SET claimed_at = datetime('now', '-3 minutes'),
       send_started_at = CASE WHEN status = 'sending' THEN datetime('now', '-3 minutes') ELSE send_started_at END
     WHERE status IN ('claimed', 'sending')`,
  ).run();
}

export async function queueAnnouncement(subject = "Big news", bodyText = "Hello!\n\nSecond paragraph.") {
  const { id } = await env.DB.prepare(
    "INSERT INTO announcements (subject, body_text, status, queued_at) VALUES (?1, ?2, 'queued', datetime('now')) RETURNING id",
  ).bind(subject, bodyText).first();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO deliveries (announcement_id, subscriber_id)
     SELECT ?1, id FROM subscribers WHERE status = 'confirmed' AND block_reason IS NULL`,
  ).bind(id).run();
  return id;
}

export async function deliveryStatuses(announcementId) {
  const { results } = await env.DB.prepare(
    "SELECT d.status FROM deliveries d JOIN subscribers s ON s.id = d.subscriber_id WHERE announcement_id = ?1 ORDER BY s.email",
  ).bind(announcementId).all();
  return results.map((r) => r.status);
}

export async function announcement(id) {
  return env.DB.prepare("SELECT status, last_error FROM announcements WHERE id = ?1").bind(id).first();
}
