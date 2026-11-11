// Sending announcements, from the scheduled job. See ADR 0003.
//
// Each delivery moves  pending -> claimed -> sending -> sent | failed | unknown | skipped.
// A run:
//  1. recovers rows an earlier run abandoned: never-started claims go back to
//     pending; rows left "sending" become unknown, or pending if they were sent
//     with a per-email idempotency key (safe to retry);
//  2. claims up to EMAILS_PER_RUN pending rows, stamping them with its claim_id;
//  3. for each request, marks its rows "sending" in ONE statement that is
//     also the final check: only rows this run still owns, whose person is
//     still confirmed and unblocked, and whose announcement is still sending,
//     are marked, a few milliseconds before the request goes out. Only those
//     are sent;
//  4. records each result, again only on rows this run still owns.
// So nobody unsubscribed, bounced, complained or blocked is sent a new email,
// no row is sent by two runs, and an unclear outcome is never guessed at.
import { announcementTemplate, announcementEmail } from "./emails.js";
import { recordSentStmt } from "./daily.js";
import { runPaced } from "./pace.js";

/** Attempts allowed per delivery (per-person temporary failures, and automatic idempotent retries). */
export const MAX_ATTEMPTS = 3;
/** How long a claimed or sending row is left alone before it counts as abandoned. */
const ABANDONED_AFTER = "-2 minutes";
/** Stop starting new requests this long into a run (runs start every minute;
 *  with a 30 s request timeout every run is done well inside ABANDONED_AFTER). */
const RUN_BUDGET_MS = 45_000;
/** This many failures in one run, all with the same error, nothing delivered
 *  yet = probably a setup problem: pause once to let the owner check. */
const SAME_FAILURE_PAUSE = 5;
/** This many requests with unclear outcomes in one run, nothing delivered =
 *  the email service is probably down: stop and pause instead of marking the
 *  whole list unknown. (One unclear bulk request is enough.) */
const UNKNOWN_PAUSE = 3;

const KEYS = "(announcement_id || ':' || subscriber_id) IN (SELECT value FROM json_each(?2))";
const ONE = "announcement_id = ?2 AND subscriber_id = ?3";
const keyOf = (row) => `${row.announcement_id}:${row.subscriber_id}`;

/** Per-email idempotency key: the same person and announcement always get the same key. */
export function deliveryKey(row) {
  return `perchlight-a${row.announcement_id}-s${row.subscriber_id}`;
}

/**
 * @param {import("./senders/index.js").EmailSender} sender
 * @param {import("./config.js").ListConfig} cfg
 * @param {number} budget  emails still allowed today
 * @returns {Promise<number>} emails sent
 */
