// Checks a webhook signed in the Standard Webhooks / Svix format, which
// Resend uses: headers svix-id, svix-timestamp and svix-signature
// ("v1,<base64 HMAC-SHA256>", space-separated if there are several), signed
// over "<id>.<timestamp>.<raw body>" with the base64 secret after "whsec_".

const TOLERANCE_SECONDS = 5 * 60;

/**
 * @param {string} secret   e.g. "whsec_..."
 * @param {Headers} headers
 * @param {string} body     the raw request body, exactly as received
 * @param {number} [nowSeconds]
 */
export async function verifyWebhookSignature(secret, headers, body, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !signatures) return false;

  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;

  let keyBytes;
  try {
    keyBytes = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    console.error("webhook: RESEND_WEBHOOK_SECRET isn't valid base64");
    return false;
  }
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  const expected = new TextEncoder().encode(bytesToBase64(new Uint8Array(mac)));

  return signatures.split(" ").some((part) => {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) return false;
    const given = new TextEncoder().encode(sig);
    return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
  });
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
