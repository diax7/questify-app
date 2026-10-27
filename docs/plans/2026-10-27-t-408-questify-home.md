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

**Plan review fold-in (88; GO at about 94 once MAJOR-1 is folded, no re-review):** MAJOR-1: a removal lands in the
month of the credit it reverses, so month rows never go negative (below). Versions only grow
(`greatest(xp_board.xp_version, EXCLUDED.xp_version)`). The timing measurement and its fallback are defined (below).
Each door is one SQL statement (one snapshot). The backfill check also asserts month rows add up to `all` and each month
equals the ledger by month. T-408b's classifier checks `inviteTokenOf` first; rehearsal codes only if a rehearsal QR
exists; FR-1614 gains a clarification line. Q-292 answered by Dhia: "Automatic monthly" (FR-1786 amended).

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
- **Month** (`'YYYY-MM'`): the sum of the XP credited in that Questify month, less the removals of those credits
  (MAJOR-1): an entry counts in the month of its own `created_at`, except a removal, which counts in the month of the
  credit it reverses (`reverses` → that credit's `created_at`). So a month row is never negative, and a past month
  changes only when one of its own credits is removed (ADR-323). Questify awards, daily games and streak milestones
  count (T-403 note). Lifetime is unaffected.
- **Tie rule (FR-606):** lower `xp_version` first: the highest entry id applied to that row
  (`greatest(xp_board.xp_version, EXCLUDED.xp_version)`, so it only grows; "reached that score first"). Unique per row,
  so the order is total and no two players share a rank.
- **Why not `ALTER TABLE player_xp ADD xp_version`:** the ALTER needs ACCESS EXCLUSIVE on `player_xp`, which conflicts
  with the row locks the daily finish and `questify_sync` hold on `player_xp` before they insert into `xp_entry`; any
  lock order the migration picks can then deadlock with one live path. A new table needs only SHARE ROW EXCLUSIVE on
  `player_xp` (for its key), which never conflicts with `FOR UPDATE` row locks (the 0069 pattern).
- **Why not Redis:** the event ranking's Redis copy exists for 50,000 players scanning in one hour (ADR-118). The
  Questify-wide board changes per player at the pace of their XP and is read on Home and Explore; PostgreSQL answers
  the top 10 from the index and the reader's place by counting the rows above it (O(rank)). **Timing (review item 3):**
  a scratch script seeds 100,000 ranked players on both boards, runs `ANALYZE`, then calls the door as the last-placed
  reader 200 times per board and records p95 and the machine (Dhia's PC, Docker Postgres 17) in ADR-322. The gate is
  50 ms p95 at 100,000 players. Over it, the first fallback (before any Redis copy) is an index-only count of the rows
  ahead minus the inactive players ahead, with a partial index on `player (id) WHERE status <> 'active'`; Redis is a
  later task only if that also fails (Q-291). The response has **no `total`**: counting every ranked player per read is the one O(N) step, and
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
   FROM xp_entry e LEFT JOIN xp_entry c ON c.id = e.reverses,
        LATERAL (VALUES ('all'), (questify_month(coalesce(c.created_at, e.created_at)))) b(board)
   WHERE e.id = made
   ON CONFLICT (board, player_id) DO UPDATE
     SET xp = xp_board.xp + EXCLUDED.xp,
         xp_version = greatest(xp_board.xp_version, EXCLUDED.xp_version);
   ```
   The month comes from the entries' own `created_at` (the credit's for a removal), not `now()`, so the board always
   equals the ledger grouped by `xp_month_of(entry)` (and tests can place entries either side of a month edge). A
   missing entry raises (a broken caller).
4. Backfill under the locks: one `'all'` row per player with entries (`sum(delta)`, `max(id)`), one month row per
   (`xp_month_of` month, player), the same rule as `xp_apply`. Then a check that raises (aborting the migration) if any
   `'all'` row differs from `player_xp.xp`, any player with `xp > 0` lacks one, a player's month rows do not add up to
   their `'all'` row, or a month row differs from the ledger grouped by month; and no month row is negative.
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
   Each door is one SQL statement (`LANGUAGE sql STABLE`), so its rows and `me` come from one snapshot (review item 4).
6. Internal (no grant): `questify_month`, `xp_month_of(entry id)` (the board month of an entry: the reversed credit's
   for a removal), and `xp_board_json(board, who)` (the rows and `me`, one rule written once).

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
before a sync that commits first applies later with a lower id; `greatest` keeps the higher id, so a row's version is
always the highest entry id on it, which tests can check exactly.

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
4. Zero and removals: no XP → `me` null; a removal this month of last month's credit → last month's row loses it (its
   version grows), this month's row is unchanged, lifetime reduced, no month row is ever negative.
5. Month edge: entries at 03:59 and 04:00 Riyadh time on the 1st land in the previous and the new month; a 01:00
   daily play counts in its Questify day's month.
6. Every writer keeps the boards equal to the ledger (`'all'` = `player_xp.xp` = `sum(delta)`; each month =
   `sum(delta)` grouped by `xp_month_of`; versions = the highest entry id on the row): event scan, operator scan, team
   award, removal, Questify award via sync, streak milestone, daily challenge and word finishes. Rehearsal pays nothing
   and writes no board row.
7. Races: two scans in two events for one player crossing; a sync crossing a scan; a daily finish crossing a scan;
   erasure crossing a credit (both orders): no deadlock, boards equal the ledger after.
8. Doors: no player-id parameter; a staff or anonymous context gets `PI401`; output keys are exactly the listed ones
   (no id, contact, gems); `scope` other than the two raises `22023`; size fixed at 10.
9. Admin doors: a player context and no context raise `QY403`; the seasons list counts ranked players per month; a
   past month's top 10 is unchanged after new entries, and changes only when one of its own credits is removed; a
   malformed month raises `22023`.

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
- **Center button (FR-831, FR-1614, ADR-324):** `/join-scan`, the shared `Camera` permission card. The new classifier
  checks `inviteTokenOf` first (an operator invite → its invite screen; that is how staff join an event), then
  `readScan` (the event scanner's classifier): a join link → `/join/[code]` (`via: qr`); a rehearsal code only if a
  rehearsal QR exists (the build checks; today it is typed); a quest, screen, step, hidden-category or meet code → "Open the
  event first to scan quest codes"; anything else → "This is not an event join code". Pure classifier in
  `src/join/join-scan.ts` with unit tests. SRS FR-1614 carries a clarification line on operator invites (done with the
  T-408 plan fold-in).
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
a month's top 10 (username, avatar, XP, level). No reset button: seasons turn over by themselves (Q-292). Strings in both languages; a console unit test and
`e2e/console-seasons.spec.ts` (desktop and phone, Arabic and English).

## Proposed decisions and questions

- **ADR-321** The split above (core server T-408, app T-408b, console T-408c). Q-291.
- **ADR-322** The Questify-wide boards: `xp_board` (`'all'` and Questify months) kept by `xp_apply` under the
  `player_xp` row lock, a removal in its credit's month; read from PostgreSQL, timed (p95 at 100,000 players, gate
  50 ms; index-only fallback before any Redis copy); tie by the highest entry id on the row; eligible = active player with XP above 0 on that board; no `total`; the `questifyRanking` platform switch.
  Q-291.
- **ADR-323** Seasons (FR-1786) are Questify months: the month changes at 04:00 Riyadh time on the 1st (the Questify
  day's edge), the new board starts empty by its key with no job, and every past month's board stays as its archive
  (read with today's rule, so a player banned or deleted later drops out of it); a past board changes only when one of
  its own credits is removed. Lifetime XP and levels are never touched. The console shows each season's top 10. No
  admin reset, schedule, season length or season prizes. Q-292 answered by Dhia 2026-10-27: "Automatic monthly"
  (FR-1786 amended).
- **ADR-324** The Questify home center button opens operator invites (checked first) and join links (rehearsal codes
  only if a rehearsal QR exists); quest-type
  codes say to open the event first; anything else is "not an event join code". Q-293.

## Docs touched

TASKS (T-408 split into T-408, T-408b, T-408c; T-705 note: the block filter on `questify_ranking`), DECISIONS, OPEN_QUESTIONS,
DATA_MODEL, API, SRS status rows, CONFIGURABILITY (the `questifyRanking` switch), STATE.
