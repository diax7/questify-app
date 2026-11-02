# T-709d - Console item catalog and XP table with the level reward map (plan, tier A)

Delivers FR-1403 in full with T-709c. Re-plan of D4 and D5 of `docs/plans/2026-11-02-t-709c-xp-thresholds-items.md`,
which the plan review of 2026-11-02 sent back: its curve save took `player_xp` in EXCLUSIVE mode, and the API pool runs
with `lock_timeout` 2 s and `statement_timeout` 5 s (`apps/api/src/db/pool-options.ts:20-23`), so every scan, sync and
sign-up queued behind the save would fail; its 300,000-row recompute would break the 5 s statement timeout on its own.
This plan writes the curve and the reward map only, with row locks on those two small tables, and moves each player's
level to that player's own `player_xp` row lock. Decisions ADR-440 and ADR-441 (Proposed, restated in place), questions
Q-399, Q-401, Q-402. Migration **0124** (0122 is the highest on main; 0123 is left for the task that may take it first;
renumber at build if both are free).

## What exists (main at 66a11e2) and is reused

- `xp_level` (0039: level 1 to 100 PK, `xp_from` UNIQUE, not deferrable, level 1 at 0); `level_item` (0063: PK level FK to
  `xp_level`, `item_id` UNIQUE, `UNIQUE (level, item_id)`); `player_item` (FK `(source_level, item_id)` to `level_item`,
  FK `(player_id, source_level)` to `level_reached`); `level_reached` (append-only, PK `(player_id, level)`, **no index on
  `level`**); `grant_level_item()` (AFTER INSERT on `level_reached`; raises 23514 when a level has no mapping);
  `xp_board` `all` (equals `player_xp.xp`, index `(board, xp DESC, xp_version) WHERE xp > 0`, 0072).
- `xp_apply` (latest body 0072:59-90): `UPDATE player_xp … level = xp_level_of(x.xp + delta)` under the player's row
  lock, then for a credit `INSERT INTO level_reached SELECT … FROM xp_level` (unlocked read), then the boards. Called by
  `xp_credit`, `xp_reverse` and `questify_sync` (Questify quests, streak milestones).
- `questify_sync` (latest body 0122:363-470): player KEY SHARE, `player_xp` FOR UPDATE, tiers, quests, streaks, then one
  gem entry per unpaid `level_reached`, `achievement_earned` (not revoked) and paying award; `questify_level_up(who,
  entries)` (0066) names the highest level the sync's entries reached.
- Readers of the stored `player_xp.level`: `own_level` (0039, **joins `xp_level cur ON cur.level = x.level`**: a stored
  level that no longer exists drops the row), `own_equipment` (0063, next reward at `x.level + 1`),
  `public_player_profile` (0120), `console_player_record` (0122), via `level_title_of` (a `<=` lookup, safe for any number).
- `item` (identity immutable; `item_visual_key_check`: `frame-01`…`frame-20`, `chest` for a character, none for a title);
  `souvenir_catalog_guard()` (0067): on `level_item`, `souvenir_rule`, `gem_shop_item` writes it locks the item FOR UPDATE
  and refuses a second source (23514); on an `item` UPDATE it freezes an item in an active souvenir (SV409) or **any item
  with a `gem_shop_item` row** (GS409, names included). Souvenir items are made by organizers with id
  `souvenir-<32 hex>` (0064:310) and upserted by id.
- T-709b/T-709c console plumbing: `console_admin()`, `catalog_text`, `catalog_audit`, `catalog_revert_doc` (CA409),
  `audit_log_catalog_idx`, the `EDITORS` map in `apps/api/src/console/catalog.ts` (list, save, revert, `confirmable`,
  `catalogDoor` mapping 23514 to 400 and CA428 to 409 `confirmation_required`), `CATALOGS` in `catalog-routes.ts`,
  `CATALOG_KINDS` in `packages/shared/src/catalog/catalog.ts`, the 60 reads a minute and 120 changes an hour per admin,
  `busy` (503) in `apps/api/src/auth/http-errors.ts`.

