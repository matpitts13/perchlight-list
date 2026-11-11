// Cloudflare Turnstile, the bot check on the signup form. Off until the
// TURNSTILE_SECRET_KEY secret is set. Turn it on in one go: add the widget
// to your form (so it sends cf-turnstile-response) and set the secret. A
// secret without the widget refuses every signup.
const VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function passesTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token || token.length > 2048) return false;
  try {
    const body = new FormData();
    body.set("secret", env.TURNSTILE_SECRET_KEY);
    body.set("response", token);
    if (ip) body.set("remoteip", ip);
    const res = await fetch(VERIFY, { method: "POST", body, signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (!data.success) console.error(`turnstile: refused (${(data["error-codes"] ?? []).join(", ")})`);
    return data.success === true;
  } catch (err) {
    // The checker is unreachable: let people through rather than closing
    // the list. The rate limit and blocklists still apply.
    console.error(`turnstile: unreachable: ${err instanceof Error ? err.message : String(err)}`);
    return true;
  }
}
