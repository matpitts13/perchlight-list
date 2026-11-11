# ADR 0002: Announcements sent by a cron job that claims D1 rows

**Date:** 2026-11-09
**Status:** Partly superseded by [ADR 0003](0003-per-delivery-states-and-sending-modes.md). The cron job and the `deliveries` table stand; the batch-key recovery described below was replaced.

## Context

An announcement goes to every confirmed subscriber, but email services cap sending (Resend's free tier allows 100 a day). A single Worker request can't safely send thousands of emails. Nobody may get the same announcement twice, even if runs overlap or crash. The email service's API key should stay in the Worker, not in the desktop app.

## Options considered

1. **Send from the desktop app.** Pros: no server-side job. Cons: the app would need the email key, sending would stop when the laptop closes, and limits would be hard to respect.
2. **Cloudflare Queues.** Pros: built-in retries and batching. Cons: another resource for every user to create and understand. Daily caps and "continue tomorrow" still need state in D1.
3. **A cron trigger every minute, with a `deliveries` table.** One row per recipient, primary key `(announcement_id, subscriber_id)`. Each run claims a batch with a single `UPDATE … WHERE rowid IN (SELECT … LIMIT n) RETURNING`, sends it, and records the results. Pros: one database holds everything, duplicates are impossible, daily caps are simple (`send_log_daily`), and any tool can queue an announcement with plain SQL. Cons: up to a minute of delay, and claims left behind by crashed runs need recovery.

## Decision

Option 3. Each claimed batch gets a random `batch_key`, which is also sent as the email service's idempotency key. It keeps the setup to a single Worker and one database.

## Consequences

- Positive: the admin app only writes rows, and the key stays in the Worker. Unsubscribes after queueing are respected (new batches are re-checked at send time and marked `skipped`).
- How each kind of result is handled (from the email service, per message):
  - **sent** → recorded.
  - **rejected** (for example a bad address; Resend's permissive batch mode refuses only that message) → `failed` right away.
  - **retry** (a per-message temporary error) → back to the queue, up to 3 attempts.
  - **service** (outage, rate limit, bad key; nothing was sent) → back to the queue *without* using up an attempt, so a temporary outage can't fail a whole list.
  - **unknown** (a timeout, or a crash before results were recorded) → the batch stays claimed and, after 2 minutes, is re-sent whole with the same idempotency key. Resend keeps keys for 24 hours and won't deliver twice.
- Negative / trade-offs:
  - A re-sent batch isn't re-checked, so its idempotency key still matches. Someone who unsubscribed in those 2 minutes may get that one email; the law allows far longer.
  - Cloudflare Email Service has no idempotency keys, so with it a crash between sending and recording can still, rarely, send a duplicate.
  - An announcement is marked `sent` when nothing is left to try. Undeliverable rows stay visible as `deliveries.status = 'failed'`.
- Follow-up required: email services are swappable (`src/lib/senders/`). Resend is the default because Cloudflare Email Service is in beta and needs a paid plan for arbitrary recipients.
