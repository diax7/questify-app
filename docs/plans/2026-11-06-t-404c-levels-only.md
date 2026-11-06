# T-404c — Levels only: remove gems and the Questify gem shop

**Status:** plan reviewed (tier A plan review 86, approve with revisions; the revisions are folded in below, 2026-11-06). Dhia's decision: `docs/INBOX.md` 2026-11-06, ADR-760
(Accepted by Dhia). Removes FR-724, FR-725, FR-726 (F-135, F-136); amends FR-415, FR-421, FR-830, FR-1106; adds
FR-741 to FR-744. Depends on T-404, T-404b, T-709b to T-709d (all built). Choices left are **Proposed ADR-761 to
ADR-768 / Q-720 to Q-725**, all decided 2026-11-06 (Q-724 and Q-725 by Dhia, the rest by the developer after the plan review). Never push, deploy, run EAS or run local mutation testing.

**The rule this plan enforces (ADR-760):** the lifetime level is the only reward across Questify. Levels, achievements
and Questify quests give XP and cosmetic items. Inside an event a player has that event's points and that event's
rewards, nothing else. A level never gives extra points, better odds, earlier access or any other advantage inside an
event. Nothing in Questify has a price: not in money, not in XP (FR-415), not in anything.

## 1. Split (ADR-761, Q-720)

