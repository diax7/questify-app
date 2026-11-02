# T-709c - Console XP, achievement-threshold and item editors (plan, tier A)

Delivers FR-1403 in full (with T-709b). Tier A: every editor here moves gems, XP levels or level rewards for every player
at once, and two of the changes (a lower threshold, a lower curve) pay gems that the append-only gem ledger can never take
back (ADR-285). Inherits the T-709b notes dated 2026-10-24 (T-401), 2026-10-25 (T-402), 2026-10-26 (T-403, the revoke)
and 2026-10-27 (T-404, the amounts). Pattern: T-709b's door, audit and revert (migration 0119,
`apps/api/src/console/catalog.ts`, `catalog-routes.ts`, plan `docs/plans/2026-11-02-t-709b-catalog-editors.md`).
Decisions ADR-436 to ADR-441 (Proposed), questions Q-398 to Q-402.

## Split (ADR-436)

Two builds, each reviewed and mutated on its own, each useful alone:

- **T-709c (part 1), migration 0122:** achievement thresholds, the amounts (`platform_setting` `xp` and `gems`), and the
  revoke and restore of a banned player's tiers. Touches `questify_sync` only to skip revoked tiers.
- **T-709d (part 2), the next free migration at build time:** the item catalog (names, art, new gem shop items) and the
  XP table with the level reward map (curve, recompute, catch-up of levels at the next sync). The curve needs the item
  editor first: every new level above 1 needs a shipped reward item that is not a shop or souvenir item.

Reason: part 2 changes `xp_apply` and `questify_sync`, the two hottest XP paths, and needs its own lock-order proofs and
measurement on the 300,000-player fixture; bundling it with part 1 makes one review cover two unrelated risk sets.

## What exists and is reused

- Tables, all closed (no grant to `questify_app` or PUBLIC): `achievement` (0065: `bronze < silver < gold`, each 1 to
  100,000), `achievement_earned` (append-only, `history_append_only`), `xp_level` (0039: level 1 to 100, `xp_from` UNIQUE,
  level 1 at 0), `player_xp` (`xp`, `level`, `gems`), `level_reached` (append-only; drives `grant_level_item` and level
  gems), `item` (0063, identity immutable), `level_item` (0063: one item per level, an item on one level only),
  `player_item` (FK to `level_item (level, item_id)`: a given level reward is frozen), `gem_shop_item` (0067),
  `gem_entry` (append-only; FKs to `level_reached` and `achievement_earned`; no adjustment source, ADR-285).
- `platform_setting` keys: `xp` (`questXp` CHECKed 1 to 99999; `dailyFinishXp` 0 to 400, `dailyRightXp` 0 to 200,
  `dailyWordXp` 0 to 1000 read defensively by `daily_xp()`, no CHECK), `gems` (no row, no CHECK; `gem_amounts()` falls
  back to 20, 10, 25, 50). The table's INSERT/UPDATE policies still let any admin request write any key through
  `questify_app` (`app_is_admin()`, 0003).
- `questify_sync` (latest body 0068): player KEY SHARE, then `player_xp` FOR UPDATE, then tiers, Questify quests, streaks,
  then one gem entry per unpaid `level_reached`, `achievement_earned` and paying award, amounts read at payment time.
- The exclusive-source guard `souvenir_catalog_guard()` (0067): an item is a level reward, a souvenir or a shop item,
  never two; it also freezes any change to an item on sale (GS409) or in an active souvenir (SV409).
- T-709b: `console_admin()` (QE403), `catalog_text` (CA400), `catalog_audit`, `catalog_revert_doc` (CA409),
  `audit_log_catalog_idx`, `admin_achievement_save` (name only, CA400 `thresholds` for anything else), the shared
  `catalog/catalog.ts` documents, the Catalog page's equal cards, `CatalogParts`, `useWrite`, the info tip.
- T-704/T-705: `player_for_admin(target, lock)`, `player_action_note`, `player_admin_action` (kinds up to `lift_ban`),
  the player record page and its confirmed, reasoned actions; the wall (PB423 on `gem_entry` for a non-active player).

## Part 1 (T-709c, migration 0122)

### D1. Achievement thresholds (ADR-437)

- `admin_achievement_save(achievement_id, doc, revert_of, confirmed boolean, request)` replaces the 0119 signature (DROP
  and CREATE; grants restated). The document is `{name: {ar, en}, bronze, silver, gold}`; numbers are whole, 1 to
  100,000, strictly rising (CA400 `thresholds`); unknown keys CA400.
