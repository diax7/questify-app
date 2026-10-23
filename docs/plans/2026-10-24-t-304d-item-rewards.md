# T-304d — Items as quest or category rewards, out of stock pays points only

Delivers FR-522 and FR-1617 (F-150). Moved here by ADR-161 and ADR-200; T-214's rank prizes are the model (ADR-162:
a price-0 desk item, its own table, collected through the same handover).
**Core bar**: it touches the points payers (`record_completion`, `pay_completion`, `pay_category_bonus`), the
removal of an award and the prize handover: one Opus plan review, one Opus code review, mutation on GitHub.
Migration **0047** (0042 to 0046 are undeployed but belong to finished tasks; this task adds its own file). Depends on
T-304 (the bonus), T-304c (the bonus once per period), T-214 (price-0 desk items), T-206 (the desk).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-205 and Q-169.

**CTO plan review 2026-10-24: 84/100, findings folded in** (both items locked in id order before giving, no
`ON CONFLICT DO NOTHING` and stock moved only after a real insert, the link guarded against a concurrent removal, the
shop's "popular" read, removal through `end_reservation` and its replay, the wipe's order and the source FKs, a later
scan after a removal gives no item, the added tests, the key's id made before the insert).

## The item (FR-522)

- `quest_item` (its own table, never a `reward`, so no shop read can list or sell it; ADR-162's reasoning):
  `id, organizer_id, event_id, name_ar, name_en, description_ar, description_en` (the reward's length checks),
  `stock_total integer NOT NULL CHECK (stock_total BETWEEN 0 AND 100000)`, `units_out integer NOT NULL DEFAULT 0`
  (`CHECK (units_out BETWEEN 0 AND stock_total)`, as `reward_stock_covers_out`), `status active | removed`,
  `created_at`, `updated_at`, `UNIQUE (id, event_id)`, tenant FKs, the `set_organizer_from_event` and touch triggers.
  Kind is always a physical item collected at the desk (FR-522 says item; no experience or digital code in v1).
- Deny by default in the same file: RLS enabled and forced, `REVOKE ALL … FROM PUBLIC`, the member policy and column
  grants of `rank_prize` (0034:70-82): `INSERT (event_id, names, descriptions, stock_total)`, `UPDATE (names,
  descriptions, stock_total, status)`. `units_out` has no grant: only the definers below move it.
- **One item, many sources**: `quest.item_id` and `category.item_id` (`uuid`, FK `(item_id, event_id)` →
  `quest_item (id, event_id)` ON DELETE RESTRICT), added to the builder's column grants. Several quests may share one
  item and its stock (a T-shirt for three quests). A trigger refuses linking a removed item, and refuses removing an
  item that an active quest or category still names (`QI409 item_in_use`). The composite FK only takes FOR KEY
  SHARE, which does not block a status update, so both triggers first take the per-event advisory lock
  (`pg_advisory_xact_lock(hashtextextended('quest_item:' || event_id, 0))`, the 0046:72 pattern): a link and a removal
  of the same event serialize, and each then sees the other's committed row. A DB test runs the two in parallel.
- **The desk is required**: `event_desk_guard` (latest 0034:146) also counts an active `quest_item`; a new
  `quest_item_desk_guard` (BEFORE INSERT, and UPDATE OF status) refuses an item while the event has no desk location
  (`DL409`), as `reward_desk_guard` (0029:41).
- **Instead of or with points**: a quest already allows `points` 0 (0010:32), so "item only" is points 0 plus an item.
  A category's item works with `completion_bonus` 0 (no points) or above.

## A redemption's third source

- `redemption` gains `quest_item_id uuid` (FK `(quest_item_id, event_id)` RESTRICT) and its source:
  `source_completion_id bigint REFERENCES quest_completion (id) ON DELETE RESTRICT` (a quest's item),
  `source_category_id uuid` and `source_period timestamptz` (a category bonus's item, the period of T-304c).
  `source_category_id` has the FK `(source_category_id, event_id)` → `category (id, event_id)` ON DELETE RESTRICT on
  both `redemption` and `quest_item_miss` (as `category_bonus`, 0044); `source_completion_id` is RESTRICT on both.
- Constraints: `redemption_one_source` becomes `num_nonnulls(reward_id, rank_prize_id, quest_item_id) = 1`;
  `redemption_price_check` becomes `price >= 1` for a reward, `price = 0` otherwise; `redemption_rank_prize_desk`
  becomes "no `delivered` unless a reward"; a shape CHECK: `quest_item_id IS NULL` ⇔ all three source columns NULL,
  and with an item exactly one of (`source_completion_id`) or (`source_category_id` and `source_period`).
- **Once per source** (the database's own guard, as the ledger's `ledger_entry_bonus_key` of T-304c):
  `UNIQUE (source_completion_id) WHERE quest_item_id IS NOT NULL` and
  `UNIQUE (enrollment_id, source_category_id, source_period) WHERE quest_item_id IS NOT NULL`. So a category item is
  given at most once per player and period, exactly like the bonus, and a daily category gives one item per day.
- The idempotency key is `'quest item ' || made` where `made` is the redemption's id from `gen_random_uuid()` before
  the insert, written as the row's `id` too (0034:871); it contains a space, so no player request can collide.
- `reserved_until` = `default_claim_until(ev)` (0034:708: the desk's last window, else the shop's closing, 1 to 60
  days away). The player cannot cancel it (`RZ409`, generalised to every price-0 item); an operator's cancel or the
  timeout ends it with no ledger entry and the unit returns to the item's stock.

## Giving the item, or missing it (FR-1617)

- `give_item(enrolled enrollment, item uuid, completion bigint, cat uuid, period timestamptz) RETURNS text`
  (not a definer; called only inside the payers; `REVOKE ALL … FROM PUBLIC`). Lock order everywhere: enrollment,
  reward or item, redemption; the enrollment is already held by every caller, and the items are already locked by
  the payer (below). Then
  - item removed or `units_out >= stock_total` → a `quest_item_miss` row, outcome `out_of_stock`;
  - `default_claim_until(ev)` NULL (the desk's hours are over) → a miss row, outcome `claim_closed`;
  - else a `redemption` (`reserved`, price 0) is inserted, and only after that insert `units_out + 1`; outcome
    `pending`.
  Plain inserts, **no `ON CONFLICT DO NOTHING`**: `give_item` runs once per source by construction (the completion
  row is new, and `pay_category_bonus` reaches it only after its own `category_bonus` insert succeeded,
  0046:137-142), so a unique violation on the source keys is a bug and raises; stock never moves for a skipped row and
  no miss is written for a source that already has a redemption.
- **No deadlock between two items**: a completion can give a quest item and then a category item. Two players whose
  quests name item A with category item B and item B with category item A would lock them in opposite orders
  (`40P01`). So `record_completion` and `pay_completion` lock both the quest's and the category's item
  (`SELECT … FROM quest_item WHERE id IN (quest.item_id, category.item_id) ORDER BY id FOR UPDATE`) before the
  completion insert, and `give_item` only re-reads them. `finish_quiz`'s zero-right path names one item (the
  category's) and needs no ordering. A DB test runs the crossed pair in parallel and expects no deadlock.
- `quest_item_miss (id, organizer_id, event_id, enrollment_id, quest_item_id, source_completion_id,
  source_category_id, source_period, reason out_of_stock | claim_closed, created_at)`, the same shape CHECK and
  once-per-source unique indexes as the redemption; RLS forced, `REVOKE ALL … FROM PUBLIC`, **no grant** (definers
  only, as `category_bonus`). It feeds the player's message and the organizer's warning and lists who missed, so an
  organizer can make it up to them by hand. Nothing is given later when stock is raised (FR-1617: points only).
- **A quest's item: on the first completion only** (lifetime `occurrence = 1`, as XP, ADR-083), so a repeatable or
  refreshing quest does not hand out a unit per scan (ADR-205, Q-169). Called after the `quest` ledger entry in
  `record_completion` (latest 0046:321) and `pay_completion` (latest 0044:242), before the category bonus. Every path
  that writes a completion goes through these two (scan, code, operator scan, manual and bulk award, vote, survey,
  share, submission approval, passport, quiz with a right answer). A quiz finished with no right answers writes no
  completion and gives no quest item.
- **A category's item: with the bonus, once per period** (T-304c). `pay_category_bonus` (latest 0046:119) changes:
  it returns early only when `completion_bonus = 0 AND item_id IS NULL`; it writes the `category_bonus` row as today;
  the `bonus` ledger entry is written only when `completion_bonus > 0` (an item-only bonus has no entry and
  `entry_id` stays NULL); then `give_item(…, NULL, category, period)`. The guard "no row of this or a later period"
  already stops a second item in the period, a switch from daily to none, and a removed bonus; the redemption's
  `(enrollment, category, period)` key is the second guard.
- **Rehearsal**: rehearsal players get items like anyone (the desk can rehearse a handover); `wipe_rehearsal`
  (latest 0046:608) deletes their misses before `quest_completion` (0046:662; the source FK is RESTRICT), their
  redemptions as today, and recounts `quest_item.units_out` from the redemptions
  left, as it already does for `reward` (0046:667); its JSON counts `item_misses`.
- **Erasure**: `erase_rows` (latest 0046:687) deletes the player's `quest_item_miss` rows; redemptions follow the
  existing pending-handover rule (`deletion_pending`, 0038:643, learns the item's name).

## Removing an award (ADR-152, latest `remove_award` 0044:553)

- Removing a `quest` credit cancels the item of that completion if it is still `reserved`; removing a `bonus` credit
  cancels the item of `(credit.category_id, credit.bonus_period)`. It calls `end_reservation(id, 'cancelled',
  'removal', 'staff', NULL)` (no UPDATE of its own), so the item row is locked before the redemption (0034:212-213,
  extended to `quest_item`) and the unit returns there, with no ledger entry; `ended_by = 'removal'` is added to
  `redemption_ended_by_check`. An item already handed over stays handed over. The removal answer gains
  `item: cancelled | handed_over | null`; the **replay branch** (0044:575-580) computes it again from the
  redemption's current state (cancelled by a removal → `cancelled`, handed over → `handed_over`, none → null).
- After a removal the completion stays in the count (ADR-152), so a later scan of the quest is occurrence 2 and gives
  no item (written into ADR-205 and Q-169).
- The `AO409` check ("cancel the player's reserved prize first") counts only priced reservations (`price > 0`): ending
  a price-0 item moves no balance.
- An item-only bonus has no ledger entry, so nothing to remove; the owner or an operator cancels the item at the desk.

## Readers of a redemption learn the third source

Each `LEFT JOIN rank_prize k` gains `LEFT JOIN quest_item i` (name from `coalesce(r, k, i)`, kind `item`) and the
readers that return rows gain `source text` (`shop | rank | quest`); return types change, so they are dropped and made
again (as 0034 did): `end_reservation` (an item returns `units_out - 1` on `quest_item`, no ledger entry),
`cancel_redemption` (`RZ409` for any price-0 item), `desk_items`, `desk_lookup`, `desk_find`, `my_desk_items`,
`my_redemptions`, `flag_detail`, `member_activity` (latest 0044:497), `deletion_pending`. The handover functions
(`finish_handover`, `desk_hand_over`, `start_collect`, latest 0032) are checked and changed only where they read
`reward_id`; the 0/0 `handover` entry already fits a price-0 item (T-214 note). `end_reservation` locks
`quest_item` FOR UPDATE beside `reward` (0034:212), before the redemption. `shop_rewards`' "popular" count
(0037:267-270, grouped by `d.reward_id`) adds `AND d.reward_id IS NOT NULL`, so price-0 rows never form a NULL group.

## Readers for the player and the organizer

- `own_quest_item(completion bigint)` (definer, the caller's own completion only): `{name_ar, name_en, outcome}`
  from the redemption or the miss of that completion.
- `own_bonus`, `own_category_bonus` and the quiz's bonus reader gain `item_ar, item_en, item_outcome` (LEFT JOINs on
  the bonus row's category and period) and `points` may be 0 (LEFT JOIN on the ledger, for an item-only bonus).
- `quest_items(target_event uuid)` (owners and editors, `AN404` otherwise): each item with `stock_total`,
  `units_out`, `stock_left`, `missed` (count of misses), the quests and categories that name it.
- `quest_item_misses(target_event uuid, target_item uuid)` (owners and editors): username, when, source, reason,
  newest first, capped at 200.

## API (API.md)

- Pay answers (every route that already returns `bonus`): `item: {name: {ar, en}, outcome: pending | out_of_stock |
  claim_closed} | null` for the quest, and `bonus.item` the same for the category; `bonus.points` may be 0.
- Builder: `GET/POST /v1/events/{id}/quest-items`, `PATCH|DELETE /v1/events/{id}/quest-items/{itemId}` (owner and
  editor; `409 item_in_use`, `409 desk_required`, `422` shapes; stock below `units_out` answers `422 stock_below_out`),
  `GET …/quest-items/{itemId}/misses`. Quest and category builders take `itemId` (null clears); a removed or other
  event's item answers `422 invalid_item`.
- Desk and the player's items: each row gains `source`; the desk's label reads "Quest reward" for `quest`.
- Removal answer: `item`.

## App and dashboard

- **App:** the completion sheet shows "+ T-shirt: collect it at the prize desk" or "The T-shirt ran out; you got the
  points" (`claim_closed`: "The prize desk has closed"); the bonus line does the same; quest and category rows show the
  item next to the points. The desk list labels quest items. Strings in `messages.ts` (Arabic via `ux-araby`), RTL
  checked, Western digits.
- **Dashboard:** a "Quest items" section on the prizes page (create, stock, remove, stock left, missed); an item
  picker on the quest and category forms; a warning on the event overview and on the item while any linked item has
  0 left ("T-shirt ran out: 12 players got points only", FR-1617), linking to the misses list.

## Tests (test first)

- **Database** (`quest-items.int.test.ts`): a quest of item + 50 points pays 50 and makes one pending price-0
  redemption (FR-522's first case); an item-only category bonus makes the item with no ledger entry and no points
  (its second case); 0 stock pays the points, writes a miss, no redemption (FR-1617); the last unit raced by two
  players gives one item and one miss; the quest item on the first completion only (a repeat pays points, no item);
  a daily category gives one item per period, a second in the next period, none on a switch from daily to none,
  none after its bonus was removed in the period; the source unique keys refuse a second item for one source;
  `claim_closed` when the desk's hours are over; the item linked to a removed item refused, removing a linked item
  refused (`QI409`), desk location cleared while an item exists refused (`DL409`); `units_out` never above stock;
  expiry and operator cancel return the unit with no ledger entry; the player's cancel refused (`RZ409`); handover
  through the desk (0/0 entry); removal of the quest credit and of the bonus credit cancels a pending item and returns
  the unit, leaves a handed-over one; `AO409` ignores price-0 items; rehearsal wipe (units recounted, misses
  deleted, JSON count) and erasure; each path that writes a completion (scan, operator scan, manual award, survey,
  passport, quiz with a right answer) gives the item once; a zero-right quiz gives the bonus item, not the quest item.
  Added after the CTO review: a replayed completion (same key) answers the same item and moves no second unit; two
  players with crossed quest and category items complete in parallel with no deadlock; a link and a removal of the
  same item in parallel never leave an active quest naming a removed item; a removal replay answers the item's current
  state; a later scan after a removal (occurrence 2) gives no item; `shop_rewards`' popular list is unchanged by
  quest items and rank prizes; an `AO409` regression: a reserved rank prize or quest item no longer blocks a removal
  that leaves the balance short.
- **Security:** outsider and cross-tenant suites list `quest_item`, `quest_item_miss`, `give_item`,
  `own_quest_item`, `quest_items`, `quest_item_misses` and the recreated readers; a player cannot read another's
  item outcome; an editor of event A cannot link an item of event B (the composite FK) nor read its misses.
- **Route and unit:** the builder routes (shapes, `item_in_use`, `desk_required`, `stock_below_out`,
  `invalid_item`), pay answers' `item` and `bonus.item`, desk rows' `source`, the removal's `item`; the app's
  completion lines; the dashboard's warning. Browser: the quest items section and the item picker (desktop and phone).
  `expo export`.
- **Mutation (GitHub):** `apps/api/src/rewards/quest-items.ts` (new), `apps/api/src/completions/complete.ts`,
  `apps/api/src/desk/desk.ts`, `apps/api/src/quests/builder.ts`, `apps/api/src/quests/categories.ts`,
  `apps/api/src/awards/**` (the removal answer).

## Phases (CTO code review once, at the end)

1. Migration 0047 (table and grants, the redemption source, `give_item` and the payers, removal, readers, wipe and
   erasure) + database tests + security suites.
2. API: item builder routes, pay answers, desk rows, removal answer.
3. App, dashboard, docs (API, DATA_MODEL, SRS status of FR-522 and FR-1617, TASKS).

## Proposed decisions and questions

- **ADR-205** A quest's or category's item is a `quest_item` (its own table with its own stock, shared by any quests
  and categories that name it, never sold in the shop), given as a price-0 desk redemption (a third source after shop
  rewards and rank prizes) with the claim deadline of `default_claim_until`. A quest gives it on the player's first
  completion only; a category gives it with its bonus, once per period (T-304c), with or without bonus points. Out of
  stock, or the desk's hours over, pays the points only and records a miss that the player is told about and the
  organizer sees; nothing is given later. The player cannot cancel it; removing the award cancels a pending item, and
  a later scan of that quest (occurrence 2, ADR-152 keeps the completion) gives no item. Q-169.
