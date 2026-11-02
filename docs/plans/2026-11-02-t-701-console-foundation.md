# T-701 - Console foundation: admin role, organizers and events, suspension, support access (plan, tier A)

Delivers FR-1402 (suspend half), FR-1607, FR-1408, FR-1409, FR-1732 (urgency and ordering), the pause/restore part of
FR-1784, Q-110 and Q-116. Splits out **T-701b** (FR-1784 owner email change and organizer merge; FR-1732's team alert):
both need a decision from Dhia first (Q-375, Q-376) and each delivers value alone. Depends on T-006, T-210 (done).
Migration **0114** (staging runs through 0112; 0113 is pushed, undeployed). ADR-405 to ADR-410 and Q-372 to Q-377 Proposed.
Core (admin powers, tenant isolation, the ledger guard): plan review, build, one code review, mutation on GitHub.

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

- **Who grants:** only the owner connection. `staff-cli grant-admin <email>` and `revoke-admin <email>` (new commands next to
  `create`), each one transaction: set `platform_role`, audit `staff.platform_role` (system actor, before/after), and on
  revoke end every live session of that account (same SQL as the RUNBOOK force-out). No HTTP route, no definer and no
  column grant can change `platform_role` or `status`; the console's admin-accounts screen and "last admin" rule are T-709.
- **No self-escalation:** proven by tests, not by review: (a) the API role's privileges on `staff_user` are exactly
  `SELECT` + `UPDATE(password_hash)` (catalog assertion); (b) an `UPDATE staff_user SET platform_role` from every API
  context (player, staff, admin flag, device, anon) fails; (c) the route inventory has no route whose handler writes it.
- **Narrow the recorded admin power (SECURITY.md "Admin power to record"):** split `staff_user_own` so UPDATE is own row
  only (plus the existing pre-identity reset setting), dropping the admin branch: no shipped path uses an admin overwrite of
  another person's `password_hash` (worker greps and runs the T-020 suites to confirm before dropping; if a path exists,
  keep the policy and record why).
- **Sign-in rules unchanged:** password + emailed code, 15 min / 8 h. No step-up re-authentication for console actions
  (ASVS L2 does not require it; every consequential action has a confirmation screen and a required reason instead).
  The support grant and the console hook both re-read the account, so a revoke or disable stops support at the next
  statement, not at the next sign-in.

## 3. Organizers and events in the console