export async function sendAnnouncements(env, sender, cfg, budget) {
  const started = Date.now();
  const bulk = cfg.sendMode === "bulk" && sender.bulkSize > 0 && typeof sender.sendBulk === "function";
  const claimId = crypto.randomUUID();

  await recoverAbandoned(env);
  await env.DB.batch([
    env.DB.prepare("UPDATE announcements SET status = 'sending' WHERE status = 'queued'"),
    // Re-queued rows (e.g. unknown ones the owner put back) re-open a finished announcement.
    env.DB.prepare(
      `UPDATE announcements SET status = 'sending', finished_at = NULL
       WHERE status = 'sent' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.announcement_id = announcements.id AND d.status = 'pending')`,
    ),
  ]);

  const limit = Math.min(budget, cfg.emailsPerRun);
  if (limit <= 0) return 0;

  const { results: rows } = await env.DB.prepare(
    `UPDATE deliveries SET status = 'claimed', claimed_at = datetime('now'), claim_id = ?2
     WHERE rowid IN (
       SELECT d.rowid FROM deliveries d JOIN announcements a ON a.id = d.announcement_id
       WHERE d.status = 'pending' AND a.status = 'sending'
       ORDER BY d.announcement_id, d.subscriber_id LIMIT ?1)
     RETURNING announcement_id, subscriber_id, attempts, solo`,
  ).bind(limit, claimId).all();
  if (!rows.length) {
    await finishAnnouncements(env);
    return 0;
  }

  const ids = (key) => JSON.stringify([...new Set(rows.map((r) => r[key]))]);
  const [subs, anns] = await env.DB.batch([
    env.DB.prepare("SELECT id, email, token FROM subscribers WHERE id IN (SELECT value FROM json_each(?1))").bind(ids("subscriber_id")),
    env.DB.prepare(
      "SELECT id, subject, body_text, body_html FROM announcements WHERE id IN (SELECT value FROM json_each(?1))",
    ).bind(ids("announcement_id")),
  ]);
  const subById = new Map(subs.results.map((s) => [s.id, s]));
  const templates = new Map(anns.results.map((a) => [a.id, announcementTemplate(cfg, a)]));
  // Emails are built for everyone claimed; who actually gets one is decided
  // by the "sending" mark, right before each request.
  const items = [];
  const gone = [];
  for (const row of rows) {
    const sub = subById.get(row.subscriber_id);
    const template = templates.get(row.announcement_id);
    if (sub && template) items.push({ row, message: announcementEmail(cfg, template, sub) });
    else gone.push(keyOf(row));
  }
  if (gone.length) {
    await env.DB.prepare(`UPDATE deliveries SET status = 'skipped' WHERE claim_id = ?1 AND status = 'claimed' AND ${KEYS}`)
      .bind(claimId, JSON.stringify(gone)).run();
  }

  // Requests: bulk batches per announcement (bulk services share one template
  // per request), or one email each. "solo" rows always go one at a time.
  const groups = [];
  if (bulk) {
    const byAnnouncement = new Map();
    for (const item of items) {
      if (item.row.solo) groups.push([item]);
      else {
        if (!byAnnouncement.has(item.row.announcement_id)) byAnnouncement.set(item.row.announcement_id, []);
        byAnnouncement.get(item.row.announcement_id).push(item);
      }
    }
    for (const list of byAnnouncement.values()) {
      for (let i = 0; i < list.length; i += sender.bulkSize) groups.push(list.slice(i, i + sender.bulkSize));
    }
  } else {
    for (const item of items) groups.push([item]);
  }

  const state = { sent: 0, stop: null, failures: [], startedGroups: new Set(), unknownRequests: 0 };
  try {
    await runPaced(
      groups.map((group) => () => sendGroup(env, sender, group, bulk, state, claimId)),
      {
        maxParallel: cfg.maxParallel,
        requestsPerSecond: cfg.requestsPerSecond,
        deadline: started + RUN_BUDGET_MS,
        shouldStop: () => state.stop !== null,
        onError: (err) => {
          state.stop = state.stop ?? "error";
          console.error(`announcements: ${err instanceof Error ? err.stack : String(err)}`);
        },
      },
    );
  } finally {
    // Rows in requests this run never started go straight back to the queue.
    const unstarted = groups.filter((g) => !state.startedGroups.has(g)).flat().map((i) => keyOf(i.row));
    if (unstarted.length) {
      await env.DB.prepare(
        `UPDATE deliveries SET status = 'pending', claimed_at = NULL, claim_id = NULL WHERE claim_id = ?1 AND status = 'claimed' AND ${KEYS}`,
      ).bind(claimId, JSON.stringify(unstarted)).run();
    }
    await pauseIfEverythingFailedTheSame(env, state, claimId);
    if (state.stop === "throttled") console.error("announcements: the email service is limiting sending; continuing next run");
    await finishAnnouncements(env);
  }
  return state.sent;
}

