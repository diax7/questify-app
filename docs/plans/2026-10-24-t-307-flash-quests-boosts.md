# T-307 — Flash quests and double-point boosts

F-102: **flash quests** (FR-251), quests that exist for players only inside a short window, launched now or scheduled,
and **double-point boosts** (FR-252), a window in which one category's quests pay double. The **live finale** (F-103:
FR-254, FR-255, FR-1621) is split out to T-307b (ADR-230, below): it is a big-screen scene and the big screen (T-504,
with T-309's pairing) does not exist yet. **Core bar**: a boost changes what a quest pays, so it sits in every quest
payer (`record_completion`, `pay_completion` and their callers); one Opus plan review, one Opus code review, mutation
on GitHub. Migration **0055** (new file; CranL runs through 0047, so 0048 to 0054's functions are changed here by
restating them, never by editing those files). Depends on T-306b (live read, community), T-306c (the gate and the
completeness test this extends), T-304/T-304c (category rules, periods), T-304d (items), T-211 (rehearsal), all done.

Dhia is away: open choices are my recommendation, written as **Proposed** ADR-230 to ADR-233 and Q-195 to Q-197, also
entered in `docs/DECISIONS.md` and `docs/OPEN_QUESTIONS.md` with this plan.

## What exists that this plan builds on

- **Points are written once.** Every quest payment is one `ledger_entry` of kind `quest` (`score_delta`, and
  `balance_delta` = the same or 0 once the shop closed); the enrollment's score and balance, the ranking cache
  (`apply_ledger_entry`, 0015), today's ranking (0035), results (0034) and a community points goal (0053) all read
  `score_delta`. `remove_award` (0053:919) reverses an entry by copying its own `score_delta`/`balance_delta` (bounded
  by what the player holds). So a boost written **into the entry** is rebuilt, reversed and ranked with no reader
  change.
- **Some points are frozen before they are paid**: a submission's `points` at send (`submission.created_at`, paid at
  approval by `pay_submission`, 0041), a quiz's `points_each` at start (`quiz_attempt.started_at`, paid by
  `finish_quiz`, 0044, also from `confirm_results`), a game round's `points` at issue (`game_round.issued_at`, paid by
  `finish_game_round`, 0050). Direct completions pay `quest.points` now: `record_completion` (0054: scan, typed code,
  location, my-QR, vote and live poll through `complete_quest`/`vote_quest`, survey, share), `stamp_step`'s final stamp
  (0045) and `pay_meeting` (0049, both sides) through `pay_completion` (0049).
- **Payouts that are not quest points**: `pay_category_bonus` (0047, once per period, 0046), `give_item` (0047),
  `pay_community_batch` (0053), `grant_manual_award` (0030/0032: `award` entries and owner/editor/operator manual quest
  completions, capped by `awarded_today` over `score_delta`), `bulk_award`, `grant_welcome`, the XP trigger (0039, a
  fixed per-quest amount, never `score_delta`).
- **Windows**: `quest_open_check` (0046:279) refuses `not_started`/`ended` by `opens_at`/`closes_at` at every door,
  manual awards included. Live polls (0052) are the model for a launched window: `send_poll` writes
  `visible/opens_at/closes_at/poll_sent_at`, a launch in a live event runs the go-live wipe first, a rehearsal launch is
  put back to draft by `wipe_rehearsal` (0052:447, the latest), `polls_shown(ev)` hides rehearsal sends between go-live
  and the wipe, and live polls stay out of every category rule.