- Row lock **FOR NO KEY UPDATE** (0119 used FOR UPDATE): `questify_sync`'s insert into `achievement_earned` takes FOR KEY
  SHARE on the achievement through the FK, which NO KEY UPDATE does not block, so a threshold edit never makes syncs wait
  and the door touches no player row. Lock order: achievement row, then `audit_log`. Nothing else.
- **Lowering pays.** When any new threshold is below the old one, the door refuses unless `confirmed` is true (CA428,
  HTTP 409 `confirmation_required` with `details.gems`: the tier amounts from `gem_amounts()` for each lowered tier). A
  raise or a name change needs no confirmation.
- **Exactly once** is carried by the existing keys: `achievement_earned` PK and `gem_entry UNIQUE (player, achievement,
  tier)`; the sync's FOR UPDATE on `player_xp` serializes two syncs of one player. Nothing new is needed; the tests prove
  it (T1 to T4).
- **Revert never claws back.** A revert is the same door with the entry's `before` (thresholds included); raising a
  threshold back leaves every `achievement_earned` row and every gem entry; `achievements_due` never removes a tier.
  A revert that lowers (the revert of a raise) needs `confirmed` like a save.
- Audit `catalog.achievement.update` / `.revert`, `before` and `after` hold the name and the three thresholds. Old 0119
  entries hold the name only: a revert of such an entry puts back the name and keeps the current thresholds (the door
  merges a `before` without thresholds over the current row).

### D2. The amounts: XP and gems (ADR-438)

- CHECKs (added NOT VALID, then VALIDATE; staging holds only `questXp`): `platform_setting_xp_daily_check` (each of the
  three daily fields absent or a whole number in its range) and `platform_setting_gems_check` (key `gems`: `levelUp`,
  `bronze`, `silver`, `gold` each a whole number 1 to 1000, all four present).
