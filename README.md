# perchlight-list

[![CI](https://github.com/matpitts13/perchlight-list/actions/workflows/ci.yml/badge.svg)](https://github.com/matpitts13/perchlight-list/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A free, self-hosted mailing list that runs on your own Cloudflare account.** It handles signups with email confirmation, keeps out bots and throwaway addresses, and sends announcements through the email service you already use: Resend, Amazon SES, Mailgun, Postmark or Cloudflare Email. There's no subscription and no per-subscriber fee, and your list never leaves your account.

It runs on Cloudflare Workers and D1. A small list fits inside Cloudflare's free plan and your email service's free tier. A large one can send hundreds of thousands of emails an hour on Workers Paid ($5/month).

Part of [Perchlight](https://github.com/matpitts13/perchlight), a free toolkit for running a product on Cloudflare. The Perchlight desktop app has a built-in screen for this list: subscribers, blocking, CSV export, writing announcements, and resuming or re-queuing sends.

## What it does

- **Double opt-in signups.** People confirm their address before they're on the list. The confirm link opens a page with a button, so email security scanners that open every link can't sign anyone up.
- **Spam protection:**
  - Cloudflare Turnstile (optional)
  - a hidden honeypot field
  - a per-network hourly limit (IPs stored only as salted hashes)
  - a check that the email domain can receive mail
  - a bundled list of 10,000+ disposable email domains
  - your own blocked and allowed domains
- **Privacy:** the signup form gives the same answer, in about the same time, for every address, so nobody can use it to find out who's on your list.
- **Announcements that follow the rules:**
  - one-click unsubscribe (`List-Unsubscribe` + `List-Unsubscribe-Post`, RFC 8058), which Gmail and Yahoo require from bulk senders
  - a visible unsubscribe link and your postal address (CAN-SPAM)
  - your daily sending limit is respected
- **Two promises, whatever the email service:**
  - Nobody who unsubscribed, bounced, complained or was blocked is sent a new email: everyone is re-checked right before every send.
  - Nobody gets the same announcement twice. If a send's outcome is unclear (say, a timeout), those people are marked **unknown** for you to re-queue, rather than guessed at. With Resend in standard mode, idempotency keys make the retry automatic and safe.
- **Stops instead of looping.** A setup problem (wrong API key, unverified domain, suspended account) pauses the announcement with the reason, until you fix it and resume. An outage or rate limit just waits and continues.
- **Bounces and spam complaints** are handled for Resend, SES, Mailgun and Postmark, so those addresses are never emailed again.

## Email services

| Service | Standard mode | Bulk mode | Automatic retry when unsure | Bounces and complaints |
|---|---|---|---|---|
| **Resend** (default) | yes | 100 per request | yes (standard mode) | webhook, Svix-signed |
| **Amazon SES** | yes | 50 per request | no, marked unknown | SNS notifications, signature checked |
| **Mailgun** | yes | 1,000 per request | no, marked unknown | webhook, HMAC-signed |
| **Postmark** | yes | 500 per request | no, marked unknown | webhook, password in URL |
| **Cloudflare Email** (beta) | yes | — | no, marked unknown | not offered by the service |

## Set up (about 10 minutes)

You need Node 22+ and a Cloudflare account.

```sh
git clone https://github.com/matpitts13/perchlight-list
cd perchlight-list
npm install
npx wrangler login
```

1. **Edit `wrangler.jsonc` → `vars`:**
   - `LIST_NAME`
   - `SITE_URL` (where this Worker is served)
   - `MAIL_FROM` (an address on a domain verified with your email service)
   - `MAIL_POSTAL_ADDRESS` (required before announcements will send)
   - `MAIL_PROVIDER`
2. **Deploy.** This creates the D1 database, applies the migrations and publishes the Worker:
   ```sh
   npm run deploy
   ```
3. **Set the secrets for your service** (`npx wrangler secret put NAME`). Every service also needs `IP_SALT` (any long random string); `TURNSTILE_SECRET_KEY` is optional.

   | Service | Settings in `wrangler.jsonc` | Secrets |
   |---|---|---|
   | Resend | — | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` |
   | Amazon SES | `AWS_REGION`, optionally `SES_CONFIGURATION_SET` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_SNS_TOPIC_ARN` |
   | Mailgun | `MAILGUN_DOMAIN`, `MAILGUN_REGION` (`us` or `eu`) | `MAILGUN_API_KEY`, `MAILGUN_WEBHOOK_SIGNING_KEY` |
   | Postmark | `POSTMARK_STREAM` (your broadcast stream's ID), `POSTMARK_UNSUBSCRIBE` | `POSTMARK_SERVER_TOKEN`, `POSTMARK_WEBHOOK_USER`, `POSTMARK_WEBHOOK_PASSWORD` |
   | Cloudflare Email | add `"send_email": [{ "name": "EMAIL" }]` | — |

4. **Connect bounces and complaints:**
   - **Resend:** add a webhook to `https://<your site>/api/webhooks/resend` for `email.bounced`, `email.complained` and `email.suppressed`.
   - **SES:**
     - Send bounce and complaint notifications to an SNS topic, ideally with the topic attribute `SignatureVersion` set to `2`.
     - Subscribe `https://<your site>/api/webhooks/ses` to that topic over HTTPS. The Worker confirms the subscription itself.
     - Set `SES_SNS_TOPIC_ARN` to the topic's ARN; messages from any other topic are refused.
   - **Mailgun:** add webhooks for *Permanent Failure*, *Spam Complaints* and *Unsubscribes* to `https://<your site>/api/webhooks/mailgun`.
   - **Postmark:** add a webhook to `https://USER:PASSWORD@<your site>/api/webhooks/postmark`, using the user and password you set as secrets, for *Bounce*, *Spam Complaint* and *Subscription Change*.
5. **Add the form to your site.** Copy the form from [`public/index.html`](public/index.html). It needs to POST to `/api/subscribe` with an `email` field and the hidden `website` honeypot field.

Local development: copy `.dev.vars.example` to `.dev.vars`, fill it in, then `npm run dev`.

## Sending speed

| Setting | Default | What it does |
|---|---|---|
| `SEND_MODE` | `standard` | `standard`: one email per request. `bulk`: the service's batch feature. |
| `EMAILS_PER_RUN` | `20` | Announcement emails per run. Runs happen every minute. |
| `MAX_PARALLEL` | `4` | Requests in flight at once (at most 6). |
| `REQUESTS_PER_SECOND` | `2` | Pacing, to stay under your service's rate limit. |
| `DAILY_SEND_LIMIT` | `100` | All emails per UTC day. `0` = no limit. Approximate: two overlapping runs can go slightly over, and your service's own limit then pauses sending until the next run. |

**On the Workers Free plan**, keep the defaults: about 20 emails a minute. That plan allows 50 outside requests and 10 ms of CPU per run.

**On Workers Paid** you can go much faster. Some examples (check your service's limits):
- **Resend, bulk:** `SEND_MODE=bulk`, `EMAILS_PER_RUN=50000`, `REQUESTS_PER_SECOND=9`, `DAILY_SEND_LIMIT=0` gives up to about 450,000 emails an hour (Resend allows 10 requests a second by default).
- **Postmark, bulk:** 500 per request, with no hard rate limit.
- **SES:** limited by your account's approved sending rate. Each recipient counts.

A run stops starting new requests after about 50 seconds, so runs don't pile up.

## Sending an announcement

The easiest way is the Perchlight desktop app. By hand, add the rows to D1 in one go:

```sql
INSERT INTO announcements (subject, body_text, status, queued_at)
VALUES ('Version 2 is out', 'Hi!\n\nHere''s what''s new...', 'queued', datetime('now'));

INSERT OR IGNORE INTO deliveries (announcement_id, subscriber_id)
SELECT last_insert_rowid(), id FROM subscribers WHERE status = 'confirmed' AND block_reason IS NULL;
```

The Worker picks it up within a minute. `body_html` is optional; without it, the text is sent as simple paragraphs.

**Tracking and fixing problems** (all in D1; the desktop app shows these with buttons):

| You see | Meaning | What to do |
|---|---|---|
| `deliveries.status = 'sent'` / `'skipped'` | Delivered, or skipped because the person unsubscribed or was blocked | Nothing |
| `'failed'` | Refused for that address (with the reason in `error`) | Nothing, or check the address |
| `'unknown'` | The request went out, but its outcome couldn't be confirmed (a timeout, a crash, or a 5xx server error, which can come after the service accepted the email) | Check your email service's logs. To re-send to them: `UPDATE deliveries SET status = 'pending' WHERE status = 'unknown' AND announcement_id = ?`. The announcement re-opens by itself. |
| `announcements.status = 'paused'` | Explained in `last_error`: a setup problem; your email service looking down (several sends with no clear result); or, once per announcement, every email in a run refused the same way, so you can check your setup before the whole list is marked failed | Fix it (and re-queue any `unknown` rows that weren't delivered), then `UPDATE announcements SET status = 'sending' WHERE id = ?` |

## Test before you rely on it

**What the authors have *not* tested, because it costs money:** real sends through Resend, Amazon SES, Mailgun, Postmark or Cloudflare Email, real bounce and complaint webhooks from those services, and the high-speed settings on Workers Paid. Everything in this project is tested automatically against fake versions of each service built from their published documentation (`npm test`), but not against live accounts. **Please do one real test on your own account before sending to a real list.** Free tiers are enough for that test with Resend, Mailgun, Postmark and the SES sandbox.

The tests use fake versions of each service built from their documentation. Before sending to a real list, send an announcement to a list of just yourself, and check:
- the email arrives with the right unsubscribe link
- your mail app's one-click unsubscribe works
- a bounce to a deliberately bad address marks it bounced

Two things in particular need checking against your own account:
- **Mailgun bulk:** each person's `List-Unsubscribe` header uses Mailgun's `%recipient%` substitution, which Mailgun's docs don't confirm for headers. Check the header in a received email. Mailgun's own unsubscribe webhook is handled too, as a backup.
- **Postmark broadcast streams:** by default (`POSTMARK_UNSUBSCRIBE=postmark`) Postmark adds its own unsubscribe link and headers, and those unsubscribes come back through the Subscription Change webhook. `self` sends this project's headers instead, which needs Postmark support to enable "manage unsubscribes on your own". Use your stream's real ID: it may be `broadcast` or `broadcasts`.

**Cloudflare Email Service** is in beta. Check whether your account supports custom headers such as `List-Unsubscribe`; it doesn't report bounces.

## API

| Endpoint | What it does |
|---|---|
| `POST /api/subscribe` | Form or JSON: `email`, optional `source`, `cf-turnstile-response`, and the `website` honeypot. Send `Accept: application/json` for a JSON reply; otherwise it redirects to `/list/check-inbox/` or `/list/problem/`. |
| `GET` / `POST /api/confirm?token=` | GET shows the confirm page; POST confirms. |
| `GET` / `POST /api/unsubscribe?token=` | GET shows the page; POST unsubscribes. Mail apps' one-click POST gets a plain 200, as RFC 8058 requires. |
| `POST /api/webhooks/{resend,ses,mailgun,postmark}` | Bounce, complaint and unsubscribe events, each verified. |

The pages in `public/list/` are plain HTML. Restyle them to match your site. Refresh the disposable-domain list with `npm run update-blocklist`, then redeploy.

## Your responsibilities

Running a mailing list means following the anti-spam and privacy laws where you and your subscribers are, such as CAN-SPAM in the US and GDPR in the EU. Double opt-in, one-click unsubscribe and the postal-address footer help, but you're responsible for how you use the list. This software is provided as-is, without warranty (see [LICENSE](LICENSE)).

## Credits

- Disposable domains: [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (CC0 1.0).
- Perchlight is an independent project. It is not affiliated with, endorsed by, or sponsored by Cloudflare, Inc., Resend, Amazon Web Services, Mailgun or Postmark. Their names are trademarks of their respective owners.

## License

[MIT](LICENSE)