/** Marks, sends and records one request's worth. */
async function sendGroup(env, sender, group, bulk, state, claimId) {
  if (state.stop) return;
  state.startedGroups.add(group);
  const viaBulk = bulk && group.length > 1;
  const withKey = sender.idempotent && !viaBulk;
  const keys = JSON.stringify(group.map((g) => keyOf(g.row)));

  // The final check and the "sending" mark in one statement.
  const { results: marked } = await env.DB.prepare(
    `UPDATE deliveries SET status = 'sending', send_started_at = datetime('now'), attempts = attempts + 1, idempotent_send = ?3
     WHERE claim_id = ?1 AND status = 'claimed' AND ${KEYS}
       AND EXISTS (SELECT 1 FROM subscribers s WHERE s.id = deliveries.subscriber_id AND s.status = 'confirmed' AND s.block_reason IS NULL)
       AND EXISTS (SELECT 1 FROM announcements a WHERE a.id = deliveries.announcement_id AND a.status = 'sending')
     RETURNING announcement_id, subscriber_id`,
  ).bind(claimId, keys, withKey ? 1 : 0).all();

  // Everyone not marked: back to the queue if their announcement was paused
  // meanwhile (and they're still subscribed), otherwise skipped.
  if (marked.length < group.length) {
    await env.DB.prepare(
      `UPDATE deliveries SET claim_id = NULL, claimed_at = NULL,
         status = CASE WHEN (SELECT a.status FROM announcements a WHERE a.id = deliveries.announcement_id) IN ('paused', 'sending')
                        AND EXISTS (SELECT 1 FROM subscribers s WHERE s.id = deliveries.subscriber_id AND s.status = 'confirmed' AND s.block_reason IS NULL)
                       THEN 'pending' ELSE 'skipped' END
       WHERE claim_id = ?1 AND status = 'claimed' AND ${KEYS}`,
    ).bind(claimId, keys).run();
  }
  const markedKeys = new Set(marked.map(keyOf));
  const toSend = group.filter((g) => markedKeys.has(keyOf(g.row)));
  if (!toSend.length) return;

  let results;
  try {
    results = viaBulk && toSend.length > 1
      ? await sender.sendBulk(toSend.map((g) => g.message))
      : await Promise.all(toSend.map((g) => sender.send(g.message, { idempotencyKey: withKey ? deliveryKey(g.row) : undefined })));
  } catch (err) {
    results = toSend.map(() => ({ status: "unknown", error: `send failed: ${err instanceof Error ? err.message : String(err)}` }));
  }

  const stmts = [];
  const pauseFor = new Set();
  let pauseError = "";
  const own = `WHERE claim_id = ?1 AND status = 'sending' AND ${ONE}`;
  toSend.forEach(({ row }, i) => {
    const r = results[i] ?? { status: "unknown", error: "no result from the email service" };
    const attempts = row.attempts + 1; // after the mark
    const err = r.error ? r.error.slice(0, 500) : null;
    const set = (sql, ...params) => stmts.push(env.DB.prepare(`UPDATE deliveries SET ${sql} ${own}`).bind(claimId, row.announcement_id, row.subscriber_id, ...params));
    const back = "status = 'pending', claimed_at = NULL, claim_id = NULL, send_started_at = NULL";
    switch (r.status) {
      case "sent":
        state.sent++;
        set("status = 'sent', provider_id = ?4, error = NULL, sent_at = datetime('now')", r.id);
        break;
      case "rejected":
        state.failures.push({ row, error: err });
        set("status = 'failed', error = ?4", err);
        break;
      case "retry":
        state.failures.push({ row, error: err });
        if (attempts >= MAX_ATTEMPTS) set("status = 'failed', error = ?4", err);
        else set(`${back}, error = ?4`, err);
        break;
      case "throttled":
        state.stop = state.stop ?? "throttled";
        set(`${back}, attempts = attempts - 1, error = ?4`, err);
        break;
      case "config":
        state.stop = "config";
        pauseFor.add(row.announcement_id);
        pauseError = err;
        set(`${back}, attempts = attempts - 1, error = ?4`, err);
        break;
      case "split":
        set(`${back}, attempts = attempts - 1, solo = 1, error = ?4`, err);
        break;
      case "unknown":
        // Same key next time = delivered at most once; capped, and well inside the key's 24 hours.
        if (withKey && attempts < MAX_ATTEMPTS) set(`${back}, error = ?4`, err);
        else set("status = 'unknown', error = ?4", err);
        break;
      default: // conflict: the key was used for different content; don't guess
        set("status = 'unknown', error = ?4", err);
    }
  });
  // Unclear outcomes with nothing delivered: the service is probably down.
  if (results.some((r) => r.status === "unknown")) {
    state.unknownRequests++;
    if (!state.sent && (viaBulk || state.unknownRequests >= UNKNOWN_PAUSE)) {
      state.stop = "unknown";
      for (const { row } of toSend) pauseFor.add(row.announcement_id);
      pauseError = `The email service may be down: sends ended without a clear result (${results.find((r) => r.status === "unknown").error}). Check your service's status and logs, re-queue any 'unknown' deliveries that weren't delivered, then resume.`;
    }
  }
  if (pauseFor.size) {
    stmts.push(
      env.DB.prepare(
        "UPDATE announcements SET status = 'paused', last_error = ?2 WHERE status = 'sending' AND id IN (SELECT value FROM json_each(?1))",
      ).bind(JSON.stringify([...pauseFor]), String(pauseError).slice(0, 500)),
    );
  }
  const sentHere = results.filter((r) => r.status === "sent").length;
  if (sentHere) stmts.push(recordSentStmt(env, sentHere));
  await env.DB.batch(stmts);
  if (pauseFor.size) console.error(`announcements: paused: ${pauseError}`);
}

