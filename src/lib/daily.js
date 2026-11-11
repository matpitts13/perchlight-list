// Emails sent per UTC day, so sending stays under DAILY_SEND_LIMIT.

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** How many more emails may go out today. */
export async function remainingToday(env, dailyLimit) {
  const row = await env.DB.prepare("SELECT sent FROM send_log_daily WHERE day = ?1").bind(today()).first();
  return Math.max(0, dailyLimit - (row?.sent ?? 0));
}

/** A statement that adds n to today's count, for use in a DB batch. */
export function recordSentStmt(env, n) {
  return env.DB.prepare(
    `INSERT INTO send_log_daily (day, sent) VALUES (?1, ?2)
     ON CONFLICT(day) DO UPDATE SET sent = sent + excluded.sent`,
  ).bind(today(), n);
}
