// The emails this list sends: the confirmation email and announcements.
//
// Announcements are built once per announcement as a template with a
// placeholder where each person's unsubscribe link goes (UNSUB). Services
// that send one message per person get it filled in here (fillTemplate);
// bulk services that substitute per recipient (SES, Mailgun) swap the
// placeholder for their own variable syntax.
import { escapeHtml } from "./http.js";

/** @typedef {import("./config.js").ListConfig} ListConfig */
/** @typedef {import("./senders/index.js").Message} Message */

/** Placeholder for the per-person unsubscribe URL. Can't occur in normal text. */
export const UNSUB = "\u0000PERCHLIGHT_UNSUBSCRIBE_URL\u0000";

export function confirmUrl(cfg, token) {
  return `${cfg.siteUrl}/api/confirm?token=${token}`;
}

export function unsubscribeUrl(cfg, token) {
  return `${cfg.siteUrl}/api/unsubscribe?token=${token}`;
}

/** List-Unsubscribe headers (RFC 2369) with one-click support (RFC 8058). */
export function unsubscribeHeaders(cfg, url) {
  const targets = [`<${url}>`];
  if (cfg.unsubscribeMailto) targets.push(`<mailto:${cfg.unsubscribeMailto}?subject=unsubscribe>`);
  return {
    "List-Unsubscribe": targets.join(", "),
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

const WRAP_OPEN =
  '<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">' +
  '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e7e5e4;border-radius:12px;padding:32px">';
const WRAP_CLOSE = "</div></body></html>";
const P = 'style="font-size:15px;line-height:1.6;margin:0 0 16px"';
const SMALL = 'style="font-size:12px;line-height:1.6;color:#78716c;margin:16px 0 0"';

/** @param {ListConfig} cfg @returns {Message} */
export function confirmationEmail(cfg, to, token) {
  const url = confirmUrl(cfg, token);
  const unsub = unsubscribeUrl(cfg, token);
  const text = [
    `Thanks for joining ${cfg.listName}.`,
    "",
    "Please confirm your address:",
    url,
    "",
    "If you didn't sign up, ignore this email and you won't hear from us again.",
    "",
    cfg.siteUrl,
  ].join("\n");
  const html =
    WRAP_OPEN +
    '<h1 style="font-size:22px;margin:0 0 16px">Confirm your address</h1>' +
    `<p ${P}>Thanks for joining ${escapeHtml(cfg.listName)}. Please confirm your address.</p>` +
    `<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c1917;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px">Confirm my address</a></p>` +
    `<p ${SMALL}>If you didn't sign up, ignore this email and you won't hear from us again.</p>` +
    WRAP_CLOSE;
  return {
    to,
    subject: `Confirm your signup to ${cfg.listName}`,
    text,
    html,
    headers: unsubscribeHeaders(cfg, unsub),
    unsubscribeUrl: unsub,
  };
}

/**
 * An announcement as a template, with UNSUB where the unsubscribe link goes,
 * and the footer every marketing email must carry: the sender's postal
 * address and a working unsubscribe link.
 * @param {ListConfig} cfg
 * @param {{ subject: string, body_text: string, body_html: string | null }} announcement
 * @returns {{ subject: string, text: string, html: string }}
 */
export function announcementTemplate(cfg, announcement) {
  const text = [
    announcement.body_text.trim(),
    "",
    "--",
    `You're getting this because you joined ${cfg.listName}.`,
    `Unsubscribe: ${UNSUB}`,
    cfg.postalAddress,
  ].join("\n");

  // body_html comes from the list's owner (the admin app), not from visitors,
  // so it is used as written. Without it, the text becomes simple paragraphs.
  const body = announcement.body_html?.trim()
    ? announcement.body_html
    : announcement.body_text
        .trim()
        .split(/\n{2,}/)
        .map((para) => `<p ${P}>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
        .join("");
  const html =
    WRAP_OPEN +
    body +
    `<p ${SMALL}>You're getting this because you joined ${escapeHtml(cfg.listName)}. ` +
    `<a href="${UNSUB}" style="color:#78716c">Unsubscribe</a><br>${escapeHtml(cfg.postalAddress)}</p>` +
    WRAP_CLOSE;

  return { subject: announcement.subject, text, html };
}

/** Fills the template for one person. */
export function fillTemplate(template, url) {
  return {
    subject: template.subject,
    text: template.text.split(UNSUB).join(url),
    html: template.html.split(UNSUB).join(escapeHtml(url)),
  };
}

/**
 * One person's announcement email: filled in, plus the template and their
 * unsubscribe URL for bulk services that substitute per recipient.
 * @param {ListConfig} cfg
 * @param {{ subject: string, text: string, html: string }} template  from announcementTemplate
 * @param {{ email: string, token: string }} subscriber
 * @returns {Message}
 */
export function announcementEmail(cfg, template, subscriber) {
  const url = unsubscribeUrl(cfg, subscriber.token);
  return {
    to: subscriber.email,
    ...fillTemplate(template, url),
    headers: unsubscribeHeaders(cfg, url),
    unsubscribeUrl: url,
    template,
  };
}
