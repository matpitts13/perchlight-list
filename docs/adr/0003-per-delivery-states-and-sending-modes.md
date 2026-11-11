# ADR 0003: Per-delivery states, standard and bulk modes, never guess

**Date:** 2026-11-09
**Status:** Accepted. Supersedes the recovery part of ADR 0002 (the cron job and the `deliveries` table stay).

## Context

ADR 0002's batch recovery failed code review twice. Re-sending an "abandoned" batch with the same idempotency key skipped the eligibility re-check. A batch that crashed *before* its request went out could then email people who had unsubscribed in the meantime, and the 409 and service-error handling had further gaps.

The project also has to support five email services (Resend, Amazon SES, Mailgun, Postmark and Cloudflare Email), from small lists on the Workers Free plan up to large senders. Research (November 2026) found:
- Only Resend has idempotency keys; Postmark says outright it has none.
- SES, Mailgun and Postmark have bulk APIs, each in a different shape.
- The Workers Free plan allows 50 outside requests per run.

## Options considered

1. **Fix the batch recovery.** Pros: keeps batches. Cons: the part that failed twice, with the most states to get right, and it still depends on idempotency that only one service offers.
2. **One email per request only.** Pros: simple. With Resend, per-email keys make retries safe. Cons: a million emails takes days to weeks.
3. **Per-delivery states plus two modes, never guessing.** Every delivery goes `pending → claimed → sending → sent | failed | unknown | skipped`, and every person is re-checked before each send. Standard mode sends one email per request; bulk mode uses each service's batch API. An unclear outcome becomes `unknown` for a person to re-queue, except with Resend in standard mode, where a per-email key makes an automatic retry safe.

## Decision

Option 3. It's the only option that keeps the two promises for every service — nobody unsubscribed or blocked is emailed, and nobody is emailed twice — while still scaling to big lists.

## Consequences

- Positive:
  - Each request marks its rows `sending` in D1 *before* the request goes out, so recovery always knows whether an email might have gone out.
  - Rows that were claimed but never started go back to the queue.
  - Throttling doesn't use up attempts.
  - A setup problem (bad key, unverified domain, suspended account, or every single send refused with the same error) pauses the announcement with `last_error` instead of failing the list.
  - A batch refused as a whole is retried one email at a time (`solo`), which isolates the bad address.
- Negative / trade-offs:
  - Without idempotency, a timeout leaves people as `unknown` until the owner re-queues them. It's a manual step, but never a duplicate.
  - Bulk mode depends on each service's documented behaviour. The README asks for a real test send before relying on it, especially for Mailgun header substitution and Postmark broadcast unsubscribes.
- Follow-up required:
  - The admin app needs Resume (paused announcements) and "Resend to these" (unknown deliveries).
  - Mailgun header substitution and Postmark's broadcast stream ID should be confirmed against real accounts.