| Part | Tier | Delivers | Migrations |
|---|---|---|---|
| **T-404c** | **A** (drops a ledger, adds an XP source, changes the sync and the player item sources) | Every gem object gone from the database, API, shared package, app and console; achievement tiers pay XP; achievement items (table, grant, console door); `level` on event ranking rows; `GET /v1/me/rewards`; the console Amounts editor's new shape | 0163, 0164 |
| **T-404d** | **B** (screens and copy) | The Journey tab and screen (the old Shop tab's place), the level badge beside names on event rankings and both profiles, the achievement editor's "Unlocks" field, the sync toast for achievement XP and items, every new string | none |

Each part is valuable alone: after T-404c no gem exists anywhere (the decision Dhia took) and the server rewards are
complete; T-404d is the new way to see them. Between the two the Questify bar has four tabs (Home, Explore, scan,
Profile). That is only on `main`; no store or demo build is cut between them (T-806 comes later). T-404c has to delete
the app's and the console's gem code anyway, because the shared gem schemas go and the types must compile.

## 2. Exact removal inventory

Deployed migrations are frozen (staging is at 0117; 0067, 0119, 0122 and 0124 are deployed). Everything is removed by
the new migrations and by deleting code. No shim, no deprecated route, no "gems: 0" kept for old builds.

### 2.1 Database objects

| Object (created in) | Fate |
|---|---|
| `gem_entry` table, its triggers `gem_entry_no_update_or_delete`, `gem_entry_no_truncate`, `gem_player_guard` (0067, 0120) | DROP TABLE (rows vanish) |
| `gem_purchase` table and its two append-only triggers (0067) | DROP TABLE, after `player_item_shop_fk` is dropped |
| `gem_shop_item` table and trigger `gem_shop_item_source` (0067) | DROP TABLE, after `admin_shop_item_doc(gem_shop_item)` (row-type dependency) |
| `player_xp.gems` column and its CHECK (0067) | DROP COLUMN (balances vanish) |
| `questify_quest.gems` column and its CHECK (0067) | DROP COLUMN |
| `questify_award_owner_key` UNIQUE (id, player_id) (0067, only for the gem FK) | DROP CONSTRAINT |
| `player_item.source_purchase_id`, `player_item_shop_fk`, the `shop` branch of `player_item_source_check` (0067) | In this order (3): drop `player_item_source_check`; `DISABLE TRIGGER owned_item_guard` by name (never `DISABLE TRIGGER ALL`); UPDATE `shop` → `questify`; `ENABLE ALWAYS TRIGGER owned_item_guard`; drop the FK and the column; add the new CHECK. A catalog test asserts the guard's `tgenabled = 'A'` afterwards |
| `platform_setting` row `gems`, constraint `platform_setting_gems_check` (0122) | DELETE row, DROP CONSTRAINT (migration 0163 alone, 4.1) |
| Functions `gem_append_only`, `gem_amount`, `gem_amounts`, `gems_due`, `own_gems`, `gem_shop`, `gem_buy`, `questify_gems_of`, `admin_shop_item_doc`, `admin_shop_items`, `admin_shop_item_save` (0067, 0119, 0122) | DROP FUNCTION (exact signatures) |
| Functions whose latest body names a gem object: `questify_sync` (0124), `questify_quest_json`, `questify_quest_save`, `own_questify_quests`, `own_locker` (0067), `souvenir_catalog_guard`, `owned_item_guard`, `admin_xp_table_save`, `admin_xp_table_preview`, `xp_table_refusals`, `admin_item_row`, `admin_item_save`, `admin_item_create` (0124), `admin_amounts_doc`, `admin_amounts`, `admin_amounts_save`, `admin_achievement_save` (0122), `data_export_questify` (0129; its `items` list also gains the achievement id and tier for `achievement`-source items, 0129:493), `data_export_account` (0155), `wallet_player_guard` (0120, comment only: no change needed, it stays for `xp_entry`) | Replaced without the gem parts (4.2). `admin_item_create` loses its `shop` argument (DROP and CREATE, new signature) |
| Audit entries `catalog.gem_shop.*` and `catalog.amounts.*` holding `gems` (0119, 0122) | Kept: `audit_log` is append-only history. A revert of an amounts entry ignores its `gems` group (4.2) |
| Items `shop-*` (six titles, six frames, visual keys `frame-15` to `frame-20`) | Kept: players own them. Five frames become achievement rewards (5.2); the ids stay (immutable, never shown) |

A catalog test in the upgrade suite asserts afterwards that no relation, column, constraint, trigger or function in
`public` has a name matching `gem` (case-insensitive), and that no function body mentions `gem_`.

### 2.2 API (`apps/api/src`)

- Delete `questify/gems.ts` and `questify/gems.test.ts`; `questify/routes.ts` loses `GET /v1/me/gem-shop` and
  `POST /v1/me/gem-shop/purchases` and the purchase rate limit; `auth/throttle.ts` loses the `gemPurchase` bucket;
  `maintenance/gate.ts` loses the purchase route; `auth/http-errors.ts` loses `gem_item_not_found`,
  `gemShopConflict`, and the gem wording of `confirmation_required` (now XP and items, 4.2).
- `players/profile.ts`: `gems` leaves `GET /v1/me` (`readGems`, `own_gems`). `questify/questify.ts`: the sync answer
  loses `gems`; each earned tier gains `xp`; the answer gains `items` (achievement items given by this call).
- `console/catalog.ts` and `catalog-routes.ts`: the `gem_shop` editor and `/catalog/gem-shop` go; the amounts editor
  takes the new document; the achievement editor's confirmation names XP; `xp-table.ts` preview loses `gems`/`levelUp`;
  `console/players/tiers.ts` comment. `players/items.ts`: the locker source `shop` becomes `questify`, plus `achievement`.
- `ranking/ranking.ts`, `ranking/display.ts`: rows and `me` carry `level` (6).
- New `questify/rewards.ts` and `GET /v1/me/rewards` (7).

### 2.3 Shared package (`packages/shared/src`)

- Delete `questify/gems.ts` and its test; `index.ts` exports; `catalog/catalog.ts` (`gem_shop` kind, shop schemas,
  `loweredGemsSchema` becomes `loweredTiersSchema`), `catalog/xp-table.ts` (preview `gems`, refusal `levelUp`);
  `questify/quests.ts` (`gems`); `players/items.ts` (locker source `shop` → `questify`, new `achievement`);
  `players/frame.ts` (comment: the six rings are no longer "bought"); new `questify/rewards.ts`.
- `i18n/messages.ts`: every gem and gem shop message goes. Instead of a list, a test enforces it: no English message
  value matches `gems?` (case-insensitive) and no Arabic value contains «جوهر» or «جواهر», except
  `terms.icon.gem` and `games.picture.gem`. `nav.shop` goes; `nav.journey` comes with T-404d.
- **Kept on purpose (ADR-768, Q-725):** `CURRENCY_ICONS` `gem` and `terms.icon.gem` (an organizer may call an event's
  points "gems"; that is the event's currency, not Questify's) and the memory game's `games.picture.gem` card.

### 2.4 App (`apps/app`)

Delete `app/(questify)/gem-shop.tsx`, `src/questify/GemShopScreen.tsx`, `GemShopCards.tsx`, `GemIcon.tsx`,
`gems.ts`, `gem-shop-api.ts`, `gem-shop-flow.ts` and their tests. `_layout.tsx` drops the Shop tab (T-404c) and gains
the Journey tab (T-404d). `ProfileScreen.tsx` drops `GemsCard`; `LockerScreen.tsx` drops the shop door and shows the
`questify` and `achievement` sources (T-404c, plain lines; T-404d polishes); `QuestifyQuestsScreen.tsx` drops "+N gems";
`sync-notices.ts` and `QuestifySyncProvider.tsx` drop the gem toast and the gems-only write; `auth/player-state.ts`
drops `gems`; comments in `DailyStreakCard.tsx` and `daily/use-daily.ts`. `#assets/currency/gem.png` stays (the event
currency icon and the catch game use it).

### 2.5 Console (`apps/web`)

Delete `components/CatalogGemShop.tsx` and the Gem shop tab in `ConsoleCatalog.tsx`; `lib/console-catalog.ts` loses
`GEM_SHOP_API`, `readGemShop`, `shopDraftOf`, `isShopDirty`; `CatalogAmounts.tsx` loses the Gems group and gains the
three achievement XP fields (T-404c, since the door's document changes); `CatalogAchievements.tsx` and
`CatalogXpTable.tsx` and `lib/console-catalog-xp.ts` (`xpLoweringOf`, line 36) confirmations name XP and items, not gems; `ConsoleQuestify.tsx` and `lib/console-questify.ts`
lose the Gems field; the item list's source line loses "Shop" and gains "Achievement"; `ConsolePlayerActions.tsx`
comment; the catalog page comment. E2E: `console-catalog.spec.ts`, `console-questify.spec.ts`,
`console-players.spec.ts` updated.

### 2.6 Tests

- **Delete:** `apps/api/test/db/gems.int.test.ts`, `gem-shop.int.test.ts`, `gems-upgrade.int.test.ts`;
  `apps/api/src/questify/gems.test.ts`; `packages/shared/src/questify/gems.test.ts`;
  `apps/app/src/questify/gem-shop-api.test.ts`, `gem-shop-flow.test.ts`, `gems.test.ts`; the shop cases of
  `apps/web/src/lib/console-catalog.test.ts` and `console-catalog.spec.ts`.
- **Rewrite** (gems named in passing; about 55 files from `rg -il gem`): the security suites (`outsider`,
  `cross-tenant`, `routes`, `maintenance-doors`), `test/db/personal-data-catalog.ts`, `sql-settings-allowlist.json`,
  `daily-streak`, `daily-challenge`, `daily-upgrade`, `streaks-upgrade`, `questify-quests`, `achievements`,
  `console-catalog`, `console-catalog-xp`, `console-xp-table`, `console-items`, `player-safety` (the writer list loses
  `gem_entry`), `push-store`, `big-screen`, `interests-quest-upgrade`, the route and unit tests listed in 2.2 to 2.5,
  and `test/support/full-player.ts`. A "never writes gems" assertion becomes "never writes a ledger entry or XP outside
  its source", not deleted silently. The rehearsal guard list and the community gate map lose the three tables and gain
  `achievement_item`.

## 3. What happens to existing gems and bought items (ADR-763, Q-722)

- **Balances and the gem ledger simply vanish.** No money was ever involved, nothing was sold, gems had no value outside
  the shop, and the product is not launched (staging and test players only). Nothing is converted: converting gems to
  XP would invent a price between them. The data export loses `gemEntries`, `gemPurchases` and `gems` with the tables.
- **Items bought in the shop stay in the lockers, equipped or not.** Their `player_item` rows are rewritten from
  `source = 'shop'` to `source = 'questify'` (no key; the purchase row it pointed at is dropped). The locker shows them
  as "A Questify reward" / «مكافأة من Questify» with the Questify mark, never the word shop or gems. The migration does
  this under the table's ACCESS EXCLUSIVE lock with `owned_item_guard` disabled for that one UPDATE and re-enabled
  `ALWAYS` at once (the guard freezes the source columns; the owner may do this inside the migration only). The new
  CHECK allows `questify` only with every key NULL, and no door can insert it (a test: only the migration wrote one).

## 4. Database changes

### 4.1 Migration 0163 (platform_setting only)

Its own file, so its own transaction: `questify_sync` locks `player_xp` and then reads `platform_setting`, while a scan
reads `platform_setting` before it locks `player_xp`; a migration holding both strongly would deadlock with one of
them (0067's lesson, ADR-291). 0163 touches `platform_setting` alone: `DELETE` the `gems` row, `DROP CONSTRAINT
platform_setting_gems_check`, and replace `platform_setting_xp_daily_check` with the same check plus three optional
fields `bronzeXp`, `silverXp`, `goldXp` (each 0 to 1000). It waits for in-flight readers and holds nothing else. Until
0164 runs, the old sync falls back to its built-in gem amounts; nothing breaks.

### 4.2 Migration 0164 (the rest)

`SET LOCAL lock_timeout = '10s'`; every table locked up front in live-path order at the strongest mode a later
statement needs (0067 precedent): `player` EXCLUSIVE (drains erasures), `player_xp` ACCESS EXCLUSIVE, `xp_entry`
ACCESS EXCLUSIVE, `level_reached`, `achievement_earned` **ACCESS EXCLUSIVE**, `achievement` SHARE ROW EXCLUSIVE,
`questify_quest`, `questify_award` ACCESS EXCLUSIVE, `gem_shop_item`, `gem_purchase`, `gem_entry` ACCESS EXCLUSIVE,
`item` **ACCESS EXCLUSIVE**, `player_item` ACCESS EXCLUSIVE, `level_item`, `souvenir_rule` SHARE ROW EXCLUSIVE. Never
`platform_setting`. Dropping a foreign key (DROP TABLE or DROP CONSTRAINT) takes ACCESS EXCLUSIVE on the referenced
table too: `gem_entry` references `level_reached` and `achievement_earned` (0067:84-85) and `gem_shop_item` references
`item` (0067:28), so those three are taken ACCESS EXCLUSIVE up front; a weaker first lock would upgrade mid-way while
`player_xp` is held and could deadlock with a reader holding `item` (`item_json` in `ranking_top` or the profile) and
then waiting on `player_xp` (plan review 86). The build worker derives the order again from the live code (`complete_quest_answer` 0151,
`questify_sync` 0124, `erase_player`, the daily doors) and writes it in the header; an upgrade test proves it (9).

Deny by default: `achievement_item` ENABLE and FORCE RLS, REVOKE ALL FROM PUBLIC and `questify_app` in the same group;
every new function `SET search_path = public, pg_temp` and `REVOKE ALL ... FROM PUBLIC` next to its CREATE; only
`own_level_rewards()` is granted to `questify_app`; replaced doors keep exactly their old grants.

**Achievement tiers pay XP (ADR-764, Q-721).**
- `xp_entry` gains `achievement_id text`, `tier text`; the source CHECK gains `achievement` (both set, every other key
  NULL; `delta > 0`); FK `(player_id, achievement_id, tier) → achievement_earned`; UNIQUE `(player_id, achievement_id,
  tier)`: one XP entry per tier ever. The existing append-only and `wallet_player_guard` triggers cover it.
- `achievement_xp()` (internal) reads `bronzeXp`, `silverXp`, `goldXp` from the `xp` setting, each falling back to
  **50, 150, 300** when absent. A tier set to 0 pays no XP and writes no entry.
- `questify_sync` (replaced) pays the XP **in the same statement group that inserts the tier**: for each row the tier
  INSERT returns, one `xp_entry (achievement)` and one `xp_apply`. Not retroactive: tiers earned before 0164 pay
  nothing (the product is not launched; a retroactive pay would land in one month's Questify ranking at once). No due
  check is needed, so the pre-check gets cheaper (`gems_due` goes).
- **How the amounts are chosen:** a scan quest pays `questXp` 100 and the curve puts level 5 at 1,400 XP and level 30
  at 46,400. A bronze tier is half a quest, silver one and a half, gold three; all fifteen tiers together give 2,500
  XP, about 5% of the curve, so achievements help a level but never replace playing. They are data in the Amounts
  editor (0 to 1000 each).
- **Questify quests** keep paying the XP they already pay (`questify_quest.xp`); their gems simply go. No XP is added
  in their place: the level items that XP leads to are the reward.
- **Level-ups** paid 20 gems; they now pay only their level item (F-131, unchanged). Nothing replaces the gems.
- **No XP is ever priced (FR-415):** after 0164 no function subtracts XP except the existing FR-1602 removal, and no
  door takes XP as a price. A catalog test asserts the only writers of negative `xp_entry.delta` are the removal doors.

**Achievement items (ADR-765, Q-723).**
- `achievement_item (achievement_id text PRIMARY KEY → achievement, tier text NOT NULL CHECK (tier IN ('bronze',
  'silver', 'gold')), item_id text NOT NULL UNIQUE → item, UNIQUE (achievement_id, item_id))`: at most one item per
  achievement, given at the tier the admin picks. Exclusive sources: `souvenir_catalog_guard` (replaced) treats
  `achievement_item` like `level_item` and `souvenir_rule` (an item has one source; the writer locks the item first),
  and drops the gem shop branch.
- `player_item` gains `source = 'achievement'` with `source_achievement_id`, `source_tier`; CHECK: both set and the other
  keys NULL; FK `(player_id, source_achievement_id, source_tier) → achievement_earned`; FK `(source_achievement_id,
  item_id) → achievement_item (achievement_id, item_id)`. `owned_item_guard` freezes the new columns.
- The grant is in `questify_sync`, after the tiers: every earned, not revoked tier of the caller whose achievement has an
  item for that tier and whose item the player does not own yet (`ON CONFLICT DO NOTHING`). It is retroactive on
  purpose: an admin who adds an item to an achievement later gives it to everyone who holds that tier, at their next
  sync. The pre-check gains `achievement_items_due(who)` (at most fifteen rows per player; no lock when nothing is due).
  A revoked tier's item is not given while revoked; a restore gives it at the next sync; an item already given is never
  taken back (items are append-only, as level items after an XP removal).
- **Seeded:** each achievement's gold tier unlocks one of the former shop frames: Wanderer → Compass ring, Quest Hunter
  → Falcon ring, City Roamer → Dune ring, Top Ten → Moon ring, Teamwork → Pearl ring. Desert ring and the six titles
  stay unassigned for the console. Players who bought one keep it and are simply not given it twice.
- **The console door:** `admin_achievement_save` (replaced) takes an optional `item: {tier, itemId} | null` in its
  document (absent means unchanged, so an entry written before 0164 reverts without touching it). Refusals, as the XP
  table's: an unknown item or a souvenir `CA409 item_unknown`; an item with another source `item_has_source`; a change
  or removal while any player owns the item from this achievement `item_given`. Setting it pays items at players' next
  syncs; no confirmation (cosmetic, nothing to take back). The threshold-lowering confirmation (`CA428`) now names, per
  lowered tier, the XP it pays and its item. `admin_achievements` lists `item`.

**The rest of 0164.** `own_questify_quests`, `questify_quest_json`, `questify_quest_save` without `gems`;
`own_locker` answers `source: questify` and `achievement` (with the achievement's name and tier); `admin_xp_table_save`
asks `confirmed` with the levels it pays (no `levelUp`); `admin_xp_table_preview` answers `{up, down, levels}`;
`xp_table_refusals` and the item doors check the achievement source instead of the shop; `admin_item_row` source is
`level`, `achievement` or none, and art is locked when any player owns the item (`item_owned`); `admin_item_create`
without `shop`; `admin_amounts_doc` and `admin_amounts_save` with one group `xp` of seven fields (a revert of an older
entry drops its `gems` group and keeps the current tier XP); `data_export_questify` and `data_export_account` without
gems; the three ranking readers gain `level` (6); `own_level_rewards()` (7). ADR-175's tombstone list loses the gem
tables.

## 5. Level rewards (Dhia's three choices)

1. **Every level unlocks an item** (F-131, FR-721): already built and verified: `grant_level_item` (0063) gives the
   `level_item` of each level reached and raises (`23514`) when a level has no item, `levels_reach` (0124) is the only
   inserter, and `level_item.level` is the curve's key. Unchanged; only its gem half goes. The build re-runs
   `test/db/profile-items.int` to prove it.
2. **Some achievements unlock their own item**: 4.2 (new; seeded for five gold tiers).
3. **The level beside the name on event rankings and the profile**: 6. The Questify XP ranking already shows the level
   (T-408, `questify_ranking`); the public profile already answers `level` (T-402).

## 6. The level on event rankings (ADR-766, Q-724)

- `ranking_rows`, `ranking_top`, `ranking_day_top` (replaced, same signatures plus a `level smallint` column; DROP and
  CREATE because the return type changes, grants restated) add `xp_level_of(x.xp)` through `LEFT JOIN player_xp x ON
  x.player_id = p.id` (primary key, one lookup per row; `xp_level` is 30 rows on a unique index). The derived level,
  as every reader since 0124, so a stored level a curve save left stale is never shown. `ownIn` reads the same for `me`.
- A blocked player's row keeps its level as it keeps its place and score (the Questify ranking's rule, FR-1415); a
  row not shown keeps nothing new. "Rank only" events (FR-1832) keep the level: it is not a score. `playerRanking`
  copies `level` field by field.
- **Cost and the hot path:** the ranking read is not on the completion path. `complete_quest_answer` calls only
  `ranking_entry_of` / `ranking_day_entry_of`, which do not change, so ADR-734's gate is untouched; Redis holds no
  names and needs no change. The read gains one primary-key probe per row (at most 100). Gate for the build: `node
  ops/load/profile.mjs --big-event-players 50000` still at or under 10 ms a completion (ADR-734; it must not move), and
  `EXPLAIN (ANALYZE, BUFFERS)` of `ranking_rows` for 100 ids and of `ranking_top(…, 100)` on the 50,000-player event,
  median of five, before and after: at most +0.5 ms or +10%, whichever is larger, recorded in the STATE bullet.
- Not on the big screen, the top-10 push or the station: those are the organizer's displays; the level is a player's
  Questify identity. A later task can add it.

## 7. The Journey tab and screen (ADR-767, Q-724)

**Name (Dhia, Q-724, 2026-11-06).** The tab is **Journey** («رحلتي»), not "Levels" or "Rewards": inside an event the
bar's prizes action is already "Rewards" («الجوائز»), and players must never confuse Questify with an event's rewards.
Route `app/(questify)/journey.tsx`; tab icon a laurel/medal (Ionicons `ribbon` until the 3D set, ADR-013).

**Read.** `GET /v1/me/rewards` (player only; staff sessions refused as every player door; no parameters; no other
player's data) → `{level: {number, title, xp, levelFrom, nextLevelAt}, levels: [{level, xpFrom, item, owned}],
achievements: [{id, name, visualKey, tier, item, owned, earned}]}` from `own_level_rewards()` (definer, caller-bound
through `profile_player()`, `PI401` otherwise). `levels` is the whole curve (at most 100 rows); `owned` reads
`player_item`. Shared zod schema `questify/rewards.ts` (strict, so no field leaks by accident). Not cached on the phone
beyond the screen's own load (a last working copy is not needed; the profile read keeps the level).

**Screen (T-404d), brand deck style (ADR-013), Arabic first, RTL, icons over text (docs/rules.md, ADR-370):**
- **Header:** a wooden plaque with the level medallion (number in Baloo Bhaijaan 2, Western digits), the level title,
  and the parchment XP bar to the next level ("{xp} / {next} XP"), the same bar as the Profile's level card.
- **Next reward:** a gold-edged parchment card showing the next level's item as it will look (a frame on the
  player's own avatar, a title on a name plate) with a lock badge and "Level {n}".
- **The level trail:** a vertical path of stones, one per level, in reading order (top to bottom, aligned to the
  start side, mirrored in RTL). Reached levels show the item in colour with a gold check; the current one glows; later
  ones are greyed with a lock icon. Each stone's accessible label says the level, the item and its state.
- **Achievement rewards:** the achievement badge art, the tier medal (bronze, silver, gold icons), the item, and its
  state (owned, or "Reach gold in Wanderer"). Only achievements with an item appear.
- Tapping an owned item opens the locker on it (the existing equip flow); nothing else is actionable. No price, no
  currency, no "get" or "buy" word anywhere.
- States: loading skeleton, a failed read with Retry, signed out handled as every Questify tab. Reduce Motion: the
  glow does not pulse. Strings: `journey.*` in both languages through `ux-araby`.

**Level badge (T-404d):** a small shield with the number beside the name on the app's event ranking rows, the podium,
the player's own row, the own Profile header and the public profile header (Dhia, Q-724: not the big screen); label "Level {n}" / «المستوى {n}».

## 8. Store compliance (`docs/STORE_COMPLIANCE.md`)

Removing a currency and a shop lowers risk; the gate is still checked: 1.6 (Apple 3.1.1, 3.1.1(a), 3.1.3(f)): nothing
is sold, no currency exists, no purchase or price UI, no link out; 1.12/2.9: no chance, every item comes from a fixed
level or tier; 1.14: age rating unchanged; PD-05/PD-22: no purchases. Edits at build: the 1.3 review-notes paragraph
"Gems and the gem shop" becomes "Levels and items" (items are earned only by levels, achievements and organizers'
souvenirs; none can be bought, traded or gifted; they give no advantage inside an event); the 1.6 table row becomes
"Levels and achievements unlock cosmetic items | No | nothing is sold or priced, no currency, no trading, no chance";
the review demo note becomes "played to level 3, so the reviewer sees two level items" (RUNBOOK too). The level badge
shows on rankings only as a cosmetic; a test proves a completion pays the same points at level 1 and level 20.

## 9. Tests (test first)

**T-404c DB** (`test/db/levels-only-upgrade.int.test.ts`, `test/db/achievement-rewards.int.test.ts`):
- Upgrade: a database with gem balances, entries, purchases, a bought equipped frame and a shop-priced audit history
  runs 0163 and 0164: the catalog has no gem object (2.1); the bought frame is still owned and equipped with `source =
  'questify'`; balances are gone; event ledger, scores and XP are unchanged byte for byte. 0164 applied while a scan
  transaction, a sync transaction and a profile or ranking read holding `item` are each in flight completes with no
  deadlock (the gems-upgrade pattern); 0163
  applied while a scan holds `player_xp` waits and completes.
- Achievement XP: a tier pays its amount once (replay, two concurrent syncs on two connections: one entry); a
  three-tier jump pays three; a 0 amount writes nothing; amounts come from the setting, absent fields fall back; tiers
  earned before 0164 pay nothing; a level crossed by tier XP gives its level item in the same call; the XP never
  touches `ledger_entry`, `enrollment.score` or any event balance; a banned player is refused (`PI401`).
- Achievement items: given once at the mapped tier; retroactive after the mapping is set; not given while the tier is
  revoked, given after restore; an already owned item is skipped; the guard refuses an item with a level, souvenir or
  second achievement source, both ways; the composite FKs refuse another player's tier; the door refuses `item_given`
  after one grant; two syncs crossing: one row; a sync crossing `erase_player`, both orders.
- Ranking: `level` on rows, `me` and the day board; derived from XP after a curve lowering; kept for a blocked row;
  present in rank-only events; a completion's points are equal at level 1 and level 20.
- `own_level_rewards`: shape, owned flags, the caller only, `PI401` for a banned or erased caller.
- Integrity: `player_item` source CHECK rejects every mixed shape; `questify` rows only from the migration; the
  writers list of `xp_entry` (player-safety) is exact; only removal doors write negative XP.

**Security:** the outsider EXECUTE probe drops the gem doors and adds `own_level_rewards` and the internal helpers
(PUBLIC holds nothing); the cross-tenant suite lists `achievement_item` (an organizer reads none); `routes.int` drops
the gem routes, adds `/v1/me/rewards`, and asserts `GET /v1/me/gem-shop` is 404; the public profile and ranking
allowlists gain `level` only.

**Route and unit:** sync, profile, rewards, ranking display, catalog (amounts, achievements with `item`, items,
XP-table preview), shared schemas (strict rewards, locker sources). **T-404d:** app unit tests for the Journey screen
states and the trail's labels, the level badge's label and RTL, the sync toast lines; console unit and e2e for the
achievement "Unlocks" field in both languages at phone width; `npx expo export`; the bar's order test (Home, Explore,
scan, Journey, Profile).

## 10. Mutation (GitHub only, ADR-174) and reviews

- T-404c globs (core, changed files only): `apps/api/src/questify/questify.ts`, `apps/api/src/questify/rewards.ts`,
  `apps/api/src/players/items.ts`, `packages/shared/src/questify/rewards.ts`, `packages/shared/src/players/items.ts`;
  tests excluded. Most logic is SQL, covered by the DB suites.
- T-404d: none (tier B).
- Reviews: this plan, one tier A plan review. T-404c: one tier A code review on the strongest model. T-404d: one tier B
  code review with the Arabic pass.

## 11. Docs updated at build

- **DECISIONS:** ADR-760 (Accepted by Dhia, in this commit); ADR-046's status line notes its gems and shop are
  superseded (this commit); ADR-284 to ADR-293 each get a "Superseded by ADR-760" line at build.
- **FEATURES:** F-135 and F-136 marked "Removed 2026-11-06 (ADR-760)", rows kept, IDs never reused; F-131 kept; F-171
  "Shop" → "Journey"; new F-349 (achievement items) and F-350 (level beside the name on event rankings).
- **SRS:** FR-724, FR-725, FR-726 retired with a dated sentence (the FR-253 pattern) and their status rows marked
  retired; new **FR-741** (no way to buy, trade or gift items or XP; carries FR-725's item half), **FR-742**
  (achievement items), **FR-743** (the level beside the name on event rankings and profiles, never an advantage inside
  an event), **FR-744** (the Journey screen); FR-415 drops "buys in the Questify shop"; FR-421 and FR-1106 drop "gems";
  FR-830 "Shop" → "Journey" and its Given about the gem shop.
- **DATA_MODEL** (gem tables out; `achievement_item`; `player_item` sources; `xp_entry` source; `xp` setting fields),
  **API** (2.2, 6, 7), **CONFIGURABILITY** (`gems` setting out, tier XP in), **ARCHITECTURE** (ledger line),
  **SECURITY** (FR-421 line), **SCOPE** (area 7 line; "points, gems and items are never sold" → "points, XP and items"),
  **STORE_COMPLIANCE** (8), **RUNBOOK** (review demo level note), **ROADMAP**, `ux/PLAYER.md` (P22 becomes Journey),
  `ux/DASHBOARD_AND_CONSOLE.md`, `legal/terms-of-use.md` §5 (Q-725), TASKS (T-404c/T-404d, T-806 note), STATE (noting that staging app builds
  break on sync until they are rebuilt: the old app parses the sync answer's `gems`).

## 12. Proposed decisions and questions

- **ADR-760** (Accepted, Dhia 2026-11-06): no gems, no Questify shop; levels are the reward across Questify.
- **ADR-761 / Q-720** the split: T-404c (tier A) then T-404d (tier B); four tabs on `main` in between.
- **ADR-762 / Q-720** two migrations: 0163 `platform_setting` only, 0164 the rest with the up-front lock list.
- **ADR-763 / Q-722** balances vanish; bought items stay with source `questify`, shown as "A Questify reward".
- **ADR-764 / Q-721** achievement tiers pay XP 50/150/300 (data), at earn time, not retroactively.
- **ADR-765 / Q-723** achievement items: one per achievement at a chosen tier, retroactive, change refused once given;
  five gold tiers seeded with the former shop frames.
- **ADR-766 / Q-724** the derived level on event ranking rows, kept for blocked rows, not on the big screen.
- **ADR-767 / Q-724** the tab is "Journey" («رحلتي», Dhia), not "Levels" or "Rewards"; `GET /v1/me/rewards`.
- **ADR-768 / Q-725** the event currency icon `gem` and the game card stay (Dhia); the terms of use lose gems at build, with
  the version bump left to the legal pass.
