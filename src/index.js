// perchlight-list: a self-hosted mailing list on Cloudflare Workers + D1.
import { json } from "./lib/http.js";
import { subscribe } from "./routes/subscribe.js";
import { confirm, confirmPage } from "./routes/confirm.js";
import { unsubscribe, unsubscribePage } from "./routes/unsubscribe.js";
import { resendWebhook, mailgunWebhook, postmarkWebhook, sesWebhook } from "./routes/webhooks.js";
import { runScheduled } from "./scheduled.js";

/** "METHOD /path" -> handler(request, env, ctx) */
const ROUTES = {
  "POST /api/subscribe": subscribe,
  "GET /api/confirm": confirmPage,
  "POST /api/confirm": confirm,
  "GET /api/unsubscribe": unsubscribePage,
  "POST /api/unsubscribe": unsubscribe,
  "POST /api/webhooks/resend": resendWebhook,
  "POST /api/webhooks/mailgun": mailgunWebhook,
  "POST /api/webhooks/postmark": postmarkWebhook,
  "POST /api/webhooks/ses": sesWebhook,
};

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
    const handler = ROUTES[`${request.method} ${path}`];
    if (handler) {
      try {
        return await handler(request, env, ctx);
      } catch (err) {
        console.error(`${request.method} ${path}: ${err instanceof Error ? err.stack : String(err)}`);
        return json({ ok: false, message: "Something went wrong. Please try again." }, 500);
      }
    }
    if (path.startsWith("/api/")) {
      const allowed = Object.keys(ROUTES).filter((k) => k.endsWith(` ${path}`)).map((k) => k.split(" ")[0]);
      return allowed.length
        ? json({ ok: false, message: "Method not allowed" }, 405, { Allow: allowed.join(", ") })
        : json({ ok: false, message: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runScheduled(env).catch((err) => console.error(`scheduled: ${err instanceof Error ? err.stack : String(err)}`)),
    );
  },
};
