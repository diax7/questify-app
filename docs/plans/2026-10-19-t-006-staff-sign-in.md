# Plan: T-006 Staff sign-in (revision 2, after CTO review 78/100)

> Quality bar: **Max** (sign-in and sessions are core, ADR-104). Standard: OWASP ASVS 5.0 L2
> (V6 authentication, V7 session management, V11 cryptography, V16 logging). Delivers FR-1725,
> NFR-030. Decisions: ADR-078 (email + password + email code, sessions expire after inactivity).
> Revision 2 answers every blocker (B1 to B4) and major (M1 to M12) in the first review.

## Scope note

Staff (organizer owners, editors, Questify admins) sign in with three steps: email + password, then
a one-time code sent by email, then a session. Nothing staff-only is reachable without all three.

**In scope**
1. Password hashing (argon2id) and a length policy.
2. Sign-in flow: password step, email-code step, resend, sign-out.
3. Sessions: random token in a cookie, stored hashed, idle expiry plus a maximum lifetime, list and
   revoke, "revoke all for a user" (used by T-020 and T-701).
4. One sliding-window throttle, per-challenge attempt limits, and a challenge-creation cap.
5. Email sender: Gmail SMTP primary, Resend backup (user choice, 2026-10-19).
6. A default-deny staff scope: every `/v1/staff/*` route needs a session unless on an explicit
   public allowlist; one sample route `GET /v1/staff/me`.
7. Migration `0002`, same deny-by-default posture, plus isolation and outsider tests.
8. A one-off CLI to create a staff user (needed for the first admin and for the staging check).

**Out of scope (written down)**
- Password reset by email, and the breached-password check that belongs with setting a password
  (both go to new task **T-020**, which also revokes all sessions on a password change, ASVS V7).
  T-006 never sets a password from the web, so the check has no caller yet.
- Dashboard screens (T-011); admin force-sign-out screen (T-701); audit log (T-004): sign-in events
  go to the structured log now and move to the audit log when T-004 lands.
- The database-backed idempotency store (T-105). Only the principal scoping of keys is fixed here.
- Organizer sign-up that creates staff users from the web (T-101).

## Decisions made in this revision

- **Host design (M4):** the dashboard origin reverse-proxies `/v1` to the API (same origin). That
  means no CORS, a host-only `__Host-` cookie that the dashboard's server can also read, `SameSite=Strict`
  that works, and the CSRF `Origin` check is a plain equality with the dashboard origin. Recorded in
  `API.md`; T-011 builds the proxy. The API refuses cross-origin cookie use.
- **Argon2 library (M2):** Node 22 has no built-in argon2 (`crypto.argon2` is 24.7+ and marked
  do-not-land on 22), and a WASM build would block the event loop of a server that also serves live
  players. So `@node-rs/argon2` (native, runs on the libuv thread pool) stays, marked `--external`
  in the esbuild bundle; the Dockerfile installs production dependencies with `pnpm deploy --prod`
  (frozen lockfile) into the runtime stage. A Phase 1 smoke test builds the image and hashes a
  password.
- **One throttle, no lock columns (B4):** no `failed_sign_ins` / `locked_until`. A single sliding
  window keyed by a keyed hash of the email applies equally to existing and unknown emails.
- **Breached-password check moves to T-020.** The admin "new sign-in" alert goes to the account
  email **and** an optional `SECURITY_ALERT_EMAIL` (someone else sees it, R9).

## Design

### Request context for the pre-identity steps (M7)
`withRequestContext` stays for identified callers. A second function,
`withPreIdentityContext(client, lookup, work)`, takes a discriminated `lookup`:
`{kind: "email", email} | {kind: "session", tokenHash} | {kind: "challenge", tokenHash}`.
It sets exactly one setting (`app.auth_email`, `app.session_token_hash`,
`app.challenge_token_hash`), clears every other setting, validates the format (a normalized email,
or 64 hex characters),
and gives `work` a `promote(staffUserId)` function that sets `app.staff_user_id` from a database row
(a UUID check applies). The request never supplies these values; only sign-in code calls them.
The row-level wall is thinner on these paths because trusted code sets the context. That is written
into `SECURITY.md`, and tests assert that one lookup exposes at most one row.

