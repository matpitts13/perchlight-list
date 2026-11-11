// Verifying Amazon SNS message signatures with WebCrypto.
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
//
// SignatureVersion 1 = RSA SHA-1, 2 = RSA SHA-256 (recommended; set the
// topic's SignatureVersion attribute to 2). WebCrypto can't read X.509
// certificates, so the public key is pulled out of the certificate's DER
// directly. Full chain validation isn't possible here; instead the
// certificate must come over HTTPS from sns.<region>.amazonaws.com, and the
// caller checks the TopicArn against the configured one.

const certCache = new Map(); // SigningCertURL -> CryptoKey promise, per hash

/** True for https://sns.<region>.amazonaws.com(.cn)/... URLs. */
export function isSnsHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
  } catch {
    return false; // not a URL
  }
}

/** The string SNS signs: "Key\nValue\n" for the fields of this message type, in order. */
export function stringToSign(msg) {
  const fields =
    msg.Type === "Notification"
      ? ["Message", "MessageId", ...(msg.Subject !== undefined && msg.Subject !== null ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return fields.map((f) => `${f}\n${msg[f] ?? ""}\n`).join("");
}

/** @param {Record<string, any>} msg  the parsed SNS POST body */
export async function verifySnsMessage(msg, { fetchCert = fetchCertificate } = {}) {
  const version = String(msg.SignatureVersion ?? "");
  const hash = version === "2" ? "SHA-256" : version === "1" ? "SHA-1" : null;
  if (!hash || !msg.Signature || !msg.SigningCertURL) return false;
  const u = safeUrl(msg.SigningCertURL);
  if (!u || !isSnsHost(u.href) || !/^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(u.pathname)) return false;

  try {
    const pem = await fetchCert(u.href);
    const key = await importCertificateKey(pem, hash);
    const signature = Uint8Array.from(atob(msg.Signature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(stringToSign(msg)));
  } catch (err) {
    console.error(`sns: couldn't verify signature: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function fetchCertificate(url) {
  if (!certCache.has(url)) {
    certCache.set(
      url,
      fetch(url, { signal: AbortSignal.timeout(5000) }).then(async (res) => {
        if (!res.ok) throw new Error(`certificate fetch answered ${res.status}`);
        return res.text();
      }).catch((err) => {
        certCache.delete(url);
        throw err;
      }),
    );
  }
  return certCache.get(url);
}

function safeUrl(s) {
  try {
    return new URL(s);
  } catch {
    return null; // not a URL
  }
}

/** Imports the RSA public key from a PEM X.509 certificate. */
export async function importCertificateKey(pem, hash) {
  const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const spki = extractSpki(der);
  return crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
}

/**
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 * TBSCertificate ::= SEQUENCE { [0] version OPTIONAL, serialNumber, signature,
 *                               issuer, validity, subject, subjectPublicKeyInfo, ... }
 * Returns the subjectPublicKeyInfo element's bytes (tag + length + content).
 */
export function extractSpki(der) {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error("certificate isn't a SEQUENCE");
  const tbs = readTlv(der, cert.contentStart);
  if (tbs.tag !== 0x30) throw new Error("tbsCertificate isn't a SEQUENCE");
  let pos = tbs.contentStart;
  let el = readTlv(der, pos);
  if (el.tag === 0xa0) {
    pos = el.end; // explicit version
    el = readTlv(der, pos);
  }
  // serialNumber, signature, issuer, validity, subject
  for (let i = 0; i < 5; i++) {
    pos = el.end;
    el = readTlv(der, pos);
  }
  if (el.tag !== 0x30) throw new Error("subjectPublicKeyInfo isn't a SEQUENCE");
  return der.slice(el.start, el.end);
}

/** Reads one DER element at offset. */
function readTlv(buf, offset) {
  if (offset + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[offset];
  let len = buf[offset + 1];
  let headerLen = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || offset + 2 + n > buf.length) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i];
    headerLen = 2 + n;
  }
  const contentStart = offset + headerLen;
  const end = contentStart + len;
  if (end > buf.length) throw new Error("truncated DER element");
  return { tag, start: offset, contentStart, end };
}
