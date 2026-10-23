# T-207 — Manual awards, caps, report, removal, bulk award

Delivers FR-308, FR-309, FR-310, FR-311, FR-320, FR-1601, FR-1712 (part), FR-1027 (on the Players page). **Max bar:**
the points ledger and admin powers (QUALITY_BASELINE). Migration **0030**. Depends on T-205 (operators, My QR).

## Decisions from Dhia (2026-10-23) → ADR-152, Accepted

1. **Caps are per event only:** a maximum per award and a maximum per person per day, set by the owner, followed by
   every operator and every editor. The owner's own dashboard awards are uncapped. No per-operator override.
2. **A removed quest stays used:** the completion stays on record and counts toward the repeat cap; only its points
   come off. A mistaken removal is put right with a new manual award.
3. **Bulk award (FR-1712) now:** an uploaded or pasted list (usernames or phone numbers), or "everyone who completed
   quest X". Sessions (T-505) and categories come later (notes on T-505; FR-1712 amended).
4. **Owners and editors remove awards** (the dashboard role table). FR-320 amended from "the owner".

## Judgment calls (mine; the CTO may overturn)

- **XP (FR-1602) moves to T-401.** No XP ledger exists yet; T-401 builds XP and must reverse a removed quest's XP
  (note added there). FR-1602 stays pending.
- **Only the owner sets the caps** (FR-310 "the owner's caps"); the role table's "editor: operators and caps" is read
  as operators only. An editor who could raise the cap would have no cap. Doc fixed in DASHBOARD_AND_CONSOLE.md.
- **The day** for the daily cap is the event's day: `timezone` and `day_start_hour` (already on `event`).
- **Awards only while the event is live** (operator, dashboard and bulk). **Removals while live or ended**: a cheat
  found at the end must still come off before winners (T-214 freezes results later; note there).
- **A manual quest award** goes through `record_completion` with method `manual`: it skips the proof checks (method,
  QR version, code) and keeps every other rule (enrollment active, event live, quest visible and inside its window,
  repeat cap). An operator's quest limit (`staff_assignment_quest`) applies to it. Points come from the quest.
- **Reasons live beside the ledger, not in it.** `ledger_entry` is append-only for every role, and a staff-typed
  reason may name a person; T-217 must be able to clear it. `ledger_note` is insert-only for the API role, and only
  the database owner (migrations, the deletion job) can update it. The report and the record join it.
