/** 32 random bytes, URL-safe. Used in confirm and unsubscribe links. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {unknown} t @returns {t is string} */
export function isToken(t) {
  return typeof t === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(t);
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads a token from the query string or a submitted form. */
export async function tokenFrom(request) {
  const fromQuery = new URL(request.url).searchParams.get("token");
  if (isToken(fromQuery)) return fromQuery;
  try {
    const form = await request.formData();
    const t = String(form.get("token") ?? "");
    return isToken(t) ? t : null;
  } catch {
    return null; // not a form body: no token
  }
}
