# T-701 - Console foundation: admin role, organizers and events, suspension, support access (plan, tier A)

Delivers FR-1402 (suspend half), FR-1607, FR-1408, FR-1409, the pause/restore part of FR-1784, Q-110 and Q-116. Splits
out **T-701b** (FR-1784 owner email change; FR-1732 urgency, ordering and the team alert, now unblocked by Q-376). Merge
is dropped from v1 (Q-375). Depends on T-006, T-210 (done). Migration **0114** (staging runs through 0113; T-601b's 0115
is committed, undeployed). ADR-405 to ADR-410; Q-372 to Q-376 answered by Dhia (2026-11-02), Q-377 Proposed.
Core (admin powers, tenant isolation, the ledger guard): plan review, build, one code review, mutation on GitHub.

**Amended 2026-11-02** after Dhia's answers and the plan review (80, NO-GO until amended). What changed: support access
is 15 minutes fixed and silent to the organizer (no banner, no organizer log, no End access, no alert, Q-373); the
organizer sees the suspension reason (Q-372); support is labelled "Questify support" wherever the dashboard shows an
actor (Q-374); the review's BLOCKER (organizer UPDATE grant), the two MAJORs (ledger guard by kind and the community
payer; the support allowlist) and the MINORs are folded into sections 2, 4, 5 and 7. Urgent reports move to T-701b.

## 1. What exists and is reused

- **Role:** `staff_user.platform_role` (`none|admin`, 0001) and `status`. `app_admin_id()` (0027) = request flag
  `app.is_admin` AND the account re-read as an active platform admin. The API role holds only `SELECT` and
  `UPDATE (password_hash)` on `staff_user` (0002): no API path writes `platform_role` or `status`. Admins are made only by
  `staff-cli create --admin` on the owner connection (audited `staff.create`, system actor).
- **Sessions (T-006):** email + password + emailed code; admins idle 15 min / max 8 h, role re-checked on every request;
  revoke, list, cap 10. Disabled accounts stop at the next request. Force-out is a RUNBOOK SQL step (screen is T-709).
- **Console:** access kind `admin` only under `/v1/admin/`, hook in `activation/routes.ts` (404 to anyone else); pages
  `/[lang]/console` (activation queue, events by code, tickets, Questify content, seasons, invitations, usage, readiness).
  `admin_lock_event`, `activate_event`, `reject_event_activation`, `set_event_player_limit` each audit with actor `admin`.
- **Tenant walls:** `app_organizer_id()` / `app_event_scope()` read `organizer_member` (0008); `award_event_of` (0030) is the
  owner/editor event door used by ~170 definers; organizer route hook (`organizers/routes.ts`) reads `membershipOf` and
  refuses `owner` routes to editors (403).
- **Audit:** `audit_log` append-only, actor types `admin|staff|system`; organizers read their own rows (RLS, event limit).
  No organizer change-log screen exists yet (FR-1029 is still "pending" in the SRS trace; stays out).
- **Alerts (T-503/T-609):** `alert_enqueue(org, event, type, key)`; `support_access` fires from `console.ticket_read` audit
  rows (once per admin, event and day); `content_unpublished` has no producer (owed here). Mail transport stays OFF.
- **Tickets console (T-312):** `console_tickets`, `console_ticket_counts`; escalated tickets carry `escalated_at`;
  120 calls/min per admin (`BUCKETS.consoleTicket`).
- `organizer.status` already allows `paused` (unused). The ledger already has BEFORE INSERT guards (0026, 0032): a
  suspension guard follows the same pattern.


## 2. Admin role model (ADR-405)

- **Who grants:** only the owner connection. `staff-cli grant-admin <email>` and `revoke-admin <email>` (next to
  `create`), each one transaction: set `platform_role`, audit `staff.platform_role` (system actor, before/after), and on
  revoke end every live session of that account (the RUNBOOK force-out SQL) **and close every live support grant**
  (`close_kind = 'revoked'`). No HTTP route, no definer and no column grant can change `platform_role` or `status`; the
  console's admin-accounts screen and "last admin" rule are T-709.
- **No self-escalation, proven by tests:** (a) the API role's privileges on `staff_user` are exactly `SELECT` +
  `UPDATE(password_hash)` (catalog assertion); (b) `UPDATE staff_user SET platform_role` fails from every API context;
  (c) no API source writes it (source grep test).
