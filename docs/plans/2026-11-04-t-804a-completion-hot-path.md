# T-804a - Completion hot path: plan caching and fewer round trips (plan, tier A, ledger)

Follows T-804's first load run (ADR-660, Q-620; branch `worktree-agent-ac5958d377abcae1a`): about 80 completions a
second for ten events on the dev PC against NFR-003 x NFR-025's 3,333, PostgreSQL CPU the limit. This plan measures
the path first, then changes how the database runs it, not what it decides. Decisions: ADR-670 to ADR-674 (Proposed);
questions Q-630 to Q-634. T-804b (Q-621, the sign-in rush) is outlined in section 8.

## 0. After the plan review (2026-11-04, score 82): built in two parts

The review's findings are folded into the sections below. **Part A (section 2 A, the plpgsql conversion) is built in
T-804a now. Parts B to D (the merged door, the guard merge, the Redis script) become task T-804c**, planned here with
the review's fixes and built later, after part A's numbers are in. Dhia answered Q-631 ("size to real bookings"): the
launch target is the biggest event day actually booked, not 3,333 a second; the code is made fast now and the hardware
scaled when bookings need it (section 5). Q-630 (what CranL offers) waits for T-811.

What the review changed:
- **Part A, every rewritten body is run (MAJOR).** plpgsql checks a body only when it runs, so the parity test calls
  every rewritten function directly at least once and asserts the list it called equals the attribute fixture's list
  (section 3).
- **Part A, the generic-plan check is real (MAJOR).** `EXPLAIN (GENERIC_PLAN)` runs on the analysed T-804 seed with one
  skewed event (50,000 players among the 2,500-player ones; `--big-event-players`), and each hot statement's mean
  execution time from `pg_stat_statements` under the plpgsql plan cache (`auto`, and forced generic) is compared with
  the custom-plan baseline (section 5).
- **Part A, only measured functions (MINOR).** The function list is the profile's: the `LANGUAGE sql` functions that
  `pg_stat_user_functions` shows called on the path (so not inlined). Functions named in section 2 A but not called are
  listed as not converted, with the reason (section 2 A's table in the migration's header).
- **Part A, the gate (MINOR).** Part A is done on: attribute and call parity green on PostgreSQL 17 and once on 16.15 (a
  throw-away container; Q-632), the sequential database time a completion at or under 14 ms, and the load rerun
  reported as the median of two runs. A miss means the list is incomplete or a generic plan is slow: re-profile before
  T-804c, not a reason to start B to D early.
- **Part A, the rollback (NIT).** The attribute fixture keeps each function's original `CREATE` statement, so a rollback
  migration is generated from it, never typed by hand.