- **The live read** (`GET /v1/events/{id}/live`, ADR-221): `live_state` (0054:836) and `event_has_live` (0053:1147,
  the API's 3 s shortcut), polled by the app's `LiveProvider`, with one-time cards in a queue.

## Flash quests (FR-251; ADR-231)

A flash quest is **any quest but a live poll** with `flash = true`. It has two ways to run:

- **Launch now**: a draft flash quest (`visible = false`, no window) is launched by an owner or editor for 1 to 1,440
  minutes: `launch_flash` writes `visible = true`, `opens_at = now`, `closes_at = least(now + minutes, event end)`,
  `flash_launched_at = now`, audited `quest.flash_launch`. As `send_poll`: in a live event it runs
  `ensure_rehearsal_wiped` first; before go-live it is allowed only while a rehearsal is open (a rehearsal launch);
  otherwise `FE409 event_not_live`. A second launch while open answers the first (`replayed`); once closed `FL409
  already_launched` (a flash quest runs once). Launching a community-locked quest is refused (`FL409
  community_locked`, as Send, ADR-228).
- **Scheduled**: the builder sets `visible = true` with both `opens_at` and `closes_at` (1 to 1,440 minutes apart).
- **End now**: `end_flash` sets `closes_at = now` on a running flash quest (as `close_poll`); ending an ended one
  changes nothing. After launch or once a scheduled window started, the API's seat keeps the window as it is (the
  builder's write-back rule for sent polls, `quests/store.ts`), so only `end_flash` moves it.

Rules:

- **Shown only inside its window** (`flash_shown(q, ev)`: not flash, or `opens_at <= now() < closes_at` and, for a
  launched one, `polls_shown(ev)`; and the event's `features.flashQuests` not false). Outside it the quest is in no
  player read: the quests list, Home, the sheets, the public page (which never lists a flash quest: a surprise drop is
  not advertised), the operator's award list. A player who did it keeps it in their activity (the ledger names it).
- **Every door** already refuses outside the window (`quest_open_check`); a draft is `hidden`. `quest_open_check` is
  restated only to refuse a flash quest while the event switch is off (`QN403 switched_off`); the platform switch is
  the API's (the quest reads drop flash quests, the completion routes refuse them, launch answers `403 feature_off`).
- **Out of every category rule**, as live polls (ADR-220): `category_done`, `category_cleared` and the in-order check
  leave flash quests out both ways, so a flash quest missed never holds a category's bonus, its successor or a later
  quest; doing one never counts toward the bonus. Restated: `category_done`, `category_cleared`, `category_rule_lock`
  (0054).
- **Periods (0046)**: a flash quest in a daily or weekly category follows the period cap like any quest (only scan,
  code and challenge sit there); a window that crosses the event-day start allows one more completion in the new day.
  Tested, accepted (the existing rule).
- **Items (0047)**: a flash quest's item is given on the first completion, as today.
- **Community (0053/0054)**: a goal may count a flash quest (the finale's push will); an unlock may target one (its
  window still applies). No change.

## Double-point boosts (FR-252; ADR-232, ADR-233)

`boost (id, organizer_id, event_id, category_id, multiplier, starts_at, ends_at, rehearsal, created_by, created_at)`:
one category of the event (a "zone" is a category under the event's own word for it, F-187; there is no other zone
entity), `multiplier` = 2 (a CHECK; the column is what the ledger entry's amount was computed with), `ends_at -
starts_at` 1 to 1,440 minutes, `ends_at <= event end`. Composite key `(category_id, event_id)` to `category`
(RESTRICT: a category with a boost cannot be deleted; the builder maps it to `409 boost_in_use`). At most 100 an
event. Closed table (RLS forced, PUBLIC revoked, no grant); written only by its definers.

- **Fire now or schedule** (`save_boost`, owners and editors): a start of now (up to 60 s ago is taken as now, as
  goals) or later; no two boosts of one category overlap (`BO409 boost_overlap`, checked under an advisory lock per
  event, as rank-prize ranges); inside the event's window (`BO422 outside_event`); not after results exist
  (`BO409 event_ended`). Audited `boost.create` / `boost.update` / `boost.end` / `boost.delete`.
- **A window never covers a past moment it did not cover**: a scheduled boost may be edited or deleted only until 1
  minute before its start (`BO409 boost_started`); a started one can only be **stopped** (`end_boost`: `ends_at =
  now`). So looking a boost up by a past time always gives the same answer (the rule ADR-233 rests on), and a delete
  never meets a payer inserting the boost's key (no transaction lives a minute: the pool's 10 s idle limit).
- **Rehearsal**: a boost saved while the rehearsal is open whose start is before the event's start is a rehearsal boost
  (`rehearsal = true`, the form says "Removed at go-live"); it pays only rehearsal accounts, and `wipe_rehearsal`
  deletes it **after** the rehearsal ledger entries that name it. Every payer runs `ensure_rehearsal_wiped` before it
  reads a boost, so no live entry ever names one.
- **Switches**: the event's `features.boosts` off stops every boost paying at once (the lookup reads it; turning it
  back on resumes what is still in its window); the platform's is the API's: no new boost is saved, running ones
  finish (as ADR-226).

### Which payouts are boosted (ADR-232)

| Payout | Boosted | Where |
|---|---|---|
| Scan, typed code, location, my-QR (an operator scanning the player), vote, live poll with points, survey, share | yes, if a boost of the quest's category is in force **now** | `record_completion` (not `manual`) |
| Passport's final stamp, meet-someone (each side, same quest) | yes, now | `pay_completion` (default time) via `stamp_step`, `pay_meeting` |
| Submission | yes, if in force **when it was sent** | `pay_submission` passes `sub.created_at` |
| Quiz (right answers × points each) | yes, if in force **when it started** (also when `confirm_results` finishes it) | `finish_quiz` passes `attempt.started_at` |
| Mini-game | yes, if in force **when the round was issued** | `finish_game_round` passes `played.issued_at` |
| Category bonus (each period), its item | **never**: the organizer's fixed bonus | `pay_category_bonus` unchanged |
| A quest's item | never: one item, not points | `give_item` unchanged |
| Community payout | never: the step's fixed reward | `pay_community_batch` unchanged |
| Manual quest award (owner, editor, operator), point award, bulk award | **never**: staff award the quest's own points; caps (`awarded_today`) stay on them; a missed boost is made up with a point award | `record_completion` with `manual`, `grant_manual_award`, `bulk_award` |
| Welcome points, rank prizes, XP | never | unchanged |

The **time a boost is judged** is the time the quest's points were fixed (ADR-233): what the player saw when they
acted is what they get, whatever the review or finish delay. Nothing new is stored on submissions, attempts or rounds:
the lookup by that time is stable (rule above).

### Recorded on the ledger entry

- `ledger_entry.boost_id uuid` → `boost (id)` RESTRICT; `CHECK (boost_id IS NULL OR kind IN ('quest', 'removal'))`.
  A boosted quest entry writes `score_delta = points × multiplier` and `balance_delta` the same (0 once the shop
  closed) with `boost_id`. One entry, so: the score, balance and ranking cache move by it; a ranking **rebuild from
  the ledger** gives the same order (test); today's ranking and results read it; `confirm_results` freezes it.
- **Removal** (`remove_award` restated): copies `boost_id` onto the removal, and reverses the entry's own amounts as
  today, so removing a boosted completion takes back exactly the doubled points (and its XP once, as 0039).
- A **community points goal** counts the boosted amount (it counts points earned, `score_delta`); a completions or
  players goal counts one as before. Stated in ADR-233.
- `member_activity`, `member_ledger` (0053) restated: each row gains `multiplier` (from the boost) for "×2" in the
  history and the team's player record.

### The payers (internal helper and restated functions)

- `quest_boost(quest_row quest, enrolled enrollment, at timestamptz) RETURNS boost`: the boost of the quest's
  category with `starts_at <= at < ends_at`, the event's switch on, and `NOT rehearsal OR` the enrollment is a
  rehearsal account; NULL otherwise. One index probe (`boost (category_id, starts_at)`), no lock.
- `record_completion` (0054) restated: after the cap checks, `b := CASE WHEN proof_method = 'manual' THEN NULL ELSE
  quest_boost(quest_row, enrolled, now()) END`; the entry and the answer's `points` carry the multiplied amount. Its
  output is unchanged (the API reads `boost` with `completion_boost(completion)`, below).
- `pay_completion` DROP and CREATE with a 9th parameter `fixed_at timestamptz DEFAULT NULL` (now when NULL): the
  boost lookup and the multiplied entry. `pay_submission`, `finish_quiz`, `finish_game_round` restated to pass their
  frozen time; `stamp_step` and `pay_meeting` keep calling with 7 or 8 arguments (now).
- `completion_boost(completion bigint) RETURNS integer` (granted): the multiplier of the caller's own completion's
  entry, NULL when none or not the caller's; the API adds `boost: {multiplier} | null` to every completion answer
  (scan, code, location, vote, survey, share, quiz finish, game finish, meet).
- **The payer completeness test** (new, beside T-306c's reader map): it lists every function whose `prosrc` inserts
  into `ledger_entry` and checks each against a map checked into the test: `boosted` (with its test row above) or
  `never` (with its one-line reason). A new payer missing from the map fails the test.

## Announcing (until T-501's push)

- `live_state` restated: `flash: [{questId, closesAt}]`, the flash quests open now that the member may play (as
  `polls`: `sees_category`, `category_lock` IS NULL, not done this period; an operator who may not play gets none);
  `boosts: [{boostId, categoryId, multiplier, endsAt}]`, running boosts of categories the member sees (never a hidden
  category's name to a player who has not revealed it). `event_has_live` restated: also true while a flash quest is
  open or a boost runs. The ETag moves with them.
- App: `LiveProvider` queues a one-time card per flash quest ("Flash quest!", its title, "Ends {time}", Open) and per
  boost ("Double points", the category, "until {time}"), remembered as the poll cards are; the quests tab and Home
  refetch when a new one appears. The "Happening now" strip (FR-806) is T-502's and reads the same fields.

## Every door and reader this reaches

| Path (latest file) | Change | Test (`test/db/flash-boosts.int.test.ts` unless said) |
|---|---|---|
| `quest_open_check` (0046:279), restated | flash quest with the event switch off: `QN403 switched_off` | door table (flash) |
| `category_done`, `category_cleared`, `category_rule_lock` (0054), restated | flash quests left out both ways | missed flash: bonus still paid, successor opens, in-order next opens; done flash adds nothing |
| `record_completion` (0054), restated | boost now, never for `manual` | payer table |
| `pay_completion` (0049), DROP and CREATE; `pay_submission` (0041), `finish_quiz` (0044), `finish_game_round` (0050), restated | boost at the frozen time | payer table, the frozen rows both ways |
| `remove_award` (0053), restated | copies `boost_id` | removal reverses the doubled amount; ranking rebuild equals the cache |
| `member_event_quests` (0054), DROP and CREATE | `flash_shown` filter; new columns `flash_closes_at`, `boost jsonb` (`{boostId, multiplier, endsAt}` of the category's running boost) | listed only in the window; boost on its category only (Done when) |
| `member_vote`, `member_quiz`, `member_survey`, `member_share`, `member_passport`, `member_game`, `member_poll` (0054), restated | `flash_shown` (no row; `member_game` QN403 `hidden`, as its lock) | each answers nothing before and after the window |
| `public_event_quests` (0054), restated | never a flash quest | public page omits it |
| `operator_award_quests` (0054), restated | a flash quest only while shown | absent outside the window |
| `live_state` (0054), `event_has_live` (0053), restated | `flash`, `boosts` | route test: shapes and ETag |
| `member_activity`, `member_ledger` (0053), restated | `multiplier` | ×2 row and its removal |
| `wipe_rehearsal` (0052), restated | after the ledger rows: delete rehearsal boosts; put rehearsal-launched flash quests back to draft (`visible = false`, window and `flash_launched_at` NULL) | rehearsal case below |
| `send_poll` | unchanged: a live poll can never be flash (CHECK) | builder refusal |
| New: `launch_flash`, `end_flash`, `save_boost`, `delete_boost`, `end_boost`, `event_boosts`, `completion_boost` (granted); `flash_on`, `flash_shown`, `quest_boost` (internal) | | outsider and cross-tenant suites |

**The door table (flash)**: one table-driven test, one row per door (scan, typed code, location, my-QR, operator scan,
owner's manual award, operator's award, vote, quiz start and answer, survey, share, passport stamp, submission, game
start and finish, meet code and pass), each run before the window (`not_started`, or `hidden` for a draft), inside
(succeeds), after (`ended`), and inside with the event switch off (`switched_off`).

**The payer table (boost)**: one row per payer above, each run with a boost on its quest's category in force (pays
×2, `boost_id` set), a boost on another category (pays ×1: the Done when), no boost, and for the frozen rows both
crossings (sent/started/issued inside and paid after the end: ×2; before and paid inside: ×1). Never rows: the
category bonus and its item, a quest item, a community payout, manual quest awards by an owner and an operator (and
`awarded_today` unchanged), point and bulk awards. Plus: a boosted live poll vote, a boosted quiz finished by
`confirm_results`, a boosted completion in a daily category (each completion inside the cap ×2, the period bonus ×1).

## Rehearsal and the go-live wipe

- **Order**: `ensure_rehearsal_wiped` first in every payer and in `launch_flash`/`save_boost` for a live event; the
  boost lookup and the flash window are read after it. So the wipe has deleted rehearsal boosts and reset rehearsal
  launches before any live entry is written.
- In `wipe_rehearsal`: rehearsal ledger rows first (they name the boosts), then submissions, attempts, rounds (as
  today), then `DELETE FROM boost WHERE event_id = target AND rehearsal`, then the flash reset (beside the poll reset).
  Real boosts and scheduled flash quests are organizer data and stay.
- Test: a rehearsal boost doubles a rehearsal account's scan; the event goes live; the first live scan runs the wipe,
  the rehearsal entry and boost are gone, the live scan pays ×1; a real boost scheduled during rehearsal survives and
  pays live players. A rehearsal-launched flash quest is a draft again after the wipe and can be launched live.

## Races and lock order

| Case | Outcome |
|---|---|
| `end_boost` while a player scans | the scan reads the boost without a lock; its entry's key takes `KEY SHARE` on the boost row, the stop's `UPDATE ends_at` takes `FOR NO KEY UPDATE`: no conflict. The scan is ×2 iff its `now()` is before the committed end it saw. Crossed test, both orders. |
| Two saves of overlapping boosts | the event's advisory lock serialises them; the second is `boost_overlap`. Crossed test. |
| `delete_boost` vs a payer | impossible inside a minute of the start (rule above); tested by the refusal. |
| `launch_flash` while players read | the launch updates the quest row (`FOR NO KEY UPDATE`); completions only read it and take `KEY SHARE` through their keys: no conflict. |
| Lock order | `save_boost`: rehearsal row → event advisory lock → boost rows; never an enrollment. `launch_flash`/`end_flash`: rehearsal row → quest row. Payers unchanged (ADR-211) plus an unlocked boost read. rules.md's lock-order paragraph gains these two lines. |

Cost: one more index probe per completion (`quest_boost`) and per quest row in `member_event_quests` (the running
boost of each category, computed once per category in a `LATERAL`). The database test reads `EXPLAIN` of the probe
once (as T-306c).

## API

- Team: quest body `flash: boolean` (422 `invalid_quest {issues: flash_live_poll | flash_window}`); `POST
  …/events/{eventId}/quests/{questId}/launch` `{minutes}` and `…/end`, **Idempotency-Key**, → `{opensAt, closesAt,
  replayed}` (404, 403 `feature_off`, 409 `already_launched` / `event_not_live` / `community_locked`, 422
  `not_flash`). `GET/POST …/events/{eventId}/boosts`, `PATCH/DELETE …/boosts/{boostId}`, `POST …/boosts/{boostId}/end`
  (403 `feature_off`, 404, 409 `boost_overlap` / `boost_started` / `event_ended` / `limit_reached`, 422
  `invalid_boost {issues}`). Category delete: `409 boost_in_use`.
- Player: quests (and Home): each quest `flash: {closesAt} | null`, `boost: {multiplier, endsAt} | null`; each
  category `boost`. Every completion answer gains `boost: {multiplier} | null`. `/live` gains `flash` and `boosts`.
  Activity rows gain `multiplier`.
- Switches: `flashQuests` and `boosts` in `packages/shared/src/config/registry.ts` (`gated: false`), the event's
  switches on the dashboard.
- `http-errors.ts` gains the new codes; `routes.int.test.ts` classifies the new routes.

## App and dashboard

- **App**: a quest card with the lightning badge (`icon-lightning`) and "Ends {time}"; a boosted category and its
  quests with the "×2" seal and "Double points until {time}"; the completion screens and the quiz and game results
  say "Double points!" when `boost` is set; activity rows "×2"; the live cards above. Older apps (F-282): the new
  fields are ignored (a flash quest is a normal quest to them, inside its window only, which the server enforces).
- **Dashboard**: the quest form's "Flash quest" switch (Launch later from here, or a scheduled window), Launch with
  minutes and End now on a flash quest (as Send and Close); a **Boosts** page (list with state, the form: category,
  now or a start, minutes; Stop; Delete before the start; the rehearsal note), the two event switches. T-603's control
  room later gathers Launch and Boost on one screen (FR-1025).

Strings (Arabic via `ux-araby` at build, Western digits, RTL checked; drafts):

| Key | English | Arabic |
|---|---|---|
| quests.flash.badge | Flash | خاطفة |
| quests.flash.endsAt | Ends {time} | تنتهي {time} |
| quests.boost.badge | ×2 | ×2 |
| quests.boost.until | Double points until {time} | نقاط مضاعفة حتى {time} |
| completion.boosted | Double points! | نقاط مضاعفة! |
| live.flash.title | Flash quest! | مهمة خاطفة! |
| live.boost.title | Double points | نقاط مضاعفة |
| live.boost.body | {category} until {time} | {category} حتى {time} |
| activity.boosted | ×2 | ×2 |

Plus the dashboard's labels ("Flash quest", "Launch now", "Minutes", "End now", "Boosts", "Double points on",
"Starts", "Stop", "Removed at go-live"), the refusals (`boost_overlap`: "Another boost runs on this category at that
time", `boost_started`: "A started boost can only be stopped", `already_launched`, `flash_window`) and the two switch
labels.

## Data (migration 0055)

- `quest`: `flash boolean NOT NULL DEFAULT false` (column grant to the API with the other builder columns),
  `flash_launched_at timestamptz` (no grant); `CHECK (NOT flash OR NOT is_live_poll(type, type_config))`; `CHECK (NOT
  flash OR NOT visible OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at - opens_at BETWEEN 1 minute
  AND 1440 minutes))`; `CHECK (flash_launched_at IS NULL OR flash)`; index `quest_flash_idx (event_id) WHERE flash`.
- `boost` table as above, index `(category_id, starts_at)` and `(event_id, starts_at)`; RLS forced, PUBLIC revoked.
- `ledger_entry.boost_id` and its CHECK; index `WHERE boost_id IS NOT NULL`.
- Functions: each new one `REVOKE ALL … FROM PUBLIC`; restated doors keep their grants; DROP and CREATE
  `pay_completion`, `member_event_quests` (grants re-issued). `erase_rows` is not restated (no new row names a player;
  `boost.created_by` is a staff id, SET NULL when the staff account goes, as goals).

## Store compliance

A flash quest and a boost change data already in the app (when a quest is open, how many event points it pays),
decided by the server (Apple 2.5.2). Boosts are never bought (3.1.1: no paid boosts, STORE_COMPLIANCE:268). The
review notes gain one line; the demo event gets a scheduled flash quest and a boost.

## Tests (test first)

- **Database** (`test/db/flash-boosts.int.test.ts`): the door table; the payer table; the readers above (in and out
  of the window, switch off, rehearsal launch hidden between go-live and the wipe); the category rules with flash
  quests; periods; items; the builder checks (live poll, window length, scheduled without both times); launch, replay,
  `already_launched`, `community_locked`, End now; boosts: overlap, outside the event, edit and delete until a minute
  before, `boost_started`, stop, limit, `event_ended`, category delete `boost_in_use`, rehearsal boost; removal
  reverses exactly; ranking rebuild from the ledger equals the cache with boosted entries; today's ranking and a
  community points goal count the doubled amount; the payer completeness map; T-306c's reader completeness map extended
  with every function here.
- **Crossed locks** (two connections): stop vs scan, both orders; two overlapping saves.
- **Security**: outsider (every new function, `anon` and `PUBLIC`; `boost` closed); cross-tenant: a boost on another
  organizer's category, launching another organizer's quest (404, never a key leak); `/live` never names a hidden
  category's boost.
- **Route**: builder bodies and refusals, launch/end, boosts CRUD and stop, quests/Home/`/live`/activity shapes, the
  completion answers' `boost`, switches.
- **App**: badges, countdown, ×2 lines, completion line, live cards and refetch, older-app fallback, RTL and Arabic;
  `expo export`. **Web**: the flash switch, Launch/End, the Boosts page; e2e `flash-boosts.spec.ts` (desktop and
  phone).
- **Mutation (GitHub)**: `apps/api/src/boosts/**`, `apps/api/src/quests/flash.ts`, `apps/api/src/plays/live.ts`,
  `apps/api/src/completions/complete.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0055 + database, crossed-lock and security tests.
2. API: flash launch/end and builder field, boosts module, completion answers, quests/Home/`/live`/activity shapes,
   switches, refusal mappings + route tests.
3. App badges, lines and live cards; dashboard flash controls and Boosts page; strings; docs (API.md, DATA_MODEL.md,
   SRS FR-251/252 status and trace rows, FEATURES, CONFIGURABILITY switches, STORE_COMPLIANCE review note, rules.md
   lock order, TASKS notes for T-501 (flash launch and boost start pushes, FR-1102), T-502 (strip), T-603 (control
   room), STATE).

## T-307b — the live finale (split, ADR-230; design for its worker)

FR-254, FR-255, FR-1621 on the big screen, after T-504 (pairing, scenes, the screen's own reader rule and outsider
tests). Shape to build then:
- `finale (event_id PK, starts_at, goal_id → community_goal | null)`, set by the owner: the countdown runs to
  `starts_at`; the "last community push" is a short community goal the owner attaches (FR-1621; T-306b's goal and its
  cached `progress`, never a ledger aggregate per request; missed shows "Not reached", no reward); the reveal is the
  owner's existing `POST …/results/reveal` (T-214): the scene shows `results_places` (username and avatar only, by
  score, so spending never lowers a place, FR-255, ADR-043) only once results are revealed. Before confirmation the
  dashboard asks for it first (FR-520). The finale never decides winners.
- Confirming needs the event ended (ADR-163): a finale before the end needs the end time moved, or Q-127 answered.
- The app's full-screen finale celebration (FR-407) plays for a player on the reveal (Home's win card already exists).

## Proposed decisions and questions

- **ADR-230** T-307 is split: T-307 builds flash quests and boosts (FR-251, FR-252); T-307b builds the live finale
  (FR-254, FR-255, FR-1621) after T-504, since it is a big-screen scene and the screen, its pairing and its reader rule
  do not exist yet. A finale page of its own on the dashboard was rejected: it would duplicate T-504's scene player.
- **ADR-231** Flash quests: a flag on any quest but a live poll; launched now for 1 to 1,440 minutes (once) or
  scheduled with both times; shown to players only inside the window (never on the public page); End now; out of every
  category rule; a rehearsal launch goes back to draft at go-live; the event switch hides them. Q-195.
- **ADR-232** Boosts: ×2 on one category (a "zone" is a category) for 1 to 1,440 minutes, now or scheduled, no overlap
  on a category, at most 100 an event; edits and deletes until a minute before the start, then only Stop; written into
  the quest's ledger entry (`boost_id`, the doubled amount) so the score, ranking rebuild, removal and results need no
  change. Boosted: every quest payment from a player's own act. Never: the category bonus, items, community rewards,
  manual quest awards and point awards, welcome points, XP. Q-196.
- **ADR-233** Boost timing and switches: a boost is judged at the time the quest's points were fixed (the completion;
  a submission's send, a quiz's start, a game round's issue), looked up by that time; the event switch off stops every
  boost paying at once; the platform switch lets running ones finish; a community points goal counts the doubled
  points; a rehearsal boost pays only rehearsal accounts and is removed at go-live. Q-197.
- **Q-195** Flash quests: hidden from players before and after their window (and never on the public event page), at
  most 24 hours long, launched once; a missed flash quest never blocks a category's bonus or what unlocks after it,
  and doing one does not count toward the bonus. Agree?
- **Q-196** Boosts: always double (×2), on one category, never overlapping; the category bonus, community rewards and
  points handed out by staff are never doubled (staff top up with a point award if a scan failed during a boost).
  Agree, or should staff awards of a quest during a boost be doubled too?
- **Q-197** A submission sent, a quiz started or a game begun during a boost gets double points even if it is approved
  or finished after the boost ends; turning boosts off for the event stops doubling at once, including for
  submissions still waiting for review; a community points goal counts doubled points. Agree?
