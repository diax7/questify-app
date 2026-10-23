# T-304 — Category rules and the completion bonus

Delivers FR-231 (completion bonus), FR-232 (in order), FR-233 (any order, whole), FR-234 (a category opens at a set
time) and FR-235 (a category unlocks after another), with the collapsed header showing the lock and the bonus (FR-230,
built in T-114, grows here). Inherits T-302's note: a quiz finished with no right answers counts as done for the bonus
and for unlocking. **Core bar** (the bonus pays points through the ledger; the gates guard every paying path): one Opus
plan review, one Opus code review, mutation on GitHub. Migration **0044** (0043 is T-303's `vote_quest` fix). Depends
on T-103, T-105, T-302, T-303 (all done).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-200 to ADR-202 and Q-164 to Q-166.

## The split (ADR-200)

T-304 as listed is a new quest type, five category rules, a reset clock, hidden categories and item rewards. Split by
what each part needs:

- **T-304 (this plan):** in order or any order, opens at, unlocks after, completion bonus in points (FR-231 to 235).
  One shared idea: when a category is "done" for a player, and one gate on the completion path.
- **T-304b:** passport quests (FR-224): a new type with steps, each step its own signed QR (T-104's signer gains a step
  id), progress "4 of 5", paid once on the last needed step.
- **T-304c:** daily and weekly refresh (FR-236, FR-1619) and hidden categories (FR-237). Refresh changes what "done"
  and the repeat cap mean (counted inside the current period from `event_day_start`, ADR-083), so it lands after this
  plan's "done" rule; played-once types (vote, quiz, survey, share, submission) cannot sit in a refreshing category.
  A hidden category is revealed by its own signed QR. **FR-238** (reveal by hint push) moves to T-501, which builds push.
- **T-304d:** item rewards for a quest or a category (FR-522, FR-1617): a price-0 desk item as rank prizes are
  (T-214's `redemption` with a third source), stock taken at completion, "ran out" told to the player and the owner.

## Category settings (owner and editor; the builder's category form)

| Column | Type | Rule |
|---|---|---|
| `order_mode` | text `any` \| `in_order`, default `any` | FR-232/233 |
| `opens_at` | timestamptz, null | FR-234; the category's quests refuse before it (their own `opens_at` still applies) |
| `unlock_after` | uuid, null, `(unlock_after, event_id)` → `category (id, event_id)` RESTRICT | FR-235; not itself; no cycle (a trigger walks the chain under the event's advisory lock; the walk stops after 30 steps, the event's category cap, and refuses as a cycle beyond it) |
| `completion_bonus` | integer 0 to 100 000, default 0 | FR-231; 0 is no bonus |

Written through the existing `PATCH …/categories/{id}` (column grants on the four columns, as `name_*`); live edits
take `confirm` as today. Deleting a category another unlocks after is refused (`409 category_in_use {categories}`),
the same shape as `join_field_in_use`.

## "Done" (strict, for the bonus) and "passable" (for the gates)

- `quest_done(enrollment, quest)`: at least one `quest_completion`, or a `quiz_attempt` finished with no right answers
  (T-302 note).
- `category_done(enrollment, category)` (**strict**, decides the bonus): every visible quest in the category is done.
  An empty category is never done. A quest added later does not take back a bonus already paid.
- The gates are looser so that a player is never stuck (no dead ends):
  - **unlock after:** satisfied when the other category is done, **or** when the player is outside its audience
    (`in_audience` false; they could never finish it);
  - **in order:** a quest waits only for earlier visible quests (by `position, id`) that are **not closed**
    (`closes_at` passed) and not done; a closed earlier quest is skipped. A **pending submission** on an earlier quest
    still blocks (it is not done until approved).

## Gates (ADR-201)

`quest_open_check(quest_row, enrolled, skip_category boolean)` (0040's function gains the parameter; every caller is
replaced) adds, after its own checks and unless `skip_category`, `QN403` with a DETAIL the app can show:

- `category_not_started` while the category's `opens_at` is in the future;
- `category_locked` while the `unlock_after` rule above is not met (the read names the category);
- `order_locked` in an in-order category while an earlier quest blocks (rules above).

`skip_category` is true **only** for `proof_method = 'manual'` (an owner or editor fixing a problem); every other
caller (record_completion's other methods, `play_enter`, the submission send, the operator's station scan) passes
false. A quiz already started finishes and pays under a lock set later (the gate runs when the attempt starts).

## Completion bonus (ADR-202)

- **Paid by the database, called explicitly**, never by a trigger and never by the API:
  `pay_category_bonus(enrolled, category, completion)` is called at the end of `record_completion` and of
  `pay_completion` (after their ledger entry), and in `finish_quiz`'s zero-right branch (with a null completion). All
  three already hold the enrollment's `FOR NO KEY UPDATE` lock, so two parallel last completions pay one bonus. It
  inserts into `category_bonus` with **`ON CONFLICT DO NOTHING`** and writes the ledger entry only when a row was
  inserted: a repeat completion (cap above 1), a replayed key and a second call all pay nothing, without relying on
  an error.
- **Ledger:** new kind `bonus`, actor `system`, new nullable `ledger_entry.category_id` with `(category_id, event_id)`
  to category RESTRICT. Shape CHECK: `kind <> 'bonus' OR (category_id IS NOT NULL AND score_delta > 0 AND
  balance_delta IN (0, score_delta))`. `balance_delta` follows the **same `shop_state(...) = 'closed'` CASE as
  `pay_completion`** (0041:172-175): after the shop closes the bonus moves the score only. `completion_id` names the
  completion that finished the category, or null for a zero-right quiz.
- **Same eligibility as the payment.** The zero-right quiz branch pays the bonus only when `finish_quiz`'s paying
  conditions hold (active member and player, live or ended, results not frozen, staff allowed to play), and then calls
  `mark_ranking_repair(event)`, as a paid finish moves the score. A later hide or delete of a quest that leaves a
  category "done" pays nothing (only a completion or a zero-right finish calls the payer).
- **Removal (ADR-152 holds):** the bonus is its own removable credit. `remove_award` (latest in 0040) adds `bonus` to
  its allowed kinds (`quest`, `award`, `welcome`, `bonus`), and `member_ledger`'s removable flag (0030:934) does too.
  Removing a quest's credit leaves the bonus alone, and removing the bonus leaves the quests alone; the owner removes
  each separately. `category_bonus` rows are never deleted by a removal, so a removed bonus is not paid again (the
  same rule as a removed quest staying used).
- **No XP:** `ledger_xp` stays on `quest` and `removal`; `xp_reverse` finds no XP for a removed bonus and writes none.
- **Rehearsal and erasure:** `wipe_rehearsal` deletes rehearsal `category_bonus` rows before the ledger rows it
  already deletes; `erase_rows` deletes the player's `category_bonus` rows (the ledger stays, anonymized, as today).
- **Response:** pay answers gain `bonus: {categoryId, points} | null`, read after the payment by completion
  (`own_bonus(completion)`); a quiz step reads it by enrollment and category (`own_category_bonus(quest)`), since a
  zero-right finish has no completion. The app shows "+{points} bonus: {category} complete".

## Every `kind IN (...)` site and whether `bonus` joins

| Site (latest version) | Decision |
|---|---|
| `ledger_entry_kind_check` (0030:25) | **joins** |
| `ledger_entry_staff_kinds` (0030:31) | no (the system pays it; a staff removal is kind `removal`) |
| `ledger_entry_operator_quests_only` (0030:34) | no |
| system actor CHECK (0028:179, `actor <> 'system' OR kind IN ('redeem_return', 'welcome')`) | **joins** |
| redemption kinds (0029:105) | no |
| `ledger_operator_play_guard` (0032:94) | **joins** (an operator not allowed to play gets no bonus either) |
| `remove_award` allowed kinds (0040, `credit.kind NOT IN ('quest', 'award', 'welcome')`) | **joins** |
| `member_ledger` removable flag (0030:934) | **joins**; the entry's title reads the category name |
| rehearsal summary `points` (0032:220; latest 0042:506) and wipe sum (0032:334) | **join** (points the rehearsal earned) |
| `completions` counts and `l.kind = 'quest'` lookups (replay, 10-second guard, stations, flags, XP backfill) | no (a bonus is not a completion) |
| `ledger_xp` trigger (0039:214) | no |

The rehearsal summary and wipe are replaced in 0044 from their latest versions.

## Tables (deny by default: no API grant; written only by the definers; RLS on, tenant FKs, RESTRICT)

| Table | Columns | Notes |
|---|---|---|
| `category_bonus` | `organizer_id`, `event_id`, `enrollment_id`, `category_id`, `entry_id`, `created_at` | PK (enrollment_id, category_id) |

## Player read

`member_event_quests` is DROPped and CREATEd (new columns; REVOKE and GRANT repeated; the outsider suite lists it):
per category `order_mode`, `category_opens_at`, `unlock_after` (id and name), `completion_bonus`, `bonus_paid`; per
quest `lock` (`null` \| `category_not_started` \| `category_locked` \| `order_locked`), computed by the same functions
as the gate. The API's `questState` gains `locked` (before `not_yet`, after `done` and `not_live`) with the reason;
Home's Up next skips locked quests through `isOpen` unchanged. The public quests-by-code read adds nothing.

## API (API.md)

- `GET /v1/events/{id}/quests`: categories gain `orderMode`, `opensAt`, `unlockAfter: {id, name} | null`,
  `bonus: {points, earned}`; quests gain `state: "locked"` and `lock`. Every pay answer gains `bonus`.
- Builder: the category object and `PATCH` gain `orderMode`, `opensAt`, `unlockAfter`, `completionBonus`; refusals
  `422 invalid_category {field}` (`unlockAfter` self, a cycle, another event; bonus out of range), `409
  category_in_use`.
- `quest_not_open` details carry the new reasons; `category_locked` also carries `{category: {ar, en}}`.

## App and dashboard

- **App (player):** the collapsed header keeps "earned / total pts · done / total quests" and adds a lock and "Opens
  {day, time}" / "Finish {category} first", and "Bonus +{points}" or "Bonus earned". Locked quest cards show a lock
  and the reason; in-order cards show their step number. The success sheet shows the bonus. Strings in `messages.ts`
  (Arabic via `ux-araby`), RTL checked, Western digits.
- **Dashboard:** the category form's order, opens-at (event time zone), unlock-after select (other categories) and
  bonus fields with help text; the builder list shows a chain icon for in-order and a lock for gated categories.

## Tests (test first)

- **Database** (`category-rules.int.test.ts`):
  - gates: in-order refuses quest 3 before 2 and allows it after; a closed earlier quest is skipped; a pending
    submission blocks; any order allows any; opens-at refuses before and allows after; unlock-after refuses until the
    other category is done (including by a zero-right quiz), and is satisfied when the player is outside the other
    category's audience; a manual award passes every gate; the station scan is gated;
  - bonus: paid once on the last quest beside the quest's points; none with no bonus set; after the shop closes it
    moves the score only; paid when the last quest is a zero-right quiz (and the ranking is marked for repair), not
    when that quiz finishes ineligible; a repeat completion (cap 2) pays no second bonus; a replayed key pays no
    second bonus; two parallel last completions give one bonus; a later hide or delete pays nothing; a closed quest
    still counts against the strict "done";
  - removal: removing a quest leaves the bonus; the bonus is removable on its own and is not paid again; no XP either
    way;
  - shape: a cycle and self-unlock refused; the 30-step walk; deleting an unlocking category refused; an empty
    category is never done; the rehearsal summary includes the bonus; rehearsal wipe and erasure.
- **Security:** outsider and cross-tenant suites list `category_bonus`, the new definers and the recreated
  `member_event_quests`; the column grants.
- **Route/unit:** the quests read and `questState` (`locked` order), each refusal's answer and reason, the pay
  answers' and quiz steps' `bonus`, the builder's fields and refusals, `bonus` removable in the ledger list; the app's
  header, lock and bonus lines (unit); one browser test for the category form (desktop and phone); `expo export`; the
  Hermes built-ins test.
- **Mutation (GitHub):** `apps/api/src/quests/categories.ts`, `apps/api/src/home/home.ts`, `apps/api/src/plays/**`,
  `apps/api/src/completions/**`, `apps/api/src/awards/**` (the files this task changes).

## Phases (CTO code review once, at the end)

1. Migration 0044 + database tests + security suites.
2. API: the read, `questState`, pay answers, builder fields and refusals.
3. App: header, locks, bonus; dashboard: category form; browser test; docs (API, DATA_MODEL, SRS status rows, TASKS
   split, notes on T-304b/c/d and T-501).

## Proposed decisions and questions

- **ADR-200** Split: T-304 (category rules and the points bonus), T-304b (passport), T-304c (refresh and hidden
  categories), T-304d (item rewards, FR-522, FR-1617); FR-238 moves to T-501. Q-164.
- **ADR-201** The gates (opens at, unlocks after, in order) bind the player's and the operator's paths, not an owner's
  or editor's manual award; "done" counts a zero-right quiz; no dead ends (an unreachable unlock category and closed
  earlier quests do not block; a pending submission does); a started quiz finishes under a later lock. Q-165.
- **ADR-202** The bonus is points (balance only while the shop is open), paid once by the database with the completion
  that finishes the category, at the bonus set then, no XP; it is its own removable credit (ADR-152), and removing a
  quest leaves it. Q-166.
