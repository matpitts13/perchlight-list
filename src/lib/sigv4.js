// AWS Signature Version 4, with WebCrypto only.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html

const enc = new TextEncoder();

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data);
  return hex(new Uint8Array(buf));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", typeof key === "string" ? enc.encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** RFC 3986 encoding, as SigV4 requires (paths are encoded segment by segment). */
function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Signs a request. Returns the headers to send (including Authorization,
 * X-Amz-Date and Host-independent extras); fetch sets Host itself.
 * @param {{ method: string, url: string, headers?: Record<string, string>, body?: string,
 *           accessKeyId: string, secretAccessKey: string, region: string, service: string,
 *           date?: Date, sessionToken?: string }} req
 */
export async function signRequest(req) {
  const url = new URL(req.url);
  const amzDate = (req.date ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const body = req.body ?? "";

  const headers = { ...(req.headers ?? {}), host: url.host, "x-amz-date": amzDate };
  if (req.sessionToken) headers["x-amz-security-token"] = req.sessionToken;
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, " ")]));
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(";");

  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const path = url.pathname.split("/").map((seg) => uriEncode(decodeURIComponent(seg))).join("/") || "/";

  const canonical = [
    req.method.toUpperCase(),
    path,
    query,
    names.map((n) => `${n}:${lower[n]}\n`).join(""),
    signedHeaders,
    await sha256Hex(body),
  ].join("\n");

  const scope = `${day}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");

  let key = await hmac(`AWS4${req.secretAccessKey}`, day);
  key = await hmac(key, req.region);
  key = await hmac(key, req.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  const out = { ...(req.headers ?? {}), "X-Amz-Date": amzDate };
  if (req.sessionToken) out["X-Amz-Security-Token"] = req.sessionToken;
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, signature, canonical, stringToSign };
}
