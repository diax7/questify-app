# Runbook

> How to run, check and repair Questify. Each entry says what to do, not why (the why is in the ADRs).

## Local checks

- `pnpm ci:changed`: lint, format check, types and all tests (what the pull-request gate runs).
- `pnpm ci:full`: `ci:changed` plus the dependency audit and the mutation check (about 20 minutes with the database
  tests; run it before merging core changes, in the background).
- Integration tests need a throw-away PostgreSQL: `docker compose up -d`, then set
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`. Without it they are skipped, and
  a skipped database test proves nothing: check the count of passed tests.
- CI (`.github/workflows/ci.yml`): one job, a PostgreSQL 17 service, secret scan, `ci:changed`, the API build,
  `pnpm audit`; then, only when `scripts/ci-scope.mjs` says the change needs them, the web build and the browser
  tests (web app, shared package, lockfile, workflow, API source or migrations).
- Browser tests locally (web app): `pnpm --filter @questify/web build`, then
  `pnpm --filter @questify/web e2e` with `TEST_DATABASE_URL` set (first time: `pnpm --filter @questify/web exec
  playwright install chromium`). Run them before merging any web, shared or API change; they are part of `ci:full`
  in spirit and take about a minute.

## Staff sign-in

Settings: `DATABASE_URL`, `AUTH_SECRET` (32+ characters), `DASHBOARD_ORIGIN`, `GMAIL_SERVICE_ACCOUNT_KEY`, `MAIL_FROM`,
optional `GMAIL_ACT_AS` (the mailbox to act for when `MAIL_FROM` is an alias), optional `RESEND_API_KEY` + `RESEND_FROM`, `SECURITY_ALERT_EMAIL`, `TRUST_PROXY_HOPS`. All come from the host's
secret store, never from chat or the repository. The app refuses to start without the required ones.

**Create an account** (inside the app container, with the owner connection; the password is piped in, never
typed on the command line or kept in an environment variable):

    printf '%s' "$PASSWORD" | node staff.cjs create someone@example.com [--admin]

**A person is locked out ("too many attempts")**: wait 15 minutes, or free them now:

    node staff.cjs clear-throttle someone@example.com    # needs AUTH_SECRET in the environment

If an attacker keeps a known admin email throttled, this is also the way back in; the address limit may need the
same attention if the attacker rotates addresses (look for the `staff.throttled` log lines).

**"Too many sign-in codes" (5 an hour)** can be caused by someone who knows the password. `clear-throttle` frees it
too; then change the password (dashboard, My account) or reset it.

**A locked-out admin (or anyone), in order:**
1. Forgot the password: "Forgot your password?" on the sign-in page emails a link (30 minutes, one use). Using it
   ends every session and clears the sign-in lockout, so the next sign-in works.
2. Throttled, or the reset requests are used up (3 an hour per email): `node staff.cjs clear-throttle <email>` clears
   the failures, the code count and the reset-request count.
3. Lost the mailbox: there is no web way back (the mailbox is the second factor, ADR-078). With the owner connection,
   disable the account and create a new one; record it.

**`staff.outbound_cap` in the log** (sign-up answers 503, invites answer `mail_cap`): the day's budget of 400 sign-up and
invite emails is spent. Sign-in and reset codes are not counted and still go out. Look for an abuse pattern (many
sign-ups from one address range); the budget refills over 24 hours, or raise `outboundMailPerDay` in
`apps/api/src/auth/limits.ts` if the traffic is real.

**Invite links answer 429 for many people at one site** (launch day behind one office network): looking at and
accepting invite links share 20 an hour per client address (`inviteChecksPerAddress` in
`apps/api/src/auth/limits.ts`). Raise it for the day, or ask people to open their link from a phone's own network.

**`event.lifecycle_failed` in the log** (with `reason` and the SQLSTATE `code`): the 30-second tick could not move events
through their lifecycle. Once is harmless: the next tick catches up, and every status shown is read at the moment, so
no one waits on the tick. Repeated for more than five minutes: check the database (`55P03` is a lock timeout, `08…` a
lost connection); to move due events by hand, run `SELECT advance_event_lifecycle();` with the API's role.

**`staff.breach_check_unavailable` in the log** (password set answers 503): the API cannot reach
`api.pwnedpasswords.com`. Check outbound HTTPS from the API container; nothing is changed while it is down.
`staff.password_notice_failed` means a "password changed" email did not go out (see the email senders below).

**Both email senders are down** (`staff.email_unavailable` in the log, sign-in answers 503): nobody can sign in.
The log line names the step and Google's reason (`unauthorized_client`: the domain-wide delegation or its scope is missing; `invalid_grant`: the mailbox in `GMAIL_ACT_AS` or `MAIL_FROM` is not a real user, or the clock is off). Check Google's daily sending limit, then Resend's key and domain. A sender that is
configured but wrong shows as `staff.email_failover` first.

**Force a person out**: end their sessions from the database owner connection
(`UPDATE staff_session SET revoked_at = now() WHERE staff_user_id = '...' AND revoked_at IS NULL`), then record it
in the same transaction:
`INSERT INTO audit_log (actor_type, action, target_type, target_id) VALUES ('system', 'staff.session.end_all', 'staff_user', '...')`.
The admin screen for this arrives with T-701.

**Audit log**: read it from the owner connection (`SELECT * FROM audit_log ORDER BY id DESC LIMIT 50`). No one can
change or remove an entry, the owner included; do not try to work around the triggers.

**Rotating `AUTH_SECRET`**: kills open sign-in codes and resets the throttle windows; nothing stored depends on
it. Sessions stay valid. Do it when someone with access leaves or the secret may have leaked.

## Email sending (ADR-112)

Sender: `questify@nafes.com`, through the Gmail API. Done once by the admin of the `nafes.com` Google Workspace.
No password or key ever goes into chat, the repository or a doc.

Already in place on `nafes.com` (checked 2026-10-20): Google Workspace mail, SPF `include:_spf.google.com`, DKIM
(`google._domainkey`, 2048-bit) and DMARC `p=none` with reports to `dmarc@nafes.com`. DNS is on Cloudflare.

1. **Mailbox:** `questify@nafes.com` is an **alias** of an existing user (the user's choice, 2026-10-20). The service
   account acts for that user and sends with the alias as From; if Google refuses the alias as the sign-in subject,
   set `GMAIL_ACT_AS` to the real mailbox. Sent codes appear in that user's Sent folder, and replies reach them.
   Set up on 2026-10-20: the alias belongs to `system@nafes.com` (`GMAIL_ACT_AS=system@nafes.com`), and
   `questify@nafes.com` was added to that mailbox's Gmail settings under "Send mail as"; without that step Gmail
   rewrites the From line to `system@nafes.com`.
2. **Google Cloud:** in console.cloud.google.com (signed in as a nafes.com admin) create a project `questify-mail`,
   enable the **Gmail API**, create a **service account** `questify-mailer`, and create a **JSON key** for it. If key
   creation is blocked ("Disable service account key creation" organization policy), allow it for this project only.
3. **Permission:** Workspace Admin console, Security, Access and data control, API controls, **Manage domain-wide
   delegation**, Add new: the service account's **client ID** (a long number on the service account page) with exactly
   one scope: `https://www.googleapis.com/auth/gmail.send`.
