import { afterEach, describe, expect, it, vi } from "vitest";
import { getSender } from "../src/lib/senders/index.js";
import { resendSender } from "../src/lib/senders/resend.js";
import { sesSender, escapeTemplate } from "../src/lib/senders/ses.js";
import { mailgunSender } from "../src/lib/senders/mailgun.js";
import { postmarkSender } from "../src/lib/senders/postmark.js";
import { cloudflareSender } from "../src/lib/senders/cloudflare.js";
import { parseFrom, redactAddresses, classifyHttp } from "../src/lib/senders/common.js";
import { announcementTemplate, announcementEmail, confirmationEmail } from "../src/lib/emails.js";
import { config } from "../src/lib/config.js";

const cfg = config({
  LIST_NAME: "Test",
  SITE_URL: "https://list.test",
  MAIL_FROM: "Site <s@list.test>",
  MAIL_POSTAL_ADDRESS: "1 Test St",
});
const template = announcementTemplate(cfg, { subject: "News {{x}}", body_text: "Hello {{name}}", body_html: null });
const email = (to, token = "t".repeat(43)) => announcementEmail(cfg, template, { email: to, token });

/** Stubs fetch with one reply (or a function of the request) and records requests. */
function stubFetch(reply) {
  const requests = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const req = { url: String(input), init, headers: new Headers(init.headers) };
    requests.push(req);
    return typeof reply === "function" ? reply(req) : reply.clone();
  });
  return requests;
}

afterEach(() => vi.restoreAllMocks());

describe("common", () => {
  it("redacts addresses, parses From, classifies HTTP failures", () => {
    expect(redactAddresses('bad "a@b.co" and <x.y@z.co>')).toBe('bad "[address]" and <[address]>');
    expect(parseFrom('"Quoted" <hi@example.com>')).toEqual({ name: "Quoted", email: "hi@example.com" });
    expect(parseFrom("hi@example.com")).toEqual({ email: "hi@example.com" });
    expect([429, 503, 502, 401, 500, 422].map(classifyHttp)).toEqual(["throttled", "unknown", "unknown", "config", "unknown", null]);
  });
});

describe("getSender", () => {
  it("returns the configured service only when its settings are complete", () => {
    const base = { MAIL_FROM: "a@b.co" };
    expect(getSender({ ...base, RESEND_API_KEY: "k" })?.name).toBe("resend");
    expect(getSender({ ...base, MAIL_PROVIDER: "ses", AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "s", AWS_REGION: "us-east-1" })?.name).toBe("ses");
    expect(getSender({ ...base, MAIL_PROVIDER: "ses", AWS_ACCESS_KEY_ID: "a" })).toBeNull();
    expect(getSender({ ...base, MAIL_PROVIDER: "mailgun", MAILGUN_API_KEY: "k", MAILGUN_DOMAIN: "mg.b.co" })?.name).toBe("mailgun");
    expect(getSender({ ...base, MAIL_PROVIDER: "postmark", POSTMARK_SERVER_TOKEN: "t" })?.name).toBe("postmark");
    expect(getSender({ ...base, MAIL_PROVIDER: "cloudflare", EMAIL: { send() {} } })?.name).toBe("cloudflare");
    expect(getSender({ RESEND_API_KEY: "k" })).toBeNull(); // no MAIL_FROM
  });
});

describe("resend", () => {
  it("standard: sends the idempotency key; 409 concurrent = unknown, 409 different payload = conflict", async () => {
    const requests = stubFetch(Response.json({ id: "e1" }));
    const s = resendSender("k", "s@x.co");
    expect(await s.send(email("a@x.co"), { idempotencyKey: "key-1" })).toEqual({ status: "sent", id: "e1" });
    expect(requests[0].headers.get("Idempotency-Key")).toBe("key-1");
    vi.restoreAllMocks();

    stubFetch(Response.json({ name: "concurrent_idempotent_requests" }, { status: 409 }));
    expect((await s.send(email("a@x.co"))).status).toBe("unknown");
    vi.restoreAllMocks();
    stubFetch(Response.json({ name: "invalid_idempotent_request" }, { status: 409 }));
    expect((await s.send(email("a@x.co"))).status).toBe("conflict");
  });

  it("standard: one bad address is rejected; a bad key is a setup problem; quota is throttling", async () => {
    const s = resendSender("k", "s@x.co");
    stubFetch(Response.json({ name: "validation_error", message: "Invalid to: a@x.co" }, { status: 422 }));
    expect(await s.send(email("a@x.co"))).toMatchObject({ status: "rejected" });
    vi.restoreAllMocks();
    stubFetch(Response.json({ name: "invalid_from_address" }, { status: 422 }));
    expect((await s.send(email("a@x.co"))).status).toBe("config");
    vi.restoreAllMocks();
    stubFetch(Response.json({ name: "daily_quota_exceeded" }, { status: 429 }));
    expect((await s.send(email("a@x.co"))).status).toBe("throttled");
  });

  it("bulk: permissive batch, ids mapped around refused entries; whole-batch 422 = split", async () => {
    const requests = stubFetch(Response.json({ data: [{ id: "one" }, { id: "three" }], errors: [{ index: 1, message: "Invalid to: b@x.co" }] }));
    const s = resendSender("k", "s@x.co");
    const results = await s.sendBulk([email("a@x.co"), email("b@x.co"), email("c@x.co")]);
    expect(requests[0].headers.get("x-batch-validation")).toBe("permissive");
    expect(results).toEqual([
      { status: "sent", id: "one" },
      { status: "rejected", error: "Resend: Invalid to: [address]" },
      { status: "sent", id: "three" },
    ]);
    vi.restoreAllMocks();
    stubFetch(Response.json({ name: "validation_error" }, { status: 422 }));
    expect((await s.sendBulk([email("a@x.co")]))[0].status).toBe("split");
  });

  it("a timeout is unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    expect((await resendSender("k", "s@x.co").send(email("a@x.co"))).status).toBe("unknown");
  });
});

