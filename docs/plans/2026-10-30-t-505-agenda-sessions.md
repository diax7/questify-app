# T-505: agenda and sessions (plan note)

Tier B (ADR-355): no ledger, sign-in or tenant-boundary logic; every door is a definer behind `award_event_of` (team), an active
enrollment (player) or a staff assignment (door check-in), the T-502 and T-205 patterns. Delivers FR-808 to FR-810 and FR-1787 to
FR-1797 except the session's points. Migration **0086** (new, undeployed; staging is at 0085). Choices: **ADR-373 / Q-340 (Proposed)**.

## Split (recorded in TASKS)

- **T-505 (this task):** sessions, registration with seats, My sessions, overlap warning, close/reopen and seats, CSV import, report and
  export, reminders, message registrants, linked quest, and **door check-in recording attendance** (no points).
- **T-505b (tier A, owed):** the session's points on check-in, once per player, and "everyone checked in to session X" as a
  bulk-award target (FR-1791's points, FR-1712). Both write the points ledger, so they get a plan and a plan review first. Check-in
  ships without points, and the report's "attended" works without them.

## Data (all deny by default: RLS forced, no grant, doors only)

- `event_session`: kind (talk, workshop, activity), title and description and place in both languages (a title in one language is
  enough, like a quest's), speakers (names as typed), `starts_at`/`ends_at` (inside the event's dates when it has them), `access`
  (`open` or `registration`), `seats` (null = no limit), `closes_at` (null = at the start), `registration_open` (close/reopen),
  `walk_ins`, `reminder_minutes` (1 to 1440, default 15), `quest_id` (same-event quest, FR-810). No price column exists (FR-1789).
- `session_registration`: session, enrollment (ON DELETE CASCADE, so the rehearsal wipe and a player leaving remove it), player,
  time. Unique per session and player. Cancelling deletes the row, so the seat is free at once.
- `session_attendance`: session, enrollment (cascade), player, operator, time, `walk_in`. Unique per session and player.
- `session_message`: the frozen text, the Idempotency-Key hash and the recipient count of a message to registrants.

## Doors

Team (owner/editor inside the event limit): `session_save` (create or edit), `session_delete`, `session_list` (also the report:
seats, registered, attended, walk-ins, no-shows), `session_registration_set` (open/close and seats; below the registered number is
refused naming it), `session_import` (rows the API already checked; one transaction), `session_message`.
Player (active member): `member_sessions` (the agenda with my state), `session_register(confirm_overlap)`, `session_cancel`.
Operator: `session_check_in` (assignment, `scan_quests` ability, no quest limit, My QR version, enrolled, registered or walk-in,
from an hour before the start to the end). Due scan: `push_due_session` (reminders), restated `push_due`.

## Care points

- Two players on the last seat: the session row is locked `FOR UPDATE` before the count; a test fires both at once.
- Overlap: the door returns `overlap` with the sessions' names and writes nothing; the app confirms and calls again.
- Reminders: one personal notice per registrant (`session:{session}:{player}`), only while registered; a cancelled player gets none.
- Message: reuses the announcement text pipeline (clean, name rule, 140-character push body) and its 3/hour, 10/day limit per event;
  one personal notice per registrant, a player who left the event is dropped by the claim's membership check.
- Rehearsal: registrations and attendance cascade from the enrollment, so the wipe removes them; the player doors wipe first.

## Mutation globs

None required (not tier A). T-505b will name `apps/api/src/sessions/**` for the points part.
