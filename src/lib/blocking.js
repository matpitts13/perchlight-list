// Which addresses may never join the list. Hand-blocked domains (D1
// blocked_domains) come first, then the bundled community list of
// disposable "burner" domains, which allowed_domains can override for the
// odd false positive.
import { DISPOSABLE_DOMAINS } from "../data/disposable-domains.js";
import { domainOf } from "./validate.js";

export const BURNER_REASON = "BURNER-EMAIL";

/** a.b.example.com -> [a.b.example.com, b.example.com, example.com]: a
 *  subdomain of a blocked domain is blocked too. At most 10 levels, which
 *  also keeps the D1 query under its bound-parameter limit. */
export function domainAndParents(domain) {
  // "mailinator.com." is the same domain to mail servers; don't let the dot dodge the list.
  const parts = domain.toLowerCase().replace(/\.+$/, "").split(".");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out.slice(-10);
}

/** The block reason for this address (e.g. BURNER-EMAIL), or null if it may join. */
export async function blockReasonFor(env, email) {
  const domains = domainAndParents(domainOf(email));
  if (!domains.length) return null;
  const marks = domains.map((_, i) => `?${i + 1}`).join(", ");

  const custom = await env.DB.prepare(
    `SELECT reason FROM blocked_domains WHERE domain IN (${marks}) ORDER BY length(domain) DESC LIMIT 1`,
  ).bind(...domains).first();
  if (custom) return custom.reason;

  if (!domains.some((d) => DISPOSABLE_DOMAINS.has(d))) return null;
  const allowed = await env.DB.prepare(
    `SELECT 1 AS ok FROM allowed_domains WHERE domain IN (${marks}) LIMIT 1`,
  ).bind(...domains).first();
  return allowed ? null : BURNER_REASON;
}
