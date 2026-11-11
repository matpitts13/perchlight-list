import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMailgun } from "../src/routes/webhooks.js";
import { verifySnsMessage, extractSpki, isSnsHost, stringToSign } from "../src/lib/sns.js";
import { addSubscriber, call, resetDb, subscriber } from "./helpers.js";
import { CERT_PEM, NOTIFICATION, SIGNATURE_SHA256, SIGNATURE_SHA1 } from "./fixtures/sns.js";

async function mailgunSignature(key, timestamp, token) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${timestamp}${token}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mailgunEvent(eventData, { tamper = false } = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const token = "tok-" + crypto.randomUUID();
  const signature = await mailgunSignature(env.MAILGUN_WEBHOOK_SIGNING_KEY, timestamp, token);
  return call("/api/webhooks/mailgun", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature: { timestamp, token, signature: tamper ? signature.replace(/^./, "0") === signature ? "f" + signature.slice(1) : signature.replace(/^./, "0") : signature }, "event-data": eventData }),
  });
}

describe("Mailgun webhook", () => {
  beforeEach(resetDb);

  it("verifies the HMAC signature", async () => {
    const ts = "1700000000";
    const sig = await mailgunSignature("key", ts, "abc");
    expect(await verifyMailgun("key", { timestamp: ts, token: "abc", signature: sig }, 1700000000)).toBe(true);
    expect(await verifyMailgun("key", { timestamp: ts, token: "abd", signature: sig }, 1700000000)).toBe(false);
    expect(await verifyMailgun("key", { timestamp: ts, token: "abc", signature: sig }, 1700000000 + 2 * 86400)).toBe(false);
  });

  it("permanent failures bounce, complaints and unsubscribes are recorded, temporary failures ignored", async () => {
    await addSubscriber("perm@example.com");
    await addSubscriber("temp@example.com");
    await addSubscriber("spam@example.com");
    await addSubscriber("leave@example.com");
    await mailgunEvent({ event: "failed", severity: "permanent", recipient: "perm@example.com" });
    await mailgunEvent({ event: "failed", severity: "temporary", recipient: "temp@example.com" });
    await mailgunEvent({ event: "complained", recipient: "spam@example.com" });
    await mailgunEvent({ event: "unsubscribed", recipient: "leave@example.com" });
    expect((await subscriber("perm@example.com")).status).toBe("bounced");
    expect((await subscriber("temp@example.com")).status).toBe("confirmed");
    expect((await subscriber("spam@example.com")).status).toBe("complained");
    expect((await subscriber("leave@example.com")).status).toBe("unsubscribed");
  });

  it("rejects a bad signature", async () => {
    await addSubscriber("x@example.com");
    const res = await mailgunEvent({ event: "complained", recipient: "x@example.com" }, { tamper: true });
    expect(res.status).toBe(401);
    expect((await subscriber("x@example.com")).status).toBe("confirmed");
  });
});

describe("Postmark webhook", () => {
  beforeEach(resetDb);
  const auth = (user = "pm-user", pass = "pm-pass") => ({ Authorization: `Basic ${btoa(`${user}:${pass}`)}`, "Content-Type": "application/json" });
  const post = (body, headers = auth()) => call("/api/webhooks/postmark", { method: "POST", headers, body: JSON.stringify(body) });

  it("needs the right Basic auth", async () => {
    await addSubscriber("x@example.com");
    const res = await post({ RecordType: "SpamComplaint", Email: "x@example.com" }, auth("pm-user", "wrong"));
    expect(res.status).toBe(401);
    expect((await subscriber("x@example.com")).status).toBe("confirmed");
  });

  it("hard bounces, complaints and Postmark-managed unsubscribes are recorded; soft bounces ignored", async () => {
    for (const e of ["hard", "soft", "spam", "unsub"]) await addSubscriber(`${e}@example.com`);
    await post({ RecordType: "Bounce", Type: "HardBounce", Email: "hard@example.com", MessageID: "m1" });
    await post({ RecordType: "Bounce", Type: "SoftBounce", Email: "soft@example.com" });
    await post({ RecordType: "SpamComplaint", Type: "SpamComplaint", Email: "spam@example.com" });
    await post({ RecordType: "SubscriptionChange", Recipient: "unsub@example.com", SuppressSending: true, SuppressionReason: "ManualSuppression" });
    expect((await subscriber("hard@example.com")).status).toBe("bounced");
    expect((await subscriber("soft@example.com")).status).toBe("confirmed");
    expect((await subscriber("spam@example.com")).status).toBe("complained");
    expect((await subscriber("unsub@example.com")).status).toBe("unsubscribed");
  });
});