- Doors: `admin_amounts()` (the effective values, fallbacks filled in, and whether each row is stored) and
  `admin_amounts_save(doc, revert_of, request)`. One document `{xp: {questXp, dailyFinishXp, dailyRightXp, dailyWordXp},
  gems: {levelUp, bronze, silver, gold}}`. Makes sure both rows exist (`INSERT … ON CONFLICT DO NOTHING` with the
  current effective values; no table lock), then locks the two rows FOR UPDATE in key order (`gems`, `xp`), writes `updated_by`, audits
  `catalog.amounts.update` / `.revert` (target `platform_setting`, id `amounts`). No player lock: scans and syncs read
  the rows without locking (0067's note), so no wait either way.
- Effect, said in the confirmation: from the save on. Every gem paid later uses the new amount, including levels and
  tiers already reached but not yet paid (the sync reads amounts at payment); quest XP already credited never changes.
  No confirmation flag in the door (no amount pays anything by itself); the console still asks once.
- **Deny by default:** the generic writer path is narrowed. `platform_setting_insert` / `_update` are replaced with
  `app_admin_id() IS NOT NULL AND key IN ('features', 'tuning')` in both `USING` (update) and `WITH CHECK` (as 0116
  did for translations), so an admin request can neither select-for-update nor write another key. The keys
  `xp`, `gems` and `moderation` can then only be written by a definer door or a migration. A catalog test asserts no
  other function writes `platform_setting` keys `xp` or `gems`.

- With the CHECKs a stored out-of-range value cannot exist: `gem_amount()` keeps its fallback only for a missing row or
  field and loses its range branch; the DB tests that stored out-of-range values to prove a fallback (`gems`,
  `daily-challenge`, `daily-word`, `xp`) now assert that the CHECK refuses the value.

### D3. Revoke and restore a banned player's tiers (ADR-439)

- `achievement_earned` and `gem_entry` stay untouched (append-only; `gem_entry` holds a FK to the earned row). New table
  `achievement_revocation` (id, player_id → `player_xp`, achievement_id, tier, `change` `revoke`|`restore`, action_id →
  `player_admin_action`, created_at; FK `(player_id, achievement_id, tier)` → `achievement_earned`), append-only for every
  role (erasure keeps it: no personal data, as the earned rows), closed. A tier is revoked when its latest row is
  `revoke`. Index `(player_id, achievement_id, tier, id DESC)`.
- `player_admin_action.kind` gains `revoke_tiers` and `restore_tiers` (CHECK replaced); `player_action_note` is
  restated with their reason codes (`revoke_tiers`: `cheating`, `prize_fraud`, `abuse`, `other`; `restore_tiers`:
  `appeal_upheld`, `mistake`, `other`).
- `admin_revoke_tiers(target, tiers jsonb, reason_code, note, request)`: `console_admin()`, `player_for_admin(target,
  true)` (player FOR NO KEY UPDATE; compatible with the sync's KEY SHARE), then `player_xp` FOR UPDATE (the sync's order),
  then checks: the player is `banned` (PA409 `not_banned`), 1 to 15 tiers, each earned and not revoked (PA409
  `not_earned` / `already_revoked`). Writes the action, one row per tier, audit `player.revoke_tiers` with ids and tiers
  only. `admin_restore_tiers` is the same with `restore` and needs no ban (the ban may be lifted).
- Readers: `earned_tier()` skips revoked tiers (the player's achievements list, the public profile badges); an
  achievement with a revoked tier shows **no next tier** (a revoked tier is never earned again, so no progress target
  is shown); the sync's gem
  due list and `gems_due()` skip revoked tiers, so a tier revoked before its gems were paid is never paid while revoked,
  and restoring it pays at the next sync. `achievements_due()` is unchanged: the earned row still exists, so a revoked
  tier is never earned again. **Gems already paid stay** (no claw-back, ADR-285; Q-398); a banned player cannot spend
  them (`gem_buy` needs an active player).
- `questify_sync` is restated from 0068 with only those two filters; a DB test diffs its behaviour on the existing suites.

### Part 1 API (console scope, 404 to anyone but an active admin; every door re-reads the admin)

- `PUT /v1/admin/catalog/achievements/{id}` now `{name, bronze, silver, gold, confirmed?}`; 409
  `confirmation_required` `{gems: {bronze?, silver?, gold?}}`; revert takes `{confirmed?}` with the same 409.
- `GET /v1/admin/catalog/amounts` · `PUT …/amounts` · `POST …/amounts/revert` (Idempotency-Key on revert).
- `POST /v1/admin/players/{playerId}/achievement-tiers/revoke` and `…/restore`: `{tiers: [{achievementId, tier}],
  reasonCode, note}`, Idempotency-Key, 30 changes an hour per admin (T-704's player-change bucket). The player record read
  gains `achievements: [{id, name, tier, revoked}]`.
- Limits: the catalog's 60 reads a minute and 120 changes an hour.

### Part 1 console UI (ADR-370: titles, labels, icons; no help lines)

- **Achievements tab:** each card gains three number fields (Bronze, Silver, Gold, the tier icons). Save stays off until
  the shared schema passes. A lowering opens one confirmation: title "Pay gems for {name}?", body "Players who now reach
  {tier} get {gems} gems at their next sync. Undoing this does not take them back.", one line per lowered tier, buttons
  "Lower and pay" / "Cancel".
- **Amounts tab** (new): two equal cards, XP (quest, daily finish, each right answer, solved word) and Gems (level up,
  bronze, silver, gold), number fields with the range as the field's own min and max (no help line). One confirmation
  naming each changed gem amount: "From now on: level up {old} → {new} gems."
- **Player record:** an Achievements section (badge, tier, a Revoked mark). Revoke tiers (only while banned) and Restore
  open the record's existing reason-and-note dialog with the tiers ticked; the confirmation says "Paid gems stay with the
  player."

## Part 2 (T-709d, next free migration)

> **Re-plan before build (plan review 2026-11-02, score 86).** As written, D5 makes scans fail: the API pool runs with
> `lock_timeout` 2 s and `statement_timeout` 5 s (`apps/api/src/db/pool-options.ts`), so every XP writer queued behind
> `LOCK TABLE player_xp IN EXCLUSIVE MODE` errors out. The re-plan: the door writes only `xp_level` and `level_item`,
> with no table lock; each player's level is corrected under that player's own `player_xp` row lock (`xp_apply` already
> recomputes `xp_level_of` at 0072:70) plus the sync's catch-up; the DEFERRABLE `xp_from` UNIQUE and the stale-curve
> guard are dropped. T-709d gets its own re-plan and plan review before build.

### D4. Item catalog (ADR-441)

- Listed items are Questify's: a level reward, a shop item, or an item with no source made here. Souvenir items (named by
  `souvenir_rule`) are organizers' and never listed or edited (CA404).
- `admin_items()`, `admin_item_save(id, doc, revert_of, request)`: names (1 to 60, `catalog_text`) always; art
  (`visual_key`, the shipped set only: `frame-01`…`frame-20`, `chest`, none for a title) only while no player owns the
  item and it is not on sale (CA409 `item_owned` / `item_on_sale`). Kind and id never change.
- The guard is restated so an item on sale may change its **names** only (art stays frozen: buyers keep what they saw);
  souvenir content stays wholly frozen.
- `admin_item_create(doc, request)`: id (`^[a-z][a-z0-9-]{0,63}$`, CA409 `exists`), kind, names, art, and optionally
  `shop: {price, position, status}`. Item and shop row are one transaction; the guard serializes on the item row and
  refuses a second source (pre-checked to CA409 `item_has_source`). No revert of a create (409 `nothing_to_revert`);
  retire through the shop editor.

### D5. XP table and level reward map (ADR-440)

- One document, one door: `admin_xp_table_save(doc, revert_of, confirmed, request)`, `doc = {levels: [{level, xpFrom,
  itemId|null}]}`: levels 1..N contiguous, N 2 to 100, level 1 at 0 with no item, `xpFrom` strictly rising, every level
  above 1 mapped to a distinct item that is not a shop or souvenir item (CA400 / CA409 with the level in the detail).
- **Lock order:** `console_admin()`; `SET LOCAL lock_timeout = '3s'` (CA503, HTTP 503 `busy` with Retry-After); first
  `LOCK TABLE player_xp IN EXCLUSIVE MODE` (blocks every XP, gem and item writer and new sign-ups, which all lock or
  key-check `player_xp`; plain reads go on); then the mapped items FOR UPDATE in id order (the guard's own lock); then
  `xp_level` and `level_item`. Every XP writer takes `player_xp` before `xp_level`/`level_item`/`item`, the door never
  touches `player`, and erasure goes `player` → `player_xp`, so no cycle. Proven by two-session tests both ways (T15).
- **Refusals:** removing a level anyone reached (`level_reached`) or holds (`player_xp.level`) is CA409 `level_held`;
  changing the item of a level whose reward anyone owns is CA409 `reward_given` (the FK would refuse anyway).
- **Writes:** `xp_level.xp_from` UNIQUE becomes DEFERRABLE INITIALLY DEFERRED so a shift does not collide mid-statement;
  changed mappings are deleted then inserted; removed top levels are deleted; then **the recompute in the same
  transaction**: `UPDATE player_xp SET level = <new level>, updated_at = now() WHERE level <> <new level>` with the
  level found by a range join, not a per-row function. `level_reached` rows are never removed (a fall keeps rewards,
  FR-1602).
- **A lowering pays.** Players who now stand at a level they never reached get it at their **next sync**: `questify_sync`
  gains a catch-up (under its existing `player_xp` FOR UPDATE: insert `level_reached` for every level at or below the
  player's XP with no row, `xp_entry_id` = the player's latest positive XP entry), so `grant_level_item` gives the item
  and the gem step pays `levelUp` once per level; the unlocked pre-check gains `levels_due()`. The XP of the next quest
  would do the same through `xp_apply`. The door refuses a lowering without `confirmed` (409 `confirmation_required`
  `{players, levels, gems}`); `admin_xp_table_preview(doc)` (read-only, no locks) gives the counts: players up, players
  down, new levels to reach (active players only) and gems = levels × `levelUp`.
- **Stale curve guard:** `xp_apply` is restated to set `level` in a second statement after the XP update (its own
  snapshot, taken after the row lock), so an award queued behind the door can never write a level from the old curve.
- Audit `catalog.xp_table.update` / `.revert` (target `xp_level`, id `all`): the levels before and after plus the counts.
  A revert is the same door and needs `confirmed` when it lowers; it never removes a reached level or an owned item.
- **Measure** on the 300,000-player fixture (T-709's): the door's lock time end to end; budget 5 s, then Q-401.

### Part 2 API and UI

- `GET|PUT /v1/admin/catalog/xp-table`, `POST …/xp-table/preview`, `POST …/xp-table/revert`; `GET|POST
  /v1/admin/catalog/items`, `PUT …/items/{id}`, `POST …/items/{id}/revert`. 503 `busy` (Retry-After 5) for the lock wait.
- **XP table tab:** one row per level (level, starts at XP, reward with the item's art and an item picker), Add level,
  Remove the top level (off while held), Save opens the preview's confirmation: "{players} players go up. They get
  {gems} gems and their level rewards at their next sync. Undoing this does not take them back." A raise says "{players}
  players go down a level. They keep what they earned."
- **Items tab:** equal cards (art, kind icon, both names, a source badge: Level {n}, Shop, Unassigned), edit in place;
  New item (kind, id, names, art from the shipped set, optional On sale with price and place).

## Tests

DB (`test/db/console-catalog-xp` part 1, `test/db/console-xp-table` part 2):

1. QE403 for every seat (organizer, staff, player, retired admin) on every new or changed door; outsider (anon, PUBLIC)
   holds EXECUTE on none; no grant on `achievement_revocation`.
2. T1 lower bronze → one sync pays the tier once; a second sync pays nothing; two concurrent syncs of one player pay once.
3. T2 revert (raise back) → earned rows, gem entries and balance unchanged; the next sync pays nothing.
4. T3 lowering without `confirmed` → CA428 and nothing written; raise or rename without it → saved.
5. T4 threshold edit while a sync holds `player_xp`: neither waits on the other (lock held in session A, door in B).
6. Thresholds: equal or falling tiers, 0, 100,001, decimals, strings → CA400; old name-only entry revert keeps thresholds.
7. Amounts: each CHECK boundary (0/1/1000/1001; daily 0 and top, top + 1); fallbacks shown; a gem amount change pays the
   new amount for an unpaid level at the next sync; credited XP unchanged; `questify_app` can no longer write `xp`,
   `gems` or `moderation` directly (and still writes `features`, `tuning` as an admin).
8. Revoke: not banned → PA409; unknown or revoked tier → PA409; revoked tier hidden from the list and profile, never
   re-earned, unpaid gems never paid while revoked; restore → paid at the next sync once; paid gems stay; the ledger,
   `achievement_earned` and `gem_entry` refuse UPDATE/DELETE; revoke concurrent with a sync → one order, both tested.
9. Part 2: curve save recomputes every level (up and down) in the same transaction; held level removal → CA409; used
   mapping change → CA409; shop/souvenir item as a reward → CA409; missing mapping → CA400; non-rising → CA400.
10. Part 2: after a lowering, the next sync writes the missing levels, gives each level item once and pays `levelUp` once
    per level; a second sync nothing; a banned player gets nothing until active.
11. T15 lock order: an award blocked behind the curve door lands with the new curve's level; the door waits behind an
    award and a sync; erasure against the door both ways; a souvenir rule write against the door; no deadlock.
12. Items: names on a shop item allowed, art refused; art on an owned item refused; new shop item with a level-mapped id
    refused; two admins creating one id → second CA409; souvenir items are CA404.

HTTP (`test/console/catalog` extended, `test/console/players` extended): 404/401 on every new route, 409
`confirmation_required` bodies, 503 `busy`, idempotent reverts and revokes. Security: `routes`, `outsider`,
`cross-tenant` updated. Shared unit (`catalog.test`): thresholds rising, amounts ranges, XP table document. Web
(`console-catalog.test`), browser (`console-catalog.spec`, `console-players.spec`, `layout.spec`).

## Mutation globs (tier A, TS only; the SQL is covered by the DB tests)

- Part 1: `apps/api/src/console/catalog.ts`, `apps/api/src/console/catalog-routes.ts`,
  `apps/api/src/console/players-tiers.ts` (new), `packages/shared/src/catalog/catalog.ts`.
- Part 2: `apps/api/src/console/xp-table.ts` (new), `apps/api/src/console/catalog.ts`,
  `packages/shared/src/catalog/xp-table.ts` (new).

## Risks

- A lowering is irreversible money: the confirmation names the gems, the door needs `confirmed`, the audit holds the counts.
- Part 2's table lock is withdrawn (the re-plan note under Part 2).
- `questify_sync` and `xp_apply` are restated: copy the latest bodies (0068, 0072) and change only the stated lines.

## Left out on purpose

Streak milestone XP (`questify_streak_milestone` is append-only; T-703, Q-400), a gem correction source (ADR-285),
deleting items, revoking for players who are not banned, new renderers for item art.

## Build notes, part 1 (2026-11-02)

- The tier doors answer an outcome row (`changed`, `not_banned`, `not_earned`, `already_revoked`, `not_revoked`) and
  write nothing unless `changed`, as `admin_ban_player` / `admin_lift_ban` do, instead of raising PA409; the API maps each
  to a 409 code. PA400 (reason, note or tier list) and PA404 are raised as planned.
- `achievement_revocation.action_id` is `ON DELETE SET NULL`: erasure deletes the player's `player_admin_action` rows, so
  the mark is kept with its action emptied (the guard lets that one change through, under the erasure flag only).
- The CHECKs on `platform_setting` spell each field out instead of calling `amount_field_ok`: a CHECK runs with the
  writer's rights, and the API's role holds EXECUTE on no internal function.
- The tier routes live in `apps/api/src/console/players/tiers.ts` (beside the other player doors), not
  `apps/api/src/console/players-tiers.ts`.
- `daily_xp_field()` keeps its range branch, unreachable now behind the new CHECK (only `gem_amount()` was named by the
  review); a follow-up.
