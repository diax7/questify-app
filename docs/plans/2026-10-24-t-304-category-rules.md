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
| `unlock_after` | uuid, null, `(unlock_after, event_id)` → `category (id, event_id)` RESTRICT | FR-235; not itself; no cycle (a trigger walks the chain under the event's advisory lock; at most 30 categories) |
| `completion_bonus` | integer 0 to 100 000, default 0 | FR-231; 0 is no bonus |

Written through the existing `PATCH …/categories/{id}` (column grants on the four columns, as `name_*`); live edits
take `confirm` as today. Deleting a category another unlocks after is refused (`409 category_in_use {categories}`),
the same shape as `join_field_in_use`.

## "Done" (one SQL function, `category_done(enrollment, category)`)

A category is done for a player when every **visible** quest in it has at least one `quest_completion` for that
enrollment, or a `quiz_attempt` finished with no right answers (T-302 note). An empty category is never done. Hidden
quests do not count; a quest added later does not undo a bonus already paid. `quest_done(enrollment, quest)` is the
per-quest half, also used by in-order.

## Gates (ADR-201)

`category_gate_check(quest_row, enrolled)` raises `QN403` with a DETAIL the app can show:

- `category_not_started` while the category's `opens_at` is in the future;
- `category_locked` while `unlock_after`'s category is not done (the read names it);
- `order_locked` in an in-order category while an earlier visible quest (by `position, id`) is not done.

It runs from `record_completion` for every method **except `manual`** (an owner or editor fixing a problem passes the
gates, as they already pass the method check), and from `play_enter` (vote, quiz, survey, share start and play) and
the submission send. A quiz already started finishes and pays even if the organizer later locks its category
(the gate is checked when the attempt starts). Operator station scans (My QR) are gated: the station answers the
same `quest_not_open` with the reason.

## Completion bonus (ADR-202)

- **Paid by the database in the transaction that makes the category done**, never by the API: an `AFTER INSERT`
  trigger on `quest_completion` and an `AFTER UPDATE OF status` trigger on `quiz_attempt` (finished, no completion)
  call `pay_category_bonus(enrollment, category)`. Both run under the enrollment's `FOR NO KEY UPDATE` lock that
  every paying path already holds (record_completion, pay_completion, finish_quiz), so two parallel last completions
  pay one bonus; `category_bonus` PK `(enrollment_id, category_id)` is the backstop.
- **Ledger:** a new kind `bonus` (`score_delta = balance_delta = completion_bonus`, actor `system`, new nullable
  `ledger_entry.category_id` with `(category_id, event_id)` → category RESTRICT; a CHECK ties `kind = 'bonus'` to
  `category_id IS NOT NULL` and to `completion_id` naming the completion that finished it, or null for a zero-right
  quiz). The score trigger, today's ranking, the ranking cache and rehearsal flags treat it as any credit. **No XP**
  (`ledger_xp` stays on `quest` and `removal`; a removal of a bonus reverses no XP).
- **Same eligibility as the paying completion.** The zero-right quiz path pays the bonus only when `finish_quiz`'s
  paying conditions hold (active member and player, live or ended, results not frozen, staff allowed to play);
  otherwise no bonus.
- **Removal:** `remove_award` on a quest completion in a category whose bonus was paid also writes a `removal` for the
  bonus (same reason, same request key suffixed `:bonus`), and deletes the `category_bonus` row so finishing it again
  pays again. A bonus cannot be removed on its own (it follows its quests).
- **Rehearsal and erasure:** `wipe_rehearsal` deletes rehearsal `category_bonus` rows before the ledger rows it already
  handles; `erase_rows` deletes the player's `category_bonus` rows (the ledger stays, anonymized, as today).
- **Response:** the paying call's answer gains `bonus: {categoryId, points} | null`, read after the payment
  (`own_bonus(completion)`), so the app shows "+{points} bonus: {category} complete".

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

- **Database** (`category-rules.int.test.ts`): in-order refuses quest 3 before 2 and allows it after; any order allows
  any; opens-at refuses before and allows after; unlock-after refuses until the other category is done (including by a
  zero-right quiz); manual award passes every gate; the station scan is gated; the bonus is paid once on the last
  quest with the quest's points (both entries), not paid with no bonus set, paid when the last quest is a zero-right
  quiz, not paid when that quiz finishes ineligible; two parallel last completions → one bonus; a replayed key pays no
  second bonus; removal of a completion reverses the bonus and finishing again pays again; a hidden quest does not
  count and an empty category is never done; a cycle and self-unlock refused; deleting an unlocking category refused;
  rehearsal wipe and erasure; no XP from the bonus.
- **Security:** outsider and cross-tenant suites list `category_bonus`, the new definers and the recreated
  `member_event_quests`; the column grants.
- **Route/unit:** the quests read and `questState` (`locked` order), each refusal's answer and reason, the pay
  answers' `bonus`, the builder's fields and refusals; the app's header, lock and bonus lines (unit); one browser test
  for the category form (desktop and phone); `expo export`; the Hermes built-ins test.
- **Mutation (GitHub):** `apps/api/src/quests/categories.ts`, `apps/api/src/home/home.ts`, `apps/api/src/plays/**`,
  `apps/api/src/completions/**` (the files this task changes).

## Phases (CTO code review once, at the end)

1. Migration 0044 + database tests + security suites.
2. API: the read, `questState`, pay answers, builder fields and refusals.
3. App: header, locks, bonus; dashboard: category form; browser test; docs (API, DATA_MODEL, SRS status rows, TASKS
   split, notes on T-304b/c/d and T-501).

## Proposed decisions and questions

- **ADR-200** Split: T-304 (category rules and the points bonus), T-304b (passport), T-304c (refresh and hidden
  categories), T-304d (item rewards, FR-522, FR-1617); FR-238 moves to T-501. Q-164.
- **ADR-201** The gates (opens at, unlocks after, in order) bind the player's and the operator's paths, not an owner's
  or editor's manual award; "done" counts a zero-right quiz; a started quiz finishes under a later lock. Q-165.
- **ADR-202** The bonus is points (score and balance), paid once by the database with the completion that finishes the
  category, at the bonus set then, no XP; removing any of its quests' completions reverses it. Q-166.