- **T-804c, the ranking never fails a completion (MAJOR, section 2 B).** Inside `complete_quest_answer` the two ranking
  reads run in their own `BEGIN ... EXCEPTION WHEN OTHERS` block that returns NULL entries and `ranking_failed = true`;
  the API then logs, marks the event for repair and answers `rank: null`, as `afterCompletion` does today
  (`ranking.ts` 310 to 337). (The alternative, the ranking reads kept outside the door, costs two round trips back.) A
  test forces a ranking error (a broken `ranking_entry_of` swapped in inside the test's transaction) and checks the
  completion still commits with its points. The door is `VOLATILE`.
- **T-804c, the guard merge (MINOR, section 2 C).** `player_request_gate` calls `player_session_owner` and
  `player_legal_held` (no copied logic), is revoked from PUBLIC by name and granted to `questify_app` only, and is tested
  with a banned player, a reset session and an expired token.
- **T-804c, the Redis script (MINOR, section 2 D).** node-redis `defineScript` (it runs `EVALSHA` and falls back on
  `NOSCRIPT`); `WRITE_READ` declares the union of the keys both halves touch; the rebuild-then-read path on a missing
  board stays as it is.

## 1. What was measured (2026-11-04, before any change)

**Set-up.** Dev PC (Ryzen 7 1700, 8 cores / 16 threads, 48 GB, Windows 10, Docker Desktop). The T-804 seed
(`apps/api/test/load/prepare.ts`: 10 live events x 2,500 players x 20 scan quests, sessions from
`issue_player_tokens`) and the T-804 load API (`apps/api/test/load/server.ts`, production pool of 10, ticks on, SMS and
push stubbed), on two throw-away containers made for this plan: `postgres:17-alpine` (17.11, the image the tests and CI
use) and `postgres:16.15-alpine` (CranL staging's version), each with `shared_preload_libraries=pg_stat_statements`,
`pg_stat_statements.track=all`, `track_planning=on`, `track_functions=all`, default `shared_buffers`. Both containers,
their databases and the runs' Redis keys were removed afterwards. The profiling scripts were scratch files (not
committed): one in flight at a time (2,000 QR completions after 300 of warm-up, then `pg_stat_statements` and
`pg_stat_user_functions` read), and a wrapper that runs T-804's own `ops/load/driver.mjs` against API processes
already running. Both runs pay the statistics' own overhead, so before and after are compared like for like.

**Round trips.** A trivial `SELECT 1` from Node to the Docker PostgreSQL took 0.93 ms; a Redis `PING` 0.88 ms (Docker
Desktop's network). One QR completion (`POST /v1/quests/:id/complete`) makes:

| Step | Where | PostgreSQL round trips | Redis |
| --- | --- | --- | --- |
| Player guard | `players/guard.ts`: `player_session_owner`, `player_legal_held` (two pool queries) | 2 | |
| Engine transaction | `completions/complete.ts` `callEngine`: `BEGIN`, `set_config`, `complete_quest`, `own_level` (+ `own_level_items` on a level-up), `own_bonus`, `own_quest_item`, `completion_boost`, `own_first_bonus`, `own_streak_bonus`, `COMMIT` | 10 (11) | |
| Ranking | `ranking/ranking.ts` `afterCompletion`: a transaction around `ranking_entry_of`, then `store.upsert` and `store.read` (two `EVAL` with the script text), then a transaction around `ranking_day_entry_of` (+ a day-board `EVAL` on a multi-day event) | 8 | 2 (3) |
| **Total** | three pool check-outs | **20 (21)** | **2 (3)** |

A typed code or a check-in adds the `reserve` and `release` transactions (`auth_throttle`); a QR does not.

**Per-call cost, idle server, one completion at a time (PostgreSQL 17.11).** Client latency mean 72.1 ms (p50 66.9,
p95 96.6). Server time of the top-level statements: **36.1 ms a completion**.

| Top-level statement | ms a call | of which planning inside |
| --- | --- | --- |
| `complete_quest` (plpgsql; calls `record_completion` and the ledger triggers) | 14.95 | the `LANGUAGE sql` callees: `period_count` 1.29, `quest_community_lock`, `category_lock`, `boost_in_force`, `quest_boost`, `play_phase` 0.77, `event_suspended` 0.67, `levels_reach` 0.58, `xp_month_of`, `platform_tuning_int`, `reviewer_paid`, `system_paid`, `excluded_from_event`, `organizer_team_players`, `xp_level_of`, `category_period_start`, `level_title_of`, ... |
| `ranking_day_entry_of` (sql, definer) | 4.97 | its query: plan 1.72 + exec 2.62, planned 2,000 times in 2,000 calls |
| `own_bonus` (sql, definer) | 3.18 | **plan 2.59, exec 0.01** |
| `ranking_entry_of` (sql, definer) | 2.70 | plan 0.89 + `ranking_eligible` x 2.75 |
| `own_level` (sql, definer) | 2.69 | plan 1.17 |
| `own_quest_item` (sql, definer) | 1.95 | plan 1.43, exec 0.09 |
| `own_first_bonus` (sql, definer) | 1.59 | plan 1.17, exec 0.07 |
| `own_streak_bonus` (sql, definer) | 1.01 | plan 0.71 |
| `completion_boost` (sql, definer) | 0.98 | plan 0.77, exec 0.02 |
| `player_session_owner` (sql, definer) | 0.78 | plan 0.53 |
| `player_legal_held` (sql, definer) | 0.78 | plan 0.32 + `legal_in_force_rows` |

The pattern is the one Q-620 named: every statement inside a `LANGUAGE sql` function that has `SECURITY DEFINER` or a
`SET` clause (so it cannot be inlined) is planned on **every** call (`pg_stat_statements.plans` = calls = 2,000),
while statements inside plpgsql functions were planned 2 to 13 times in 2,000 calls (the plan is cached per
connection). 63 `LANGUAGE sql` functions run on this path (19 definer with `SET`, 41 with `SET` only, 3 with neither);
the schema has 494 `LANGUAGE sql` (141 definer) and 805 plpgsql functions.

**Prototype (throw-away database only).** Every called single-statement `LANGUAGE sql` function was rewritten
mechanically as plpgsql with the same signature, attributes, owner and grants (`RETURN QUERY` for sets, `RETURN (...)`
for scalars, `#variable_conflict use_column`), 50 functions plus `levels_reach` by hand (its data-modifying `WITH` needs
`SELECT ... INTO`). Functions with a standard (`BEGIN ATOMIC`) body (`event_day`, `event_multi_day`,
`questify_day`, `questify_month`, `streak_day_closed`, `event_day_start`) and those returning a composite (`boost_in_force`,
`quest_boost`, `flag_tuning`) were left as they were.

| Sequential, 2,000 completions | PG 17.11 before | PG 17.11 after | PG 16.15 before | PG 16.15 after |
| --- | --- | --- | --- | --- |
| Server time a completion (top-level statements) | 36.1 ms | **12.4 ms** | 34.1 ms | **13.6 ms** |
| Client latency mean (p95) | 72.1 (96.6) ms | 39.4 (50.8) ms | 66.2 (82.4) ms | 43.4 (56.7) ms |
| `complete_quest` | 14.95 ms | 7.83 ms | 14.00 ms | 8.53 ms |
| `own_bonus` | 3.18 ms | 0.21 ms | 3.04 ms | below 0.6 |

After the prototype the client's 39 ms is mostly round trips: about 20 PostgreSQL and 2 Redis at about 1 ms each, plus
the API's own work.

**Under load (PostgreSQL 17.11 container, open schedule, 60 s after 10 s warm-up, pool 10 per API process).**

| Run | Confirmed/s | p50 / p95 | within 1 s | PostgreSQL CPU | API CPU |
| --- | --- | --- | --- | --- | --- |
| Before, 80/s, 2 APIs | 80 | 100 / 238 ms | 100% | 6.8 cores | 0.27 + 0.29 |
| Before, 160/s, 2 APIs | 61 | 15 s (timeouts) | 0% | 10.1 cores | 0.39 + 0.40 |
| After, 160/s, 1 API | 160 | 2.7 / 3.4 s | 0% | 4.8 cores | one process at its limit |
| After, 160/s, 2 APIs (second run) | 160 | 64 / 207 ms | 100% | 5.1 cores | 0.45 + 0.53 |
| After, 200/s, 3 APIs | 200 | 118 / 1,000 ms | 95.0% | 8.0 cores | 0.41 + 0.51 + 0.43 |
| After, 240/s, 3 APIs | 221 | 0.8 / 15 s | 52.5% | 8.4 cores | 0.43 + 0.54 + 0.43 |

The 80/s run matches T-804's (p95 245 ms, 6 to 7 cores), so the containers compare. The first 160/s run on two APIs
gave p95 1.9 s (83%) with a freshly started second process; the second gave p95 207 ms. Wait events sampled every
100 ms at 160/s after: on average 4.0 backends on CPU, 3.8 idle in transaction waiting for the API's next statement
(`ClientRead`), 0.05 on lock-manager waits: no row-lock or multixact contention; the cost is CPU and round trips.
Database CPU per completion: before about 85 ms (6.8 cores / 80), after about 32 to 40 ms (5.1 / 160 to 8.0 / 200,
on a PC whose 16 threads the APIs and drivers share). One API process tops out near 130 to 150 completions a second
(about 6 to 7 ms of Node CPU each).

**PG16 and 17.** Same behaviour and the same gain (above). All 147 migrations ran cleanly on 16.15 from an empty
database (staging has run up to 0117; 0118 to 0147 had only run on 17 until now). PostgreSQL 18 caches SQL-function
plans itself (T-804 measured about 45% less database CPU there); the plpgsql rewrite is right on 16, 17 and 18.

## 2. The changes

**(A) The completion path's `LANGUAGE sql` functions become plpgsql (ADR-670).** One new migration (the next free
number; 0148 today) restates, with `CREATE OR REPLACE` and the same signature, every non-inlinable SQL function the
completion path and the player guard call: `player_session_owner`, `player_legal_held`, `legal_in_force_rows`,
`legal_version_key`, `own_level`, `own_bonus`, `own_quest_item`, `completion_boost`, `own_first_bonus`,
`own_streak_bonus`, `ranking_entry_of`, `ranking_day_entry_of`, `ranking_system`, `ranking_on`, `period_count`,
`category_period_start`, `category_lock`, `category_community_lock`, `quest_community_lock`, `play_phase`,
`event_suspended`, `levels_reach`, `xp_level_of`, `xp_month_of`, `level_title_of`, `quest_xp`, `reviewer_paid`,
`system_paid`, `platform_tuning_int`, `platform_feature_on`, `feature_enabled`, `daily_streak_on`,
`is_review_demo_player`, `boost_in_force`, `quest_boost`, `flag_tuning`, and, unless the inlining test below shows they
are inlined where they are called, `ranking_eligible`, `excluded_from_event`, `organizer_team_players`. The build
starts by re-running the profile and takes the list from `pg_stat_user_functions` (calls on the path, `lanname = 'sql'`,
not inlined), so a function added since this plan is not missed.

Why behaviour stays identical, rule by rule:
- **Same object.** `CREATE OR REPLACE` with the same argument types keeps the function's OID, owner, ACL (the
  `REVOKE ... FROM PUBLIC` and `GRANT ... TO questify_app` of its first migration), comments and dependants. The
  statement restates `SECURITY DEFINER`, `SET search_path = public, pg_temp`, volatility (`STABLE` stays `STABLE`, so
  the function still reads the caller's snapshot), `STRICT`, `PARALLEL` and return type word for word; only `LANGUAGE`
  and the body change. A test compares these attributes before and after (section 3).
- **Name resolution.** Each body starts with `#variable_conflict use_column`: where an argument and a column share a
  name, the column wins, as it does in a SQL function (plpgsql's default is an error).
- **Scalars.** `SELECT <expr> INTO result FROM ...; RETURN result;`, never `RETURN (subquery)`: a SQL function returns
  the first row and NULL on none; `RETURN (subquery)` would raise on two rows. `SELECT INTO` without `STRICT` keeps the
  first-row rule and NULL.
- **Sets.** `RETURN QUERY <the same query>` (no row is the same empty set).
- **Composites** (`boost_in_force`, `quest_boost`, `flag_tuning`): `SELECT ... INTO r; IF NOT FOUND THEN RETURN NULL;
  END IF; RETURN r;`, so "no boost" stays a NULL row, not a row of NULLs.
- **Writes** (`levels_reach`): the data-modifying `WITH` stays one statement, ending `SELECT ... INTO result`.
- **Ledger and idempotency.** No table, trigger, constraint, index or grant changes; the ledger stays append-only; the
  idempotency key's unique index inside `record_completion` is untouched; the order of writes and locks in
  `record_completion` is untouched, so the lock order (and deadlock behaviour) is the same.
- **RLS.** Definer functions run as their owner as before; the request context (`app.player_id` and the rest) is read
  the same way. No policy changes.
- **Plan choice.** A cached plpgsql statement may switch to a generic plan after five calls. The path's queries are
  key lookups (completion id, enrollment id, quest id), where the generic plan is the same index scan; the build checks
  the hot statements' generic plans with `EXPLAIN (GENERIC_PLAN)` (PG16+) in a test and keeps any whose generic plan
  is not an index scan as SQL or rewrites it. No `plan_cache_mode` setting (a per-function `SET` costs every call).
- **Inlined functions stay SQL.** (Built differently, section 9: the profile showed these six are *not* inlined, because
  of their `SET` clause; part A drops the clause so they are.) Standard-body and other inlinable functions (`event_day` and friends) are not
  touched: converting them would make them slower.
- **Rule for later.** `docs/rules.md` gains one line: a function on a request path that is `SECURITY DEFINER` or has a
  `SET` clause is plpgsql, not `LANGUAGE sql`; a list-guard test enforces it for the named path (ADR-670).

**(B) One statement answers a completion (ADR-671; T-804c, with section 0's ranking fix).** A new definer door `complete_quest_answer(...)` (plpgsql, same
arguments as `complete_quest`) calls `complete_quest` and then, inside the server, the existing `own_level` and
`own_level_items`, `own_bonus`, `own_quest_item`, `completion_boost`, `own_first_bonus`, `own_streak_bonus`,
`ranking_entry_of` and `ranking_day_entry_of` for the new completion, and returns one row: the six engine columns,
the level-up, bonus, item, boost, first-bonus and streak parts, and the overall and day ranking entries. Each part is
the existing function's own answer (no logic is copied), so each keeps its own "only the caller's completion" check.
The refusal SQLSTATEs (QC404, QC403, QP403, QN403, QD409, QV422, QK422) pass through unchanged. `callEngine` makes one
call; `afterCompletion` takes the two entries from the answer instead of reading them in two more transactions (the
entries are read in the transaction that wrote them, after the score update, so they carry this completion's score
version; the Redis version guard already orders out-of-order writes). The `own_*` and `ranking_*entry_of` doors stay:
replays and other routes (kiosk, operator scan, NFC tap) still call them, and an old API during a rolling deploy still
works. The ranking's failure path is unchanged: a Redis failure logs, marks the event for repair and answers `rank:
null`. Revoked from PUBLIC, granted to `questify_app` only, in the same migration (outsider and route-catalog suites).

**(C) One player check (ADR-672; T-804c).** `player_session_owner` and `player_legal_held` become one call for a write
(`player_request_gate(hash, is_write)` returning the owner and whether a write is held), so a player's write costs one
round trip, not two. GETs keep one call. The guard's answers (401, 403 `legal_acceptance_required`, the open doors while
unaccepted) are unchanged. This touches sign-in, so it is tested as tier A (section 3).

**(D) Redis: one script per completion (ADR-673; T-804c).** The store's `upsert` then `read` become one Lua script
(`WRITE_READ`) run with `EVALSHA` (falling back to `EVAL` on `NOSCRIPT`), so a completion makes one Redis call (two on a
multi-day event), and the script body is not sent each time. The version rule, tombstones and the rebuild-on-missing
path are the same code paths, reused by the new script.

**Round trips per QR completion:** before 20 PostgreSQL (21 on a level-up) + 2 Redis, three pool check-outs; after 5
PostgreSQL (guard 1; `BEGIN`, `set_config`, `complete_quest_answer`, `COMMIT`) + 1 Redis, two check-outs.

**Pool size.** Stays 10 per API process. After (B) a completion holds a connection for about 4 round trips plus its
database time (about 15 to 20 ms on this PC), so 10 connections carry far more than the 130 to 150 a second one Node
process can make; T-804 showed a pool of 30 only moved the queue into PostgreSQL. Scaling is more API processes, each
with 10 (and the push pool's 3); `max_connections` on the database must cover processes x 13 (Q-630).

**Not in this task.** Rewriting `record_completion` or the ledger triggers (`xp_credit`, `streak_record`,
`souvenir_enqueue`, `raise_completion_flags`) for speed; moving any of them out of the transaction (an architecture
change, Q-631); load shedding before the pool (Q-633); the remaining 430 SQL functions off the path (PostgreSQL 18
would cache them; Q-630).

## 3. Correctness net

- **Existing suites, unchanged and green:** `test/db/completion-engine`, `category-rules`, `categories-refresh`,
  `categories-hidden`, `quest-items`, `first-bonus`, `flash-boosts`, `event-streak`, `daily-streak`, `xp`,
  `profile-items`, `session-points`, `sessions`, `player-legal`, `legal-help`, `ranking`, `today-ranking`,
  `questify-ranking`, `ranking-repair-seats`; `test/completions/complete` and `flow`; `test/ranking/*`;
  `apps/api/src/completions/complete.test.ts`; the T-105 idempotency and race tests. No assertion is edited; a test
  that must change is a finding for the review.
- **Security suites unchanged:** `test/security/outsider`, `cross-tenant`, `routes` (the new door is added to their
  lists; nothing existing is removed).
- **New: attribute parity** (`test/db/hot-path-plpgsql.int.test.ts`): for each rewritten function, owner, ACL,
  `prosecdef`, `proconfig`, `provolatile`, `proisstrict`, `proparallel`, argument and result types equal a fixture taken
  from the database before the migration; `lanname = 'plpgsql'`; the path list has no `LANGUAGE sql` function with a
  definer flag or a `SET` clause (the guard of ADR-670).
- **New: answer parity**: on a fixture that hits every part (a plain completion, a level-up with items, a category bonus
  with an item pending / out of stock / closed, a boost, a first-N bonus won and missed, a streak bonus, a multi-day
  event, a replay with the same key, every refusal), the row of `complete_quest_answer` equals what the old calls return
  one by one for the same completion, and the HTTP body of `POST /complete` is equal field by field to today's (a
  recorded expected body per case).
- **New: edge parity for the rewritten scalars**: none-found gives NULL, a composite with no row gives NULL (not a row of
  NULLs), and `levels_reach` writes each level once under two concurrent credits (the existing XP race test, rerun).
- **New: round-trip budget**: an API test wraps the pool's `query` and asserts a QR completion makes at most 5
  PostgreSQL statements and the ranking store one call (regression guard).
- **New: generic plans**: `EXPLAIN (GENERIC_PLAN)` of the hot statements uses their indexes.
- **Mutation (GitHub, `mutation.yml`, one run):** `apps/api/src/completions/complete.ts`,
  `apps/api/src/ranking/ranking.ts`, `apps/api/src/ranking/store.ts`, `apps/api/src/players/guard.ts`. The SQL is
  covered by the parity tests plus hand mutants in the build (first-row vs error in a scalar, `use_column` removed,
  a dropped part of the answer, the NULL composite).

## 4. Migration safety on a live database

- `CREATE OR REPLACE FUNCTION` updates the catalogue row only; it takes no lock on tables and does not wait for running
  calls. A call that started keeps the old body; the next call in any session sees the new one (cache invalidation).
  Two sessions replacing the same function at once fail with "tuple concurrently updated", so only the migration runner
  does it (one file, one transaction; the runner's `lock_timeout` of 10 s and its retry apply).
- The migration is additive for the API: the old doors keep working, so the order is migration first, then the API.
  Rolling back the API needs nothing; rolling back the database is a forward migration restoring the SQL bodies
  (taken from git), never an edit of a deployed migration.
- The first call per pooled connection plans each statement once (a few ms); then the cache holds.
- PostgreSQL 16.15 (CranL staging): same behaviour, same gain, all migrations run (section 1). CI and the tests use 17
  (Q-632). No PG17-only syntax in the new migration (`EXPLAIN (GENERIC_PLAN)` is 16+).

## 5. Target and rerun

- **Part A (T-804a), on this PC** (Docker PostgreSQL 17 with `pg_stat_statements`, the T-804 seed plus one skewed
  event, `node ops/load/run.mjs --rate-per-event 1200 --rush "" --api-instances 3 --big-event-players 50000`, two
  runs, the median reported): 200 completions a second for the ten events with 95% confirmed within 1 s and the
  ranking within 5 s, every completion, ledger row and score matching (T-804's tally), and the sequential profile at or
  under 14 ms of database time a completion. Plus the generic-plan check: `EXPLAIN (GENERIC_PLAN)` of the hot
  statements on that seed, and each hot statement's mean execution time with the plan cache (`auto`, and
  `force_generic_plan`) within 1.5 times (or 0.05 ms) of the custom-plan baseline (`force_custom_plan`).
- **T-804c, on this PC:** at least 240 a second on the same terms (3 times T-804's 80), sequential at or under 10 ms.
- The numbers go in STATE.md and T-804's line. **Then** T-804's production-like rerun (its seeding step first, RUNBOOK
  "Load test").
- **The launch target (Q-631, answered by Dhia 2026-11-04: "size to real bookings").** NFR-003 x NFR-025 is set from
  the biggest event day actually booked, not 20,000 a minute in each of ten events at once. These tasks make the code
  fast; the hardware is sized to bookings, from the per-completion cost measured here: after (A) to (D) a completion
  should cost about 10 ms of database CPU on an idle dedicated server and 25 to 40 ms on this loaded PC, and 6 to 7 ms
  of Node CPU, so a day's peak rate times those figures gives the database cores and API processes it needs. A day
  beyond one primary (thousands a second) would need events split over several primaries or part of the completion
  moved out of its transaction, designed only when a booking needs it. What CranL can offer is asked at T-811 (Q-630).
  Nothing is bought in this task.

## 6. Steps

1. Re-run the profile on the current main (throw-away container as above); fix the function list (section 2 A).
2. Tests first: attribute fixture, answer parity, round-trip budget, generic plans (failing where they must).
3. Migration: (A) rewrites, `complete_quest_answer`, `player_request_gate`, revokes and grants.
4. API: `callEngine`, `afterCompletion`, the guard, the Redis script.
5. Touched suites, security suites, types, lint, function limits; the full suite once.
6. Load rerun (section 5) and the sequential profile; STATE, TASKS, API.md (no change to the HTTP body), DATA_MODEL
   (function list), rules.md line, RUNBOOK (profiling recipe).

## 7. Decisions and questions

- ADR-670 hot-path functions in plpgsql; ADR-671 one statement answers a completion; ADR-672 one player check per
  write; ADR-673 one Redis script per completion; ADR-674 how the hot path is measured (throw-away containers with
  `pg_stat_statements`, before and after on the same container).
- Q-630 CranL's database sizes, versions (16, 17, 18) and the network time between API and database; Q-631 the
  3,333 a second target; Q-632 tests on 17 while staging runs 16.15; Q-633 load shedding before the pool; Q-634 whether
  T-804b's address window is per event or per platform.

## 8. T-804b outline - the sign-in rush (Q-621; tier A, sign-in; its own plan when it starts)

Measured by T-804: every `POST /v1/auth/code` takes the platform budget's advisory lock
(`pg_advisory_xact_lock`, `auth/outbound.ts` and the SMS budget) for the rest of its transaction, so the platform
sends about 100 codes a second; and one client address is refused after 200 an hour, which a venue's Wi-Fi reaches in
minutes.
1. **Profile first** on the T-804 rush (`--skip-completions --rush 50:10,100:10,200:10`): lock wait vs work per code.
2. **Budget without a held lock:** a per-hour counter row taken with one `UPDATE ... SET used = used + 1 WHERE used <
   cap RETURNING used` at the end of the transaction (or a short separate one), so requests wait only on that row
   update, not on the whole sign-in; the SMS and email budgets stay exact (never over the cap; a refused send gives
   its unit back).
3. **Shared addresses:** raise the player per-address window (Q-621 recommends about 2,000 an hour) while the per-number
   and per-install windows still stop pumping; staff windows unchanged. Whether it should be per event as well is
   Q-634.
4. **Tests:** budget never exceeded under 200 parallel requests at the cap; the per-number and per-install refusals
   unchanged; outsider suite unchanged; the rush rerun must show 250 codes a second at p95 under 1 s on this PC.
5. Q-093's platform SMS budget stays Dhia's choice.

## 9. Part A results (T-804a, built 2026-11-04)

**What was built.** Migration 0148: the 35 `LANGUAGE sql` functions the profile showed called once or more per
completion become plpgsql (ADR-670), and the six standard-body functions on the path (`event_day` and friends, called
up to 18 times a completion) lose their `SET search_path` so PostgreSQL inlines them. The plan had assumed these six
were inlined already; they were not. `test/db/hot-path-plpgsql.int.test.ts` with `hot-path-plpgsql.fixture.json`
(attributes and original `CREATE` of each function at 0147). The load seed gained `--big-event-players`.

**Correctness.** Attribute parity, every rewritten function called and run (`pg_stat_get_xact_function_calls`), each
answer equal to the old SQL body's on the same arguments, and the six shown inlined; hand mutants caught (a changed
score in `ranking_entry_of`, `boost_in_force` returning a row of NULLs, a wrong column in `own_streak_bonus`, one
`RESET` dropped); removing `use_column` changed nothing (no body has a name clash; equivalent). The 42 touched ledger,
ranking, sign-in, player and security files (1,430 tests) and the 5 Redis ranking and completion files (93) unchanged
and green on 17; the parity, completion engine, XP, streak and ranking suites (121 tests) green on a throw-away 16.15.

**Sequential profile** (throw-away 17.11 with `pg_stat_statements`, T-804 seed plus one 50,000-player event, 2,000 QR
completions, same database before and after):

| | before | after, `auto` | after, forced custom | after, forced generic |
| --- | --- | --- | --- | --- |
| Database time a completion | 33.5 ms | **10.9 ms** | 44.6 ms | 10.8 ms |
| Client mean (p95) | 63.5 (81.7) ms | 37.2 (48.4) ms | 80.6 (105.9) ms | 37.6 (48.8) ms |

Per statement: `complete_quest` 13.5 to 6.7 ms, `ranking_day_entry_of` 4.5 to 0.8, `own_bonus` 2.9 to 0.24,
`ranking_entry_of` 2.5 to 0.5, `own_level` 2.4 to 0.7, the guard's two checks 0.76 and 0.71 to 0.23 each. No `LANGUAGE
sql` function is called per completion any more. (A run of `auto` taken while a container image was downloading gave
18.0 ms and is not used.)

**Generic plans.** `auto` equals forced generic, so the plan cache settles on generic plans and they are cheap: of 120
statements compared, one ran more than 1.5 times and 0.05 ms slower generic than custom (an existing streak check, not
converted here, +0.06 ms). `EXPLAIN (GENERIC_PLAN)` of each of the 35 converted queries on the analysed skewed seed
reaches every large table (enrollment, ledger, completions, sessions, players) by index; sequential scans only on small
configuration tables (and on `event`, 11 rows in the seed). Under load, none of the 34 converted statements matched
against the before run's custom plans ran slower. Seven existing plpgsql statements are still planned on most calls
under `auto` (cheap; a T-804c note).

**Load** (`node ops/load/run.mjs --rate-per-event 1200 --rush "" --api-instances 3 --big-event-players 50000`, 200 a
second asked, 60 s after 10 s warm-up, the same throw-away 17.11):

| Run | Confirmed/s | All 200 | p50 / p95 | within 1 s | ranking within 5 s (p95) | PostgreSQL CPU | API CPU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Before | 52 | 3,136 of 12,000 (8,851 timeouts, 13 errors 500) | 15.0 / 15.0 s | 0% | 30% (14.5 s) | 11.5 cores | 0.41 to 0.45 each |
| After, run 1 | 200 | 12,000 | 92 / 504 ms | 98.1% | 100% (1.0 s) | 7.0 cores | 0.45 to 0.54 each |
| After, run 2 | 200 | 12,000 | 100 / 533 ms | 97.9% | 100% (0.86 s) | 6.4 cores | 0.44 to 0.56 each |

Median of the two after runs: **200 a second, 98.0% within 1 s, p95 518 ms**; the gate (200 a second at 95%) is met.
Every run's completions, ledger rows and scores matched (before: 10,993 written for 3,136 confirmed answers, the
points-after-give-up case of Q-633). T-804c (parts B to D) is next.

## 10. Parts B to D results (T-804c, built 2026-11-04)

**What was built.** Migration 0149: `complete_quest_answer` and `player_request_gate` (ADR-680), the ranking scripts by
SHA1 (ADR-681), the catalog guard and the richer parity seed (ADR-682). A QR completion: 5 PostgreSQL statements
(gate; `BEGIN`, `set_config`, the door, `COMMIT`) and one Redis call (`WRITE_READ`; a second for a multi-day event's day
board), held by a test in `test/ranking/ranking.int.test.ts`.

**Load** (throw-away 17.11 with `pg_stat_statements`, `ANALYZE` after seeding, statistics reset after warm-up; ten
events plus a 50,000-player event, three APIs, 60 s):

| Run | Confirmed/s | p50 / p95 | within 1 s | ranking within 5 s (p95) | PostgreSQL CPU | API CPU |
| --- | --- | --- | --- | --- | --- | --- |
| 240/s, run 1 | 240 | 42 / 94 ms | 100% | 100% (449 ms) | 5.9 cores | 0.28 to 0.33 each |
| 240/s, run 2 | 240 | 42 / 95 ms | 100% | 100% (456 ms) | 5.1 cores | 0.30 to 0.36 each |
| 400/s | 331 | 4.8 / 15 s | 0% | 60% | 11.2 cores | 0.39 to 0.50 each |

Every run's completions, ledger rows and scores matched.

**Database time.** Same container, 10 completions a second for 60 s, before (0148's API) and after: about 23.5 ms of
statement time a completion both ways (before: `complete_quest` 14.7 ms plus ten part and guard calls 9 ms; after:
the door 22.2 ms plus the gate 1.2 ms); client mean 57.6 to 36.8 ms, p95 79.6 to 46.8 ms. Under load at 240 a second
the door averaged 22.0 ms and the gate 0.73 ms. The work is the same; the round trips are gone. The 10 ms gate is not
met and the two measuring methods disagree (Q-641).
