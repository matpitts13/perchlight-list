// Settings from wrangler.jsonc "vars", read in one place with defaults.
// Secrets (API keys etc.) are read by the code that uses them.

/**
 * @typedef {object} ListConfig
 * @property {string} listName
 * @property {string} siteUrl              no trailing slash
 * @property {string} mailFrom             e.g. "My Site <hello@example.com>"
 * @property {string} provider             resend | ses | mailgun | postmark | cloudflare
 * @property {"standard" | "bulk"} sendMode
 * @property {string} postalAddress        required for announcements (CAN-SPAM)
 * @property {string} unsubscribeMailto    optional address for mailto: unsubscribes
 * @property {number} dailyLimit           emails per UTC day, all kinds; Infinity = no limit
 * @property {number} emailsPerRun         announcement emails per scheduled run (runs are every minute)
 * @property {number} maxParallel          requests in flight at once (1-6)
 * @property {number} requestsPerSecond    pacing, to stay under the email service's rate limit
 */

/** @param {Record<string, unknown>} env @returns {ListConfig} */
export function config(env) {
  const daily = int(env.DAILY_SEND_LIMIT, 100, 0);
  return {
    listName: str(env.LIST_NAME) || "our mailing list",
    siteUrl: str(env.SITE_URL).replace(/\/+$/, ""),
    mailFrom: str(env.MAIL_FROM),
    provider: (str(env.MAIL_PROVIDER) || "resend").toLowerCase(),
    sendMode: str(env.SEND_MODE).toLowerCase() === "bulk" ? "bulk" : "standard",
    postalAddress: str(env.MAIL_POSTAL_ADDRESS),
    unsubscribeMailto: str(env.UNSUBSCRIBE_MAILTO),
    dailyLimit: daily === 0 ? Infinity : daily,
    emailsPerRun: int(env.EMAILS_PER_RUN, 20, 1),
    maxParallel: Math.min(int(env.MAX_PARALLEL, 4, 1), 6),
    requestsPerSecond: int(env.REQUESTS_PER_SECOND, 2, 1),
  };
}

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

/** A whole number >= min from a setting, or the fallback if it isn't one. */
function int(v, fallback, min) {
  const s = str(v);
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return n >= min ? n : fallback;
}
