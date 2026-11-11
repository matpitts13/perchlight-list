// Resend (resend.com).
// Standard: POST /emails with an Idempotency-Key, so a retry can't deliver twice
//   (keys last 24 hours; 409 concurrent_idempotent_requests = still in progress,
//   409 invalid_idempotent_request = key reused for different content).
// Bulk: POST /emails/batch, up to 100, with permissive validation so one bad
//   address fails only itself; refused emails come back in errors[] by index.
// Rate limit: 10 requests/second per team by default.
import { classifyHttp, describe, redactAddresses, request, safeJson } from "./common.js";

const API = "https://api.resend.com";
export { redactAddresses };

/** @returns {import("./index.js").EmailSender} */
export function resendSender(apiKey, from) {
  const payload = (m) => ({
    from,
    to: [m.to],
    subject: m.subject,
    text: m.text,
    html: m.html,
    headers: m.headers,
  });
  const headers = (extra = {}) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra });

  return {
    name: "resend",
    idempotent: true,
    bulkSize: 100,

    async send(message, options = {}) {
      const r = await request(`${API}/emails`, {
        method: "POST",
        headers: headers(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey.slice(0, 256) } : {}),
        body: JSON.stringify(payload(message)),
      });
      if (r.networkError) return { status: "unknown", error: `Resend unreachable: ${r.networkError}` };
      const data = safeJson(r.text);
      if (r.res.ok) return { status: "sent", id: data?.id ?? null };
      const error = describe("Resend", r.res.status, r.text);
      if (r.res.status === 409) {
        return data?.name === "concurrent_idempotent_requests" ? { status: "unknown", error } : { status: "conflict", error };
      }
      return { status: requestFailure(r.res.status, data?.name) ?? "rejected", error };
    },

    async sendBulk(messages) {
      const r = await request(`${API}/emails/batch`, {
        method: "POST",
        headers: headers({ "x-batch-validation": "permissive" }),
        body: JSON.stringify(messages.map(payload)),
      });
      const all = (status, error) => messages.map(() => ({ status, error }));
      if (r.networkError) return all("unknown", `Resend unreachable: ${r.networkError}`);
      const data = safeJson(r.text);
      if (!r.res.ok) {
        // With permissive validation a bad recipient doesn't fail the request,
        // so a request-level 4xx means something about the batch itself.
        return all(requestFailure(r.res.status, data?.name) ?? "split", describe("Resend", r.res.status, r.text));
      }
      const errors = new Map((data?.errors ?? []).map((e) => [e?.index, String(e?.message ?? "refused")]));
      const ids = (data?.data ?? []).map((d) => d?.id ?? null);
      let next = 0;
      return messages.map((_, i) =>
        errors.has(i)
          ? { status: "rejected", error: `Resend: ${redactAddresses(errors.get(i).slice(0, 300))}` }
          : { status: "sent", id: ids[next++] ?? null },
      );
    },
  };
}

/** Resend error names that mean a setup problem, not one bad message. */
const CONFIG_ERRORS = new Set([
  "missing_api_key",
  "invalid_api_key",
  "restricted_api_key",
  "invalid_from_address",
  "invalid_access",
  "not_found",
  "method_not_allowed",
]);

function requestFailure(status, name) {
  if (name === "rate_limit_exceeded" || name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return "throttled";
  if (CONFIG_ERRORS.has(name)) return "config";
  return classifyHttp(status);
}