**Routes** (all `admin`, 120 reads/min per admin with the ticket limiter's pattern, `no-store`):
- `GET /v1/admin/organizers?q&status=active|paused&cursor&limit` → name, slug, status, event counts (draft, scheduled,
  live), owner email. `q` matches name or slug (prefix, case-folded) or an owner email **exactly** (no email prefix search).
- `GET /v1/admin/organizers/{id}` → organizer, owner and team (email, role, event limit), events (state, dates, limit,
  suspended), live support grants, last 50 Questify entries for this organizer.
- `GET /v1/admin/events/{id}` (T-210) gains `suspended`, `supportGrants`, last 50 Questify entries.
- Definers `console_organizers(...)`, `console_organizer(id, request)`; `admin_event` restated. Each re-reads
  `app_admin_id()` (QE403 → 404), each read that returns an email writes one audit row with ids only
  (`console.organizers_read` with the organizer ids shown, `console.organizer_read`, `console.event_read`,
  `console.activation_requests_read`): closes Q-116. Counts-only reads (readiness, ticket counts, usage) stay unaudited.

**Web:** console menu "Organizers and events" (wireframe 4.2): search, status filter, rows with state; organizer page
(events, owner and team, Suspend/Reactivate, history); event page gains Suspend/Reactivate and **Open as support**. Phone
and computer layouts, Arabic and English, RTL, Western digits; confirmation screens per ADR-063 (section 5 rows "Suspend
an organizer", "Activate, suspend or reject an event", "Open an event as support").

## 4. Suspension (ADR-406)

**State:** organizer suspension = `organizer.status = 'paused'` (existing column); event suspension = new
`event.suspended_at timestamptz` + `suspended_by uuid` (no API write grant on either; definers only). One helper
`event_suspended(event_id) RETURNS boolean` (STABLE, definer, two PK lookups). Suspension is an overlay: it never changes
`event.status`, activation, entitlements, config, team, enrollments, scores, balances, reservations or any ledger or audit
row. Lifting it restores exactly what was there.

**Doors:** `admin_suspend_organizer(org, reason, request)`, `admin_reactivate_organizer(...)`,
`admin_suspend_event(event, reason, request)`, `admin_reactivate_event(...)`: `app_admin_id()`, row lock, reason 10–300
characters cleaned (`clean_reason`), SU409 when already in that state, audited `organizer.suspend|reactivate` /
`event.suspend|reactivate` (actor admin, reason in `after`, organizer and event ids so the organizer reads it).
Idempotency-Key on the routes; 30 an hour per admin.

**What it blocks (database walls are immediate; API walls within 10 s):**
- **Players (FR-1607):** the public list and event page reads (`public_events`, `public_event*`, own-events list show it as
  "unavailable"); joining (BEFORE INSERT/UPDATE trigger on `enrollment` into `pending|active`, ADR-141's pattern, ES423);
  every ledger insert from a player, staff or device context (new `ledger_suspension_guard` BEFORE INSERT on
  `ledger_entry`: no points earned, spent, awarded or settled); reservations (spend entries) and prize hand-over (the desk
  and team hand-over doors check `event_suspended`). Plus an API wall: a player-route hook answers `404 event_unavailable`
  for any `/v1/events/{eventId}/…` player route of a suspended event, read from an in-process set of suspended ids
  refreshed every 10 s (`suspended_ids()`, ids only) and invalidated at once on the instance that changed it. Not blocked:
  the player's own history, passport, data export, account deletion, own tickets.
- **Devices:** station and kiosk scans hit the ledger guard; the big screen's `screen_event` returns unavailable.
- **Pushes:** the push claim drops a notice for a suspended event (one check at the claim, T-501's door), so nothing queued
  before the suspension reaches players.
- **Staff (dashboard read-only):** the organizer route hook answers `423 organizer_suspended` (organizer paused) or
  `423 event_suspended` (a route with that `:eventId`) to every non-GET, except ending a support grant. `membershipOf`
  returns the organizer's status in the same query; no extra round trip. Database wall for staff: the ledger guard,
  join and hand-over doors (the ~170 `award_event_of` call sites mix reads and writes, so the general staff write wall is
  the API hook; recorded in ADR-406 as accepted).
- **Never touched:** time-driven work keeps running in system context (live/ended transitions, reservation expiry and its
  refund entries, erasure): the ledger guard allows a context with no player, staff or device id.
- **Support during suspension (Q-377):** support writes stay allowed (fix the content, then reactivate), except the ledger.

**Organizer and player copy:** dashboard banner "This event is paused by Questify. Contact support." with the support
details, editing disabled; app "This event is unavailable right now." The reason stays internal (Q-372).

## 5. Support access: time-boxed, audited, organizer-visible (ADR-407, ADR-408)

There is no support-access mechanism today (only audited ticket reads). Instead of an admin bypass, the admin gets a
**support grant** and then uses the organizer's own dashboard and doors as an editor limited to that one event.

**Table `support_grant`:** id, admin_id, organizer_id, event_id (FK to `event (id, organizer_id)`), reason (10–300,
cleaned), opened_at, expires_at (opened + 15 to 240 minutes, default 60), closed_at, closed_by (staff id), close_kind
(`admin|organizer|revoked`). RLS forced, no grant to the API role; definers only. One live grant per admin and event
(partial unique index); a member of the organizer cannot open one (SG409: use your membership). 20 grants an hour per
admin.

**Doors:** `support_open(event, reason, minutes, request)` (`app_admin_id()`; audited `support.opened` with grant id and
expiry; the existing `audit_log_alert_support` trigger's WHEN widens to `support.opened`, so the team gets the
`support_access` alert, deduped per admin, event and day); `support_close(grant, request)` (the admin, audited
`support.closed`); `support_end(grant, request)` (owner, or editor within their event limit, via `award_event_of`; audited
`support.ended` with the staff actor); `own_support_grants()` (the admin's live grants for the console).
Opening a new grant is the only way to extend one.

**How the organizer's doors accept it:**
- **DB:** `app_organizer_id()` and `app_event_scope()` gain a second branch, used only when no membership row matches:
  a live grant (`closed_at IS NULL AND expires_at > now()`) for `app.staff_user_id` in `app.organizer_id`, whose account is
  still an active platform admin; the scope is the array of granted event ids, never NULL ("all"). `UNION ALL … LIMIT 1`
  so a member's path stops at the first branch. The request flag `app.is_admin` is **not** set on these requests: support
  acts with exactly an editor's rights in that event, never the admin RLS branches.
- **API:** the organizer hook, on no membership and a session whose account is an active admin, asks
  `supportSeatOf(staff, organizer)` → principal `{role: "support", eventScope: [eventIds], expiresAt}`. `owner` routes
  stay 403; routes for another event of the organizer, or of another organizer, stay 404. Any code that tests
  `role === "editor"` explicitly is listed and reviewed (support must match editor wherever editor is allowed).
- **Which writes:** every editor door within the granted event (quests, rewards and stock, layout and words, control
  room, inbox, awards, exports), each already audited by its own door. **Not:** owner-only doors (team, transfer, delete
  event, owner switches), other events, organizer-level settings, the activation request, and the ledger while suspended.

**Stamping and visibility (FR-1409):** new nullable `audit_log.support_grant_id` (not in the API's INSERT column grant),
set by a BEFORE INSERT trigger when a `staff` entry's actor holds a live grant for that event and is not a member. So the
organizer's view can tell "Questify support" from its own team without trusting the caller. A new organizer read
`event_questify_log(event, before_id, limit)` (owner/editor within limit) returns every entry of the event with
`actor_type = 'admin'` or a `support_grant_id`: grants opened, closed and ended (with reason and window), changes made
under support (action, target, changed field names, never values), ticket reads, activation, limits and suspension. The
actor is always shown as "Questify support" (Q-374). Dashboard: a "Questify support" card on the Overview and a banner on
every page of the event while a grant is live ("Questify support has access to this event until 15:40." + **End access**);
the admin sees the reverse banner ("You are editing as Questify support. The organizer will see this.").

**`content_unpublished` producer (T-609 note, ADR-409):** an AFTER INSERT trigger on stamped support entries whose
`action` is in an explicit allowlist of "hide from players" actions that exist today (worker lists them from the code:
quest unpublish/pause, reward retire, announcement withdraw, home block or info section removal) calls
`alert_enqueue(org, event, 'content_unpublished', 'unpublish:' || id)`. A guard test fails if an allowlisted action name
no longer appears in the API. FR-1727 becomes "built". Player moderation stays T-705.

**Not a god-mode:** without a live grant an admin reaches no organizer door (404, as today). Console reads of the event
page are audited (section 3) and appear in the organizer's Questify log. T-712 (read-only view as organizer) later adds a
`view` kind to the same grant.

## 6. Urgent reports in the console (FR-1732, partial)

`console_tickets` gains `urgent` (the ticket's event is live now, `event_status_now`) and `dueAt` (escalated or created +
1 h when urgent, + 24 h otherwise); open tickets order urgent first, then by `dueAt`. `console_ticket_counts` gains
`urgent`; the console menu shows it as a badge. T-705's moderation queue reuses the same rule. The team alert (email to a
team mailbox) is T-701b (Q-376).

## 7. Migration 0114 (deny by default)

New: `event.suspended_at|suspended_by`, `support_grant`, `audit_log.support_grant_id`, `event_suspended`, `suspended_ids`,
the four suspension doors, the four support doors, `event_questify_log`, `console_organizers`, `console_organizer`,
`ledger_suspension_guard`, `enrollment_suspension_guard`, `audit_stamp_support`, `alert_on_support_unpublish`; restated:
`app_organizer_id`, `app_event_scope`, `admin_event`, `console_tickets`, `console_ticket_counts`, the public event reads,
the push claim, the hand-over doors, `screen_event`, the `staff_user` UPDATE policy, the support alert trigger. Every new
function `REVOKE ALL … FROM PUBLIC`; EXECUTE granted to `questify_app` only for the doors; helpers and trigger functions
hold no grant. `support_grant` RLS forced, no table grant. Every definer pins `search_path = public, pg_temp`.

## 8. Tests (test first)

- **DB** `test/db/console-suspension.int.test.ts`: each door's refusals (non-admin, flag without the role, disabled admin,
  member-only staff, player, device, anon → QE403/42501), reason bounds, SU409, audit rows; effects: join, ledger insert
  from player/staff/device refused, system-context refund allowed, reserve and hand-over refused, public reads hide the
  event; **ledger untouched**: row count and per-enrollment sums identical before suspend and after reactivate; races:
  suspend vs a concurrent scan (the scan either commits before or is refused, never half) and vs a join at the last seat.
- **DB** `test/db/support-grant.int.test.ts`: open/close/end/expiry (`now()` moved by a test clock or a short grant);
  `app_organizer_id`/`app_event_scope` with and without a grant; scope is only the granted event (another event of A and
  any event of B invisible and refused); expired, closed, revoked-admin and disabled-admin grants open nothing; a member
  cannot open one; one live grant per admin and event under two concurrent opens; owner-only doors refused; stamping
  (support entries stamped, a member's entries never, a forged `support_grant_id` in an INSERT refused by the column
  grant); `event_questify_log` limits; alerts `support_access` and `content_unpublished` enqueued once.
- **Role:** `test/db/admin-role.int.test.ts`: catalog privileges on `staff_user`; `platform_role` update refused from every
  context; admin can no longer write another person's `password_hash`; CLI grant/revoke audited and ends sessions.
- **HTTP** `test/console/organizers.int.test.ts`, `test/console/support.int.test.ts`: routes, 404 for non-admins, read
  audit rows written with ids only, rate limits (429), the organizer hook with a support seat (editor routes 2xx, owner 403,
  other event 404, after expiry 404), 423 on non-GET for a suspended organizer/event, `event_unavailable` on player routes.
- **Security suites:** outsider (every new function and the table refused to `anon` and `PUBLIC`, exact grant list),
  cross-tenant (A's grant cannot reach B; B's team cannot read A's grants or Questify log; `support_grant` classified),
  route-access (new routes under `/v1/admin/`), a route walk of every player route with `:eventId` against a suspended
  event (non-2xx or on a short, reviewed exception list), rehearsal and community list guards updated.
- **Perf:** a dashboard member read and the scan path measured before and after the `app_organizer_id` branch and the
  ledger guard (existing perf tests, by hand); report the numbers.
- **Web/app:** console organizers, organizer page, suspend dialogs, support open flow and both banners, the organizer's
  Questify card and End access (`e2e`, Arabic and English, phone and desktop); app "event unavailable" screen;
  `messages.ts` strings in both languages.
- **Mutation globs** (GitHub only): `apps/api/src/console/**/*.ts` (new module: organizers, suspension, support),
  `apps/api/src/organizers/routes.ts` and `apps/api/src/organizers/store.ts` (support seat, suspended refusals),
  `apps/api/src/events/suspended-set.ts` (the 10 s set), `apps/api/src/auth/staff-admin.ts` (grant/revoke).

## 9. Docs touched at build

API.md (console and organizer routes, error codes 423/`event_unavailable`), DATA_MODEL.md, SECURITY.md (support grant,
suspension walls, admin role, the narrowed policy, Q-116 closed), DASHBOARD_AND_CONSOLE.md (section 5 rows shipped),
RUNBOOK (grant-admin/revoke-admin; ending a grant by hand), SRS trace (FR-1402, 1408, 1409, 1607, 1727 built; 1732, 1784
partial), TASKS (T-701b line; T-712 note: add a `view` grant kind), STATE.

## 10. Risks

1. **The `app_organizer_id()` change touches every tenant policy.** Mitigation: branch only after no membership, LIMIT 1,
   scope never NULL, active-admin re-read in the branch, cross-tenant suite plus the new grant tests; perf measured.
2. **Staff non-ledger writes on a suspended event are stopped by the API hook only.** Accepted (ADR-406): the hook is the
   single registration point for every organizer route; the money paths have database walls.
3. **Hidden membership checks** in definers that read `organizer_member` directly fail closed for support (a door support
   cannot use); found by the support e2e run, fixed only where it is an editor door.
4. **10 s lag** of the player API wall across instances; the database walls (join, points, prizes, lists) are immediate.
5. **A support mistake changes a live event** (ADR-068's accepted cost); the grant, the stamp and the organizer's card and
   alert are the safeguard.

## 11. Decisions and questions (recorded at build: DECISIONS.md, OPEN_QUESTIONS.md)

- **ADR-405** (Proposed): platform admins granted and revoked only from the owner connection (CLI), audited, revoke ends
  sessions; the admin UPDATE branch on `staff_user` dropped. Console admin management stays T-709.
- **ADR-406** (Proposed): suspension is an overlay (`organizer.status='paused'`, `event.suspended_at`), never touching
  ledger, enrollments or reservations; DB walls on join, ledger, prizes, lists; API walls elsewhere.
- **ADR-407** (Proposed): support access is a time-boxed grant (15–240 min, default 60, reason required) that makes the
  admin an editor of one event through the organizer's own doors; no admin bypass of organizer doors.
- **ADR-408** (Proposed): support entries stamped by the database; the organizer reads every Questify entry of its event.
- **ADR-409** (Proposed): `content_unpublished` produced from stamped support actions on an explicit allowlist.
- **ADR-410** (Proposed): T-701b split (owner email change, organizer merge, urgent-report team alert).
- **Q-372 (product, Dhia):** does the organizer see the suspension reason? Recommended: no; a fixed text and the support
  contact; the reason stays in the console.
- **Q-373 (product, Dhia):** support opens without the organizer's approval (ADR-068's event-day speed), default 60
  minutes, and the owner or an editor can end it. Recommended as stated.
- **Q-374 (product, Dhia):** the organizer sees "Questify support", not the admin's name. Recommended.
- **Q-375 (product + technical, Dhia, T-701b):** "merge two organizer accounts" cannot move events: `ledger_entry` and
  `audit_log` carry `organizer_id` and are append-only. Recommended: merge moves the team and leaves each event under
  its organizer, with the merged organizer closed to new events; or drop merge from v1.
- **Q-376 (product, Dhia, T-701b):** which mailbox receives urgent-report alerts (and whether WhatsApp is wanted instead).
- **Q-377 (developer):** support writes stay allowed while an event or organizer is suspended (not the ledger).
- Closed by this task when built: Q-110 (suspension) and Q-116 (console reads audited). Q-117 (times after activation)
  stays open, not in this task. T-615's counsel note (Q-080) needs nothing here: if counsel narrows name display, a
  migration narrows the setting's CHECK; no console override is built.
