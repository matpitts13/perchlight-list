// Confirming a signup.
//  GET  /api/confirm?token=...  the link in the email: shows a page with a
//       Confirm button and never confirms by itself. Mail scanners open
//       every link, and a GET that confirmed would sign up people who never
//       clicked anything.
//  POST /api/confirm            the button: confirms.
import { redirect } from "../lib/http.js";
import { isToken, tokenFrom } from "../lib/tokens.js";
import { pageWithToken } from "../lib/pages.js";

export function confirmPage(request, env) {
  const token = new URL(request.url).searchParams.get("token");
  if (!isToken(token)) return redirect("/list/link-expired/");
  return pageWithToken(env, request, "/list/confirm/", token);
}

export async function confirm(request, env) {
  const token = await tokenFrom(request);
  if (!token) return redirect("/list/link-expired/");

  const row = await env.DB.prepare("SELECT status, block_reason FROM subscribers WHERE token = ?1").bind(token).first();
  if (!row) return redirect("/list/link-expired/");
  if (row.status === "pending" && !row.block_reason) {
    await env.DB.prepare(
      `UPDATE subscribers SET status = 'confirmed', confirmed_at = datetime('now')
       WHERE token = ?1 AND status = 'pending' AND block_reason IS NULL`,
    ).bind(token).run();
    return redirect("/list/confirmed/");
  }
  // Already confirmed is fine; anything else (unsubscribed, bounced, blocked) stays as it is.
  return redirect(row.status === "confirmed" ? "/list/confirmed/" : "/list/unsubscribed/");
}
