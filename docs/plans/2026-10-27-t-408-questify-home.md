# T-408 — Questify home, Explore and the Questify-wide ranking

Delivers FR-611, FR-612, FR-830, FR-831, FR-832, FR-833, FR-1614 and FR-1786. Depends on T-401 (XP, migration 0039),
T-403b/T-404/T-405/T-406 (the other XP writers), T-404b (gem shop screen), T-406b (daily cards), T-407b (For you).
Choices are **Proposed ADR-321 to ADR-324 / Q-291 to Q-293**. Never push, deploy, run EAS or run local mutation testing.

## Split (ADR-321)

| Task | Bar | What |
|---|---|---|
| **T-408** | **CORE** | Migration 0072 (the ranking boards kept by `xp_apply`, their index, the backfill, the read doors), `GET /v1/questify/ranking`, the two admin season reads, shared schemas, the `questifyRanking` platform switch. It reads and restates the XP payer's path. |
| **T-408b** | Standard (app) | The bottom bar outside events, Questify Home (events grouped, daily cards, streak line, Questify quests), Explore (public events, For you, the ranking), the join-QR scanner on the center button. |
| **T-408c** | Standard (web) | The console's Seasons page: each Questify month with its ranked count and its top 10. |

T-408 is planned in full below; T-408b and T-408c get a short section each and a code review only.

---

## T-408 (CORE)

### The shape (ADR-322)

One cache table holds both boards, kept by `xp_apply` in the same transaction as every XP entry:

```
xp_board(board text, player_id uuid → player_xp, xp bigint, xp_version bigint, PRIMARY KEY (board, player_id))
  board: 'all' (lifetime) or 'YYYY-MM' (a Questify month); CHECK board ~ '^(all|[0-9]{4}-(0[1-9]|1[0-2]))$'
  index xp_board_rank_idx (board, xp DESC, xp_version) WHERE xp > 0
```

