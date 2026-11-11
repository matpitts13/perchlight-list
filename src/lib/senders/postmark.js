// Postmark. Header X-Postmark-Server-Token; JSON in and out.
// Standard: POST /email. Bulk: POST /email/batch, up to 500, one result per
//   message (the batch answers 200 even if some messages fail).
// Announcements go to a broadcast message stream (POSTMARK_STREAM). By default
//   Postmark manages unsubscribes on broadcast streams and adds its own
//   List-Unsubscribe headers, which can't be replaced; those unsubscribes come
//   back through the SubscriptionChange webhook. POSTMARK_UNSUBSCRIBE=self
//   sends our own headers instead, which needs Postmark support's approval.
// No idempotency keys, no hard rate limit.
import { classifyHttp, describe, request, safeJson } from "./common.js";

const API = "https://api.postmarkapp.com";

// Error codes: https://postmarkapp.com/developer/api/overview#error-codes
// Only the long-standing per-recipient codes are matched by number (300
// invalid email, 406 inactive recipient); everything else is classified by
// HTTP status and message text, so newer codes are handled sensibly.
const REJECTED_CODES = new Set([300, 406]);
const REJECTED_TEXT = /inactive|suppress|invalid .*(to|email|address|recipient)|recipient/i;
const CONFIG_TEXT = /token|sender signature|not allowed|pending approval|account|stream|domain|unauthori|forbidden/i;

/** @returns {import("./index.js").EmailSender} */
export function postmarkSender({ serverToken, stream, ownUnsubscribe }, from) {
  const headers = { "X-Postmark-Server-Token": serverToken, "Content-Type": "application/json", Accept: "application/json" };
  const payload = (m, isAnnouncement) => {
    const h = isAnnouncement && !ownUnsubscribe ? {} : m.headers ?? {};
    return {
      From: from,
      To: m.to,
      Subject: m.subject,
      TextBody: m.text,
      HtmlBody: m.html,
      Headers: Object.entries(h).map(([Name, Value]) => ({ Name, Value })),
      // Confirmation emails are transactional; announcements go to the broadcast stream.
      MessageStream: isAnnouncement ? stream : "outbound",
    };
  };

  function classifyCode(code, message) {
    const text = String(message ?? "");
    const error = describe("Postmark", code, text);
    if (REJECTED_CODES.has(code)) return { status: "rejected", error };
    if (CONFIG_TEXT.test(text)) return { status: "config", error };
    if (REJECTED_TEXT.test(text)) return { status: "rejected", error };
    return { status: "retry", error };
  }

  function failure(r, fallback) {
    const data = safeJson(r.text);
    if (typeof data?.ErrorCode === "number" && data.ErrorCode !== 0) {
      const c = classifyCode(data.ErrorCode, data.Message);
      return c.status === "retry" ? { status: classifyHttp(r.res.status) ?? fallback, error: c.error } : c;
    }
    return { status: classifyHttp(r.res.status) ?? fallback, error: describe("Postmark", r.res.status, r.text) };
  }

  return {
    name: "postmark",
    idempotent: false,
    bulkSize: 500,

    async send(m) {
      const r = await request(`${API}/email`, { method: "POST", headers, body: JSON.stringify(payload(m, Boolean(m.template))) });
      if (r.networkError) return { status: "unknown", error: `Postmark unreachable: ${r.networkError}` };
      const data = safeJson(r.text);
      if (r.res.ok && (data?.ErrorCode ?? 0) === 0) return { status: "sent", id: data?.MessageID ?? null };
      return failure(r, "rejected");
    },

    async sendBulk(messages) {
      const r = await request(`${API}/email/batch`, { method: "POST", headers, body: JSON.stringify(messages.map((m) => payload(m, true))) });
      const all = (result) => messages.map(() => result);
      if (r.networkError) return all({ status: "unknown", error: `Postmark unreachable: ${r.networkError}` });
      if (!r.res.ok) return all(failure(r, "split"));
      const results = safeJson(r.text);
      if (!Array.isArray(results)) return all({ status: "unknown", error: "Postmark returned an unreadable batch reply" });
      return messages.map((_, i) => {
        const e = results[i];
        if (!e) return { status: "unknown", error: "Postmark returned no result for this message" };
        return e.ErrorCode === 0 ? { status: "sent", id: e.MessageID ?? null } : classifyCode(e.ErrorCode, e.Message);
      });
    },
  };
}