## The lock rule (the heart of this re-plan)

**Invariant L:** every write to `xp_level` or `level_item` happens while the writer holds **FOR UPDATE on every
`xp_level` row**, and every insert into `level_reached` happens while the inserter holds **FOR KEY SHARE on each level it
inserts**. FOR UPDATE conflicts with FOR KEY SHARE, so a level can never be reached in the middle of a curve change, and
the curve can never change under a reach in flight.

Lock order, everywhere: `player` → `player_xp` → `xp_level` (ascending level) → `level_item` → `item` → `audit_log`.

- **Reach path** (`xp_apply`, the sync's catch-up): holds `player_xp` FOR UPDATE; then `levels_reach()` takes FOR KEY SHARE
  on the levels it is about to insert, in level order; then the `grant_level_item` trigger reads `level_item` and inserts
  `player_item`, whose FKs take KEY SHARE on `level_item` and `item`. KEY SHARE never conflicts with KEY SHARE, so reaches
  of many players run side by side as today.
- **Curve door**: never touches `player`, `player_xp` or any player row. Takes `xp_level` level 1 FOR UPDATE (the door
  serializer: no reach ever locks level 1), then in a **new statement** (fresh snapshot, so levels another door just added
  are included) every `xp_level` row FOR UPDATE in level order, then the `level_item` rows it changes FOR UPDATE, then the
  guard's item locks (items pre-locked by the door in id order). **One total budget of 1 s for all its lock waits**
  (plan review 2026-11-02, MAJOR: `lock_timeout` bounds each lock wait, not the save, so a door waiting on two reaches in
  turn could hold a queued scan past its own 2 s): the door records `clock_timestamp()` at entry, takes its locks one row
  per statement, and before each locking statement sets `set_config('lock_timeout', <1 s minus elapsed>, true)`; when the
  budget is used up it raises CA503. CA503 and a lock wait that runs out (55P03) both answer HTTP 503 `busy`,
  Retry-After 2. A scan queued behind the door waits at most about 1 s plus the door's few milliseconds of writes.
- **Item door**: locks only the one `item` row (FOR NO KEY UPDATE for a name change, which waits on nobody; FOR UPDATE for
  an art change, which waits for reaches and buys of that item in flight).
- No cycle: the reach path holds `player_xp` and asks for `xp_level`/`level_item`/`item`; the curve door holds
  `xp_level`/`level_item`/`item` and never asks for `player_xp`; the item door holds one `item` and asks for nothing.
  Erasure (`player` → `player_xp` → deletes `player_item`) takes no catalog lock. Sign-up (`player_xp_start`) takes none.

What a reach can see during a save, in READ COMMITTED:

- The reach locked level L first → the door waits for its commit, then its checks (new statements) see the reach's
  `level_reached` row and refuse to remove or remap L (CA409).
- The door locked first → the reach's `FOR KEY SHARE` waits; on the door's commit PostgreSQL re-checks the row: a removed
  level is skipped (no row written), a moved `xp_from` is tested again against the player's total, and the trigger, a new
  statement, reads the new mapping. No reach ever fails because of a save.
- A level the door adds is not in the reach's snapshot → not reached now → written by the player's next sync (D3).
- `xp_apply`'s `level = xp_level_of(…)` stays an unlocked read: it may store a level from the curve before the save. That
  stale cache is accepted (ADR-440): it is corrected at the player's next XP or sync, and the readers that would break on
  it derive the level from XP instead (D4). No stale-curve guard, no second statement.

## D1. XP table and level reward map: one document, one door (ADR-440)

`admin_xp_table()` → `{levels: [{level, xpFrom, itemId|null, reached: boolean}]}` (`reached`: any `level_reached` row,
for the console's lock icons). `admin_xp_table_save(doc jsonb, revert_of bigint, confirmed boolean, request uuid)`:

1. `console_admin()` (QE403); `clock_timestamp()` recorded: the 1 s lock budget starts.
2. Locks as in the lock rule. A revert then reads `catalog_revert_doc('xp_level', 'all', revert_of)` under those locks.
3. Validates the whole document (CA400, `DETAIL` names the field and level): only key `levels`; levels `1..N` contiguous,
   N 2 to 100; level 1 `xpFrom` 0 and `itemId` null; every other `xpFrom` whole, 1 to 100,000,000, strictly rising; every
   level above 1 has an `itemId` matching the item id pattern, all distinct. Then CA409 with the level in the detail:
   unknown item (`item_unknown`); the item is a shop or souvenir item, or has the `souvenir-` prefix (`item_has_source`).
4. Refusals, checked after the locks (so race-safe, see the lock rule):
   - **Removing a level** (N shrinks) when anyone reached it (`EXISTS level_reached WHERE level = L`, served by the new
     index) or anyone stands at or above its start (`EXISTS xp_board WHERE board = 'all' AND xp >= old xp_from`, one index
     probe): CA409 `level_held`. The `xp_board` probe covers players whose catch-up has not run yet.
   - **Changing the item of level L** when anyone reached L: CA409 `reward_given` (stricter than "owns": it also counts
     erased players, whose items were deleted; no index on `player_item.item_id` is needed). A level nobody reached can be
     remapped freely.
   - No other refusal: moving any `xp_from` up or down is allowed (a fall keeps rewards, FR-1602; a rise pays at next sync).
5. **Lowering needs `confirmed`.** The save "can pay" when any kept level's `xpFrom` falls, or an added level starts at or
   below the highest XP anyone holds (one `xp_board` index probe). Without `confirmed`: CA428 with `DETAIL` `{levels:
   [the paying levels], levelUp: gem_amounts().level_up}` → HTTP 409 `confirmation_required`. The counts are the preview's
   job (D2), not the door's, so the door stays short.
6. Writes, in this order so the non-deferrable `xp_from` UNIQUE never collides mid-way (the DEFERRABLE change is dropped):
   delete `level_item` then `xp_level` rows of removed levels (top only; their `xp_from` values are freed); update raised
   `xp_from` values one row at a time from the highest level down; update lowered ones from the lowest level up; insert
   added levels; delete the `level_item` rows whose item changes, then insert the new mappings (the guard locks each new
   item and refuses a second source). Proof the order never collides: a raised level's new value is above its old value
   and below the next level's new value, which is already written if raised and is above it if lowered or unchanged; the
   mirror holds for lowered levels.
7. Audit `catalog.xp_table.update` / `.revert`, target `xp_level`, id `all`, `before` and `after` the levels (level,
   xpFrom, itemId). No player counts in the audit (the door does not compute them). A revert is the same door with the
   entry's `before`: same validation, same refusals (a revert that would remove a reached level is CA409 `level_held`),
   same `confirmed` rule; it never removes a `level_reached` row or an item.
8. **No player row is written.** No recompute, no table lock, no long statement: the door is at most about 300 row
   writes on two 100-row tables plus a handful of index probes.

`admin_xp_table_preview(doc jsonb)` (read-only, no locks, validates like the door, CA400): over `xp_board` `all` minus the
inactive players (`player_inactive_idx`, as the ranking reads), one count per XP range between the union of the old and
new boundaries (one `width_bucket` pass over the board's index, the inactive players' rows taken off): `up` (players whose level by the new curve is higher), `down`, `levels`
(levels newly due: for each level, players at or above its new start and below its old start, or any for an added level),
`gems = levels × levelUp`. Advisory: the numbers can move by the time the save commits, and the console says "about".

## D2. Each player's level, under that player's own lock (ADR-440)

Migration 0124 changes four functions, each restated from its latest body with only the stated lines changed:

- **`levels_reach(who uuid, made bigint, total bigint) RETURNS smallint[]`** (new, internal): `WITH due AS MATERIALIZED
  (SELECT l.level FROM xp_level l WHERE l.level > 1 AND l.xp_from <= total AND NOT EXISTS (SELECT 1 FROM level_reached r
  WHERE r.player_id = who AND r.level = l.level) ORDER BY l.level FOR KEY SHARE OF l) INSERT INTO level_reached … SELECT
  who, level, made FROM due ON CONFLICT DO NOTHING RETURNING level`. Only levels the player has not reached are locked, so
  a reach that adds nothing locks nothing. The caller must hold the player's `player_xp` row lock. **The only code that
  inserts into `level_reached`** (plan review NIT): a DB test over `pg_proc.prosrc` checks no other live function does.
- **`xp_apply`** (0072 body): its `INSERT INTO level_reached` becomes `PERFORM levels_reach(who, made, total)`. Nothing else.
- **`xp_catch_up(who uuid) RETURNS smallint[]`** (new, internal; the caller holds `player_xp` FOR UPDATE): reads the
  player's XP; `made` = the player's latest `xp_entry` with `delta > 0` (index `xp_entry_player_idx`, backward); calls
  `levels_reach(who, made, xp)` (none when `made` is null, i.e. no XP); then `UPDATE player_xp SET level =
  xp_level_of(xp), updated_at = now() WHERE player_id = who AND level <> xp_level_of(xp)`. Returns the levels written.
- **`levels_due(who uuid) RETURNS boolean`** (new, internal): the stored level differs from `xp_level_of(xp)`, or a level at
  or below the XP has no `level_reached` row (at most 100 PK probes).
- **`questify_sync`** (0122 body): the unlocked pre-check gains `AND NOT levels_due(who)`; **right after the `player_xp`
  FOR UPDATE, before any `xp_apply`**, `caught := xp_catch_up(who)` (plan review MINOR: run after the quests, the catch-up
  could ask for a lower level than one a quest's `xp_apply` already holds, crossing a door that locks in level order;
  first, every level the sync locks rises, so it can never deadlock with a save; the sync's own quest and streak XP
  reaches its levels through `xp_apply` as before); the gem step is unchanged and pays `levelUp` once per
  new `level_reached` row (`gem_entry UNIQUE (player_id, source_level)` keeps it once); the answer's `levelUp` comes from
  a new overload `questify_level_up(who, entries, caught smallint[])` that also counts the caught levels as reached by
  this sync (the 0066 two-argument helper stays: the daily doors of 0069 call it). A banned or deleted player is refused by the sync
  (PI401) and gets nothing until active again.

Exactly once: `level_reached` PK, `player_item` PK and `UNIQUE (player_id, source_level)`, `gem_entry UNIQUE (player_id,
source_level)`, and the `player_xp` FOR UPDATE that serializes two syncs (and a sync with a scan) of one player.

The catch-up's `xp_entry_id` is the latest credit, so a completion screen replayed later may show a caught-up level under
that completion's level-up. Accepted; noted in Q-399.

## D3. Readers (ADR-440)

- **Derive from XP** where the stored level would break or mislead the player: `own_level` (`cur.level` and the next level
  from `xp_level_of(x.xp)`, so a removed or stale level never drops the row), `own_equipment` (next reward at
  `xp_level_of(x.xp) + 1`), `console_player_record` (the admin sees the truth). `xp_level_of` is one index lookup on a
  100-row table.
- **Accept the stored level until the player's next sync or XP**: `public_player_profile` (latest body 0120:595; its
  0063 and 0065:428 versions, the passport profile, read `x.level` the same way) and the Questify board row `xp_board_row`
  (0072:156); a title lookup with `<=`, valid for any number. The console's record read `x.level` at 0118:332 and 0122:582;
  0124 derives it there (above). A stored level may be stale for players who have not synced since a save, or, after a
  save/reach race, name a level that was removed (rare; corrected at that player's next sync).
- Index: `CREATE INDEX level_reached_level_idx ON level_reached (level)` (the door's `level_held` and `reward_given`
  probes). Level-ups are rare writes; migration takes a SHARE lock on `level_reached` for the build (seconds at launch
  sizes; rehearsed on staging) under its own `SET LOCAL lock_timeout = '2s'` (plan review MINOR), so a deploy that cannot
  get the lock fails and is retried instead of queueing level-ups behind it; the rest of the migration keeps 10 s.

## D4. Item catalog (ADR-441)

- **Listed items are Questify's**: a level reward, a shop item, or an item with no source. An item named by a
  `souvenir_rule` or with id `souvenir-%` is an organizer's: never listed, never edited (CA404).
- `admin_items()` → `[{id, kind, name, visualKey, source: {level}|{shop: {status}}|null, locked: {art: reason|null}}]`.
- `admin_item_save(id, doc, revert_of, request)`, `doc = {name: {ar, en}, visualKey}`:
  - Names (`catalog_text`, 1 to 60) always: row lock **FOR NO KEY UPDATE**, which never waits on reaches or buys (their
    KEY SHARE does not conflict).
  - Art (`visualKey` in the shipped set for the item's kind; the table CHECK is the final word, 23514 → 400) only when it
    changes, under **FOR UPDATE** on the item (waits for reaches and buys of that item in flight, then sees them): refused
    CA409 `item_on_sale` when the item has any `gem_shop_item` row (on sale or retired: buyers keep what they saw), CA409
    `item_owned` when it is a level reward of a level anyone reached. A reach that starts after the lock waits and gets the
    new art. An unassigned item has no owner by construction.
  - Audit `catalog.item.update` / `.revert`, target `item`, id the item. A revert puts back the `before` through the same
    rules (an art revert on a now-owned item is CA409).
- `admin_item_create(doc, request)`, `doc = {id, kind, name, visualKey, shop?: {price, position, status}}`:
  - `id` `^[a-z][a-z0-9-]{0,63}$`, not starting with `souvenir-` (CA400 `id`); an existing id is CA409 `exists`
    (`INSERT … ON CONFLICT DO NOTHING`, then the check; two admins with one id → one wins, the other CA409).
  - With `shop`: the item and its `gem_shop_item` row in one transaction (price 1 to 100,000, position 1 to 1,000, status
    `active` or `retired`, as 0067's CHECKs). The guard locks the new item and refuses a second source; a pre-check returns CA409
    `item_has_source` before the guard's 23514 can.
  - Audit `catalog.item.create` (no revert: 409 `nothing_to_revert`; retire it through the shop editor).
- **The exclusive-source guard** (`souvenir_catalog_guard`, restated from 0067): unchanged for `level_item`,
  `souvenir_rule`, `gem_shop_item` (lock the item FOR UPDATE, refuse a second source). On an `item` UPDATE: an item in an
  active souvenir stays wholly frozen (SV409); an item with a `gem_shop_item` row may change its **names only** (GS409 when
  `visual_key` changes). Kind and id stay frozen by `item_identity_guard`. Race-safety is the guard's own: every source
  writer locks the item FOR UPDATE first, and its EXISTS checks run as new statements after the lock, so two writers giving
  one item two sources serialize and the second is refused.

## API (console scope, 404 to anyone but an active admin; every door re-reads the admin)

- `GET /v1/admin/catalog/xp-table` · `PUT …/xp-table` (`{levels, confirmed?}`) · `POST …/xp-table/preview` ·
  `POST …/xp-table/revert` (`{confirmed?}`, Idempotency-Key). 409 `confirmation_required` `{levels, levelUp}`; 409
  `level_held` / `reward_given` / `item_unknown` / `item_has_source` with `{level}`; 503 `busy` (Retry-After 2) for CA503.
- `GET /v1/admin/catalog/items` · `POST …/items` (create) · `PUT …/items/{id}` · `POST …/items/{id}/revert`.
- `xp_table` and `item` join `CATALOG_KINDS`, `EDITORS` (`xp_table` confirmable) and `CATALOGS`; the preview and the create
  are their own handlers in `apps/api/src/console/xp-table.ts` and `catalog-routes.ts`. Limits: the catalog's 60 reads a
  minute (the preview counts as a read) and 120 changes an hour.

## Console UI (ADR-370: titles, labels, icons; no help lines)

- **XP table tab:** one row per level (level, starts at XP, the reward with its art and an item picker of unassigned items);
  a lock icon on a reached level's reward; Add level; Remove top level (off while reached). Save runs the preview first:
  "About {up} players go up. They get about {gems} gems and their level rewards at their next sync. Undoing this does not
  take them back." / "About {down} players go down a level. They keep what they earned." Buttons "Save and pay" / "Cancel".
  A 503 shows "Players are levelling up right now. Try again in a moment."
- **Items tab:** equal cards (art, kind icon, both names, a source badge: Level {n}, Shop, Unassigned); names edit in place;
  the art picker is off with the reason ("On sale" / "Players own it"). New item: kind, id, names, art from the shipped
  set, optional On sale with price and place.
- Every string in Arabic and English (`packages/shared/src/i18n/messages.ts`), RTL checked, Western digits.

## Tests

DB (`apps/api/test/db/console-xp-table.int.test.ts`, `console-items.int.test.ts`):

1. QE403 for every seat on every new door; outsider (anon, PUBLIC) holds EXECUTE on none; `levels_reach`, `xp_catch_up`,
   `levels_due` granted to nobody; catalog lint: no function but the two doors writes `xp_level` or `level_item`, and no
   live function but `levels_reach` inserts into `level_reached` (over `pg_proc.prosrc`).
2. Validation: N 1 and 101, gaps, level 1 not at 0, non-rising, 0 and 100,000,001, decimals, strings, missing or duplicate
   items, level 1 with an item, unknown keys → CA400; unknown, shop, souvenir and `souvenir-` items → CA409.
3. Remove a level someone reached → `level_held`; someone at or above its start with no row yet → `level_held`; nobody →
   removed, its item now unassigned. Remap a reached level → `reward_given`; unreached → remapped, including a swap of two
   unreached levels' items.
4. Shift without collision: raise all, lower all, mixed, a shift onto another level's old value, add and remove in one save.
5. Lowering without `confirmed` → CA428 with levels and amount, nothing written; with it → saved; a raise or a rename of
   nothing needs none; an added level above everyone's XP needs none.
6. Catch-up: after a lowering, the next sync writes the missing levels, gives each level item once, pays `levelUp` once per
   level, corrects the stored level, and its answer names the top caught level; a second sync writes nothing; two concurrent
   syncs of one player pay once; a banned player gets nothing until the ban is lifted, then once; a raise lowers the stored
   level at the next sync and keeps items and gems.
7. Readers: after a save and before any sync, `own_level` and `own_equipment` answer the derived level (a stored level that
   was removed still returns the row); the public profile shows the stored level until the sync.
8. **Races (two sessions, both orders, each with the API's `lock_timeout` 2 s):** a scan that reaches L while the door
   removes L (reach first → `level_held`; door first → the scan commits without L and without error); a scan reaching L while
   the door remaps L (reach first → `reward_given`; door first → the player gets the new item); a sync's catch-up against
   the door both ways; two doors (the second sees the first's added levels); the door against an item art edit, a souvenir
   rule write and a gem buy of a mapped item; erasure and sign-up against the door never wait. No deadlock in any pair.
   **The total budget** (plan review MAJOR): two sessions hold reaches on two different levels; the door queues behind the
   first; a scan queued behind the door (on a level the door already holds) finishes in under 2 s, and the door answers
   CA503 or 55P03 within about 1 s. **Sync against two saves, both orders** (plan review MINOR): a sync whose catch-up and
   quest XP both reach new levels, crossed with a save, never deadlocks.
9. Door duration on the 300,000-player fixture (`apps/api/test/perf`, as T-408's timing): a 100-level save with every
   kind of change, held-lock time under 200 ms; a scan waiting behind it finishes under its 2 s lock timeout. Preview under
   1 s. Sync with the new pre-check: no measurable change on the ranking timing suite.
10. Items: names on a shop item (on sale and retired) allowed, art refused; art on a reached level reward refused, on an
    unreached one allowed; art race against a reach both ways; create with and without shop; create with an existing id,
    two concurrent creates of one id, a `souvenir-` id; a level-mapped id put on sale → `item_has_source`; souvenir items
    CA404; revert of a create → `nothing_to_revert`; the guard's GS409 and SV409 paths directly.

HTTP (`apps/api/test/console/catalog` extended): 404/401 on every new route, 409 bodies, 503 `busy` with Retry-After,
idempotent reverts. Security: `routes`, `outsider`, `cross-tenant` updated. Shared unit (`catalog.test`, `xp-table.test`):
the XP table document, the item document. Web (`console-catalog.test`), browser (`console-catalog.spec`, `layout.spec`).

## Mutation globs (tier A, TS only; the SQL is covered by the DB tests)

`apps/api/src/console/xp-table.ts` (new), `apps/api/src/console/catalog.ts`, `apps/api/src/console/catalog-routes.ts`,
`packages/shared/src/catalog/xp-table.ts` (new), `packages/shared/src/catalog/catalog.ts`.

## Risks

- `xp_apply` and `questify_sync` are the two hottest XP paths: copy the 0072 and 0122 bodies and change only the stated
  lines; the existing XP, ranking, gems, streak and Questify quest suites must pass unchanged.
- A stored level can be stale until a player's next sync or XP (Q-399); only the public profile and the passport show it.
- The `FOR KEY SHARE` in `levels_reach` adds a lock per newly reached level; reaches never conflict with each other, only
  with a save, which holds its locks for milliseconds (measured, Q-401).
- A lowering is irreversible money: `confirmed` in the door, the preview's numbers in the confirmation, the audit holds the
  before and after.

## Left out on purpose

A batch recompute of every player's stored level; deleting items; putting an existing unassigned item on sale (create a
new shop item instead); level titles (T-709b); new renderers for item art; a gem correction source (ADR-285).

## Build notes (2026-11-02)

- Plan review (85, approve with revisions) folded in before the build: one 1 s lock budget for the whole save (CA503,
  `xp_lock_left`; tested with two reaches holding the door in turn, and shown to catch a per-lock timeout: that variant
  held the queued scan 1.9 s); the sync's catch-up right after its `player_xp` lock; the index built under its own 2 s
  `lock_timeout`; the readers listed in D3; `levels_reach` the only inserter, checked over `pg_proc.prosrc`.
- The catch-up order: the both-orders test also passes with the catch-up after the quests. A reach locks every unreached
  level at or below the player's total in one statement in level order, and a later statement of the same sync only adds
  higher levels (the curve cannot change while the sync holds a level lock), so neither order can cross a save's level
  order. Kept as the review asked; the test documents the case.
- The removal probe reads the highest XP once (`xp_board_top()`, one index probe) instead of an `EXISTS` with a parameter,
  whose generic plan scanned the whole board (3 s at 300,000 players). The refusal checks run as three set-based queries.
- The preview counts players only in the XP ranges where a level changes (`xp_board_active_between`: one index range less
  the inactive players in it), instead of one pass over the board: 3.8 s became about 0.2 to 0.3 s for a 100-level table.
- An item create with an id that exists (a level reward's included) answers 409 `item_exists`; the `item_has_source`
  pre-check of D4 cannot fire for a new item. The guard's 23514 for a level item put on sale is tested directly.
- No gem-buy race against the door: an item a level gives can never be on sale (the source guard), so a buy never touches
  the door's rows.
- Timing (`apps/api/test/perf/xp-table-timing`, 300,000 players, 50,000 with reached rows, this PC with another worker's
  tests on the same database server): preview 191 to 307 ms; a 100-level save with every kind of change 159 to 316 ms; a
  save removing 70 levels 117 to 203 ms; a scan queued behind a save finished in 167 to 616 ms, always under its 2 s.
  The 200 ms held-lock budget holds unloaded; under load the 1 s budget still bounds what a scan waits (Q-401).
