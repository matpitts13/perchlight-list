import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSubscriber, call, mockOutbound, resetDb, subscriber } from "./helpers.js";

describe("confirm and unsubscribe links", () => {
  beforeEach(async () => {
    await resetDb();
    mockOutbound();
  });
  afterEach(() => vi.restoreAllMocks());

  it("GET confirm shows a page with the token filled in and changes nothing", async () => {
    const token = await addSubscriber("p@example.com", "pending");
    const res = await call(`/api/confirm?token=${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`value="${token}"`);
    expect((await subscriber("p@example.com")).status).toBe("pending");
  });

  it("POST confirm confirms a pending address", async () => {
    const token = await addSubscriber("p@example.com", "pending");
    const form = new FormData();
    form.set("token", token);
    const res = await call("/api/confirm", { method: "POST", body: form });
    expect(res.headers.get("Location")).toBe("/list/confirmed/");
    const row = await subscriber("p@example.com");
    expect(row.status).toBe("confirmed");
    expect(row.confirmed_at).not.toBeNull();
  });

  it("POST confirm doesn't re-subscribe an unsubscribed address", async () => {
    const token = await addSubscriber("gone@example.com", "unsubscribed");
    const form = new FormData();
    form.set("token", token);
    const res = await call("/api/confirm", { method: "POST", body: form });
    expect(res.headers.get("Location")).toBe("/list/unsubscribed/");
    expect((await subscriber("gone@example.com")).status).toBe("unsubscribed");
  });

  it("a bad token goes to the link-expired page", async () => {
    const res = await call("/api/confirm?token=short");
    expect(res.headers.get("Location")).toBe("/list/link-expired/");
  });

  it("GET unsubscribe shows a page and changes nothing", async () => {
    const token = await addSubscriber("c@example.com");
    const res = await call(`/api/unsubscribe?token=${token}`);
    expect(await res.text()).toContain(`value="${token}"`);
    expect((await subscriber("c@example.com")).status).toBe("confirmed");
  });

  it("one-click unsubscribe (RFC 8058) works with the token in the query string", async () => {
    const token = await addSubscriber("c@example.com");
    const res = await call(`/api/unsubscribe?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200); // RFC 8058: no redirect for one-click
    expect(res.headers.get("Location")).toBeNull();
    const row = await subscriber("c@example.com");
    expect(row.status).toBe("unsubscribed");
    expect(row.unsubscribed_at).not.toBeNull();
  });

  it("the page's Unsubscribe button redirects to the confirmation page", async () => {
    const token = await addSubscriber("c@example.com");
    const form = new URLSearchParams({ token });
    const res = await call("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    expect(res.headers.get("Location")).toBe("/list/unsubscribed/");
    expect((await subscriber("c@example.com")).status).toBe("unsubscribed");
  });

  it("unsubscribing keeps a bounced status as the record of why", async () => {
    const token = await addSubscriber("b@example.com", "bounced");
    await call(`/api/unsubscribe?token=${token}`, { method: "POST" });
    expect((await subscriber("b@example.com")).status).toBe("bounced");
  });

  it("the database refuses to put a blocked address back on the list", async () => {
    await addSubscriber("blocked@example.com", "unsubscribed");
    await env.DB.prepare("UPDATE subscribers SET block_reason = 'SPAM' WHERE email = 'blocked@example.com'").run();
    await expect(
      env.DB.prepare("UPDATE subscribers SET status = 'confirmed' WHERE email = 'blocked@example.com'").run(),
    ).rejects.toThrow(/blocked address must stay unsubscribed/);
  });

  it("unknown API paths are 404 and wrong methods are 405", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    const res = await call("/api/subscribe");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
  });
});
