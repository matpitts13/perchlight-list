export const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;

/**
 * Lower-cased, trimmed address, or null if it isn't a plausible email.
 * A trailing dot ("a@b.com.") still delivers; it's dropped so the stored
 * address and the block check see the plain domain.
 * @param {unknown} raw
 */
export function normalizeEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase().replace(/\.+$/, "");
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

/** The part after the last @. */
export function domainOf(email) {
  return email.slice(email.lastIndexOf("@") + 1);
}