### Tables (migration 0002; RLS forced; explicit grants; no PUBLIC rights)
All hashes are `bytea` with `CHECK (octet_length(...) = 32)`.
- `staff_user`: **revoke** `INSERT` and table-level `UPDATE` from the app role; grant
  `UPDATE (password_hash)` only (for re-hash on sign-in; it works only under the promoted context via
  the `staff_user_own` policy, which is why re-hash is a separate step). Account creation comes from the
  CLI (owner connection) now, and from narrow grants in T-101 / T-701. This closes the mass-assignment
  path to `platform_role` (M6). New policy `staff_user_signin`: `SELECT` where `email = app_auth_email()`
  (the lookup is by the normalized email; no derived key, so no coupling to `AUTH_SECRET`).
- `staff_login_challenge(id, staff_user_id, token_hash unique, code_hash, expires_at, attempts,
  resends, last_sent_at, consumed_at, created_at)`.
  Policies: `SELECT` and `UPDATE` only where `token_hash = app_challenge_token_hash()`; `INSERT` only
  where `staff_user_id = app_staff_user_id()`; `DELETE` where own **or** `created_at` is more than a day
  old (the global retention sweep). The row is never read by `staff_user_id`, so `code_hash` stays
  unreadable. Supersede = `DELETE` own rows; the hourly cap is counted in `auth_throttle`
  (bucket `challenge_user`, key = HMAC of the user id), not by reading this table. The new challenge is
  inserted with its own token hash already set in the pre-identity context, so `INSERT ... RETURNING`
  satisfies the `SELECT` policy (a test performs exactly this insert). Column grants: `UPDATE (attempts,
  resends, code_hash, last_sent_at, consumed_at)`. Index on `(staff_user_id)`.
- `staff_session(id, staff_user_id, token_hash unique, created_at, last_seen_at, expires_at?, revoked_at,
  user_agent, ip)` (no `expires_at` column: expiry is computed from `created_at` and the current role).
  Policies: `SELECT` where own, or admin, or `token_hash = app_session_token_hash()`; `UPDATE` where
  own or token match; `INSERT` where own; `DELETE` where own **or** `COALESCE(revoked_at, last_seen_at)`
  is more than 30 days old (the global retention sweep, so departed staff's IP and user agent are removed
  too). Column grants: `UPDATE (last_seen_at,
  revoked_at)`. A `BEFORE UPDATE` trigger refuses un-revoking and moving `last_seen_at` backward.
  Index on `(staff_user_id)`.
- `auth_throttle(bucket text, key bytea, at timestamptz)`, index `(bucket, key, at)`. Keys are HMACs,
  never plain hashes (M12). Policy: app role may `INSERT`, `SELECT` (count) and `DELETE`; rows hold no
  readable personal data.
- Settings functions return `NULL` for an empty setting (`NULLIF(current_setting(..., true), '')`), so
  an empty value matches nothing. All new functions: `REVOKE ... FROM PUBLIC` in the same migration.

### Keys (M12)
`AUTH_SECRET` (at least 32 characters). Keys derived by HMAC with domain separation:
`throttle_email_key = HMAC(k_email, normalized email)`, `throttle_ip_key = HMAC(k_ip, address)`,
`throttle_user_key = HMAC(k_user, user id)`, `code_hash = HMAC(k_code, challengeId || code)` (bound to
the challenge so equal codes differ across rows). Rotating `AUTH_SECRET` only kills open challenges and
resets the throttle windows; no stored account data depends on it.

