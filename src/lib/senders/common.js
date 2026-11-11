// Pieces shared by the email services.

/** Error text can quote the recipient; keep addresses out of logs and the database. */
export function redactAddresses(text) {
  return String(text).replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+/g, "[address]");
}

/** "My Site <hello@example.com>" -> { name, email }; a bare address -> { email }. */
export function parseFrom(from) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!m) return { email: from.trim() };
  const name = m[1].replace(/^"|"$/g, "");
  return name ? { name, email: m[2].trim() } : { email: m[2].trim() };
}

/** Long enough for a 1,000-recipient bulk request; short enough that a run
 *  (45 s budget) always finishes well before rows count as abandoned (2 min). */
export const REQUEST_TIMEOUT_MS = 30000;

/**
 * fetch with a timeout. Returns { res, text } or { networkError } when the
 * request may or may not have reached the service (timeout, dropped connection).
 */
export async function request(url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { res, text: await res.text() };
  } catch (err) {
    return { networkError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The usual meaning of an HTTP failure, before service-specific details:
 * 429 = throttled (refused before processing), 401/403 = config, any 5xx =
 * unknown (a gateway error can come after the service processed the request,
 * so it's never treated as "nothing was sent"), other 4xx = null (the caller
 * decides whether it's one bad message or a setup problem).
 * @returns {"throttled" | "config" | "unknown" | null}
 */
export function classifyHttp(status) {
  if (status === 429) return "throttled";
  if (status === 401 || status === 403) return "config";
  if (status >= 500) return "unknown";
  return null;
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null; // not JSON: callers fall back to the raw text
  }
}

/** A short, address-free error string from a service's reply. */
export function describe(service, status, text) {
  return `${service} ${status}: ${redactAddresses(String(text).slice(0, 300))}`;
}
