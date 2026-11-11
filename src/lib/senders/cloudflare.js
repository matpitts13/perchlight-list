// Cloudflare Email Service, through a send_email binding named EMAIL.
// Still in beta, and sending to any address needs a paid Workers plan.
// Standard mode only (no bulk feature), and no idempotency keys.
// Custom headers (List-Unsubscribe) are passed along; check Cloudflare's docs
// for whether your account's version of the service supports them.
import { parseFrom, redactAddresses } from "./common.js";

export { parseFrom };

/** @returns {import("./index.js").EmailSender} */
export function cloudflareSender(binding, from) {
  const sender = parseFrom(from);
  return {
    name: "cloudflare",
    idempotent: false,
    bulkSize: 0,
    async send(m) {
      try {
        const r = await binding.send({ to: m.to, from: sender, subject: m.subject, text: m.text, html: m.html, headers: m.headers });
        return { status: "sent", id: r?.messageId ?? null };
      } catch (err) {
        // An error carrying a code is the service refusing the message: safe
        // to retry. Anything else (a dropped call) may have been sent: unknown.
        const hasCode = err && typeof err === "object" && "code" in err && err.code;
        const msg = redactAddresses(err instanceof Error ? err.message : String(err));
        const error = `Cloudflare Email: ${hasCode ? `${err.code} ` : ""}${msg}`;
        return { status: hasCode ? "retry" : "unknown", error };
      }
    },
  };
}
