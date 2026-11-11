// Sending the confirm-your-address email, at signup and as a retry.
import { config } from "./config.js";
import { confirmationEmail } from "./emails.js";
import { recordSentStmt, today } from "./daily.js";

/**
 * Sends one confirmation email and records it. Returns true if accepted.
 * The idempotency key (honoured by Resend) is the token, how many times this
 * address has been sent one, and the day: a retry of the same send is
 * delivered once, while a fresh request gets a new email.
 * With services that have no idempotency keys, a send interrupted mid-way
 * may be retried and arrive twice; for a confirmation email that's harmless.
 */
export async function sendConfirmation(env, sender, email, token, sendsSoFar) {
  const result = await sender.send(confirmationEmail(config(env), email, token), {
    idempotencyKey: `perchlight-confirm-${token}-${sendsSoFar}-${today()}`,
  });
  if (result.status !== "sent") {
    console.error(`confirmation email (${result.status}): ${result.error}`);
    return false;
  }
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE subscribers SET confirm_sent_at = datetime('now'), confirm_sends = confirm_sends + 1 WHERE email = ?1",
    ).bind(email),
    recordSentStmt(env, 1),
  ]);
  return true;
}

/**
 * Retries confirmation emails that were never sent (the email service was
 * down or not set up when the person signed up). Only signups from the last
 * 7 days: after that, an unexpected email is more confusing than useful.
 * Returns how many were sent.
 */
export async function retryUnsentConfirmations(env, sender, budget) {
  if (budget <= 0) return 0;
  const { results } = await env.DB.prepare(
    `SELECT email, token, confirm_sends FROM subscribers
     WHERE status = 'pending' AND block_reason IS NULL AND confirm_sent_at IS NULL
       AND created_at > datetime('now', '-7 days')
     ORDER BY id LIMIT ?1`,
  ).bind(Math.min(budget, 1000)).all();
  let sent = 0;
  for (const row of results) {
    if (await sendConfirmation(env, sender, row.email, row.token, row.confirm_sends)) sent++;
    else break; // the service is still failing; try again next run
  }
  return sent;
}