describe("ses", () => {
  const s = () => sesSender({ accessKeyId: "AKID", secretAccessKey: "SECRET", region: "eu-west-1", configurationSet: "events" }, "Site <s@x.co>");

  it("standard: signed SendEmail with the List-Unsubscribe headers", async () => {
    const requests = stubFetch(Response.json({ MessageId: "ses-1" }));
    expect(await s().send(email("a@x.co"))).toEqual({ status: "sent", id: "ses-1" });
    const r = requests[0];
    expect(r.url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(r.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/eu-west-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    const body = JSON.parse(r.init.body);
    expect(body.ConfigurationSetName).toBe("events");
    expect(body.Content.Simple.Headers.map((h) => h.Name)).toEqual(["List-Unsubscribe", "List-Unsubscribe-Post"]);
  });

  it("bulk: inline template with per-person substitution and ReplacementHeaders; '{{' in content is escaped", async () => {
    const requests = stubFetch(Response.json({ BulkEmailEntryResults: [{ Status: "SUCCESS", MessageId: "m1" }, { Status: "MESSAGE_REJECTED", Error: "bad" }, { Status: "TRANSIENT_FAILURE" }] }));
    const results = await s().sendBulk([email("a@x.co", "a".repeat(43)), email("b@x.co"), email("c@x.co")]);
    expect(results.map((r) => r.status)).toEqual(["sent", "rejected", "retry"]);
    const body = JSON.parse(requests[0].init.body);
    const t = body.DefaultContent.Template.TemplateContent;
    expect(t.Subject).toBe("News {{perchlight_lb}}x}}");
    expect(t.Text).toContain("Unsubscribe: {{perchlight_unsubscribe_url}}");
    expect(t.Html).toContain('href="{{perchlight_unsubscribe_url}}"');
    expect(t.Text).not.toContain("\u0000");
    const entry = body.BulkEmailEntries[0];
    expect(entry.Destination.ToAddresses).toEqual(["a@x.co"]);
    expect(JSON.parse(entry.ReplacementEmailContent.ReplacementTemplate.ReplacementTemplateData)).toEqual({
      perchlight_lb: "{{",
      perchlight_unsubscribe_url: `https://list.test/api/unsubscribe?token=${"a".repeat(43)}`,
    });
    expect(entry.ReplacementHeaders.find((h) => h.Name === "List-Unsubscribe").Value).toContain("a".repeat(43));
  });

  it("maps SES errors: throttling, setup problems, unverified domain in bulk results", async () => {
    stubFetch(Response.json({ message: "slow" }, { status: 400, headers: { "x-amzn-ErrorType": "TooManyRequestsException:http://internal" } }));
    expect((await s().send(email("a@x.co"))).status).toBe("throttled");
    vi.restoreAllMocks();
    stubFetch(Response.json({ __type: "AccountSuspendedException", message: "suspended" }, { status: 400 }));
    expect((await s().send(email("a@x.co"))).status).toBe("config");
    vi.restoreAllMocks();
    stubFetch(Response.json({ BulkEmailEntryResults: [{ Status: "MAIL_FROM_DOMAIN_NOT_VERIFIED" }] }));
    expect((await s().sendBulk([email("a@x.co")]))[0].status).toBe("config");
  });

  it("escapeTemplate leaves text without braces alone", () => {
    expect(escapeTemplate("plain } text")).toBe("plain } text");
  });
});

describe("mailgun", () => {
  it("standard: one recipient, h: headers, Basic auth, EU host", async () => {
    const requests = stubFetch(Response.json({ id: "<mg1>", message: "Queued" }));
    const s = mailgunSender({ apiKey: "key-1", domain: "mg.x.co", region: "eu" }, "Site <s@x.co>");
    expect(await s.send(email("a@x.co"))).toEqual({ status: "sent", id: "mg1" }); // brackets stripped, as webhooks report it
    const r = requests[0];
    expect(r.url).toBe("https://api.eu.mailgun.net/v3/mg.x.co/messages");
    expect(r.headers.get("Authorization")).toBe(`Basic ${btoa("api:key-1")}`);
    expect(r.init.body.get("to")).toBe("a@x.co");
    expect(r.init.body.get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  });

  it("bulk: recipient-variables and %recipient% substitution in body and header", async () => {
    const requests = stubFetch(Response.json({ id: "<mg2>" }));
    const s = mailgunSender({ apiKey: "k", domain: "mg.x.co", region: "us" }, "s@x.co");
    const results = await s.sendBulk([email("a@x.co", "a".repeat(43)), email("b@x.co", "b".repeat(43))]);
    expect(results).toEqual([{ status: "sent", id: null }, { status: "sent", id: null }]); // one id for the batch can't identify a person
    const form = requests[0].init.body;
    expect(requests[0].url).toBe("https://api.mailgun.net/v3/mg.x.co/messages");
    expect(form.getAll("to")).toEqual(["a@x.co", "b@x.co"]);
    expect(form.get("text")).toContain("%recipient.perchlight_unsubscribe_url%");
    expect(form.get("h:List-Unsubscribe")).toBe("<%recipient.perchlight_unsubscribe_url%>");
    const vars = JSON.parse(form.get("recipient-variables"));
    expect(vars["b@x.co"].perchlight_unsubscribe_url).toContain("b".repeat(43));
  });

  it("a domain/sender 400 is a setup problem; another 400 splits the batch", async () => {
    const s = mailgunSender({ apiKey: "k", domain: "mg.x.co" }, "s@x.co");
    stubFetch(Response.json({ message: "Domain mg.x.co is not allowed to send" }, { status: 400 }));
    expect((await s.sendBulk([email("a@x.co")]))[0].status).toBe("config");
    vi.restoreAllMocks();
    stubFetch(Response.json({ message: "to parameter is not a valid address" }, { status: 400 }));
    expect((await s.sendBulk([email("a@x.co")]))[0].status).toBe("split");
  });
});

describe("postmark", () => {
  it("announcements go to the broadcast stream; Postmark-managed unsubscribes omit our headers", async () => {
    const requests = stubFetch(Response.json([{ ErrorCode: 0, MessageID: "p1" }, { ErrorCode: 406, Message: "Inactive recipient" }]));
    const s = postmarkSender({ serverToken: "tok", stream: "broadcast", ownUnsubscribe: false }, "s@x.co");
    const results = await s.sendBulk([email("a@x.co"), email("b@x.co")]);
    expect(results.map((r) => r.status)).toEqual(["sent", "rejected"]);
    const body = JSON.parse(requests[0].init.body);
    expect(requests[0].url).toBe("https://api.postmarkapp.com/email/batch");
    expect(requests[0].headers.get("X-Postmark-Server-Token")).toBe("tok");
    expect(body[0].MessageStream).toBe("broadcast");
    expect(body[0].Headers).toEqual([]);
  });

  it("with POSTMARK_UNSUBSCRIBE=self our headers are sent; confirmations use the transactional stream", async () => {
    const requests = stubFetch(Response.json({ ErrorCode: 0, MessageID: "p2" }));
    const s = postmarkSender({ serverToken: "tok", stream: "news", ownUnsubscribe: true }, "s@x.co");
    await s.send(email("a@x.co"));
    expect(JSON.parse(requests[0].init.body).Headers.map((h) => h.Name)).toContain("List-Unsubscribe");
    expect(JSON.parse(requests[0].init.body).MessageStream).toBe("news");
    await s.send(confirmationEmail(cfg, "a@x.co", "t".repeat(43)));
    expect(JSON.parse(requests[1].init.body).MessageStream).toBe("outbound");
  });

  it("a bad token is a setup problem", async () => {
    stubFetch(Response.json({ ErrorCode: 10, Message: "Bad or missing Server API token." }, { status: 401 }));
    const s = postmarkSender({ serverToken: "bad", stream: "broadcast" }, "s@x.co");
    expect((await s.send(email("a@x.co"))).status).toBe("config");
  });
});

describe("cloudflare", () => {
  it("sends through the binding and reports failures as retryable", async () => {
    const sent = [];
    const binding = {
      async send(m) {
        if (m.to === "fail@x.co") throw Object.assign(new Error("nope"), { code: "E_TEST" });
        sent.push(m);
        return { messageId: `id-${m.to}` };
      },
    };
    const s = cloudflareSender(binding, "Site <s@x.co>");
    expect(await s.send(email("a@x.co"))).toEqual({ status: "sent", id: "id-a@x.co" });
    expect(await s.send(email("fail@x.co"))).toMatchObject({ status: "retry" }); // refused with a code
    const dropped = cloudflareSender({ send: async () => { throw new Error("connection lost"); } }, "s@x.co");
    expect(await dropped.send(email("a@x.co"))).toMatchObject({ status: "unknown" }); // may have been sent
    expect(sent[0].from).toEqual({ name: "Site", email: "s@x.co" });
    expect(s.bulkSize).toBe(0);
  });
});
