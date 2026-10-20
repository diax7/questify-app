# T-020 — Staff password reset and password change

**Task (TASKS.md):** reset by email link, breached-password check (k-anonymity range API, `Add-Padding`, 3 s timeout,
listed in the data map) on every set, revoke all of the user's sessions on a change or reset (ASVS V7); done when a
locked-out admin has a documented way back. Delivers FR-1725 (recovery). Depends on T-006 (done). Quality bar:
**Max** (sign-in is core).

Revision 2 (after CTO review 1, 84/100; review 2: GO 94/100, Phase B order fixed as below): B1 retry, M1 lockout recovery, M2 consume-by-delete, M3 CLI set path and
policy typing, M4 tracked background work, m1–m8, n1–n2.

## Scope note

- Today two paths set a staff password: `staff-cli create` (an **operator-chosen** password from stdin) and the
  silent rehash on sign-in (same password, new parameters). The policy in `password.ts` is used only by the CLI; the
  breach check does not exist (SECURITY.md says it "arrives with T-020").
- Reuse: the pre-identity context (one row by token hash), the throttle buckets and reservation pattern, the verify
  gate, `recordAudit`, the email sender and templates, the staff route scope (origin check, session hook, public
  list), `staff-admin.clearThrottleFor`, the web sign-in building blocks and `post-json.ts`.
- Out of scope: player accounts (codes, no password), admin-forced resets (T-704/T-709), a sessions page in the web.

## Behaviour

### Reset (signed out)

1. `POST /v1/staff/auth/reset/request` `{ email, lang }` — public, origin-checked like the sign-in steps.
   Body: `email` string 3–254, `lang` `z.enum(["ar","en"])` (it is placed in the emailed URL path).
   - **Before the reply, for every email:** normalize; check and record the per-email key (3 an hour, bucket
     `reset_email`) and per-address key (10 an hour, `reset_address`). Over a limit: `429 too_many_attempts` with
     `retry-after`. These counts are keyed by what the caller sent, so they reveal nothing about existence.
   - Then answer **`202 {}`**, the same for every email, and hand the rest to the tracked background runner (`defer`):
     look up the account; if active, delete its reset rows (bare delete after promote), insert one with a fresh
     256-bit token (hash stored), valid 30 minutes, and email the link
     `DASHBOARD_ORIGIN/{lang}/reset-password#token=<token>`. The token is in the fragment, so it never reaches a
     server log, a proxy or a `Referer`. Unknown or disabled: nothing is sent. The email itself is bilingual like the
     existing templates; `lang` only picks the link's page language.
   - The background task catches everything and logs `staff.reset_failed` / `staff.reset_email_unavailable` with the
     error name only.