- **Lifetime** (`'all'`): `xp` equals `player_xp.xp` (a DB test and the migration's own check assert it); it is
  duplicated here so one index orders it with its tie version. `xp ≥ 0` always.
- **Month** (`'YYYY-MM'`): the sum of `xp_entry.delta` whose `created_at` falls in that Questify month (T-401 note:
  reversals included). A removal in November of an October credit lands in November, so a month row may be negative;
  October never changes after it ends (ADR-323). Questify awards, daily games and streak milestones count (T-403 note).
- **Tie rule (FR-606):** lower `xp_version` first: the id of the XP entry applied last to that row ("reached that score
  first"). Unique per row, so the order is total and no two players share a rank.
- **Why not `ALTER TABLE player_xp ADD xp_version`:** the ALTER needs ACCESS EXCLUSIVE on `player_xp`, which conflicts
  with the row locks the daily finish and `questify_sync` hold on `player_xp` before they insert into `xp_entry`; any
  lock order the migration picks can then deadlock with one live path. A new table needs only SHARE ROW EXCLUSIVE on
  `player_xp` (for its key), which never conflicts with `FOR UPDATE` row locks (the 0069 pattern).
- **Why not Redis:** the event ranking's Redis copy exists for 50,000 players scanning in one hour (ADR-118). The
  Questify-wide board changes per player at the pace of their XP and is read on Home and Explore; PostgreSQL answers
  the top 10 from the index and the reader's place by counting the rows above it (O(rank)). The build times both on a
  seeded 100,000-player board and records the numbers in ADR-322; a Redis copy is a later task if that read passes
  50 ms (Q-291). The response has **no `total`**: counting every ranked player per read is the one O(N) step, and
  FR-611 does not ask for it.
- **Eligible (ADR-322):** `player.status = 'active'` (deleted tombstones and banned players are never shown and never
  push anyone down) and `xp > 0` on that board. No hide option (FR-605). Gems never appear (T-404 note). The viewer
  block filter is T-705's (FR-1415; its TASKS note gains this door).

### Migration 0072 (new file; 0071 and earlier untouched)

```sql
SET LOCAL lock_timeout = '10s';
-- Live-path order (0069): every path that writes XP inserts into xp_entry, so holding it ACCESS EXCLUSIVE stops all
-- XP changes; player_xp only SHARE ROW EXCLUSIVE (for the new key), which no FOR UPDATE row lock conflicts with. Never
-- player, ledger_entry, enrollment or platform_setting.
LOCK TABLE xp_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player_xp IN SHARE ROW EXCLUSIVE MODE;
```

1. `questify_month(at timestamptz) RETURNS text` = `to_char(questify_day(at), 'YYYY-MM')` (internal; ADR-323: the
   month changes at 04:00 Riyadh time on the 1st, the Questify day's edge, so a 01:00 daily play counts in the month
   of its Questify day).
2. `xp_board` as above: RLS forced, no policy, REVOKE ALL FROM PUBLIC, no grant. Written only by `xp_apply` and the
   backfill. Not append-only (a cache, like `player_xp`); kept on the tombstone (no personal data; ADR-175 gains a row).
3. `xp_apply(who, made, delta)` restated: 0039's body unchanged, then, while the `player_xp` row lock it just took is
   held:
   ```sql
   INSERT INTO xp_board (board, player_id, xp, xp_version)
   SELECT b.board, who, delta, made
   FROM xp_entry e, LATERAL (VALUES ('all'), (questify_month(e.created_at))) b(board)
   WHERE e.id = made
   ON CONFLICT (board, player_id) DO UPDATE
     SET xp = xp_board.xp + EXCLUDED.xp, xp_version = EXCLUDED.xp_version;
   ```
   The month comes from the entry's own `created_at`, not `now()`, so the board always equals the ledger grouped by
   month (and tests can place entries either side of a month edge). A missing entry raises (a broken caller).
4. Backfill under the locks: one `'all'` row per player with entries (`sum(delta)`, `max(id)`), one month row per
   (Questify month, player). Then a check that raises (aborting the migration) if any `'all'` row differs from
   `player_xp.xp` or any player with `xp > 0` lacks one.
5. Doors (SECURITY DEFINER, REVOKE FROM PUBLIC in the same group, granted to `questify_app` only):
   - `questify_ranking(scope text) RETURNS jsonb`: the caller is `profile_player()`; NULL raises `PI401` (as the sync).
     `scope` `lifetime` → `'all'`, `month` → `questify_month(now())`; anything else raises `22023`. Answers
     `{board, rows: [{rank, username, avatar, equipment, xp, level, isMe}] (top 10 eligible), me: {rank, username,
     avatar, equipment, xp, level} | null}`; `me` is null when the caller has no eligible row; `rank` = 1 + eligible
     rows ahead. `level` is the lifetime level from `player_xp`; `equipment` as `ranking_top` builds it (0063). Never a
     player id, contact, birth year or gems.
   - `questify_seasons() RETURNS jsonb` (admin, `questify_admin()`): every month board, newest first, with its ranked
     count and whether it is the current one.
   - `questify_season_top(month text) RETURNS jsonb` (admin): that month's top 10 by the same rule and its ranked count;
     a malformed month raises `22023`, an unknown one answers an empty list. Only the top 10, which players saw too;
     ranks below 10 stay visible only to their own player (ADR-052), so no audit line is needed.
6. Internal (no grant): `questify_month`, `xp_board_rows(board, size)` and `xp_board_place(board, who)` if the doors
   need a shared body (one rule written once).

### Lock order

| Path | Order | Board |
|---|---|---|
| Scan / removal (`ledger_xp`) | enrollment → `xp_entry` insert → `player_xp` UPDATE → `xp_board` upsert | last |
| `questify_sync` (awards, milestones) | `xp_entry` read → `player` KEY SHARE → `player_xp` FOR UPDATE → `xp_entry` → `xp_apply` → board | last |
| Daily finish | streak row → `player_xp` FOR UPDATE → `xp_entry` → `xp_apply` → board | last |
| Erasure | `player` FOR UPDATE → `player_xp` FOR UPDATE; never touches `xp_board` | none |
| Reads | no locks (READ COMMITTED, one statement per door, so rows and `me` come from one snapshot) | |

A player's board rows are only written while that player's `player_xp` row lock is held, so two writers for one player
serialize before the board, and no cycle can pass through `xp_board`. Version note: a scan that inserted its entry
before a sync that commits first applies later with a lower id; the row keeps the id of the entry applied last. The
order stays total; the tie then follows apply order within that one player's row only.

Migration vs live traffic: in-flight XP writers hold `xp_entry` ROW EXCLUSIVE and finish first; a daily finish or sync
already holding a `player_xp` row lock waits on `xp_entry` behind the migration, which does not wait on it (SHARE ROW
EXCLUSIVE vs ROW SHARE); after the commit it runs the new `xp_apply` and its entry lands on the board. Sign-ups insert
`player_xp` (ROW EXCLUSIVE) without touching `xp_entry` and finish before the migration takes `player_xp`.

### API and shared

- `packages/shared/src/questify/ranking.ts`: `questifyRankingScopeSchema` (`lifetime | month`), the row, `me` and
  response schemas, and the admin `questifySeasonsSchema` / `questifySeasonSchema`; `month` as `^\d{4}-(0[1-9]|1[0-2])$`.
- `FEATURES.questifyRanking: { gated: false, level: "platform" }` (on unless turned off): off, the route answers 404
  `ranking_off` and the app hides the ranking; the boards keep being written, so turning it back on is exact.
- `apps/api/src/questify/ranking.ts` (calls the door; `PI401` → 401; maps the jsonb through the shared schema) and
  `GET /v1/questify/ranking?scope=lifetime|month` (default `lifetime`; access `player`; `no-store`) in
  `src/questify/routes.ts`. 400 on another scope.
- `GET /v1/admin/questify/seasons` and `GET /v1/admin/questify/seasons/:month` in `src/questify/admin-routes.ts`
  (read access, as `GET /v1/admin/questify`); `QY403` → 403; 400 on a malformed month.
- API.md rows, DATA_MODEL (`xp_board`; `ranking_season` in the baseline table becomes "built as `xp_board` month
  boards"), SRS status rows.

### Tests (test first)

DB, new `test/db/questify-ranking.int.test.ts`:
1. Order: higher XP first; equal XP → the lower `xp_version` first; FR-611's case: 125 players, the reader 120th sees
   10 rows and `me.rank = 120`.
2. Reference check: 300 seeded players with random XP and versions, some banned, some deleted: every player's
   `me.rank` and the top 10 equal `row_number() OVER (ORDER BY xp DESC, xp_version)` over eligible rows, both scopes.
3. Banned and deleted players: absent from rows, never counted ahead of anyone, their own call raises `PI401`; a
   deleted player's board rows stay.
4. Zero and negative: no XP → `me` null; a removal this month of last month's credit → this month's row negative and
   unranked, last month's board unchanged, lifetime reduced.
5. Month edge: entries at 03:59 and 04:00 Riyadh time on the 1st land in the previous and the new month; a 01:00
   daily play counts in its Questify day's month.
6. Every writer keeps the boards equal to the ledger (`'all'` = `player_xp.xp` = `sum(delta)`; each month =
   `sum(delta)` grouped by `questify_month(created_at)`; versions = last applied id): event scan, operator scan, team
   award, removal, Questify award via sync, streak milestone, daily challenge and word finishes. Rehearsal pays nothing
   and writes no board row.
7. Races: two scans in two events for one player crossing; a sync crossing a scan; a daily finish crossing a scan;
   erasure crossing a credit (both orders): no deadlock, boards equal the ledger after.
8. Doors: no player-id parameter; a staff or anonymous context gets `PI401`; output keys are exactly the listed ones
   (no id, contact, gems); `scope` other than the two raises `22023`; size fixed at 10.
9. Admin doors: a player context and no context raise `QY403`; the seasons list counts ranked players per month; a
   past month's top 10 is unchanged after new entries and a later removal; a malformed month raises `22023`.

Upgrade, new `test/db/questify-ranking-upgrade.int.test.ts` (the `daily-upgrade` pattern): a database at 0071 with
veterans across two months (scans, a removal, a Questify award, a daily finish) → after 0072 the boards equal the
ledger; the migration's first statements lock exactly `xp_entry` ACCESS EXCLUSIVE and `player_xp` SHARE ROW EXCLUSIVE;
a scan in flight blocks the migration until it commits; a daily finish holding its `player_xp` row lock while the
migration runs completes after it and its entry is on the board; the backfill check aborts on a tampered `player_xp`.

Security: outsider suite (`xp_board` has no grant; the three doors and `questify_month` closed to PUBLIC and anon; the
two admin doors refuse a player), cross-tenant lists, route inventory (`/v1/questify/ranking` player,
`/v1/admin/questify/seasons*` admin), the rehearsal list guard, the community gate map.

Unit and route: shared schemas (scopes, month pattern, a row with an extra key refused); `ranking.test.ts` (`PI401` →
401, mapping); routes (default scope, 400 bad scope, 404 `ranking_off` when the switch is off, 401 signed out,
`no-store`); admin routes (403, 400 month, shape).

Mutation (GitHub, core only): `apps/api/src/questify/ranking.ts`, the ranking parts of `apps/api/src/questify/routes.ts`
and `apps/api/src/questify/admin-routes.ts`, `packages/shared/src/questify/ranking.ts`.

---

## T-408b (standard, app)

- **Bar (FR-830):** a tab group `app/(questify)/_layout.tsx`: Home, Explore, the center button, Shop, Profile, the
  event bar's style and fixed left-to-right order (ADR-110 note, Q-100). `home.tsx`, `profile.tsx` and `gem-shop.tsx`
  move into the group (paths unchanged, so deep links and `router.replace("/home")` keep working); `explore.tsx` is new.
  Shop opens the gem shop (T-404b), never an event's shop.
- **Center button (FR-831, FR-1614, ADR-324):** `/join-scan`, the shared `Camera` permission card. `readScan` (event
  scanner's classifier) decides: a join link or a rehearsal code → `/join/[code]` (`via: qr`); an operator invite →
  its invite screen (that is how staff join an event); a quest, screen, step, hidden-category or meet code → "Open the
  event first to scan quest codes"; anything else → "This is not an event join code". Pure classifier in
  `src/join/join-scan.ts` with unit tests.
- **Home (FR-832):** the player's events from `GET /v1/me/events` grouped Live (`statusNow = live`), Upcoming
  (`scheduled`, soonest first) and Past (ended or archived, newest first), pending and declined rows with their note;
  tapping opens the event. The two daily cards from `GET /v1/me/daily` (moved off the Profile; each hidden when null),
  the streak line from `GET /v1/me` `dailyStreak` (hidden when null), a Questify quests card to `/questify-quests`.
  The typed join code stays (accessibility), the For you button goes (now in Explore), the marketing step still shows
  here. Signed out: sign-in, the code entry and the public events as today.
- **Explore (FR-833, FR-611, FR-612):** the public events list (moved from Home; tapping opens the join card), the For
  you section (T-407b's list; signed in), the Questify-wide ranking with Lifetime / This month tabs in the event
  ranking's 11-row layout (`src/event/ranking.ts`), hidden when `questifyRanking` is off; signed out, a sign-in
  prompt in place of For you and the ranking. No event screen imports the Questify ranking (FR-612; a unit test reads
  the event route files).
- Every string in Arabic and English (`ux-araby`), RTL checked, Western digits. Tests: classifier, grouping, ranking
  API client, Hermes guard, `npx expo export`. Phone check owed.

## T-408c (standard, console)

`/console/seasons` (platform admins): the months newest first with their ranked count and the current one marked, and
a month's top 10 (username, avatar, XP, level). Strings in both languages; a console unit test and
`e2e/console-seasons.spec.ts` (desktop and phone, Arabic and English).

## Proposed decisions and questions

- **ADR-321** The split above (core server T-408, app T-408b, console T-408c). Q-291.
- **ADR-322** The Questify-wide boards: `xp_board` (`'all'` and Questify months) kept by `xp_apply` under the
  `player_xp` row lock; read from PostgreSQL, no Redis copy until the timed read passes 50 ms; tie by the entry applied
  last; eligible = active player with XP above 0 on that board; no `total`; the `questifyRanking` platform switch.
  Q-291.
- **ADR-323** Seasons (FR-1786) are Questify months: the month changes at 04:00 Riyadh time on the 1st (the Questify
  day's edge), the new board starts empty by its key with no job, and every past month's board stays as its archive
  (read with today's rule, so a player banned or deleted later drops out of it). Lifetime XP and levels are never
  touched. The console shows each season's top 10. No admin-set schedule, season length or season prizes in v1. Q-292
  (for Dhia: product; FR-611 says "calendar month", read here as the Questify month).
- **ADR-324** The Questify home center button opens join links and rehearsal codes, and operator invites; quest-type
  codes say to open the event first; anything else is "not an event join code". Q-293.

## Docs touched

TASKS (T-408 split into T-408, T-408b, T-408c; T-705 note: the block filter on `questify_ranking`), DECISIONS, OPEN_QUESTIONS,
DATA_MODEL, API, SRS status rows, CONFIGURABILITY (the `questifyRanking` switch), STATE.
