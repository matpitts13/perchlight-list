// Bounce, complaint and unsubscribe webhooks, one per email service. Each
// checks the request really came from the service before changing anything.
//   POST /api/webhooks/resend    Svix signature (RESEND_WEBHOOK_SECRET)
//   POST /api/webhooks/mailgun   HMAC signature (MAILGUN_WEBHOOK_SIGNING_KEY)
//   POST /api/webhooks/postmark  Basic auth in the webhook URL (POSTMARK_WEBHOOK_USER / _PASSWORD)
//   POST /api/webhooks/ses       Amazon SNS signature + topic (SES_SNS_TOPIC_ARN)
import { json } from "../lib/http.js";
import { verifyWebhookSignature } from "../lib/webhook-signature.js";
import { applyListEvents, safeEqual } from "../lib/list-events.js";
import { verifySnsMessage, isSnsHost } from "../lib/sns.js";

const MAX_BODY = 256 * 1024;

async function readBody(request) {
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BODY) return null;
  const body = await request.text();
  return body.length > MAX_BODY ? null : body;
}

/** SNS messages older than this are refused (replay protection). Long enough
 *  for SNS's delivery retries after an outage; replaying a bounce or complaint
 *  can only ever remove someone from the list, never add them. */
const SNS_MAX_AGE_MS = 72 * 60 * 60 * 1000;

function notConfigured(name) {
  console.error(`webhook: ${name} isn't set; refusing unverifiable events`);
  return json({ ok: false, error: "not configured" }, 503);
}

function parse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined; // not JSON
  }
}

// --- Resend --------------------------------------------------------------
// Events: email.bounced (data.bounce.type "Permanent" | "Temporary"),
// email.complained, email.suppressed (already on Resend's suppression list).
export async function resendWebhook(request, env) {
  if (!env.RESEND_WEBHOOK_SECRET) return notConfigured("RESEND_WEBHOOK_SECRET");
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: "too large" }, 413);
  if (!(await verifyWebhookSignature(env.RESEND_WEBHOOK_SECRET, request.headers, body))) {
    return json({ ok: false, error: "bad signature" }, 401);
  }
  const event = parse(body);
  if (event === undefined) return json({ ok: false, error: "not JSON" }, 400);

  const data = event?.data ?? {};
  let kind;
  if (event?.type === "email.bounced") {
    const type = String(data.bounce?.type ?? "permanent").toLowerCase();
    if (type !== "permanent") return json({ ok: true, ignored: type });
    kind = "bounced";
  } else if (event?.type === "email.suppressed") {
    kind = "bounced";
  } else if (event?.type === "email.complained") {
    kind = "complained";
  } else {
    return json({ ok: true, ignored: String(event?.type ?? "unknown") });
  }
  const to = Array.isArray(data.to) ? data.to : [data.to];
  await applyListEvents(env, to.map((email) => ({ email, kind, providerId: data.email_id })));
  return json({ ok: true });
}

// --- Mailgun -------------------------------------------------------------
// Body: { signature: { timestamp, token, signature }, "event-data": { event, severity, recipient } }.
// Signature = hex HMAC-SHA256 of timestamp + token, keyed with the webhook signing key.
const MAILGUN_MAX_AGE_SECONDS = 24 * 3600; // Mailgun retries failed webhooks for hours

export async function mailgunWebhook(request, env) {
  if (!env.MAILGUN_WEBHOOK_SIGNING_KEY) return notConfigured("MAILGUN_WEBHOOK_SIGNING_KEY");
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: "too large" }, 413);
  const payload = parse(body);
  if (!payload) return json({ ok: false, error: "not JSON" }, 400);

  const sig = payload.signature ?? {};
  if (!(await verifyMailgun(env.MAILGUN_WEBHOOK_SIGNING_KEY, sig))) return json({ ok: false, error: "bad signature" }, 401);

  const e = payload["event-data"] ?? {};
  let kind = null;
  if (e.event === "failed" && e.severity === "permanent") kind = "bounced";
  else if (e.event === "complained") kind = "complained";
  else if (e.event === "unsubscribed") kind = "unsubscribed";
  if (!kind) return json({ ok: true, ignored: String(e.event ?? "unknown") });
  await applyListEvents(env, [{ email: e.recipient, kind, providerId: e.message?.headers?.["message-id"] }]);
  return json({ ok: true });
}

export async function verifyMailgun(signingKey, { timestamp, token, signature }, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!timestamp || !token || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > MAILGUN_MAX_AGE_SECONDS) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}${token}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(String(signature).toLowerCase(), expected);
}

