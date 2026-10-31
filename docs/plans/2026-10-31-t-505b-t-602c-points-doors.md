# T-505b and T-602c: session points, the session bulk target, and the switches in the points doors (plan)

Tier A, both (CLAUDE.md "Three tiers": they write or gate the points ledger). Plan, plan review, build, one code review,
then one grouped mutation run. Delivers FR-1791 (the points), FR-1712 (the session target), FR-1009 (completes it).
Builds on ADR-373 (sessions), ADR-381 (switches), T-207 (`bulk_award`, migration 0030/0032), T-306 (live polls, 0052).
Proposed at build time: **ADR-382** (T-505b), **ADR-383** (T-602c), **Q-349**, **Q-350** (texts at the end).

**One worker, two commits, two migrations:** **0093** for T-505b, **0094** for T-602c (whichever is built first takes
0093). Both are new and undeployed; staging runs through 0090. Check STATE.md before editing 0092: if 0092 is deployed by
then, restate `event_copy_extras` in 0093; if not, add `points` to its session copy in place.

## The one path for points (what both tasks reuse; nothing new writes points another way)

Every points move is one `INSERT INTO ledger_entry` inside a definer door, in the same transaction as the fact it pays
for. The triggers do the rest: `ledger_a_stamp_rehearsal` (rehearsal flag from the enrollment), `apply_ledger_entry`
(enrollment `score`/`balance` caches), `ledger_operator_play_guard` (QP403 for a staff member who may not play),
`ledger_xp` (quest and removal only), `ledger_streak` (quest only), append-only triggers. A door that is not a quest
completion calls `PERFORM mark_ranking_repair(ev.id)`, and the repair tick rebuilds the event and day boards (and the
rank-diff pushes) from the ledger; that is how `bulk_award` and `remove_award` move the ranking today. Undo is always a
new `removal` row via `remove_award`, never a delete. The rehearsal wipe deletes rehearsal ledger rows generically.

- **T-505b** adds one ledger kind, `session`, written by the door, and reuses `bulk_award` unchanged in what it writes
  (kind `award`, one `ledger_note` per entry with `bulk_id`), only with a third way to pick the members.
- **T-602c** writes no points; it adds a refusal before the existing writes in `reserve_reward` and `vote_quest`.

Why a new kind and not `award`: an operator's `award` counts toward the operator's daily cap (`awarded_today` sums
`kind = 'award'` without a bulk note), shows as a hand award in the staff record, and has no session to name. Why not the
linked quest: FR-1791 pays the session's own points; the linked quest (FR-810) is a separate quest with its own points.

## T-505b: migration 0093

**Data**
1. `event_session.points integer NOT NULL DEFAULT 0 CHECK (points BETWEEN 0 AND 100000)`; 0 means "no points".
2. `ledger_entry.session_id uuid`, `FOREIGN KEY (session_id, event_id) REFERENCES event_session (id, event_id) ON DELETE
   RESTRICT`. Kind list and `ledger_entry_system_returns_only` restated with `session` (actor is `operator`, never
   `system`). New `ledger_entry_session_shape`: `kind <> 'session' OR (session_id IS NOT NULL AND operator_id IS NOT NULL
   AND actor = 'operator' AND score_delta > 0 AND balance_delta = score_delta AND completion_id, quest_id, category_id,
   community_step_id, redemption_id, boost_id, reverses IS NULL)`; and `session_id IS NULL OR kind IN ('session',
   'removal')` (a removal carries it so its line names the session). `CREATE UNIQUE INDEX ledger_entry_session_key ON
   ledger_entry (session_id, enrollment_id) WHERE kind = 'session'`. Constraints added `NOT VALID` then `VALIDATE`;
   `SET LOCAL lock_timeout = '10s'` and explicit `LOCK TABLE` of `ledger_entry`, `event_session`, `bulk_award` first.
3. `bulk_award.session_id uuid`, FK `(session_id, event_id) → event_session ON DELETE SET NULL (session_id)` (a bulk row
   outlives a session deleted after a rehearsal wipe), `CHECK (quest_id IS NULL OR session_id IS NULL)`.

