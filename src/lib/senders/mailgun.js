// Mailgun. POST /v3/<domain>/messages (multipart form), Basic auth api:<key>.
// US: api.mailgun.net, EU: api.eu.mailgun.net (use the domain's region).
// Standard: one recipient per request.
// Bulk: up to 1,000 recipients in one request with recipient-variables, so
//   each person sees only their own address and their own unsubscribe link
//   (%recipient.perchlight_unsubscribe_url%). Mailgun accepts or refuses the
//   whole request; per-person problems arrive later through webhooks.
//   Mailgun's docs don't confirm %recipient% substitution inside custom
//   headers, so test the List-Unsubscribe header with a real send (README).
// No idempotency keys.
import { UNSUB } from "../emails.js";
import { classifyHttp, describe, request, safeJson } from "./common.js";

const VAR_UNSUB = "perchlight_unsubscribe_url";

/** @returns {import("./index.js").EmailSender} */
export function mailgunSender({ apiKey, domain, region }, from) {
  const host = String(region).toLowerCase() === "eu" ? "https://api.eu.mailgun.net" : "https://api.mailgun.net";
  const url = `${host}/v3/${encodeURIComponent(domain)}/messages`;
  const auth = `Basic ${btoa(`api:${apiKey}`)}`;

  async function post(form) {
    return request(url, { method: "POST", headers: { Authorization: auth }, body: form });
  }

  function failure(r, fallback) {
    const error = describe("Mailgun", r.res.status, safeJson(r.text)?.message ?? r.text);
    // A 400 about the domain or sender is a setup problem, not one bad address.
    if (r.res.status === 400 && /domain|from|sender|not allowed|sandbox|authoriz/i.test(r.text)) return { status: "config", error };
    if (r.res.status === 404) return { status: "config", error }; // unknown domain or wrong region
    return { status: classifyHttp(r.res.status) ?? fallback, error };
  }

  return {
    name: "mailgun",
    idempotent: false,
    bulkSize: 1000,

    async send(m) {
      const form = new FormData();
      form.set("from", from);
      form.set("to", m.to);
      form.set("subject", m.subject);
      form.set("text", m.text);
      form.set("html", m.html);
      for (const [k, v] of Object.entries(m.headers ?? {})) form.set(`h:${k}`, v);
      const r = await post(form);
      if (r.networkError) return { status: "unknown", error: `Mailgun unreachable: ${r.networkError}` };
      // Webhooks report the Message-Id without angle brackets; store it the same way.
      if (r.res.ok) return { status: "sent", id: String(safeJson(r.text)?.id ?? "").replace(/^<|>$/g, "") || null };
      return failure(r, "rejected");
    },

    async sendBulk(messages) {
      const t = messages[0].template; // the caller groups bulk messages by announcement
      const asTemplate = (s) => s.split(UNSUB).join(`%recipient.${VAR_UNSUB}%`);
      const form = new FormData();
      form.set("from", from);
      for (const m of messages) form.append("to", m.to);
      form.set("subject", t.subject);
      form.set("text", asTemplate(t.text));
      form.set("html", asTemplate(t.html));
      form.set("recipient-variables", JSON.stringify(Object.fromEntries(messages.map((m) => [m.to, { [VAR_UNSUB]: m.unsubscribeUrl }]))));
      // Same header names for everyone; the URL is substituted per recipient.
      for (const [k, v] of Object.entries(messages[0].headers ?? {})) {
        form.set(`h:${k}`, v.split(messages[0].unsubscribeUrl).join(`%recipient.${VAR_UNSUB}%`));
      }
      const r = await post(form);
      const all = (result) => messages.map(() => result);
      if (r.networkError) return all({ status: "unknown", error: `Mailgun unreachable: ${r.networkError}` });
      if (r.res.ok) {
        // One id covers the whole batch, so it can't identify a person's
        // delivery; bounces are matched by address instead.
        return messages.map(() => ({ status: "sent", id: null }));
      }
      return all(failure(r, "split"));
    },
  };
}
