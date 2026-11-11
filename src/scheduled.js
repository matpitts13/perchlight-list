// The every-minute job: retry unsent confirmation emails, then send the next
// announcement emails, within today's sending limit. Each step runs even if
// an earlier one failed.
import { config } from "./lib/config.js";
import { getSender } from "./lib/senders/index.js";
import { remainingToday } from "./lib/daily.js";
import { retryUnsentConfirmations } from "./lib/confirmations.js";
import { sendAnnouncements, hasAnnouncementsWaiting } from "./lib/announce.js";

const CONFIRMATIONS_PER_RUN = 10;

async function step(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`scheduled (${name}): ${err instanceof Error ? err.stack : String(err)}`);
    return fallback;
  }
}

export async function runScheduled(env) {
  // Signup rate-limit counters are only needed for the hour they cover.
  await step("cleanup", () => {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 13);
    return env.DB.prepare("DELETE FROM signup_attempts WHERE hour < ?1").bind(dayAgo).run();
  });

  const sender = getSender(env);
  if (!sender) return; // no email service yet: signups wait, nothing to do

  const cfg = config(env);
  // The daily limit is read once per run, so two overlapping runs can go
  // slightly over it; the email service's own limit then throttles (handled).
  let budget = await remainingToday(env, cfg.dailyLimit);
  if (budget <= 0) return;

  // Confirmations first: they're what people are waiting for right now.
  budget -= await step("confirmations", () => retryUnsentConfirmations(env, sender, Math.min(budget, CONFIRMATIONS_PER_RUN)), 0);

  // Marketing email must carry the sender's postal address (CAN-SPAM).
  if (!cfg.postalAddress) {
    if (await step("check", () => hasAnnouncementsWaiting(env), false)) {
      console.error("announcements: waiting to send, but MAIL_POSTAL_ADDRESS isn't set. Set it in wrangler.jsonc and redeploy.");
    }
    return;
  }
  await step("announcements", () => sendAnnouncements(env, sender, cfg, budget), 0);
}
