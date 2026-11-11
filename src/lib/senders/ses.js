// Amazon SES, v2 API over signed fetch (SigV4, service "ses").
// Standard: POST /v2/email/outbound-emails (SendEmail), Simple content with headers.
// Bulk: POST /v2/email/outbound-bulk-emails (SendBulkEmail), up to 50 entries,
//   an inline template (simple substitution) and per-entry ReplacementHeaders
//   for each person's List-Unsubscribe. One result per entry.
// No idempotency keys. Sending speed is limited by each account's approved rate.
import { signRequest } from "../sigv4.js";
import { UNSUB } from "../emails.js";
import { classifyHttp, describe, request, safeJson } from "./common.js";

/** Template variables. "{{" in the content is written as {{perchlight_lb}} so it isn't read as a variable. */
const VAR_UNSUB = "perchlight_unsubscribe_url";
const VAR_LB = "perchlight_lb";

/** SES error types and bulk statuses that mean a setup problem. */
const CONFIG = new Set([
  "AccountSuspendedException",
  "SendingPausedException",
  "MailFromDomainNotVerifiedException",
  "NotFoundException",
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "ACCOUNT_SUSPENDED",
  "ACCOUNT_SENDING_PAUSED",
  "CONFIGURATION_SET_SENDING_PAUSED",
  "MAIL_FROM_DOMAIN_NOT_VERIFIED",
  "CONFIGURATION_SET_NOT_FOUND",
  "CONFIGURATION_SET_DOES_NOT_EXIST",
  "TEMPLATE_NOT_FOUND",
  "TEMPLATE_DOES_NOT_EXIST",
  "INVALID_SENDING_POOL_NAME",
]);
const THROTTLED = new Set([
  "TooManyRequestsException",
  "LimitExceededException",
  "ThrottlingException",
  "ACCOUNT_THROTTLED",
  "ACCOUNT_DAILY_QUOTA_EXCEEDED",
]);
const REJECTED = new Set(["MessageRejected", "MESSAGE_REJECTED", "INVALID_PARAMETER", "INVALID_PARAMETER_VALUE"]);

export function escapeTemplate(s) {
  return s.split("{{").join(`{{${VAR_LB}}}`);
}

/** @returns {import("./index.js").EmailSender} */
export function sesSender({ accessKeyId, secretAccessKey, region, configurationSet }, from) {
  const base = `https://email.${region}.amazonaws.com`;
  const toHeaders = (h) => Object.entries(h ?? {}).map(([Name, Value]) => ({ Name, Value }));

  async function call(path, payload) {
    const body = JSON.stringify(payload);
    const { headers } = await signRequest({
      method: "POST",
      url: base + path,
      headers: { "Content-Type": "application/json" },
      body,
      accessKeyId,
      secretAccessKey,
      region,
      service: "ses",
    });
    return request(base + path, { method: "POST", headers, body });
  }

  function failure(r, fallback) {
    const data = safeJson(r.text);
    const type = String(r.res.headers.get("x-amzn-ErrorType") ?? data?.__type ?? data?.code ?? "").split(":")[0].split("#").pop();
    const error = describe("SES", r.res.status, `${type} ${data?.message ?? data?.Message ?? r.text}`);
    if (CONFIG.has(type)) return { status: "config", error };
    if (THROTTLED.has(type)) return { status: "throttled", error };
    if (REJECTED.has(type)) return { status: fallback, error };
    return { status: classifyHttp(r.res.status) ?? fallback, error };
  }

  return {
    name: "ses",
    idempotent: false,
    bulkSize: 50,

    async send(m) {
      const r = await call("/v2/email/outbound-emails", {
        FromEmailAddress: from,
        Destination: { ToAddresses: [m.to] },
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: m.subject, Charset: "UTF-8" },
            Body: { Text: { Data: m.text, Charset: "UTF-8" }, Html: { Data: m.html, Charset: "UTF-8" } },
            Headers: toHeaders(m.headers),
          },
        },
      });
      if (r.networkError) return { status: "unknown", error: `SES unreachable: ${r.networkError}` };
      if (r.res.ok) return { status: "sent", id: safeJson(r.text)?.MessageId ?? null };
      return failure(r, "rejected");
    },

    async sendBulk(messages) {
      // All messages in one bulk call share a template (the caller groups by announcement).
      const t = messages[0].template;
      const asTemplate = (s) => escapeTemplate(s).split(UNSUB).join(`{{${VAR_UNSUB}}}`);
      const r = await call("/v2/email/outbound-bulk-emails", {
        FromEmailAddress: from,
        ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
        DefaultContent: {
          Template: {
            TemplateContent: { Subject: asTemplate(t.subject), Text: asTemplate(t.text), Html: asTemplate(t.html) },
            TemplateData: JSON.stringify({ [VAR_LB]: "{{", [VAR_UNSUB]: "" }),
          },
        },
        BulkEmailEntries: messages.map((m) => ({
          Destination: { ToAddresses: [m.to] },
          ReplacementEmailContent: {
            ReplacementTemplate: { ReplacementTemplateData: JSON.stringify({ [VAR_LB]: "{{", [VAR_UNSUB]: m.unsubscribeUrl }) },
          },
          ReplacementHeaders: toHeaders(m.headers),
        })),
      });
      const all = (result) => messages.map(() => result);
      if (r.networkError) return all({ status: "unknown", error: `SES unreachable: ${r.networkError}` });
      if (!r.res.ok) return all(failure(r, "split"));

      const results = safeJson(r.text)?.BulkEmailEntryResults ?? [];
      return messages.map((_, i) => {
        const e = results[i];
        if (!e) return { status: "unknown", error: "SES returned no result for this entry" };
        if (e.Status === "SUCCESS") return { status: "sent", id: e.MessageId ?? null };
        const error = describe("SES", e.Status, e.Error ?? "");
        if (CONFIG.has(e.Status)) return { status: "config", error };
        if (THROTTLED.has(e.Status)) return { status: "throttled", error };
        if (REJECTED.has(e.Status)) return { status: "rejected", error };
        return { status: "retry", error }; // TRANSIENT_FAILURE, FAILED
      });
    },
  };
}