### Flow (B1, B3: failures are committed, hashing never holds a connection)
Every failure is a **returned result value**, never a thrown error, so the transaction that records
it commits. The route maps results to HTTP errors afterwards.
1. `POST /v1/staff/auth/password {email, password}`
   - Body validated (Zod): email is normalized (trim, NFKC, lowercase); password 1 to 128 code points
     before any hashing; JSON content type required; body size capped.
   - **Transaction A** (a few milliseconds; `lock_timeout` and `statement_timeout` of 1 s): take
     `pg_try_advisory_xact_lock` on the email key; if the lock is not obtained, answer `429` at once
     (parked requests must never hold pooled connections, R2). With the lock held, **count first**: if
     the `fail_email` window for the email or the `fail_ip` window for the address is at its limit,
     commit and answer `429 too_many_attempts` (with `Retry-After`) without inserting and without
     hashing, so a throttled person does not extend their own lockout. Under the limit: insert the
     reserved attempt rows for `(fail_email, email key)` and `(fail_ip, address key)`. The answer is
     identical for existing and unknown emails because unknown emails are counted too. Then look up the
     user through the email context.
   - **Verify outside any transaction**: through a concurrency gate (at most 4 verifies at once; a 5th
     waits briefly, then `503 busy`, M3). Unknown or disabled user: a dummy verify against a hash made at
     startup with the live parameters. Same time, same `401 invalid_credentials` for unknown, disabled
     and wrong password.
   - **Transaction B**: on success, delete the reserved `fail_email` **and `fail_ip`** rows of this
     attempt (successes must not fill a shared venue address), then count the `challenge_user` bucket
     (refuse with `429` at 5 in the last hour, B2), record this challenge in it, delete the user's
     earlier challenges, insert the new one, commit. Re-hash if the parameters changed. The `429` for
     the challenge cap is visible only to someone holding the correct password.
   - Then **send the email outside any transaction** (see Email). Return `{challengeToken,
     expiresInSeconds}`. If sending fails everywhere: kill the challenge and answer `503
     email_unavailable`.
2. `POST /v1/staff/auth/code {challengeToken, code}`
   - One statement raises `attempts` and returns the row (so concurrent guesses cannot exceed 5).
     Per challenge: 5 attempts in total across resends (resends do not reset it, B2). A wrong code also
     inserts a `(fail_email, emailKey)` row, so failures across challenges feed the same throttle;
     the throttle blocks both steps. The 5th wrong guess answers `401 invalid_code` and the challenge
     is dead; the next call on that challenge answers `410 challenge_expired`. Over the throttle:
     `429`.
   - On a correct code: `UPDATE ... SET consumed_at = now() WHERE consumed_at IS NULL AND expires_at >
     now() RETURNING ...`; zero rows means someone else won the race and nothing is created (M9).
     In the same transaction: re-check the user is still `active`, create the session, update nothing
     else. The cookie is set by the route after commit.
3. `POST /v1/staff/auth/resend {challengeToken}`: at most 3 resends, at least 60 seconds apart; a new
   code replaces the old one (the old stops working); counts toward the challenge cap.
4. `POST /v1/staff/auth/sign-out`: revokes the current session, clears the cookie with identical
   attributes. Works on an already-expired session too (still clears the cookie).
5. `GET /v1/staff/sessions`, `DELETE /v1/staff/sessions/:id`: own sessions only; the current one is
   marked. `GET /v1/staff/me`: id, email, platform role, memberships.

### Default-deny HTTP scope (M5)
Staff routes are registered inside one Fastify scope whose `onRequest` hook requires a valid session.
The sign-in routes are listed in an explicit public allowlist. A test walks Fastify's route list
(`onRoute`) and fails if any route is neither allowlisted nor answering `401` without a cookie. Another
test proves password-only and challenge-only callers reach nothing. The hook runs in `onRequest`, so the
idempotency `preHandler` sees the principal. Sign-in routes are never marked `idempotent` (they carry
secrets). `request.staff` and `principalId` are typed by a Fastify declaration, replacing the cast in
`conventions.ts`. All `/v1/staff/*` answers carry `Cache-Control: no-store`; 429 answers carry
`Retry-After`.