// --- Postmark ------------------------------------------------------------
// No signatures: the webhook URL carries a user and password
// (https://USER:PASSWORD@your.site/api/webhooks/postmark), sent as Basic auth.
// RecordType Bounce (Type HardBounce), SpamComplaint, SubscriptionChange (SuppressSending).
export async function postmarkWebhook(request, env) {
  if (!env.POSTMARK_WEBHOOK_USER || !env.POSTMARK_WEBHOOK_PASSWORD) return notConfigured("POSTMARK_WEBHOOK_USER / POSTMARK_WEBHOOK_PASSWORD");
  if (!safeEqual(basicCredentials(request.headers.get("Authorization")), `${env.POSTMARK_WEBHOOK_USER}:${env.POSTMARK_WEBHOOK_PASSWORD}`)) {
    return json({ ok: false, error: "unauthorized" }, 401, { "WWW-Authenticate": 'Basic realm="webhooks"' });
  }
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: "too large" }, 413);
  const e = parse(body);
  if (!e) return json({ ok: false, error: "not JSON" }, 400);

  let event = null;
  if (e.RecordType === "Bounce" && (e.Type === "HardBounce" || e.Type === "BadEmailAddress")) {
    event = { email: e.Email, kind: "bounced", providerId: e.MessageID };
  } else if (e.RecordType === "SpamComplaint") {
    event = { email: e.Email, kind: "complained", providerId: e.MessageID };
  } else if (e.RecordType === "SubscriptionChange" && e.SuppressSending === true) {
    // Postmark-managed unsubscribes on a broadcast stream. A complaint-driven
    // suppression is recorded as a complaint.
    event = { email: e.Recipient, kind: e.SuppressionReason === "SpamComplaint" ? "complained" : "unsubscribed", providerId: e.MessageID };
  }
  if (!event) return json({ ok: true, ignored: String(e.RecordType ?? "unknown") });
  await applyListEvents(env, [event]);
  return json({ ok: true });
}

/** "user:password" from a Basic Authorization header (UTF-8), or "" if there isn't one. */
function basicCredentials(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header ?? "");
  if (!m) return "";
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return ""; // not valid base64
  }
}

// --- Amazon SES (through SNS) --------------------------------------------
// SNS posts JSON as text/plain. SubscriptionConfirmation: we confirm by
// fetching SubscribeURL. Notification: Message is the SES event as a JSON
// string (notificationType, or eventType with event publishing).
export async function sesWebhook(request, env) {
  if (!env.SES_SNS_TOPIC_ARN) return notConfigured("SES_SNS_TOPIC_ARN");
  const body = await readBody(request);
  if (body === null) return json({ ok: false, error: "too large" }, 413);
  const msg = parse(body);
  if (!msg) return json({ ok: false, error: "not JSON" }, 400);

  if (msg.TopicArn !== env.SES_SNS_TOPIC_ARN) return json({ ok: false, error: "unexpected topic" }, 403);
  if (!(await verifySnsMessage(msg))) return json({ ok: false, error: "bad signature" }, 401);
  // A captured, validly signed notification can't be replayed later.
  const age = Date.now() - Date.parse(msg.Timestamp);
  if (!Number.isFinite(age) || age > SNS_MAX_AGE_MS) return json({ ok: false, error: "stale message" }, 400);

  if (msg.Type === "SubscriptionConfirmation") {
    if (!isSnsHost(msg.SubscribeURL)) return json({ ok: false, error: "bad subscribe URL" }, 400);
    const res = await fetch(msg.SubscribeURL, { signal: AbortSignal.timeout(10000) });
    return json({ ok: res.ok, confirmed: res.ok }, res.ok ? 200 : 502);
  }
  if (msg.Type !== "Notification") return json({ ok: true, ignored: String(msg.Type) });

  const n = parse(msg.Message);
  if (!n) return json({ ok: true, ignored: "unreadable message" });
  const type = n.notificationType ?? n.eventType;
  const providerId = n.mail?.messageId;
  let events = [];
  if (type === "Bounce" && n.bounce?.bounceType === "Permanent") {
    events = (n.bounce.bouncedRecipients ?? []).map((r) => ({ email: r.emailAddress, kind: "bounced", providerId }));
  } else if (type === "Complaint") {
    events = (n.complaint?.complainedRecipients ?? []).map((r) => ({ email: r.emailAddress, kind: "complained", providerId }));
  }
  if (!events.length) return json({ ok: true, ignored: String(type) });
  await applyListEvents(env, events);
  return json({ ok: true });
}