- **Organizer rows are definer-only (review BLOCKER 1):** `questify_app` has table-wide `INSERT, UPDATE` on `organizer`
  (0001) and `organizer_update` admits `id = app_organizer_id()`, so a member (or support) could write `status` and lift
  a suspension. 0114 runs `REVOKE INSERT, UPDATE ON organizer FROM questify_app` and drops `organizer_insert` and
  `organizer_update` (organizers are created only by the `create_organizer` definer; nothing in the API updates one,
  checked by grep). Catalog test: the API role holds only `SELECT` on `organizer`.
- **Narrow the recorded admin power:** `staff_user_own` becomes SELECT-only (own row or admin) and a new
  `staff_user_update` allows UPDATE of the own row only. Both password paths (`sign-in.ts` rehash, `password-reset.ts`)
  run as the user (`promote`), so no shipped path needs the admin branch.
- **Sign-in rules unchanged:** password + emailed code, 15 min / 8 h; no step-up (confirmation screen and reason instead).
  The support grant and the console hook both re-read the account, so a revoke or disable stops support at the next
  statement.

## 3. Organizers and events in the console

**Routes** (all `admin`, under the console hook; reads 120/min per admin, `no-store`):
- `GET /v1/admin/organizers?q&status=active|paused&cursor&limit` → name, slug, status, event counts (draft, scheduled,
  live), owner email. `q` matches name or slug (prefix, case-folded) or an owner email **exactly**.
- `GET /v1/admin/organizers/{id}` → organizer (with suspension), owner and team (email, role, event limit), events
  (state, dates, suspended), the last 50 audit entries for this organizer.
