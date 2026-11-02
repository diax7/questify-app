# T-709 - Platform health, platform numbers, admin accounts and sessions (plan note, tier B)

Delivers FR-1783, FR-1419, FR-1785. FR-1403 (the content editors) is split out as **T-709b** (ADR-415). Migration
**0117** (staging runs through 0113; 0114 and 0115 are committed and undeployed; 0116 is T-702's). Read only except one
door that ends a session through the existing session table; no sign-in logic, points or tenant isolation is touched.

## What exists and is reused

- Console scope, hook and `admin` access kind (`activation/routes.ts`); `console_admin()` (QE403) and
  `suspension_reason_clean()` (SU400, 10 to 300 characters) from 0114; the `door()` wrapper that maps refusals to HTTP
  (`console/doors.ts`); `recordAudit` for audited reads; the throttle buckets (`holdBack`).
- `staff_session` (0002): the API role can update only its own user's sessions, so another admin's session is ended by a
  definer (the owner bypasses row security). `sessionLimitsFor("admin")` (15 min idle, 8 h) defines "open".
- Queues with their own indexes: `push_send` (queue, leased), `organizer_alert` (queue, leased, finished), `notice`
  (unfanned), `souvenir_work`, `invitation_recipient` (leased), `invitation_channel_hold`, `invitation_campaign` counters.
- UI: `Tile`/`Figure`/`PanelGrid` (T-607), `FactList`, the ConfirmedButton + reason pattern (T-701), `Icon` check, alert,
  blocked (T-618), `infoTip` (ADR-370).

## Design

1. **Health door** `console_health()` (STABLE definer, `console_admin()`): every unbounded count reads through
   `LIMIT 10001`. Ages are seconds. Stuck = a lease that ran out five minutes ago. No ticker keeps a run record, so the
   view shows the symptoms of a stopped ticker: scheduled events past their start (or live past their end) by two
   minutes, the oldest waiting push and alert, expired leases, failing notice fan-outs and souvenir work.
   A partial index `push_send_failed (finished_at) WHERE state IN ('failed','unknown')` serves the failed-in-24-hours count.
2. **One shared function** `evaluateHealth(facts, transports, databaseMs, at)` (`packages/shared/src/platform`): six tiles,
   each `{key, state, reasons, figure, facts}`. State rules and limits are constants (`HEALTH_LIMITS`) until T-703 gives the
   console tuning numbers. Transports are yes/no from the server's configuration (no key, sender or address).
3. **Numbers door** `console_numbers()`: counts by status; players seated in live events; the last hour's points entries
   in live events, read per event through `ledger_entry (event_id, created_at)` and capped at 100,001 per event.
4. **Admin doors:** `console_admin_accounts(idle, max_age)`, `console_admin_sessions(account, idle, max_age)` (QA404 for a
   non-admin account), `admin_end_session(session, reason, request)` (row lock, QA404 when absent, ended, or not an
   admin's, audit `staff.session.force_end` with the reason and whose session it was). The two reads are audited with ids only.
5. **Routes** (console scope, 404 to non-admins): `GET /v1/admin/health`, `/numbers`, `/admins`,
   `/admins/:staffUserId/sessions`, `POST /v1/admin/sessions/:sessionId/end` (idempotent; the caller's own session is a
   409 `own_session`). Reads 60 a minute, ends 30 an hour, per admin.
6. **Last admin (FR-1785):** `revoke-admin` locks every admin row by id first and refuses the last active admin.
7. **Web:** `/console/health`, `/console/numbers`, `/console/admins`, three nav items, Arabic and English, RTL, phone
   width; health tiles are grid cells the tile fills (equal height per row), state = icon + word, View more.

## Tests

DB (`test/db/platform-health`): refusals for every non-admin seat, each count and bound (10,001), the audit entry, the
reason bounds, member sessions untouched, an ended session cannot revive. HTTP (`test/console/platform`): 404 for
non-admins, the six tiles, audited reads with ids only, the forced sign-out refuses the next request at once, own session
409, short reason 400. `test/db/admin-role`: the last admin, a disabled admin, two simultaneous revokes. Security suites:
outsider (five doors, exact grants), cross-tenant (every tenant seat gets QE403), route table. Unit: `platform.test`
(every state rule at its boundary), `console-platform.test`. Browser: `console-platform.spec` plus `layout.spec`.

## Left out on purpose

Per-event "players online" and API error counters (not recorded anywhere; Q-382), sign-in SMS outcomes (not recorded;
Q-383), a heartbeat table for tickers, adding or removing admins from the console (ADR-405), and FR-1403 (T-709b).
