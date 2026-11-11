# ADR 0001: A Worker with static assets, not Pages Functions

**Date:** 2026-11-09
**Status:** Accepted

## Context

The code this project grew from ran as Cloudflare Pages Functions inside a website. As a standalone, deployable project it also has to send announcements on a timer, and it should work with Cloudflare's one-click "Deploy" button.

## Options considered

1. **Pages Functions** (as before). Pros: the code moves over almost unchanged. Cons: Pages has no cron triggers, so batched sending would need a second Worker. Cloudflare is also steering new projects to Workers.
2. **A Worker with static assets.** Pros: one deployable unit with `fetch` and `scheduled` handlers, D1 created automatically on deploy, and it works with the Deploy button. Cons: the handlers had to be rewritten from `onRequestPost({ request, env, waitUntil })` to a small router.
3. **Two Workers** (signup and sender). Pros: separate concerns. Cons: twice the setup for every user, with no benefit at this size.

## Decision

Option 2. Cron sending needs a Worker anyway, and one unit keeps setup to `npm run deploy`.

## Consequences

- Positive: a single `wrangler.jsonc`. Static pages are served free and only `/api/*` runs code (`run_worker_first`).
- Negative / trade-offs: this code is no longer a drop-in replacement for the original Pages Functions.
- Follow-up required: confirm the Deploy button creates the D1 database and applies migrations (SDD open question 4).