**The idempotency key of a session's points: the pair (session, enrollment), enforced by `ledger_entry_session_key`.**
It is a natural key, not a client header: FR-1791 says once per player, so no key a client sends can open a second
payment. The route stays as it is (no `Idempotency-Key`), and rule 6 holds because the door is idempotent by state:
- **A retried check-in** (lost answer, double tap, two operators at once): attendance's `UNIQUE (session_id,
  player_id)` sends the second to `already`; `already` carries `points` = the `score_delta` of that player's `session`
  entry (0 if none), so the operator sees the same "+50" the first answer had.
- **Checked out and in again:** no check-out exists. Should one ever delete an attendance row, the ledger index still
  refuses a second `session` entry for the pair; paying never depends on the attendance row's life.
- **An undo by staff:** `remove_award` on the `session` entry writes a `removal` (reverses it, copies `session_id`).
  Attendance stays (the report is about presence). A later scan answers `already` with `points: 0`; the pair is spent
  for good. To give the points back, staff use a manual award. No "un-check-in" door is built (Q-349).

**`session_check_in` (restated)**, in this order:
1. Session row `FOR SHARE` (SS404). This blocks `session_delete` (FOR UPDATE) and `session_save`'s UPDATE until the
   check-in commits, so a delete racing a check-in ends as delete-then-SS404 or check-in-then-PS409, never 23503 (closes
   the FOLLOWUPS race), and the points paid are the committed value at check-in.
2. Assignment `FOR SHARE` and the OP403/OA403/OS403/OY409 checks as today; `ensure_rehearsal_wiped`.
3. The event row; **agenda switch**: `NOT feature_enabled(ev, 'agenda')` → `AG403` DETAIL `feature_off` (the door is now
   a points door; ADR-381 left it open). `operator_sessions` refuses the same way so the door app shows why.
4. My QR version, enrollment, active (as today).
5. **Event status**: `play_phase(ev, member) IS NULL` → `QN403` DETAIL `event_not_live` (live for real players; a
   rehearsal account in a draft or scheduled event). Covers ended and archived (FOLLOWUPS item) the station-scan way.
6. `too_early` / `ended` / `already` (with `points`) / `not_registered` as today.
7. Insert attendance. If `target.points > 0` and the player may play (no `staff_assignment` with `NOT can_play`), insert
   the `session` entry (plain INSERT: a unique violation here is a broken invariant and must be loud), then
   `mark_ranking_repair`. A staff member who may not play is checked in with `points: 0` (the guard trigger stays the
   backstop). Answer `checked_in` with `walkIn` and `points`.

No boost multiplier, no XP, no streak day, no first-N, not in community goals' points, outside every operator cap.
Score and balance both move (spendable, ranks, today's board), like an award.

**Other doors in 0093**
- `session_delete`: event `FOR SHARE` then re-read (as `session_save`), archived → `PE409 event_closed`; PS409
  `has_attendance` also when any `session` ledger entry names it. `store.ts` maps a residual 23503 to that PS409.
- `session_cancel`: PS409 `checked_in` when the caller already has attendance (FOLLOWUPS: early check-in then cancel).
- `session_message`: the rate limit counts the event's announcements and session messages together (FOLLOWUPS 0086:492).
- `session_write`, `session_import`, `session_team_item`, `member_sessions`, `operator_sessions`: carry `points`.
- `bulk_award` **DROP and CREATE** with `target_session uuid` after `target_quest`: exactly one of list, quest, session
  (AB400 otherwise); SS404 for a session not in the event; the replay compares `session_id` too. New closed helper
  `session_bulk_targets(ev, target_session)`: active members with attendance, may play, minus those whose `session`
  entry was removed (as `quest_bulk_targets` drops a removed completion). Then the existing filter (rehearsal phase,
  enrollments locked `FOR NO KEY UPDATE` in id order), the same `award` entries, notes, audit (`session` added).
  Granted door `session_bulk_count(target_event, target_session) → jsonb {count, earlier}` (`earlier`: bulk awards
  already made to that session).
- Restated with `session` added to their kind lists: `ledger_operator_play_guard`, `remove_award` (removable; copies
  `session_id`), `member_ledger` (removable flag; title via `event_session`), `member_activity` (title via
  `event_session` for `session` and its removal). The worker greps every latest function body that filters
  `ledger_entry.kind` and lists each one in the commit message as "added" or "left out, because". Known left out:
  `community_read_slice`, `ledger_xp`, `ledger_streak`, `awarded_today`, `wipe_rehearsal`'s summary counts (they already
  miss `streak`; one FOLLOWUPS line for both, no restatement of a 100-line function for a summary number).

**The bulk target's audience and the late check-in race.** The audience is fixed when `bulk_award` reads
`session_bulk_targets`, inside its transaction: a check-in that commits before that read is in, one that commits after
is not. Nothing is paid twice by the race (each member is locked and written once per bulk row), the answer and the
record give `awarded`, and the confirm screen shows the preview count and says a late arrival is awarded from a list.
A second bulk to the same session is a new award that pays everyone again; the confirm screen names `earlier` (Q-349).

**When the session or its points change after check-ins.** Points are paid at the value read under the lock and never
recomputed (the ledger is append-only). Editing `points` changes future check-ins only; the dashboard form says so once
anyone is checked in ("Players already checked in keep what they got"). A top-up for past attendees is the session
bulk target; T-604's "future only or also past" may reuse it later. Moving the time, closing registration or changing
seats leaves paid entries alone. Deleting stays refused once anyone checked in (or was paid). Duplicating the event
copies `points`. The rehearsal wipe removes rehearsal entries, then their attendance (enrollment cascade).

**API** (`apps/api/src/sessions`, `apps/api/src/awards`): the draft takes `points` (integer 0..100000, default 0) and
the import an optional `points` column; `door.ts` maps `QN403` → `event_not_live` and `AG403` → `feature_off` red
reasons, and passes `points` through; bulk body adds `{ sessionId, points, reason }`, preview adds `{ sessionId }`
(answers `{ count, earlier }`). `packages/shared`: `SessionCheckInAnswer.points`, session `points`, bulk target type,
messages (ar/en, Western digits, the event's currency name): "Points on check-in", door "+{points} {currency}",
`history.session` "Session: {title}", `awards.kind.session`, bulk target "Everyone checked in to a session",
"Already awarded to this session {count} times", the future-only note.
**Web:** Agenda form and import template gain points; Awards page gains the Session target (picker from
`session_list`), preview and the `earlier` note; the player ledger labels the kind and offers Remove.
**App:** the door result shows "+N" on `checked_in` and `already`; Agenda shows "+N on check-in" when N > 0; History
shows the session line.

## T-602c: migration 0094 (the switches inside the points doors)

The rule is `feature_enabled(ev, key)` (0083): the event's `config.features.<key>` and the platform's
`features.<key>.enabled`, as `composeConfig` reads them. A parity test proves the API's `eventFeatureOn` and the
database agree for `shop` and `polls` in all four switch states (and names any unlock rule if the registry has one).

- **`reserve_reward`** (restated from 0074): after the replay lookup and after `SELECT * INTO ev`, `NOT
  feature_enabled(ev, 'shop')` → `RS403` DETAIL `feature_off`. Rehearsal accounts too (the switch is the setup).
  `rewards/shop.ts` maps RS403 `feature_off` to `featureOff()` (403 `feature_off`), every other RS403 as before.
- **`vote_quest`** (restated from 0052): after `play_quest` (so an outsider still gets not found), when
  `is_live_poll(...)`, `NOT feature_enabled(ev, 'polls')` and no completion of the caller already holds this key →
  `PF403` DETAIL `feature_off`. A plain vote quest is never affected.
- **`member_poll`** becomes plpgsql (same output): if the row it would return exists and polls are off → `PF403`;
  `poll_results` inherits it (it reads `member_poll` first). **`member_vote`** (from 0055) likewise, only for a live
  poll. No row for the caller stays "no row" (not found), so the switch never reveals a quest to a non-member.
- `plays/votes.ts` maps PF403 → `featureOff()` for `GET …/vote`, `GET …/poll`, `POST …/vote`. The routes keep no
  separate check (they hold a quest or reward id, not the event's); the database is the one gate.
- **App:** a 403 `feature_off` on reserve or on a poll sheet shows the organizer-turned-this-off message, closes the
  sheet and refetches the configuration (the tab or card then disappears). Check the existing generic handling first.

**Replays while off.** A retried reserve or vote whose key already succeeded answers its first result (the replay paths
run before the switch check): rule 6 replays stay stable; only a new write is refused.

**A reservation already made when the shop turns off stands.** It stays `reserved` until `reserved_until`; the desk
still hands it over by My QR (operator doors are not behind the switch); the player may still cancel (points return);
expiry still returns points; a digital code already delivered stays delivered. Gap: the player's held prizes are only
listed in the shop read, which is refused while off (ADR-381), so the app cannot show them then (Q-350).

**Racing the switch.** No lock on the event: a reserve or vote that read the switch on before the owner's change
committed is a write made while it was on. Both outcomes are valid states; no test needed beyond the sequential ones.

## Tests (test first; DB tests against `TEST_DATABASE_URL`)

**DB, T-505b** (`apps/api/test/db/sessions.int.test.ts`, `awards.int.test.ts`, `rehearsal.int.test.ts`):
- Check-in pays `points` once: score, balance, kind, operator, `session_id`; 0 points writes no entry; ranking repair
  marked; no XP row, no streak day, no `awarded_today` change.
- **Races (two connections, both fired at once):** two operators scan one player → one `checked_in` with points, one
  `already` with the same points, one entry; check-in vs `session_delete` → SS404 or PS409, never 23503; check-in vs a
  points edit → the entry equals the value committed before the lock; check-in vs `session_cancel` → PS409
  `checked_in` or `not_registered`, never attended-without-registration; session bulk vs a late check-in → `awarded`
  equals entries written, nobody twice.
- Refusals: draft/scheduled real player and ended/archived event (QN403); rehearsal account before go-live paid and
  wiped at go-live (entry and attendance gone, session then deletable); agenda off (AG403); non-playing operator
  attended with 0 points; `remove_award` of a `session` entry → re-scan `already` with 0, no second entry; removal
  writes no XP; `session_delete` archived (PE409).
- Bulk: session target reaches attendees only, skips removed entries and non-playing staff; editor over the per-award
  cap (AC409); key replay same answer, changed session → AK422; two targets → AB400; other event's session → SS404;
  `earlier` counts.
- Readers: `member_activity`/`member_ledger` show the session title for the entry and its removal.
**DB, T-602c** (`rewards`/`shop-window.int.test.ts`, `live-polls.int.test.ts`, `vote-quiz.int.test.ts`):
- Shop off (event switch; platform switch) → reserve RS403 `feature_off`, no redemption, balance unchanged; replay of
  an earlier key while off → first result; cancel and desk handover of a held prize while off still work.
- Polls off → live-poll vote PF403, no completion; replay while off → first result; plain vote quest still votes;
  `member_poll`, `member_vote` (live poll), `poll_results` → PF403 for a member, empty for a non-member.
- Parity: `feature_enabled` vs `eventFeatureOn` for shop and polls.
**Outsider** (`test/security/outsider.int.test.ts`): the public role cannot execute `session_bulk_count`, the new
`bulk_award(…8 args)`, `session_bulk_targets`; the old 7-argument `bulk_award` no longer exists; `ledger_entry` still
has no grant. **Cross-tenant** (`cross-tenant.int.test.ts`): an editor of organizer A cannot bulk-award or count a
session of organizer B (AN404/SS404); an operator of event A cannot check in at event B's session (OP403); event A's
shop or polls switch does not change event B's reserve or vote.
**HTTP** (`test/sessions/routes.int.test.ts`, `test/awards`, `test/rewards`, `test/plays`): status codes and bodies
for each refusal above (403 `feature_off`, red reasons on the door), the bulk body union.
**Web/app:** Agenda form points field, Awards session target, door "+N", History line; `organizers.spec.ts` unaffected
(no new owner-only switch). `npx expo export` once.

**Mutation globs (one grouped run, both tasks):** `apps/api/src/sessions/door.ts`, `apps/api/src/sessions/store.ts`,
`apps/api/src/awards/awards.ts`, `apps/api/src/awards/routes.ts`, `apps/api/src/rewards/shop.ts`,
`apps/api/src/plays/votes.ts` (`!**/*.test.ts`). The SQL is covered by the DB tests above, not by Stryker. Fix the
stale T-505b note in TASKS ("migration 0087").

## Risks

- `bulk_award`'s signature change breaks any caller not updated (API, outsider list, rehearsal list): the full suite
  catches it; grep `bulk_award(` before the commit.
- A missed kind list shows a session line as "Balance change" or not removable: the commit's grep table is the guard.
- `FOR SHARE` on the session serializes check-ins with registrations on that session for milliseconds; fine at door
  rates. Lock order is session → assignment → enrollment everywhere; `bulk_award` takes only enrollments (id order).
- Converting `member_poll`/`member_vote` to plpgsql must keep the output exact: the existing vote and poll tests run
  unchanged.

## Open questions (Proposed; recorded as Q-349 and Q-350 when built)

**Q-349 - T-505b session points: what is decided without Dhia.** Recommended (developer): (1) a new ledger kind
`session`, paid by the door once per player and session (the pair is the key; no client key can pay twice); (2) points
paid only while the player may play: live for real players, before go-live for rehearsal accounts, never to staff who
do not play, never while the agenda is off; (3) no boost, XP, streak or community-goal credit; outside operator caps;
(4) editing a session's points changes future check-ins only; (5) a player checked in cannot cancel the registration;
(6) staff undo is removing the entry; attendance stays, the player is never paid for that session again, and there is
no un-check-in; (7) the session bulk target reaches who was checked in when it runs, minus removed entries; a second
bulk pays again and the confirm screen says how many came before. **Open:** should a session with points be capped for
an editor (as an editor's award is)? Recommended no, as a quest's points are not.

**Q-350 - T-602c switches in the points doors: what is decided without Dhia.** Recommended (developer): (1) the shop
switch refuses new reservations and the polls switch refuses live-poll votes and their reads, in the database, with 403
`feature_off`; plain vote quests are not live polls and stay open; (2) a retried request that already succeeded
answers as before; (3) reservations made before the switch-off stand: desk handover, cancel and expiry work. **Open:**
while the shop is off the player cannot see a prize they still hold (it is listed only in the shop read). Recommended:
a small tier B follow-up that shows held prizes on Home while the shop is off, not built here.