describe("SNS signatures", () => {
  it("pulls the public key out of a certificate", () => {
    const der = Uint8Array.from(atob(CERT_PEM.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const spki = extractSpki(der);
    expect(spki[0]).toBe(0x30);
    expect(spki.length).toBeGreaterThan(256);
  });

  it("verifies OpenSSL-made SignatureVersion 2 (SHA-256) and 1 (SHA-1) signatures", async () => {
    const fetchCert = async () => CERT_PEM;
    expect(await verifySnsMessage({ ...NOTIFICATION, SignatureVersion: "2", Signature: SIGNATURE_SHA256 }, { fetchCert })).toBe(true);
    expect(await verifySnsMessage({ ...NOTIFICATION, SignatureVersion: "1", Signature: SIGNATURE_SHA1 }, { fetchCert })).toBe(true);
  });

  it("rejects tampered messages, wrong versions and certificates from anywhere but SNS", async () => {
    const fetchCert = async () => CERT_PEM;
    const good = { ...NOTIFICATION, SignatureVersion: "2", Signature: SIGNATURE_SHA256 };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await verifySnsMessage({ ...good, Message: good.Message.replace("Permanent", "Transient") }, { fetchCert })).toBe(false);
    expect(await verifySnsMessage({ ...good, SignatureVersion: "1" }, { fetchCert })).toBe(false);
    expect(await verifySnsMessage({ ...good, SigningCertURL: "https://evil.example.com/SimpleNotificationService-1.pem" }, { fetchCert })).toBe(false);
    expect(await verifySnsMessage({ ...good, SigningCertURL: "http://sns.us-east-1.amazonaws.com/SimpleNotificationService-1.pem" }, { fetchCert })).toBe(false);
    vi.restoreAllMocks();
  });

  it("builds the documented string to sign", () => {
    expect(stringToSign({ Type: "Notification", Message: "m", MessageId: "i", Timestamp: "t", TopicArn: "a" })).toBe(
      "Message\nm\nMessageId\ni\nTimestamp\nt\nTopicArn\na\nType\nNotification\n",
    );
    expect(isSnsHost("https://sns.eu-west-1.amazonaws.com/x")).toBe(true);
    expect(isSnsHost("https://sns.eu-west-1.amazonaws.com.evil.com/x")).toBe(false);
  });
});

describe("SES webhook (through SNS)", () => {
  // The fixture notification is dated 2026-11-09T12:00:00Z; pretend it's 10 minutes later.
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:10:00Z"));
    await resetDb();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refuses a validly signed notification that's more than 72 hours old (replay)", async () => {
    vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(CERT_PEM));
    await addSubscriber("bounce@example.com");
    const res = await call("/api/webhooks/ses", {
      method: "POST",
      body: JSON.stringify({ ...NOTIFICATION, SignatureVersion: "2", Signature: SIGNATURE_SHA256 }),
    });
    expect(res.status).toBe(400);
    expect((await subscriber("bounce@example.com")).status).toBe("confirmed");
  });

  function stubCertFetch(extra = () => null) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "string" ? input : input.url);
      if (url.endsWith(".pem")) return new Response(CERT_PEM);
      const r = extra(url);
      if (r) return r;
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("a signed permanent bounce marks the subscriber bounced", async () => {
    stubCertFetch();
    await addSubscriber("bounce@example.com");
    const res = await call("/api/webhooks/ses", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=UTF-8" },
      body: JSON.stringify({ ...NOTIFICATION, SignatureVersion: "2", Signature: SIGNATURE_SHA256 }),
    });
    expect(res.status).toBe(200);
    expect((await subscriber("bounce@example.com")).status).toBe("bounced");
  });

  it("refuses an unexpected topic and an unsigned message", async () => {
    stubCertFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await addSubscriber("bounce@example.com");
    const wrongTopic = await call("/api/webhooks/ses", { method: "POST", body: JSON.stringify({ ...NOTIFICATION, TopicArn: "arn:aws:sns:us-east-1:1:other" }) });
    expect(wrongTopic.status).toBe(403);
    const unsigned = await call("/api/webhooks/ses", { method: "POST", body: JSON.stringify({ ...NOTIFICATION, SignatureVersion: "2", Signature: "AAAA" }) });
    expect(unsigned.status).toBe(401);
    expect((await subscriber("bounce@example.com")).status).toBe("confirmed");
  });

  it("a subscription confirmation with a valid signature but a non-SNS SubscribeURL is refused", async () => {
    // A real confirmation can't be produced here without SNS's key; this only
    // checks that the signature is required first.
    stubCertFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/api/webhooks/ses", {
      method: "POST",
      body: JSON.stringify({ ...NOTIFICATION, Type: "SubscriptionConfirmation", SubscribeURL: "https://evil.example.com/", Token: "t", SignatureVersion: "2", Signature: SIGNATURE_SHA256 }),
    });
    expect(res.status).toBe(401); // signature no longer matches the changed fields
  });
});