4. **Secrets:** in CranL, app `questify-api-staging`, Environment: add `GMAIL_SERVICE_ACCOUNT_KEY` = the whole JSON
   key file's content, and `MAIL_FROM` = `questify@nafes.com`. Then delete the downloaded key file.
5. **Check:** sign in on staging with a Gmail address; in Gmail, "Show original" must say SPF, DKIM and DMARC PASS.
   Add `nafes.com` to Google Postmaster Tools to watch delivery.

Later, by the domain owner: after two to four weeks of clean DMARC reports, change `p=none` to `p=quarantine`, then
`p=reject` (this covers all of nafes.com's mail).

**Dashboard address:** `questify.nafes.com` gets a DNS record pointing at the CranL web app when it is deployed. In
Cloudflare it must be **DNS only (grey cloud)**: Cloudflare's proxy would add a hop in front of CranL's edge and break
the client-address count (ADR-113).

## Web app (dashboard)

- Image: `Dockerfile.web` at the repository root (CranL builds from the folder holding the Dockerfile), with CranL Dockerfile path `Dockerfile.web`; port 3000; health check on `/en/sign-in`.
- Staging (2026-10-20): app `questify-web-staging`, https://questify-web-staging-4ecphq.cranl.net; the API's
  `DASHBOARD_ORIGIN` is that address until `questify.nafes.com` (CNAME already in Cloudflare, DNS only) is switched on.
- Setting: `API_ORIGIN` = the API's **internal** address, for staging `http://questify-api-staging-3ez01s:3000`
  (never the public https URL: the app refuses to start with one). No secrets in the web app.
- The API's `DASHBOARD_ORIGIN` must equal the web app's public https origin, and `TRUST_PROXY_HOPS=1` (ADR-113).

## Database and deploy

- Migrations: `node migrate.cjs` (owner connection `DATABASE_ADMIN_URL`; `--roles` the first time; `--verify` as the
  app role proves its limits). Remove the owner connection string from the app environment afterwards.
- A deploy on CranL is manual (no webhook): build from the Dockerfile, then check `/healthz` and `/readyz`.