- `GET /v1/admin/events/{id}` (T-210) gains `suspension`, `supportGrants` (live grants on the event).
- Reads run in the admin seat (the RLS admin branches, as T-210's console event); each read that returns an email
  writes one audit row with ids only: `console.organizers_read` (organizer ids shown), `console.organizer_read`,
  `console.event_read` (closes Q-116; the activation queue returns no email and stays unaudited, as do counts).

**Web:** console menu "Organizers" (wireframe 4.2): search, status filter, rows; organizer page (events, owner and team,
Suspend/Reactivate, recent history); the console event page gains Suspend/Reactivate, **Open as support** and the live
grants with **End**. Phone and computer layouts, Arabic and English, RTL, Western digits; confirmation screens per
ADR-063 with a required reason.

## 4. Suspension (ADR-406)

**State:** organizer suspension = `organizer.status = 'paused'` plus `suspended_at`, `suspended_by`, `suspension_reason`;
event suspension = `event.suspended_at`, `suspended_by`, `suspension_reason`. No API write grant on any of them
(organizer: no UPDATE at all after section 2; event: column grants only). `event_suspended(event_id)` (STABLE, definer,
two primary-key reads, no grant) is true when either is suspended. Suspension is an overlay: it never changes
`event.status`, activation, entitlements, config, team, enrollments, scores, balances, reservations or any ledger or
audit row; lifting it restores exactly what was there.

**Doors:** `admin_suspend_organizer(org, reason, request)`, `admin_reactivate_organizer(org, request)`,
`admin_suspend_event(event, reason, request)`, `admin_reactivate_event(event, request)`: `app_admin_id()`, row lock,
reason 10-300 characters cleaned, SU409 when already in that state, audited `organizer.suspend|reactivate` /
`event.suspend|reactivate` (actor admin, reason in `after`). Idempotency-Key on the routes; 30 an hour per admin.

**Timing (review MINOR):** the database walls refuse every statement that **starts after the suspension commits** (READ
COMMITTED: each statement reads the committed row). A statement already running finishes. Tested with a transaction
opened before the suspension whose insert runs after it.

**What it blocks:**
- **Ledger (review MAJOR 2):** `ledger_suspension_guard` BEFORE INSERT on `ledger_entry` keys on the entry's **kind**,
  not on the context: while the event or its organizer is suspended only `redeem_return` (reservation expiry and
  cancellation refunds) and `removal` (staff removals and erasure) are written; every other kind (`quest`, `redeem`,
  `welcome`, `handover`, `award`, `bonus`, `community`, `first_bonus`, `streak`, `session`, `adjust`) raises ES423.
  So the hand-over doors `desk_hand_over` and `accept_handover` (each writes a `handover` entry) and `accept_desk_sale`
  (a `redeem` entry) are refused through the guard, with no restatement.
- **Batches skip, never fail:** `pay_community_batch` and `settle_goal` skip suspended events (one refused event must not
  fail the community tick's batch); `invitation_claim_campaigns` skips suspended events; the push claim
  (`push_claim`) drops a notice of a suspended event. Tests for each.
- **Joining (FR-1607):** BEFORE INSERT/UPDATE trigger on `enrollment` into `pending|active` raises ES423.
- **Public reads:** `public_events`, `public_event`, `public_event_quests`, `public_event_join_rules`,
  `public_event_rules` leave a suspended event out (the card answers not found); `screen_event` answers nothing.
- **Player API wall:** the player guard answers `404 event_unavailable` for any player route with `:eventId` of a
  suspended event, read from an in-process set (`suspended_ids()`, ids only, refreshed every 10 s and invalidated at once
  on the instance that changed it). `suspended_ids()` is EXECUTE-granted to `questify_app` (the API reads it with no
  context), consistent with section 7. Own history, passport, data export and account deletion have no `:eventId`.
- **Staff (dashboard read-only):** the organizer hook answers `423 organizer_suspended` (organizer paused) or
  `423 event_suspended` (a route whose `:eventId` is suspended) to every non-GET of a member. `membershipOf` returns the
  organizer's suspension in the same query. Database wall for staff: the ledger guard and the join trigger (the ~170
  `award_event_of` call sites mix reads and writes, so the general staff write wall is the API hook; ADR-406).
- **Time-driven work keeps running:** live/ended transitions, reservation expiry and its `redeem_return` refunds,
  erasure (`removal`).
- **Support during suspension (Q-377, developer):** support writes stay allowed (fix the content, then reactivate);
  the ledger stays closed to them too.

**Organizer and player copy (Q-372):** dashboard banner "Questify paused this event: {reason}. Contact support." (and the
organizer form) with the reason Questify wrote, editing disabled; app "This event is unavailable right now." Players
never see the reason.

## 5. Support access: 15 minutes, silent, audited (ADR-407, ADR-408, ADR-409)

There is no support-access mechanism today. Instead of an admin bypass, the admin opens a **support grant** and then uses
the organizer's own dashboard and doors as an editor limited to that one event.

**Table `support_grant`:** id, admin_id, organizer_id, event_id (FK to `event (id, organizer_id)`), reason (10-300,
cleaned), opened_at, expires_at (**opened_at + 15 minutes, fixed**, CHECK), closed_at, close_kind (`admin|revoked`).
RLS forced, no grant to the API role; definers only. One live grant per admin and event (partial unique index on
`(admin_id, event_id) WHERE closed_at IS NULL`, plus the door closing an expired one first); a member of the organizer
cannot open one (SG409: use your membership); 20 grants an hour per admin (SG429).

**Doors:** `support_open(event, reason, request)` (`app_admin_id()`; audited `support.opened` with grant id and expiry,
actor admin); `support_close(grant, request)` (the admin side: any active admin may close any live grant; audited
`support.closed`); `own_support_grants()` (the caller's live grants, for the console and `/v1/staff/me`). Opening a new
grant is the only way to extend one. **Silent to the organizer (Q-373):** no banner, no organizer read of grants, no End
access for the organizer, no `support_access` alert; the record is Questify's audit log only.

**How the organizer's doors accept it:**
- **DB:** `app_organizer_id()` and `app_event_scope()` gain a second branch used only when no membership row matches and
  `app.staff_user_id` is set (player and device contexts skip it): a live grant (`closed_at IS NULL AND expires_at >
  now()`) of `app.staff_user_id` in `app.organizer_id`, whose account is still an active platform admin. The scope is
  `COALESCE(array_agg(event_id), '{}')`, never NULL ("all"). `app.is_admin` is **not** set on these requests: support
  has exactly an editor's rights in that event, never the admin RLS branches.
- **API (review MAJOR 3, deny by default):** the organizer hook, on no membership and an active admin session, reads the
  admin's live grant for that organizer and builds the principal `{role: "editor", eventScope: [eventId], support:
  {grantId, eventId, expiresAt}}`. Support may use **only** (a) routes with `:eventId` equal to the grant's event, and
  (b) the GETs the dashboard shell needs (`GET …/events`, scoped to the one event by the database). Refused with 404
  even inside the event: device pairing (`POST …/devices`, `POST …/devices/preview`), exports
  (`POST …/exports/:kind`); refused as event-less: every other route without `:eventId` (`/alerts/me`, leave, event
  create, team). `owner` routes stay 403. A test per refusal.
- **Which writes:** every editor door within the granted event, each already audited by its own door. **Not:**
  owner-only doors, other events, organizer-level routes, the ledger while suspended. Doors that fail closed for
  support because they read `organizer_member` directly: `souvenir_event` and `invitation_team_event` (owner-only
  features anyway; listed, not widened).
- `/v1/staff/me` lists the admin's live grants as support memberships (role editor, the one event, `support` set), so
  the dashboard pages open for them; the admin sees "You are in this event as Questify support until 15:40." on the
  event's pages (the admin's own banner; the organizer sees nothing).

**Stamping (FR-1409, ADR-408):** new nullable `audit_log.support_grant_id` (not in the API's INSERT column grant). A
BEFORE INSERT trigger **always assigns it itself**, ignoring any value a definer passed: the live grant of the entry's
staff actor in that organizer when the actor is not a member, else NULL. `revoke-admin` closes live grants.

**"Questify support" label (Q-374, ADR-409):** wherever the dashboard shows an actor (a points entry's "by", a flag's
"resolved by", a device's "paired by", a ticket's "answered by" and "escalated by"), a platform admin who is not a member
of the organizer is shown as **Questify support** instead of the email: one helper `staff_shown(staff, organizer)`
returns the email or the marker `questify-support`, which the dashboard translates. The admin id stays in Questify's
audit log. `content_unpublished` stays without a producer (support is silent; moderation's producer is T-705).

## 6. Urgent reports (moved to T-701b)

Urgency and ordering of the console's tickets and the urgent-report email (to the `MAIL_FROM` address stored as platform
configuration data, Q-376) ship together in T-701b with the owner email change.

## 7. Migration 0114 (deny by default)

New: `organizer.suspended_at|suspended_by|suspension_reason`, `event.suspended_at|suspended_by|suspension_reason`,
`support_grant`, `audit_log.support_grant_id`, `event_suspended`, `suspended_ids`, `staff_shown`, the four suspension
doors, `support_open`, `support_close`, `own_support_grants`, `ledger_suspension_guard`, `enrollment_suspension_guard`,
`audit_stamp_support`; restated: `app_organizer_id`, `app_event_scope`, the five public event reads, `screen_event`,
`push_claim`, `pay_community_batch`, `settle_goal`, `invitation_claim_campaigns`, the four actor-showing reads, the
`staff_user` and `organizer` policies and grants. Every new function `REVOKE ALL … FROM PUBLIC`; EXECUTE granted to
`questify_app` only for the doors, `own_support_grants` and `suspended_ids`; helpers and trigger functions hold no
grant. Read definers that write audit rows are VOLATILE. Every definer pins `search_path = public, pg_temp`.

## 8. Tests (test first)

- **DB** `test/db/console-suspension.int.test.ts`: each door's refusals (non-admin, flag without the role, disabled
  admin, member, player, anon), reason bounds, SU409, audit rows; join, ledger by kind (refused kinds, `redeem_return`
  and `removal` allowed), hand-over and desk sale refused, public reads hide the event, screen; batches skip a suspended
  event (community payer, invitation claim, push claim); **ledger untouched** before suspend and after reactivate; the
  statement-start race; the organizer UPDATE grant gone.
- **DB** `test/db/support-grant.int.test.ts`: open/close/expiry (15 minutes, shortened with the owner connection);
  `app_organizer_id`/`app_event_scope` with and without a grant, empty staff context; scope is only the granted event;
  expired, closed, revoked-admin and disabled-admin grants open nothing; a member cannot open one; one live grant under
  two concurrent opens; the hourly cap; owner-only doors refused; stamping (support entries stamped, a member's never, a
  passed value ignored); `staff_shown`.
- **Role** `test/db/admin-role.int.test.ts`: catalog privileges on `staff_user` and `organizer`; `platform_role` update
  refused; an admin can no longer write another person's `password_hash`; CLI grant/revoke audited, revoke ends sessions
  and grants.
- **HTTP** `test/console/organizers.int.test.ts`, `test/console/support.int.test.ts`: routes, 404 for non-admins, read
  audit rows with ids only, the support seat (event routes 2xx, owner 403, other event 404, event-less 404, pairing and
  exports 404, after expiry 404), 423 on non-GET for a suspended organizer/event, `event_unavailable` on player routes.
- **Security suites:** outsider (new functions and the table refused to `anon` and `PUBLIC`, exact grant list),
  cross-tenant (A's grant cannot reach B), route-access, rehearsal and community list guards updated.
- **Perf:** a player-context read and a member read measured before and after the `app_organizer_id` branch; reported.
- **Web/app:** console organizers, organizer page, suspend dialog, support open flow, the admin's support banner, the
  organizer's suspension banner with the reason (`e2e`, Arabic and English); `messages.ts` strings in both languages;
  the app's "event unavailable" message.
- **Mutation globs** (GitHub only): `apps/api/src/console/**/*.ts`, `apps/api/src/organizers/routes.ts`,
  `apps/api/src/organizers/support-seat.ts`, `apps/api/src/events/suspended-set.ts`, `apps/api/src/auth/staff-admin.ts`.

## 9. Docs touched at build

API.md, DATA_MODEL.md, SECURITY.md (support grant, suspension walls, admin role, the narrowed policy, organizer grant,
Q-116 closed), RUNBOOK (grant-admin/revoke-admin; closing a grant by hand), SRS trace (FR-1402, 1408, 1409, 1607 built;
1784 partial), TASKS (T-701b line; T-712 note: add a `view` grant kind), STATE.

## 10. Risks

1. **The `app_organizer_id()` change touches every tenant policy.** Branch only after no membership and only with a staff
   id, scope never NULL, active-admin re-read in the branch, cross-tenant suite plus the grant tests; perf measured.
2. **Staff non-ledger writes on a suspended event are stopped by the API hook only.** Accepted (ADR-406).
3. **Hidden membership checks** in definers that read `organizer_member` directly fail closed for support (listed).
4. **10 s lag** of the player API wall across instances; the database walls are immediate.
5. **A support mistake changes a live event silently** (Q-373: Dhia accepts that the organizer may not know); the grant,
   the 15-minute window and the stamped audit entries are the safeguard.

## 11. Decisions and questions (recorded at build)

- **ADR-405:** platform admins granted and revoked only from the owner connection (CLI), audited; revoke ends sessions and
  support grants; the admin UPDATE branch on `staff_user` dropped; `organizer` rows definer-only.
- **ADR-406:** suspension is an overlay; the ledger guard keys on the entry's kind; batches skip; API walls elsewhere.
- **ADR-407:** support access is a 15-minute grant (reason required) that makes the admin an editor of one event through
  the organizer's own doors, on a deny-by-default route allowlist; no admin bypass.
- **ADR-408:** support entries stamped by the database; the dashboard shows "Questify support" for them.
- **ADR-409:** support access is silent to the organizer (no banner, log, alert or End access); `content_unpublished`
  waits for T-705's moderation producer.
- **ADR-410:** T-701b split (owner email change; urgent reports with the team alert); merge dropped from v1.
- **Q-372 (Dhia, 2026-11-02):** the organizer sees the reason Questify wrote; players see only "unavailable".
- **Q-373 (Dhia, 2026-11-02):** 15 minutes fixed, no notification, banner, approval or End access for the organizer;
  recorded in Questify's audit log only.
- **Q-374 (Dhia, 2026-11-02):** "Questify support" wherever the dashboard's history shows an actor.
- **Q-375 (Dhia, 2026-11-02):** merge dropped from v1.
- **Q-376 (Dhia, 2026-11-02):** urgent alerts go to the `MAIL_FROM` address, stored as configuration data (T-701b).
- **Q-377 (developer, Proposed):** support writes stay allowed while suspended, except the ledger.
- Closed by this task: Q-110 (suspension) and Q-116 (console reads audited). Q-117 stays open.
