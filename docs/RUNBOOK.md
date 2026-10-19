# Runbook

> How to run, check and repair Questify. Each entry says what to do, not why (the why is in the ADRs).

## Local checks

- `pnpm ci:changed`: lint, format check, types and all tests (what the pull-request gate runs).
- `pnpm ci:full`: `ci:changed` plus the dependency audit and the mutation check (about 20 minutes with the database
  tests; run it before merging core changes, in the background).
- Integration tests need a throw-away PostgreSQL: `docker compose up -d`, then set
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`. Without it they are skipped, and
  a skipped database test proves nothing: check the count of passed tests.
- CI (`.github/workflows/ci.yml`): one job, a PostgreSQL 17 service, secret scan, `ci:changed`, `pnpm audit`.

## Staff sign-in

Settings: `DATABASE_URL`, `AUTH_SECRET` (32+ characters), `DASHBOARD_ORIGIN`, `SMTP_USER`, `SMTP_APP_PASSWORD`,
optional `RESEND_API_KEY` + `RESEND_FROM`, `SECURITY_ALERT_EMAIL`, `TRUST_PROXY_HOPS`. All come from the host's
secret store, never from chat or the repository. The app refuses to start without the required ones.

**Create an account** (inside the app container, with the owner connection; the password is piped in, never
typed on the command line or kept in an environment variable):

    printf '%s' "$PASSWORD" | node staff.cjs create someone@example.com [--admin]

**A person is locked out ("too many attempts")**: wait 15 minutes, or free them now:

    node staff.cjs clear-throttle someone@example.com    # needs AUTH_SECRET in the environment

If an attacker keeps a known admin email throttled, this is also the way back in; the address limit may need the
same attention if the attacker rotates addresses (look for the `staff.throttled` log lines).

**"Too many sign-in codes" (5 an hour)** can be caused by someone who knows the password. `clear-throttle` frees it
too; then change the password (no web reset exists until T-020).

**Both email senders are down** (`staff.email_unavailable` in the log, sign-in answers 503): nobody can sign in.
Check the Gmail app password and Google's sending limit, then Resend's key and domain. A sender that is
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

## Email domain (ADR-112)

Sending address: `noreply@questify.nafes.com`, through the Gmail API. Done once, by whoever controls `nafes.com`'s
DNS and the Google accounts. No password or key ever goes into chat, the repository or a doc.

1. **Google Workspace:** sign up (Business Starter is enough) with `questify.nafes.com` as the domain, or add it as
   a secondary domain if `nafes.com` already has Workspace. Verify it with the TXT record Google shows.
2. **Mailbox:** create the user `noreply@questify.nafes.com` (one licence). Turn on 2-Step Verification for the admin.
3. **DNS on `questify.nafes.com`:**
   - MX: Google's MX record (`smtp.google.com`, priority 1), so bounces and replies have a home.
   - SPF: TXT `v=spf1 include:_spf.google.com ~all`.
   - DKIM: Admin console, Apps, Google Workspace, Gmail, Authenticate email: generate a **2048-bit** key, add the TXT
     record at `google._domainkey.questify.nafes.com`, then press **Start authentication**.
   - DMARC: TXT at `_dmarc.questify.nafes.com`: `v=DMARC1; p=none; rua=mailto:dmarc@questify.nafes.com; adkim=s; aspf=s`.
     After two to four weeks of clean reports change `p=none` to `p=quarantine`, later to `p=reject`.
4. **Gmail API access without a password:** in Google Cloud, create a project, enable the **Gmail API**, create a
   **service account**, and create a JSON key for it (if the organization policy "Disable service account key
   creation" blocks it, allow it for this project only). In the Workspace Admin console, Security, API controls,
   **Domain-wide delegation**: add the service account's client ID with exactly one scope,
   `https://www.googleapis.com/auth/gmail.send`.
5. **Secrets:** put the JSON key into the CranL secret store of `questify-api-staging` (the variable name comes with
   T-021). Delete the downloaded file afterwards.
6. **Watch the reputation:** add the domain to Google Postmaster Tools. Test by sending a code to a Gmail address and
   opening "Show original": SPF, DKIM and DMARC must all say PASS.

Also good for staying out of spam: one fixed "From" name, a plain-text part in every message, no link shorteners, and
a slow start in volume. Resend (backup) gets its own subdomain `send.questify.nafes.com` with its own SPF and DKIM.

## Database and deploy

- Migrations: `node migrate.cjs` (owner connection `DATABASE_ADMIN_URL`; `--roles` the first time; `--verify` as the
  app role proves its limits). Remove the owner connection string from the app environment afterwards.
- A deploy on CranL is manual (no webhook): build from the Dockerfile, then check `/healthz` and `/readyz`.