2. `POST /v1/staff/auth/reset/confirm` `{ token, newPassword }` — public, origin-checked. `token`
   `^[A-Za-z0-9_-]{43}$`, `newPassword` max 1024.
   - A full `fail_address` window answers 429 before any lookup.
   - **Phase A (read-only transaction, pre-identity kind `reset`):** find the row by token hash. Unknown hash → record
     one `fail_address` failure, `410 reset_link_invalid`. Expired → the same 410 without a recorded failure (an
     honest person clicking an old email; `fail_address` is shared with sign-in behind an office NAT). Promote, read
     the account; disabled → 410. Returns the account's id and email.
   - **Outside any transaction:** `checkPasswordPolicy(newPassword, email)` (422 on failure), breach check (422
     `breached` or 503), argon2id hash through the verify gate (503 `busy` when full).
   - **Phase B (one transaction, kind `reset`):** (`withPreIdentityContext` commits whenever `work` returns, so every
     refusal happens before anything is written)
     1. Promote with the user id from Phase A; re-read the account; disabled since Phase A → 410 before any write.
     2. `DELETE FROM staff_password_reset WHERE expires_at > now() RETURNING staff_user_id` — consumes the link by
        deleting it (the database clock decides expiry). Zero rows → 410 (a second confirm racing this one waits on
        the row lock, then finds nothing). A returned id that differs from the promoted one throws (cannot happen;
        defence in depth).
     3. Bare `DELETE FROM staff_password_reset` (the policy picks the user's other rows).
     4. Set the hash; revoke **every** live session; delete the user's sign-in challenges.
     5. Clear the user's `fail_email` and `challenge_user` throttle keys: the person just proved the mailbox and the
        old password is gone, so an old lockout protects nothing (reset is the self-service unlock).
     6. Audit `staff.password.reset` with `after: { sessionsEnded: n }` (no hash, no token).
   - Then the "password changed" notice (below) through `defer`. Answer `204`. The person signs in again with
     password and email code (ADR-078 keeps the second factor).

### Change (signed in)

`POST /v1/staff/password` `{ currentPassword, newPassword }` (both max 1024) — staff scope (session + origin).

1. `checkPasswordPolicy(newPassword, email)` first: an obviously weak new password gets a fast 422 without spending a
   lockout slot, a gate place or an outbound call.
2. Reserve a failure in `fail_email` and `fail_address` (the sign-in pattern); a full window answers 429.
3. Verify the current password through the verify gate. Wrong → `403 current_password_wrong` (not 401, which the web
   reads as a lost session); the reserved failure stays, so wrong guesses share the sign-in lockout. Right → release
   the reservation.
4. Breach check (only now, so an unauthenticated caller never drives outbound calls), then hash.
5. One transaction: set the hash; revoke every **other** live session; delete the user's challenges and reset rows;
   audit `staff.password.change` with `after: { sessionsEnded: n }`.
6. The notice through `defer`. Answer `204`.

**Change keeps the current session (deviation from the TASKS wording, recorded).** TASKS says "revoke all of the
user's sessions on a change or reset". ASVS 5.0 V7.4.3 asks for all *other* sessions after a change, and throwing
the person out mid-task gains nothing: they just proved the current password inside a session that already passed
the email code. The session token is not rotated (rotation would restart the 12-hour maximum without the second
factor). Reset revokes all. TASKS wording is corrected when ticking, with this reason.

### Password policy on every set

- `checkPasswordPolicy` stays synchronous. Reasons: `too_short` (< 12 code points after NFKC), `too_long` (> 128),
  `same_as_email`, and new `context_word` (contains, case-insensitive, `questify`, `nafes`, or the email's local
  part when it is 4+ characters; ASVS V6.2.11). No composition rules (ASVS V6.2.5).
- At the flow level `WeakReason = PolicyReason | "breached"`; the answer is `422 weak_password` with
  `details.reason`. `staff-admin.ts` `REASONS` gains `context_word` and `breached`.
- `staff-cli create` (`createStaffAccount`) runs the same breach check; unreachable → a plain error ("the breached-
  password check is unreachable; try again"), no skip flag.

### Breached-password checker (`src/auth/breached.ts`)

- SHA-1 of the NFKC-normalized password, uppercase hex; `GET https://api.pwnedpasswords.com/range/<first 5>` with
  `Add-Padding: true` and a `user-agent`; parse `SUFFIX:COUNT` lines; a suffix match with count > 0 is breached
  (padding rows have count 0).
- **Timeout, retry, fallback (rule 5):** one overall 3 s deadline over the whole check. On a network error, a 5xx or a
  429, retry once, only if at least 1 s of the deadline is left. Anything else (deadline spent, second failure, other
  non-200) throws `BreachCheckUnavailable`. **Fail closed:** the flows answer `503 breach_check_unavailable` with
  `retry-after: 30` and change nothing; the log line `staff.breach_check_unavailable` carries the error name only.
- Injected as `BreachCheck = (password) => Promise<boolean>` (true = breached; throws when unavailable), so unit and
  integration tests and the e2e server use fakes; no network in tests.
- Data map: only 5 hex characters of a SHA-1 leave the server; no personal data. Listed in INTEGRATIONS (with the
  timeout, retry and fallback) and SECURITY.

### Tracked background work

`createDeferred()` returns `{ defer(task), idle() }`: `defer` adds the promise to a `Set` (removed when settled; the
task catches and logs its own errors), `idle()` awaits everything pending. `server.ts` awaits `idle()` in Fastify's
`onClose` with a 5 s cap; tests await `idle()` before asserting on mail. No concurrency limiter: the 10-an-hour
address throttle bounds it.

### The "password changed" notice

Bilingual in one message, Arabic first (ux-araby): the time in Riyadh, and "if this was not you, reset your
password: `DASHBOARD_ORIGIN/ar/forgot-password`" (plus the English line with `/en/`). No token. A platform admin's
notice also goes to `SECURITY_ALERT_EMAIL`.

## Data (migration `0007_password_reset.sql`)

```sql
CREATE TABLE staff_password_reset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- index on staff_user_id; ENABLE + FORCE row level security; nothing for PUBLIC
-- app.reset_token_hash setting + app_reset_token_hash() (REVOKE from PUBLIC, EXECUTE to questify_app)
-- SELECT:  token_hash = app_reset_token_hash()
-- INSERT:  staff_user_id = app_staff_user_id()
-- DELETE:  staff_user_id = app_staff_user_id() OR token_hash = app_reset_token_hash()
--          OR created_at < now() - interval '1 day'
-- GRANT SELECT, INSERT, DELETE (no UPDATE: a link is consumed by deleting it)
```

- `pre-identity.ts`: lookup kind `{ kind: "reset", tokenHash }` → `app.reset_token_hash`; the settings list grows by
  one and every other setting is still cleared.
- Revoking sessions: `UPDATE staff_session SET revoked_at = now() WHERE staff_user_id = $1 AND revoked_at IS NULL
  [AND id <> $2]` under the promoted user (existing `session_update` policy).
- Sweep: `sweepRetention` also issues the bare `DELETE FROM staff_password_reset`.
- `staff-admin.clearThrottleFor` also clears the `reset_email` key.

## Files

- API: `migrations/0007_password_reset.sql`; `src/db/pre-identity.ts`; `src/auth/limits.ts`;
  `src/auth/throttle.ts` (`BUCKETS.resetEmail`, `resetAddress`); `src/auth/password.ts`
  (`context_word`); `src/auth/breached.ts`; `src/auth/deferred.ts`; `src/auth/password-reset.ts` (request, confirm,
  change; ≤100 lines per function); `src/auth/staff-store.ts`; `src/auth/staff-admin.ts` (REASONS, breach check,
  clearThrottleFor); `src/auth/email/templates.ts`; `src/auth/http-errors.ts` (`weak_password`,
  `reset_link_invalid`, `current_password_wrong`, `breach_check_unavailable`); `src/auth/routes.ts`; `src/server.ts`,
  `src/staff-cli.ts`, `test/e2e-server.ts` (wire the checker; e2e fake treats one fixed password as breached).
- Tests:
  - `test/auth/password-reset.int.test.ts`: request for known, unknown and disabled emails answers the same and only
    the known one gets mail; request throttles; a link works once; expired and unknown links (only unknown records a
    failure); two confirms racing (one wins); disabled between phases (410, link still present); all sessions revoked
    on reset, all but current on change; challenges and other reset rows gone; audit rows hold no secret; each weak
    reason; breached → 422; checker down → 503 and nothing changed; wrong current password counts toward the
    sign-in lockout; **an email locked by 8 failures is reset, then the first sign-in works**; the notice goes out;
    an admin's notice reaches the security mailbox; logs never hold the email, token or password.
  - `src/auth/breached.test.ts`: prefix sent, `Add-Padding` sent, padding rows ignored, retry once on 5xx/network,
    no retry when under 1 s left, 4xx not retried, deadline → unavailable.
  - `src/auth/password.test.ts`: `context_word` cases. `test/auth/staff-admin.int.test.ts`: create refuses a breached
    password; clear-throttle covers reset.
  - `test/db/sign-in.int.test.ts` (pre-identity): the `reset` kind exposes one row; the request never supplies
    `app.reset_token_hash`.
  - Security suites: classify `staff_password_reset` (outsider: no PUBLIC/anon grant on the table or the function;
    cross-tenant: one user's reset context never sees or deletes another's row); route walk: the two reset routes
    public, change staff-only.
  - Stryker scope gains `password-reset.ts`, `breached.ts`, `deferred.ts` (core gate, `QUALITY_BASELINE.md`).
- Web: `PasswordStep` gets a "Forgot your password?" link; `/[lang]/forgot-password` (email → the same message every
  time); `/[lang]/reset-password` (client reads `#token`, keeps it in memory only and strips it with
  `history.replaceState`; after a refresh shows "open the link from your email again" with a link to forgot-password;
  new password and confirm; rules shown before typing; maps each error; a 503 keeps the typed passwords);
  `/[lang]/account` (signed in; change password; linked from `TopBar`). Password fields: `autocomplete="new-password"`
  (`current-password` for the current one), a hidden `username` field with the email where known, paste allowed, a
  show/hide toggle (ASVS V6.2.7, V6.2.8). Messages AR/EN in `packages/shared` (ux-araby).
  E2E: forgot → link from the codes file → reset → old password refused, new one signs in; change password while
  signed in → old password refused, a second browser context is signed out.
- Docs: API.md (three routes, error codes), SECURITY.md (reset, change and breach rows in the controls table; line 50),
  INTEGRATIONS (Pwned Passwords in the data map), RUNBOOK ("Locked-out admin": forgot → reset link; throttled →
  `clear-throttle`, which covers reset; lost mailbox → owner connection, ADR-078 risk; `staff.breach_check_unavailable`
  → check egress to `api.pwnedpasswords.com`; remove "no web reset exists until T-020"), TASKS (tick, wording note),
  STATE.

## States handled

Unknown/disabled email (same 202), throttled (429 + retry-after), email down during request (logged, still 202),
link unknown/expired/used (410), two tabs confirming (one wins), account disabled between phases (410), weak or
breached (422 with reason), breach service down (503 + retry-after, nothing changed), verify gate busy (503 `busy`),
wrong current password (403, lockout counted), session ended mid-change (401 as today), notice email failure (logged
only), reset page refreshed (guidance, no broken form), shutdown with work pending (drained, 5 s cap).

## Phases

1. **API** — migration, pre-identity kind, store, checker, deferred runner, flows, routes, CLI, unit + integration +
   security suites, mutation scope.
2. **Web + docs** — the three pages, the link, messages, e2e, docs.