### Sessions (M8)
- Token: 32 random bytes, base64url, stored as sha256. Cookie `__Host-qs_session`: `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`, no `Domain`.
- Validate in **one short transaction**: `SELECT` the session by token hash (pre-identity context; no
  row lock, so a dashboard's parallel fetches do not serialize), promote to the user, read the user's
  current status and role. Idle limit and maximum age
  come from the user's **current** role: staff 30 min idle / 12 h max; platform admin 15 min / 8 h
  (constants in config; platform settings can own them after T-007). Expired or revoked or user
  disabled: commit a revocation, return a result, the route answers `401 session_expired` and clears
  the cookie. Otherwise update `last_seen_at` only if it is more than 60 seconds old.
- The `Origin` header of every unsafe request must equal `DASHBOARD_ORIGIN` (else `403 csrf_rejected`).
- A new session of a **platform admin** emails the account and `SECURITY_ALERT_EMAIL` ("new sign-in").
- At most 10 live sessions per user; opening the 11th revokes the oldest.
- Retention: at each sign-in, a bounded sweep (`LIMIT 100`) deletes any sessions that ended over 30
  days ago and any challenges older than a day, for all users (so departed staff's IP and user agent go
  too); `auth_throttle` rows older than a day are deleted when the throttle runs.

### Trust of proxy headers (M1, R3)
`trustProxy: true` is replaced by `TRUST_PROXY_HOPS`. The intended chain is **CranL edge -> dashboard
(Next.js proxy for `/v1`) -> API**, so the API sits behind two hops and the dashboard proxy must
forward `X-Forwarded-For` (written into T-011). The setting is checked on staging against the real
chain (T-011 repeats it); until the proxy exists the value is 1 (edge only). IPv6 addresses are keyed on
their /64 prefix. A test shows a spoofed `X-Forwarded-For` does not change the throttle key. The address
bucket degrades safely: a `429` from it logs which bucket fired, and one address key accounting for most
sign-in traffic raises an alert (T-018) rather than silently locking everyone out; staff are never
locked out by the address bucket alone for a correct password (the per-address limit counts failures
only, and successes remove their rows).

### Passwords
argon2id: 19 MiB, 2 passes, 1 lane (OWASP minimum profile), one constant; re-hash on sign-in when
parameters change (done after a successful verify, in its own short step, so a correct password is not
measurably slower in a way that helps an attacker). Policy (for the CLI now, T-020 later): 12 to 128
**code points** after NFKC, no composition rules, not equal to the email. Tests with Arabic and emoji.

### Email (M10)
`EmailSender.send({to, subject, text})`. Implementations: `SmtpEmailSender` (nodemailer; connection,
greeting and socket timeouts of 5 s each), `ResendEmailSender` (plain `fetch`, 5 s timeout),
`FailoverEmailSender` (primary, then backup; total cap 8 s; both fail raises a typed error),
`RecordingEmailSender` (tests only, in `test/support`). The code email is bilingual (Arabic first),
Western digits, never logged. The same code is sent by both senders (no new code on failover).
Gmail sends `From` the authenticated account (it rewrites it otherwise). Resend needs a **verified
sending domain** (SPF and DKIM), so `RESEND_FROM` is required whenever `RESEND_API_KEY` is set and the
app refuses to start without it. The backup therefore needs a domain that Dhia owns (for example the
Questify domain once chosen); until then Resend stays unconfigured and failover is off.
**The Gmail account must be a dedicated Google account** with an app password, not a personal mailbox
(an app password grants full mailbox access). Gmail and Resend are foreign providers: they are added to
the data map (NFR-020), to `INTEGRATIONS.md` as a time-limited exception to the in-region preference,
and to the counsel batch (T-807).

### Config and wiring
Fail fast in production if missing: `DATABASE_URL`, `AUTH_SECRET`, `DASHBOARD_ORIGIN`, `SMTP_USER`,
`SMTP_APP_PASSWORD`. Optional: `RESEND_API_KEY` with `RESEND_FROM` (both or neither), `SECURITY_ALERT_EMAIL`,
`TRUST_PROXY_HOPS`. The Dockerfile sets `UV_THREADPOOL_SIZE=8` (the verify gate is 4, so the pool that also
serves DNS and file work is never fully taken by hashing; a smoke check resolves a name while 4 hashes
run). Every auth transaction sets `lock_timeout` and `statement_timeout`.
`buildApp` takes a `pool` and an `emailSender`; `/readyz` checks the database.

### Logging and signals (M11)
Events (`staff.password_ok`, `staff.password_failed`, `staff.throttled`, `staff.code_failed`,
`staff.session_opened`, `staff.session_revoked`, `staff.email_failover`, `staff.email_unavailable`):
user id (when known), event, request id, and a truncated keyed hash of the address. Never the email,
IP, password, code, token. `set-cookie` is redacted. Counters for failover, both-senders-down,
throttle hits and failure spikes are exposed on the log line now and wired to alerts in T-018. That is
a **recorded deviation** from the core Definition of Done (alert part only): it is written into
`TASKS.md` (T-018 depends on it and must wire these signals) and `STATE.md`. A runbook entry covers
"admin locked out", "challenge cap burned by someone with the password" and "both email senders down"
(no reset exists until T-020; the CLI can clear the throttle for an email).

### The CLI
`staff-cli.ts` runs with the owner database connection (`DATABASE_ADMIN_URL`, delivered like the migration
runner's, never stored in the app environment). Commands: `create <email> [--admin]`, `clear-throttle
<email>`. The password is read from a hidden prompt or stdin, never argv or an environment variable.

## Files

Create under `apps/api/src/auth/`: `password.ts`, `keys.ts` (HMAC, token hash, code), `throttle.ts`,
`verify-gate.ts`, `email/{sender,smtp,resend,failover,templates}.ts`, `staff-store.ts` (SQL),
`sign-in.ts`, `session.ts`, `routes.ts`, `staff-scope.ts`; `apps/api/src/db/pre-identity.ts`;
`apps/api/src/staff-cli.ts`; `apps/api/migrations/0002_staff_sign_in.sql`. Modify `config.ts`, `app.ts`,
`server.ts`, `conventions.ts`, `Dockerfile`, `apps/api/package.json`, `stryker.config.json` (the new
core files are in scope), and the docs: `API.md`, `DATA_MODEL.md`, `SECURITY.md` (ASVS V6/V7/V11/V16
evidence table, thinner-RLS note), `INTEGRATIONS.md`, `OPEN_QUESTIONS.md` (Q-034), `TASKS.md` (add T-020;
notes on T-004 and T-011), `STATE.md`. New dependencies: `@node-rs/argon2`, `nodemailer` (+ types), `zod`
(request validation at the boundary, used by the shared package later too). All versions looked up
2026-10-19; install scripts stay blocked.

## Phases (each ends with a CTO review, score at least 90, no blocker)

1. **Database and image.** Migration 0002, `pre-identity.ts`, isolation tests, Dockerfile change and an
   image smoke test (hash a password inside the image).
2. **Primitives.** Passwords, keys, code generation, verify gate, email senders and templates. Unit and
   property tests; mutation score at least 90% on these files.
3. **Flow and routes.** Store, throttle, sign-in, sessions, scope, routes, wiring, config, CLI.
   Integration tests on real PostgreSQL through `app.inject`. Mutation scope includes `sign-in.ts`,
   `session.ts`, `throttle.ts`, `verify-gate.ts` at 90%.
4. **Hardening, docs, live check.** Concurrency, expiry by backdating, cookie flags, log redaction,
   route-walk test, outsider tests; docs; staging: migrate, create a throwaway user by CLI, sign in, delete.

## Tests (written first, each phase)

- Unit: password length edges (11, 12, 128, 129), NFKC and Arabic/emoji, equals-email, parameter
  re-hash, code range and format, HMAC domain separation, constant-time compare on unequal lengths,
  email templates, failover (primary ok, primary fails, both fail, timeout), config validation.
- Integration (real PostgreSQL): all route happy and error paths; **five wrong codes then read
  `attempts` as the table owner (the increment survives the error, B1)**; sixth correct code refused;
  codes at exactly expiry and one second after; attempts persist across resends; new challenge kills
  the old; fifth challenge in an hour allowed, sixth refused (B2); failures across challenges trip the
  throttle (B2); 1,000 parallel password guesses stay within the limit (B3); unknown, wrong and throttled
  all answer the same way, and unknown/wrong both ran a hash (B4); two concurrent correct codes make one
  session (M9); two concurrent wrong guesses; idle and absolute expiry by backdating; disabled user
  mid-session; role change shortens the limits; revoked cannot be un-revoked (trigger); spoofed
  `X-Forwarded-For` does not change keys (M1); idempotency keys scoped per user and never stored for
  sign-in routes; route-walk default-deny (M5); cookie flags and clearing attributes; empty-setting
  matches no row; context for user X exposes nothing of Y; 10-session cap.
- Outsider and cross-tenant: public credential reaches none of the new tables or functions; an editor
  of organizer A reaches nothing of B through the sign-in tables.

## Judgment calls (flag if you disagree)

1. Throttle thresholds (starting values, constants): 8 failures per email and 30 per address per 15
   minutes; 5 challenges per user per hour. A known admin email can be kept throttled by an attacker
   (annoyance, not entry); the runbook has the CLI to clear it.
2. Session limits are constants for now.
3. Gmail SMTP is a stop-gap with a daily cap; the swap point is the `EmailSender` interface.
4. Password reset, breached check and web password setting are deferred to T-020.