- **Find a player (operator):** exact username (case-insensitive) or exact Saudi mobile, only among the event's
  members, only for an operator with the `award` ability. No prefix search for operators (no browsing a guest list).
  Rate limit 30 finds per operator per 10 minutes (the station's other paths have none, but this one reads phones).
  The dashboard keeps the Players page's existing username search.
- **Which entries can be removed:** the credit kinds: `quest` (any method), `award`, `welcome`. Not spends, returns
  or handovers. Once per entry (a unique index).

## Data (migration 0030)

1. **`event`** gains `award_cap_each integer NOT NULL DEFAULT 200 CHECK (1..100000)` and `award_cap_day integer NOT
   NULL DEFAULT 500 CHECK (award_cap_day >= award_cap_each AND award_cap_day <= 1000000)`; written only through
   `set_award_caps` (owner; audited), not in the API role's UPDATE grant.
2. **`quest_completion.method`** adds `manual`.
3. **`ledger_entry`**:
   - kinds add `award` (points by hand) and `removal`; actor adds `staff` with a new `staff_user_id uuid REFERENCES
     staff_user` (`(actor = 'staff') = (staff_user_id IS NOT NULL)`); `reverses bigint REFERENCES ledger_entry (id)`.
   - `ledger_entry_award_shape`: `award` → `score_delta > 0 AND score_delta = balance_delta`, no completion, quest or
     redemption, actor `operator` or `staff`.
   - `ledger_entry_removal_shape`: `removal` ↔ `reverses IS NOT NULL`; `score_delta <= 0`, `balance_delta <= 0`
     (both clamped, so a removal may be 0/0 and still mark the entry removed); actor `staff`; no redemption. The
     record shows the full amount removed from `reverses → entry.score_delta` (FR-1601). `completion_id` and `quest_id` copy the removed
     entry's, so per-quest sums (`earned`) net out. Unique partial index on `reverses`.
   - `ledger_entry_staff_kinds`: `actor <> 'staff' OR kind IN ('quest', 'award', 'removal')`.
   - `ledger_entry_operator_quests_only` widens to `quest, handover, redeem_return, award`.
   - `ledger_operator_play_guard` also refuses `award` to an operator who may not play.
4. **`ledger_note`** `(entry_id bigint PK REFERENCES ledger_entry, organizer_id, event_id, reason text 1–300 chars,
   bulk_id uuid REFERENCES bulk_award, created_at)`, `CHECK ((reason IS NULL) = (bulk_id IS NOT NULL))`: a bulk
   award's reason is stored once, on `bulk_award`. Forced RLS, read like `ledger_entry`, no grants to write; a
   trigger refuses UPDATE/DELETE for every role but the owner connection. Every `award`, `removal` and manual quest
   entry has exactly one (written in the same function).
5. **`manual_award_key`** `(id, event_id, operator_id uuid REFERENCES player NULL, staff_user_id uuid REFERENCES
   staff_user NULL, idempotency_key, entry_id, enrollment_id, amount, created_at)`, exactly one of the two actors
   (CHECK), unique per (event, actor, key): the idempotency record for points awards and removals (a quest award uses
   the completion's key). The key is looked up **first**, before any other check, like `record_completion`; a replay
   whose enrollment, amount, quest or kind differs is 422 `idempotency_key_reused` (the same for `bulk_award`: amount,
   target and count).
6. **`bulk_award`** `(id, organizer_id, event_id, staff_user_id, amount 1–100000, reason, target text 'list'|'quest',
   quest_id, count_awarded, count_skipped, idempotency_key, created_at; UNIQUE (event_id, staff_user_id,
   idempotency_key))`.

## Functions (definers, `search_path` pinned, revoked from PUBLIC, granted to `questify_app` only)

Refusal codes follow the 0026 pattern and are listed in each function's header.

- `record_completion` gains `staff uuid` and `reason text` parameters: `actor = 'staff'` with `staff_user_id` when
  set; the replay check compares `staff_user_id` too; method `manual` skips the proof block (method, QR version,
  code) but keeps the 10-second station guard when an operator is set; a manual entry gets its `ledger_note`.
  `complete_quest` and `operator_complete_quest` pass NULL for both.
- **Lock order everywhere:** the operator's `staff_assignment` row (`FOR NO KEY UPDATE`: it still conflicts with the
  scan's `FOR SHARE` without blocking `staff_assignment_quest` key checks), then the enrollment.
- `operator_find_player(target_event, query)` → `(enrollment_id, username, avatar, active boolean)` (0 or 1 row; never
  the exact status, so an operator is not told who is banned). Needs an
  operator of the event with `award`.
- `operator_award_state(target_event)` → caps, the operator's points awarded today, left today, and the quests they
  may award (open, inside their limit).
- `operator_award(target_event, target_enrollment, quest, amount, reason, request_key)` → `(entry_id, points,
  replayed)`. Exactly one of `quest`/`amount`. Locks the operator's `staff_assignment` row (serializes
  one operator's awards: the daily-cap race) and then the enrollment. Checks: ability `award`, not self, event live,
  enrollment active, the amount (or the quest's points) ≤ `award_cap_each`, today's sum + it ≤ `award_cap_day`. Today's
  sum counts this operator's `award` entries and `manual` quest entries in the event day (removals do not refund
  the cap). Writes the entry (and for a quest, the completion through `record_completion`), the note, the key, a
  ranking repair mark.
- `staff_award(target_event, target_enrollment, quest, amount, reason, request)`: the same for an owner or editor in
  scope; editors capped (an advisory lock on (event, staff user) serializes their daily sum), the owner uncapped. Audit
  log entry `event.manual_award`.
- `remove_award(target_event, entry, reason, request)`: owner or editor in scope; event live or ended; the entry is a
  credit kind of this event; locks the enrollment; writes `removal` with `score_delta = −least(entry.score_delta,
  enrollment.score)` (a spend that lowered the rank, 0025, already took some score; `score >= 0` holds) and
  `balance_delta = −least(entry.balance_delta, enrollment.balance)` (FR-1601), the note, a repair mark, an audit entry
  `event.award_removed`. A second removal of the same entry answers `already_removed`. **Open reservations:** when either
  delta would be clamped (balance < the entry's balance delta, or score < its score delta) and the player holds a `reserved` redemption, the removal
  is refused (409 `open_reservation`): its later cancel or timeout would return points the removal could not take.
  The confirm sheet says "Cancel their reserved prize first" (the desk's cancel, T-206). A removal that takes the
  full amount leaves reservations alone: their return gives back only what was really spent.
- `resolve_bulk_targets(target_event, usernames text[], phones text[])` → matched `(enrollment_id, username, status)`
  and the unmatched inputs (max 2000 lines). `quest_completers(target_event, quest)` → the active enrollments with a
  completion of that quest whose quest entry was not removed (a caught cheater gets no bonus).
- `bulk_award(target_event, enrollments uuid[], target, quest, amount, reason, request)`: owner or editor. The owner's
  bulk is uncapped; an **editor's** bulk needs `amount <= award_cap_each` and does not count toward the daily cap
  (otherwise a one-player list is an uncapped award; FR-1712's "outside operator caps" predates capped editors;
  ADR-152, Q-118). One transaction; the passed ids are re-filtered to this event and the caller's scope (dropped ids
  count as skipped, so one foreign id never aborts the batch); skips non-active enrollments and operators who may
  not play (counted); one
  `award` entry per player with the same note `bulk_id`; one repair mark; one audit entry. Max 2000 players.
- `set_award_caps(target_event, each, day, request)`: owner only; audited.
- `manual_awards(target_event, after_id, page)`: the report (FR-311): award and removal entries and manual quest
  entries with player username, quest title or points, reason, who (operator username or staff name), time, and
  whether it was removed; newest first, cursor paging.
- `member_ledger(target_event, target_enrollment, after_id, page)`: one player's entries for the dashboard's
  "remove" list (kind, points, quest, who, reason, removable).
- The per-quest `earned` sums (0022, 0026) add `score_delta` by `quest_id` with no kind filter, so a removal nets
  out (partly, when clamped); the app shows whatever the sum is.
- `member_activity` (0023/0024) names `award` and `removal` for the player's own history; the reason is never shown
  to the player.

## API (`docs/API.md`)

Operator (`apps/api/src/operators`, new `awards.ts`):
- `POST /v1/operator/events/{eventId}/find-player` `{query}` → `{player: {enrollmentId, username, avatar} | null}`;
  403 `not_operator` / `ability_off`; 429 `too_many_attempts`.
- `GET /v1/operator/events/{eventId}/award` → `{capEach, capDay, leftToday, quests: [{id, title, points}]}`.
- `POST /v1/operator/award` `{eventId, enrollmentId, questId?, points?, reason}`, **Idempotency-Key** →
  `{points, replayed}`; 403 `ability_off` / `self_award` / `operator_not_playing`, 409 `over_cap {cap: "each"|"day",
  limit, left}` / `already_completed`, 403 `quest_not_open` / `enrollment_inactive`.

Dashboard (`apps/api/src/awards`, new module):
- `POST …/events/{eventId}/players/{enrollmentId}/awards` (member), `GET …/players/{enrollmentId}/entries`,
  `POST …/events/{eventId}/entries/{entryId}/remove` (member; owner or editor),
- `POST …/events/{eventId}/bulk-awards/preview` `{lines}` or `{questId}` → matched count, unmatched lines;
  `POST …/events/{eventId}/bulk-awards` **Idempotency-Key**,
- `GET …/events/{eventId}/awards` (the report, cursor), `PUT …/events/{eventId}/award-caps` (owner).

Every reason: trimmed, 1–300 characters, required (400 `reason_required`). Points: integer 1–100000.

## Screens

- **Dashboard, Players page:** a player's panel gains their points record (each entry with **Remove**, through a
  confirm sheet with a required reason) and **Award** (quest or points, reason, confirm sheet showing the cap that
  applies to an editor). **New Awards page:** the report (empty state "No manual awards yet"), the caps card (owner
  edits, editors read), **Bulk award** (paste or upload a .csv/.txt list or pick a quest → preview: matched,
  not found → amount and reason → confirm). Arabic and English, RTL, phone width.
- **Operator app, Tools → Manual award** (OPERATOR_MODE 3.5): find (username or phone), the player card, quest or
  points, reason, "Limit: 200 per award", "Left today: 450 of 500", Award off until all filled, the confirm screen,
  the result "Awarded 50 to Sara_88. Reason saved.", refusals in plain words. The Tools placeholder row goes. Hidden
  when the `award` ability is off.
- **Player app:** history shows "Awarded by staff" and "Points removed".

## States

Empty report, no match on find, over cap (each / day, with what is left), reason empty, event not live, enrollment
inactive, operator not playing, self-award, already removed, removal leaving balance at 0 (FR-1601 message on the
confirm sheet: "Their balance is 50; it will go to 0. The score drops by 200."), open reservation on a clamped removal, an
editor's bulk over the per-award cap, bulk with unmatched lines, bulk over 2000, offline/server error, replay with the same key.

## Tests

- **Database** (`apps/api/test/db/…`): every refusal; caps at the boundary (exactly the cap passes, +1 fails);
  removal after spending (FR-1601 both examples); removal after a spend that lowered the rank (the score clamp);
  a clamped removal refused with an open reservation, then allowed after the cancel; a full removal beside a
  reservation whose cancel returns only the spend; quest completers leave out removed ones; a replay with another
  amount or player is 422; removed quest stays used; one removal per entry; **races**: two
  awards by one operator crossing the daily cap (one refused), two removals of one entry, a removal against a spend, a removal against a reserve,
  an editor's two awards across the cap; append-only `ledger_note`; an editor outside the event scope; cross-tenant.
- **Outsider:** the API role without a player or staff context executes none of the new functions to any effect;
  `anon`/`PUBLIC` hold no EXECUTE.
- **Routes:** each status above, idempotent replay, rate limit on find.
- **Unit:** reason and amount parsing, the bulk list parser (usernames, `05…`/`+966…` phones, blanks, duplicates).
- **Browser** (Playwright, desktop and phone): award and remove on the Players page; bulk preview and confirm;
  the report.
- **App:** unit tests of the award flow state (`apps/app/src/operator/award.ts`); `expo export`.
- **Mutation** (Stryker) on `apps/api/src/awards` and `src/operators/awards.ts`.

## Phases (one code review at the end, per the token budget)

1. Migration 0030 + database tests + outsider tests.
2. API (operator and dashboard routes) + route and unit tests.
3. Dashboard (Players panel, Awards page) + browser test.
4. Operator app (Manual award) + player history labels + app tests; docs (API, DATA_MODEL, SRS amendments, ADR-152,
   TASKS notes on T-401, T-505, T-214, T-217), mutation.

## Out

XP reversal (T-401), session targets (T-505), category targets, the live control room placement (T-603 reuses the
award form), practice mode for awards (FR-929, with practice mode), pushes to the player about awards.
