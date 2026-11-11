// Swappable email services. Each one sends a single message (standard mode)
// and, if the service has a bulk feature, a batch (bulk mode). Add a service
// by writing one more file with the same shape and a case below.
import { config } from "../config.js";
import { resendSender } from "./resend.js";
import { sesSender } from "./ses.js";
import { mailgunSender } from "./mailgun.js";
import { postmarkSender } from "./postmark.js";
import { cloudflareSender } from "./cloudflare.js";

/**
 * @typedef {object} Message
 * @property {string} to
 * @property {string} subject
 * @property {string} text
 * @property {string} html
 * @property {Record<string, string>} headers
 * @property {string} unsubscribeUrl
 * @property {{ subject: string, text: string, html: string }} [template]  announcements: shared
 *   content with emails.UNSUB where the unsubscribe URL goes (SES/Mailgun bulk substitute it)
 */

/**
 * What happened to one message:
 * - sent:      accepted by the service.
 * - rejected:  refused for this person only (bad address, suppressed). Don't retry.
 * - retry:     failed for this person only, may work later. Counts as an attempt.
 * - throttled: rate limit, quota or a temporary outage; nothing was sent. Try
 *              again later without counting an attempt, and stop this run.
 * - config:    a setup problem (bad key, unverified domain, suspended account);
 *              nothing was sent. Pause the announcement until the owner fixes it.
 * - split:     (bulk only) the whole batch was refused as invalid, probably
 *              because of one bad message; resend these one at a time.
 * - unknown:   the request may or may not have been delivered (timeout).
 * - conflict:  (idempotent services) the key was used for different content;
 *              treated as unknown, never retried automatically.
 * @typedef {{ status: "sent", id: string | null }
 *   | { status: "rejected" | "retry" | "throttled" | "config" | "split" | "unknown" | "conflict", error: string }} SendResult
 */

/**
 * @typedef {object} EmailSender
 * @property {string} name
 * @property {boolean} idempotent   honours idempotencyKey (a retry with the same key can't deliver twice)
 * @property {number} bulkSize      most messages per bulk request; 0 = no bulk feature
 * @property {(message: Message, options?: { idempotencyKey?: string }) => Promise<SendResult>} send
 * @property {(messages: Message[]) => Promise<SendResult[]>} [sendBulk]
 */

/**
 * The configured email service, or null if it isn't set up yet (signups are
 * still stored; their emails go out once it is).
 * @returns {EmailSender | null}
 */
export function getSender(env) {
  const cfg = config(env);
  if (!cfg.mailFrom) return null;
  switch (cfg.provider) {
    case "resend":
      return env.RESEND_API_KEY ? resendSender(env.RESEND_API_KEY, cfg.mailFrom) : null;
    case "ses":
      return env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION
        ? sesSender(
            {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
              region: env.AWS_REGION,
              configurationSet: env.SES_CONFIGURATION_SET || "",
            },
            cfg.mailFrom,
          )
        : null;
    case "mailgun":
      return env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN
        ? mailgunSender({ apiKey: env.MAILGUN_API_KEY, domain: env.MAILGUN_DOMAIN, region: env.MAILGUN_REGION || "us" }, cfg.mailFrom)
        : null;
    case "postmark":
      return env.POSTMARK_SERVER_TOKEN
        ? postmarkSender(
            {
              serverToken: env.POSTMARK_SERVER_TOKEN,
              stream: env.POSTMARK_STREAM || "broadcast",
              ownUnsubscribe: String(env.POSTMARK_UNSUBSCRIBE || "postmark").toLowerCase() === "self",
            },
            cfg.mailFrom,
          )
        : null;
    case "cloudflare":
      return env.EMAIL ? cloudflareSender(env.EMAIL, cfg.mailFrom) : null;
    default:
      console.error(`MAIL_PROVIDER "${cfg.provider}" isn't supported. Use resend, ses, mailgun, postmark or cloudflare.`);
      return null;
  }
}
