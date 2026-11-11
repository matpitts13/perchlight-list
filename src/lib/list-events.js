// Applying bounce, complaint and unsubscribe events from email services.
import { normalizeEmail } from "./validate.js";

/** Which current statuses each event may change. A bounce or an unsubscribe
 *  only matters for addresses we still email, so someone who unsubscribed
 *  stays free to rejoin. A spam complaint is final for everyone but an
 *  earlier complaint. */
const FROM = {
  bounced: ["pending", "confirmed"],
  complained: ["pending", "confirmed", "unsubscribed", "bounced"],
  unsubscribed: ["pending", "confirmed"],
};

/**
 * @param {Array<{ email: unknown, kind: "bounced" | "complained" | "unsubscribed", providerId?: string | null }>} events
 */
export async function applyListEvents(env, events) {
  const stmts = [];
  for (const e of events) {
    const email = normalizeEmail(e.email);
    if (!email || !FROM[e.kind]) continue;
    // A blocked address stays as it is: it's already unsubscribed, and the
    // database keeps it that way.
    stmts.push(
      env.DB.prepare(
        `UPDATE subscribers SET status = ?2, unsubscribed_at = COALESCE(unsubscribed_at, datetime('now'))
         WHERE email = ?1 AND block_reason IS NULL AND status IN (SELECT value FROM json_each(?3))`,
      ).bind(email, e.kind, JSON.stringify(FROM[e.kind])),
    );
    if (e.providerId) {
      stmts.push(env.DB.prepare("UPDATE deliveries SET error = ?2 WHERE provider_id = ?1").bind(String(e.providerId), e.kind));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
