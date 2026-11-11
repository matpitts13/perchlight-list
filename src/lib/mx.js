// Can this domain receive email? Asked over DNS-over-HTTPS (Cloudflare's
// resolver). Answers false only when DNS clearly says no: the domain doesn't
// exist, publishes a "null MX" (RFC 7505: it accepts no mail), or has
// neither an MX nor an address. If DNS can't be reached or answers with an
// error, it returns null and the signup goes ahead: a DNS hiccup must never
// turn real people away.
const DOH = "https://cloudflare-dns.com/dns-query";
const TYPE = { A: 1, MX: 15, AAAA: 28 };

async function lookup(name, type) {
  const res = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: "application/dns-json" },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`DNS-over-HTTPS answered ${res.status}`);
  return res.json();
}

/** @returns {Promise<boolean | null>} */
export async function domainAcceptsMail(domain) {
  try {
    const mx = await lookup(domain, "MX");
    if (mx.Status === 3) return false; // NXDOMAIN: no such domain
    if (mx.Status !== 0) return null; // SERVFAIL and the like: don't guess
    const records = (mx.Answer ?? []).filter((a) => a.type === TYPE.MX);
    if (records.length) return !records.every((a) => /^0\s+\.?$/.test(String(a.data).trim()));
    // No MX: mail goes to the domain's own address (RFC 5321, section 5.1).
    for (const type of ["A", "AAAA"]) {
      const r = await lookup(domain, type);
      if (r.Status === 0 && (r.Answer ?? []).some((a) => a.type === TYPE[type])) return true;
    }
    return false;
  } catch (err) {
    console.error(`mx check: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
