// Unsubscribing.
//  GET  /api/unsubscribe?token=...  shows a page with an Unsubscribe button
//       and never unsubscribes by itself: mail scanners open every link.
//  POST /api/unsubscribe            does it, from that button or from the
//       mail app's own one-click button (RFC 8058: token in the query string,
//       body "List-Unsubscribe=One-Click"). One-click gets a plain 200: the
//       RFC forbids redirecting it. The page button gets the usual redirect.
import { redirect } from "../lib/http.js";
import { isToken, tokenFrom } from "../lib/tokens.js";
import { pageWithToken } from "../lib/pages.js";

export function unsubscribePage(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  if (!isToken(token)) return redirect("/list/link-expired/");
  return pageWithToken(env, request, "/list/unsubscribe/", token);
}

export async function unsubscribe(request, env) {
  const oneClick = (await request.clone().text()).includes("List-Unsubscribe=One-Click");
  const token = await tokenFrom(request);
  if (token) {
    // bounced and complained already get nothing; keep those statuses as the record of why.
    await env.DB.prepare(
      `UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = datetime('now')
       WHERE token = ?1 AND status IN ('pending', 'confirmed')`,
    ).bind(token).run();
  }
  if (oneClick) {
    return new Response("You're unsubscribed.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  // The same page whether or not the token matched: nothing to learn here.
  return redirect(token ? "/list/unsubscribed/" : "/list/link-expired/");
}
