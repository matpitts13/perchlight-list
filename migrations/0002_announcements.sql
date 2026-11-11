-- Announcements: written and queued from the Perchlight admin app (or any
-- tool that writes these rows), sent by the Worker's scheduled job.
--
-- To queue one, in a single transaction:
--   UPDATE announcements SET status = 'queued', queued_at = datetime('now') WHERE id = ?;
--   INSERT OR IGNORE INTO deliveries (announcement_id, subscriber_id)
--     SELECT ?, id FROM subscribers WHERE status = 'confirmed' AND block_reason IS NULL;
--
-- A paused announcement (status 'paused', reason in last_error) is resumed by
-- setting its status back to 'sending'. Deliveries whose outcome is unknown
-- are re-queued by setting their status back to 'pending'.
CREATE TABLE IF NOT EXISTS announcements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject      TEXT NOT NULL,
  body_text    TEXT NOT NULL,          -- plain text, always sent
  body_html    TEXT,                   -- optional HTML version
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'queued', 'sending', 'paused', 'sent', 'cancelled')),
  last_error   TEXT,                   -- why it's paused (a setup problem to fix)
  -- 1 once the "every email refused the same way" check has paused it; it
  -- never pauses it again, so resuming can't loop on genuinely bad addresses.
  auto_paused  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  queued_at    TEXT,
  finished_at  TEXT
);

-- One row per recipient per announcement. The primary key means nobody can
-- get the same announcement twice, however the rows are added.
--   pending  -> claimed (picked up by a run) -> sending (request about to go out)
--            -> sent | failed | unknown | skipped
-- unknown: the request went out but its outcome couldn't be confirmed (for
-- example a timeout). Never re-sent automatically, except with an email
-- service that deduplicates retries (Resend, standard mode).
CREATE TABLE IF NOT EXISTS deliveries (
  announcement_id  INTEGER NOT NULL REFERENCES announcements (id) ON DELETE CASCADE,
  subscriber_id    INTEGER NOT NULL REFERENCES subscribers (id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'claimed', 'sending', 'sent', 'failed', 'unknown', 'skipped')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  -- 1 = send this one on its own, not in a bulk batch (its batch was refused
  -- as a whole, so it's retried individually to find the bad address).
  solo             INTEGER NOT NULL DEFAULT 0,
  claimed_at       TEXT,
  -- The run that claimed it. Every later change by that run checks this, so a
  -- slow or overlapping run can never change a row it no longer owns.
  claim_id         TEXT,
  send_started_at  TEXT,
  -- 1 if it was sent with a per-email idempotency key (Resend, standard mode):
  -- only then is an interrupted send safe to retry automatically.
  idempotent_send  INTEGER NOT NULL DEFAULT 0,
  provider_id      TEXT,               -- the email service's message id
  error            TEXT,
  sent_at          TEXT,
  PRIMARY KEY (announcement_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status, announcement_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_provider ON deliveries (provider_id);

-- Emails sent per UTC day (confirmations and announcements), so sending
-- stays under the email service's daily limit (DAILY_SEND_LIMIT).
CREATE TABLE IF NOT EXISTS send_log_daily (
  day   TEXT PRIMARY KEY,
  sent  INTEGER NOT NULL DEFAULT 0
);
