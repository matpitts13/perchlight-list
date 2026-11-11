// POST /api/subscribe - mailing-list signup (double opt-in).
// Accepts a form (multipart/urlencoded) or JSON. Answers JSON when the
// request asks for it (a page script), otherwise redirects to a page, so the
// form also works without JavaScript.
import { json, redirect } from "../lib/http.js";
import { newToken, sha256Hex } from "../lib/tokens.js";
import { normalizeEmail, domainOf } from "../lib/validate.js";
import { BURNER_REASON, blockReasonFor } from "../lib/blocking.js";
import { domainAcceptsMail } from "../lib/mx.js";
import { passesTurnstile } from "../lib/turnstile.js";
import { getSender } from "../lib/senders/index.js";
import { sendConfirmation } from "../lib/confirmations.js";
import { remainingToday } from "../lib/daily.js";
import { config } from "../lib/config.js";

const MAX_ATTEMPTS_PER_HOUR = 10;
const RESEND_COOLDOWN_MINUTES = 10;
const MAX_CONFIRM_SENDS = 5; // per day, for one pending address
const DAY_MS = 24 * 3600_000;
const MAX_BODY_BYTES = 10 * 1024;

export async function subscribe(request, env, ctx) {
  const wantsJson = (request.headers.get("Accept") ?? "").includes("application/json");
  const reply = (ok, message, status = 200) =>
    wantsJson ? json({ ok, message }, status) : redirect(ok ? "/list/check-inbox/" : "/list/problem/");

  // A signup is a few short fields; anything bigger isn't one. Measured on
  // the body itself, since Content-Length is missing from chunked requests.
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return reply(false, "That didn't look like a signup. Please try again.", 413);
  }

  let fields;
  try {
    const type = request.headers.get("Content-Type") ?? "";
    const parsed = new Request(request.url, { method: "POST", headers: request.headers, body: raw });
    const body = type.includes("application/json") ? await parsed.json() : null;
    const form = body ? null : await parsed.formData();
    const field = (name) => String((body ? body?.[name] : form.get(name)) ?? "");
    fields = {
      email: field("email"),
      website: field("website"), // honeypot: hidden from people, filled in by bots
      source: field("source"),
      turnstileToken: field("cf-turnstile-response"), // added by the Turnstile widget
    };
  } catch {
    return reply(false, "That didn't look like a signup. Please try again.", 400);
  }

  const sender = getSender(env);
  // The same answer, in about the same time, whatever the address's state,
  // so the form can't be used to find out who is on the list: emails are
  // sent after the reply (waitUntil), never while the visitor waits.
  const done = () =>
    reply(
      true,
      sender
        ? "Almost done - check your inbox to confirm your address."
        : "Thanks - you're on the list. We'll email you shortly to confirm your address.",
    );

  // A bot. Answer exactly as for a person, so it neither retries nor learns there was a trap.
  if (fields.website) return done();

  const email = normalizeEmail(fields.email);
  if (!email) return reply(false, "Please enter a valid email address.", 400);
  const source = fields.source.slice(0, 40).replace(/[^a-z0-9-]/gi, "") || "site";

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await passesTurnstile(env, fields.turnstileToken, ip))) {
    return reply(false, "Please complete the bot check on the form and try again.", 400);
  }

  // Rate limit per network, stored only as a salted hash, per hour. IPv6
  // users get a whole /64 each, so limit by that prefix, not the address.
  // IP_SALT should be set as a secret; without it the site URL is used, which
  // still keeps raw IPs out of the database but is guessable.
  const network = ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
  const ipHash = await sha256Hex(`${env.IP_SALT || env.SITE_URL || "perchlight-list"}:${network}`);
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  const attempt = await env.DB.prepare(
    `INSERT INTO signup_attempts (ip_hash, hour, attempts) VALUES (?1, ?2, 1)
     ON CONFLICT(ip_hash, hour) DO UPDATE SET attempts = attempts + 1
     RETURNING attempts`,
  ).bind(ipHash, hour).first();
  if (attempt && attempt.attempts > MAX_ATTEMPTS_PER_HOUR) {
    return reply(false, "Too many signups from your connection. Please try again in an hour.", 429);
  }

  const existing = await env.DB.prepare(
    "SELECT status, token, confirm_sent_at, confirm_sends, block_reason FROM subscribers WHERE email = ?1",
  ).bind(email).first();

  // A disposable or hand-blocked domain: kept, unsubscribed and tagged, so it
  // shows in the admin app, and never emailed. A reason already on the row is
  // kept. Only new, pending or unsubscribed rows change: a stranger typing a
  // confirmed member's address into the form must not unsubscribe them, nor
  // erase a bounce or complaint record. (Blocking existing members of a
  // domain is the list owner's call, made in the admin app.)
  const blockReason = await blockReasonFor(env, email);
  if (blockReason) {
    await env.DB.prepare(
      `INSERT INTO subscribers (email, token, source, status, unsubscribed_at, block_reason, blocked_at)
       VALUES (?1, ?2, ?3, 'unsubscribed', datetime('now'), ?4, datetime('now'))
       ON CONFLICT(email) DO UPDATE SET status = 'unsubscribed',
         unsubscribed_at = COALESCE(unsubscribed_at, datetime('now')),
         block_reason = COALESCE(block_reason, excluded.block_reason),
         blocked_at = COALESCE(blocked_at, excluded.blocked_at)
       WHERE subscribers.status IN ('pending', 'unsubscribed')`,
    ).bind(email, newToken(), source, blockReason).run();
    return reply(
      false,
      blockReason === BURNER_REASON
        ? "Please use a permanent email address. Temporary and disposable addresses can't join the list."
        : "That email address can't join the list.",
      400,
    );
  }

  // A domain that can't receive email: a typo or a made-up address. Nothing
  // is stored or sent. Checked for every address, listed or not, so the DNS
  // lookup's time can't tell which addresses are already on the list.
  if ((await domainAcceptsMail(domainOf(email))) === false) {
    return reply(false, "That email domain can't receive email. Please check the address.", 400);
  }

  // Paths that return without changing anything still do one small write, so
  // their timing matches a real signup's and can't reveal who's on the list.
  const quietDone = async () => {
    await env.DB.prepare("UPDATE subscribers SET source = source WHERE email = ?1").bind(email).run();
    return done();
  };

  // Blocked by hand, already confirmed, or reported as bounced or spam: no
  // change and nothing sent, with the same answer as anyone else.
  if (existing && (existing.block_reason || ["confirmed", "bounced", "complained"].includes(existing.status))) {
    return quietDone();
  }

  let token;
  let sendsSoFar = 0;
  if (existing) {
    // Pending or unsubscribed: a fresh request to join, but one address can't
    // be emailed over and over. A pending address keeps its token, so the
    // link already in its inbox keeps working; an unsubscribed one gets a new one.
    const lastSent = existing.confirm_sent_at ? Date.parse(`${existing.confirm_sent_at.replace(" ", "T")}Z`) : 0;
    const sinceLast = now.getTime() - lastSent;
    const coolingDown = sinceLast < RESEND_COOLDOWN_MINUTES * 60_000;
    const capped = existing.confirm_sends >= MAX_CONFIRM_SENDS && sinceLast < DAY_MS;
    if (existing.status === "pending" && (coolingDown || capped)) return quietDone();

    token = existing.status === "pending" ? existing.token : newToken();
    const resetCount = sinceLast >= DAY_MS;
    sendsSoFar = resetCount ? 0 : existing.confirm_sends;
    // block_reason IS NULL: blocked since the read above, so nothing changes
    // (the trigger would refuse it anyway) and nothing is sent.
    const updated = await env.DB.prepare(
      `UPDATE subscribers SET status = 'pending', token = ?2, unsubscribed_at = NULL,
           source = CASE WHEN status = 'unsubscribed' THEN ?3 ELSE source END,
           confirm_sends = CASE WHEN ?4 THEN 0 ELSE confirm_sends END
       WHERE email = ?1 AND block_reason IS NULL AND status IN ('pending', 'unsubscribed')`,
    ).bind(email, token, source, resetCount ? 1 : 0).run();
    if (!updated.meta.changes) return done();
  } else {
    token = newToken();
    // Two submissions of a new address at once: the second is a no-op.
    const inserted = await env.DB.prepare(
      "INSERT INTO subscribers (email, token, source) VALUES (?1, ?2, ?3) ON CONFLICT(email) DO NOTHING RETURNING id",
    ).bind(email, token, source).first();
    if (!inserted) return done();
  }

  if (sender) ctx.waitUntil(sendAfterReply(env, sender, email, token, sendsSoFar));
  return done();
}

/** Sends the confirmation after the visitor has their answer. Anything left
 *  unsent (blocked meanwhile, daily limit reached, service down) is picked
 *  up by the scheduled job. */
async function sendAfterReply(env, sender, email, token, sendsSoFar) {
  try {
    const row = await env.DB.prepare("SELECT block_reason FROM subscribers WHERE email = ?1").bind(email).first();
    if (!row || row.block_reason) return;
    if ((await remainingToday(env, config(env).dailyLimit)) <= 0) return;
    await sendConfirmation(env, sender, email, token, sendsSoFar);
  } catch (err) {
    console.error(`confirmation email: ${err instanceof Error ? err.message : String(err)}`);
  }
}
