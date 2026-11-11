-- Subscribers. Status moves pending -> confirmed -> unsubscribed (or
-- pending -> unsubscribed). bounced and complained are set from the email
-- service's webhooks; those addresses are never emailed again.
-- token is a random secret used in confirm and unsubscribe links.
CREATE TABLE IF NOT EXISTS subscribers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'confirmed', 'unsubscribed', 'bounced', 'complained')),
  token            TEXT NOT NULL UNIQUE,
  source           TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at     TEXT,
  unsubscribed_at  TEXT,
  -- When the confirmation email was last sent; NULL means never (the email
  -- service was unreachable or not set up yet; the scheduled job retries).
  confirm_sent_at  TEXT,
  confirm_sends    INTEGER NOT NULL DEFAULT 0,
  -- Why this address may never join (e.g. BURNER-EMAIL); NULL = not blocked.
  block_reason     TEXT,
  blocked_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscribers_status ON subscribers (status);

-- Abuse limit: signup attempts per network per hour, stored only as a salted hash.
CREATE TABLE IF NOT EXISTS signup_attempts (
  ip_hash   TEXT NOT NULL,
  hour      TEXT NOT NULL,
  attempts  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, hour)
);

-- Domains blocked by hand, on top of the bundled disposable-domain list
-- (src/data/disposable-domains.js). A subdomain matches its parent.
CREATE TABLE IF NOT EXISTS blocked_domains (
  domain    TEXT PRIMARY KEY COLLATE NOCASE,
  reason    TEXT NOT NULL DEFAULT 'BURNER-EMAIL',
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Domains the bundled list gets wrong. Overrides only the bundled list,
-- never blocked_domains.
CREATE TABLE IF NOT EXISTS allowed_domains (
  domain    TEXT PRIMARY KEY COLLATE NOCASE,
  added_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A blocked address is always unsubscribed. Enforced in the database, not
-- just the code, so no path (signup, confirm, webhooks, the admin app) can
-- put it back on the list. Clearing block_reason is the only way to lift it,
-- and the address then stays unsubscribed until its owner signs up again.
CREATE TRIGGER IF NOT EXISTS subscribers_blocked_insert
BEFORE INSERT ON subscribers
WHEN NEW.block_reason IS NOT NULL AND NEW.status <> 'unsubscribed'
BEGIN
  SELECT RAISE(ABORT, 'blocked address must stay unsubscribed');
END;

CREATE TRIGGER IF NOT EXISTS subscribers_blocked_update
BEFORE UPDATE ON subscribers
WHEN NEW.block_reason IS NOT NULL AND NEW.status <> 'unsubscribed'
BEGIN
  SELECT RAISE(ABORT, 'blocked address must stay unsubscribed');
END;