/**
 * Many failures in one run, all with the same error, for an announcement that
 * has delivered nothing and hasn't been auto-paused before, look like a setup
 * problem (say, an unverified From address) rather than bad addresses: put the
 * refused rows back and pause, once. After the owner resumes, failures are
 * recorded normally, so this can never loop.
 */
async function pauseIfEverythingFailedTheSame(env, state, claimId) {
  const f = state.failures;
  if (state.sent || f.length < SAME_FAILURE_PAUSE || new Set(f.map((x) => x.error)).size !== 1) return;
  const announcementIds = JSON.stringify([...new Set(f.map((x) => x.row.announcement_id))]);
  const eligible = await env.DB.prepare(
    `SELECT id FROM announcements a WHERE a.id IN (SELECT value FROM json_each(?1)) AND a.status = 'sending' AND a.auto_paused = 0
       AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.announcement_id = a.id AND d.status = 'sent')`,
  ).bind(announcementIds).all();
  const pauseIds = new Set(eligible.results.map((r) => r.id));
  if (!pauseIds.size) return;
  const error = f[0].error;
  const keys = JSON.stringify(f.filter((x) => pauseIds.has(x.row.announcement_id)).map((x) => keyOf(x.row)));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE deliveries SET status = 'pending', attempts = MAX(attempts - 1, 0), claimed_at = NULL, claim_id = NULL, send_started_at = NULL
       WHERE claim_id = ?1 AND status = 'failed' AND ${KEYS}`,
    ).bind(claimId, keys),
    env.DB.prepare(
      `UPDATE announcements SET status = 'paused', auto_paused = 1, last_error = ?2
       WHERE status = 'sending' AND id IN (SELECT value FROM json_each(?1))`,
    ).bind(JSON.stringify([...pauseIds]), `Every email was refused with: ${error}`.slice(0, 500)),
  ]);
  console.error(`announcements: paused once to check setup; every email was refused with: ${error}`);
}

async function recoverAbandoned(env) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE deliveries SET status = 'pending', claimed_at = NULL, claim_id = NULL WHERE status = 'claimed' AND claimed_at < datetime('now', ?1)",
    ).bind(ABANDONED_AFTER),
    // Sent with a per-email idempotency key and under the attempt cap: retry (the service deduplicates).
    env.DB.prepare(
      `UPDATE deliveries SET status = 'pending', claimed_at = NULL, claim_id = NULL, send_started_at = NULL,
         error = 'retried after an interrupted send'
       WHERE status = 'sending' AND send_started_at < datetime('now', ?1) AND idempotent_send = 1 AND attempts < ?2`,
    ).bind(ABANDONED_AFTER, MAX_ATTEMPTS),
    env.DB.prepare(
      `UPDATE deliveries SET status = 'unknown', claim_id = NULL,
         error = 'the send was interrupted; it may or may not have been delivered'
       WHERE status = 'sending' AND send_started_at < datetime('now', ?1)`,
    ).bind(ABANDONED_AFTER),
  ]);
}

/** Marks sending announcements with nothing left in progress as sent. Rows
 *  that failed or whose outcome is unknown stay visible on deliveries;
 *  re-queuing them re-opens the announcement. */
export async function finishAnnouncements(env) {
  await env.DB.prepare(
    `UPDATE announcements SET status = 'sent', finished_at = datetime('now')
     WHERE status = 'sending' AND NOT EXISTS (
       SELECT 1 FROM deliveries d WHERE d.announcement_id = announcements.id AND d.status IN ('pending', 'claimed', 'sending'))`,
  ).run();
}

/** True if any announcement is waiting to be sent. */
export async function hasAnnouncementsWaiting(env) {
  const row = await env.DB.prepare(
    "SELECT 1 AS waiting FROM announcements WHERE status IN ('queued', 'sending') LIMIT 1",
  ).first();
  return Boolean(row);
}
