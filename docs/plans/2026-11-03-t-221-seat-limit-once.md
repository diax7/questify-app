# T-221 - Check a hard limit once per statement, so accept-all becomes one call (plan, tier A)

Delivers FR-1821 and FR-1825 at scale (T-218, T-501d). Tier A: seat limits on the join path. Migration **0146** (main's
highest is 0145, T-802b; take the next free number at build time if another task lands first). ADR-630 to ADR-632 and
Q-590, Q-591 Proposed. Replaces the stop-gap of ADR-353 (5) and answers Q-323.

**Done when:** accept-all of 5,000 pending requests on a hard-limited event with 20,000 seated players finishes in one
call under 5 s with the decision push, and two accept-alls racing a join never seat more than the limit.

## What exists (read for this plan)

- **The seat guard** `enrollment_player_limit` (0027, restated 0032 and 0036; no later restatement: grep of
  `apps/api/migrations` and `apps/api/src`): `BEFORE INSERT OR UPDATE OF status FOR EACH ROW`. For each row moving into
  `active` (not rehearsal, not from `active`/`banned`) it takes `event FOR KEY SHARE`, the seat lock
  (`lock_event_seats`, advisory xact lock 270027), re-reads the limit, runs `event_seats()` (a count of the event's
  `active`/`banned` non-rehearsal rows through the `(event_id, player_id)` unique index plus a heap visit per row),
  raises `QL409` at a hard limit and calls `record_limit_alerts(.., seats + 1)` for any limit mode. With 20,000 seated
  each count is several ms, so accept-all is quadratic: 1,000 a call took 3.3 to 9.4 s (Q-323). Note the **soft**
  mode pays the same per-row count (alerts), not only hard.
- **The seat lock order** (0036 header): the event's seat lock, then the enrollment row. Every definer that seats a
  player takes `free_seats()` (event `KEY SHARE`, seat lock, count) before it reads or locks the row:
  `join_core` → `join_write` (join, invitation, waiting list), `enroll_operator`, `decide_join_request`,
  `accept_all_join_requests` (0036, restated 0077 with `LIMIT least(free, CASE WHEN free IS NULL THEN 1000 ELSE 250
  END)`). Admin limit changes (`activate_event`, `set_event_player_limit`, 0027) take the event `FOR UPDATE`, then the
  seat lock.
- **Every writer of `enrollment.status`** (latest restatements):
  - seat-taking: `join_write` INSERT `ON CONFLICT DO NOTHING` / UPDATE (0036, restated 0037), `enroll_operator` (0038),
    `decide_join_request` and `accept_all_join_requests` (0036/0077), the ban lift `set_enrollment_ban` banned→active
    (0036; banned is already a seat), the rehearsal join (0038, `joined_via = 'rehearsal'`, never counted),
    `review_demo_seed_players` (0144, 12 inserts into a demo event without a limit);
  - seat-freeing: `leaveEvent` in `apps/api/src/join/join.ts:706` (player's own `UPDATE ... SET status = 'left'`),
    `erase_rows` (0121, active/pending → left), `set_enrollment_ban` (active → banned keeps the seat), the rehearsal wipe
    (`DELETE` of rehearsal rows, 0032 onward);
  - direct writes: RLS lets only the admin update another player's row (0019 policy) or insert (0018 policy); the status
    guard (0019) lets a player only go to `left`. The row guard is today the **only** check on such a direct write.
- **Other row triggers on the accept-all update** (each costs per row, unchanged by the seat fix):
  `enrollment_status_guard`, `enrollment_waitlist_clear`, `enrollment_suspension_guard` (0114, `ES423`), then AFTER:
  `enqueue_souvenir_on_join` (0064; `souvenir_enqueue` is `LANGUAGE sql` with a `SET` clause, so PostgreSQL 17 plans it
  again on every trigger call: T-501d measured about 1 ms a row), `enrollment_welcome` (`grant_welcome`, 0038: a ledger
  insert whose 0012 trigger updates the enrollment's score, then an upsert of the one `ranking_repair` row of the
  event), `enrollment_push_decision` (0077, `notice_create` one insert a row), `mark_ranking_on_enrollment` (0015:139,
  `WHEN` the score is above 0, so a fresh acceptance skips it), and the three exit triggers `enrollment_close_submissions`
  (0040), `enrollment_void_quizzes` (0041) and `enrollment_abandon_rounds` (0050), all `AFTER UPDATE OF status` and a
  no-op on a move into `active`. Confinement triggers (rehearsal 0032,
  review demo 0144) fire on `joined_via` / `event_id, player_id` only. The maintenance gate (`src/maintenance/gate.ts`)
  holds player play doors (`POST /v1/join` included); accept-all is a team door and is not on it (unchanged).
- **Measured** (T-501d, `test/perf/push-producers-timing.int`): one call of 1,000 on an event without a hard limit
  1.70 to 1.76 s with the decision push (1.43 s without); an unbounded 5,000 took 7.4 s. So removing the quadratic seat
  check is necessary but **not sufficient**: at about 1.4 ms a row, 5,000 rows are about 7 s. The per-row cost has to
  come down too (phase 3).

## Chosen design (ADR-630)

### 1. The seat check runs once per statement

Drop the row trigger `enrollment_player_limit` and its function. Add one function `enrollment_seat_limit()` (PL/pgSQL,
`SECURITY DEFINER`, `search_path = public, pg_temp`, revoked from PUBLIC in the same group) and two triggers:

```sql
CREATE TRIGGER enrollment_seat_limit_insert AFTER INSERT ON enrollment
  REFERENCING NEW TABLE AS seated_new FOR EACH STATEMENT EXECUTE FUNCTION enrollment_seat_limit();
CREATE TRIGGER enrollment_seat_limit_update AFTER UPDATE ON enrollment
  REFERENCING OLD TABLE AS seated_old NEW TABLE AS seated_new FOR EACH STATEMENT EXECUTE FUNCTION enrollment_seat_limit();
```

(PostgreSQL allows transition tables only on AFTER triggers, one event each, and **without a column list**, so the
UPDATE trigger fires on every enrollment update; see "Hot path" below.)

The function:
1. Collects the **seated rows**: rows of `seated_new` with `status = 'active'` and `joined_via IS DISTINCT FROM
   'rehearsal'`, and for UPDATE only where the old row's status was not `active`/`banned` (join on `id`). Nothing
   seated → `RETURN NULL` at once, no lock (every score update, leave, ban, erase ends here).
2. For each event among them, **in `event_id` order** (a multi-event statement cannot deadlock against itself):
   `event FOR KEY SHARE` (waits for an admin changing the limit, as today); skip mode `none`; `lock_event_seats`;
   re-read mode and limit; `seats := event_seats(event)` (a fresh snapshot under the lock in READ COMMITTED: it sees
   every committed seat and this statement's own); `taken` = the event's seated rows.
3. Hard mode and `seats > cap` → `RAISE 'the event is full' USING ERRCODE = 'QL409', DETAIL = cap::text` (same
   SQLSTATE and detail as today). The whole statement is undone.
4. Any limit mode → the 80 and 100 marks with the **same `players` value the row-by-row guard recorded**: the count at
   the crossing, `greatest(threshold, seats - taken + 1)`, for each mark with `seats >= threshold` (a new internal
   `record_limit_crossings(event, org, cap, before, after)` that reuses the 80 mark's `ceil(cap * 0.8)` from 0027:77;
   `record_limit_alerts` stays for the admin doors that pass the current count).

The function branches on `TG_OP` with separate queries, so the INSERT path never names `seated_old` (the INSERT
trigger has no old table). It is correct only under READ COMMITTED: the count after the seat lock must be a fresh
snapshot that sees every seat committed while it waited. Its header says so, and once a statement seats a player on a
limited event it raises if `current_setting('transaction_isolation')` is not `read committed` (no door runs at another
level; a test proves the raise).

Semantics kept: a seat is `active` or `banned`, rehearsal never counts, a ban lift never takes a new seat, a limit
lowered below the seats refuses every new seat and keeps everyone in, a soft limit only records marks. The INSERT
special case of the old guard ("a player already in the event": `ON CONFLICT DO NOTHING`) disappears, because a row
that was not inserted is not in the transition table. One deliberate difference: a single statement that frees one
seat and takes another at exactly the limit now passes (net count), where the row guard depended on row order; no door
writes such a statement.

The definers keep deciding before writing (`free_seats`, `LIMIT free`), so for them the trigger re-takes locks they
already hold (the advisory lock and `KEY SHARE` are re-entrant) and runs one count: it never refuses a definer's call,
it is the last guard for a direct write, exactly the role the row guard had.

### 2. Accept-all takes up to 5,000 a call in both modes (ADR-631)

Restate `accept_all_join_requests` (from 0077) with `LIMIT least(free, 5000)` (`least` ignores a NULL `free`): a
hard-limited event accepts every request the free seats allow up to 5,000; an event without one, 5,000 instead of
1,000. A true "no cap" is refused: 20,000 pending on an event without a limit would take about 15 s and the API's 5 s
statement limit would refuse the call and accept nothing. The dashboard loop (`apps/web/src/lib/accept-all.ts`,
`ACCEPT_ALL_CALLS = 10`) stays as is: for 5,000 or fewer it is one call; above that it repeats as today (50,000 per
press). Only its comment and the numbers in it change. The 5,000 is a measured bound (phase 4); if the laptop run of
the Done-when fixture is above 3.5 s after phase 3, the cap is lowered to what fits in 3.5 s and the Done-when is
recorded as missed with the number, not shipped silently.

### 3. Cut the per-row cost of an acceptance (ADR-632)

In the order the profile (phase 0) ranks them; the first is already known:
1. **`souvenir_enqueue` restated in PL/pgSQL** with the same one `INSERT ... ON CONFLICT` and the same answers (the
   ADR-353 (5) precedent for `notice_create`): its plan is kept for the session instead of being planned on every row.
   Measured about 1 ms of the 1.4 ms a row in T-501d. Its other callers (completions, quizzes, rounds, staff, reinstate)
   only get faster.
2. **`grant_welcome`'s `ranking_repair` upsert** gains `WHERE ranking_repair.marked_at IS DISTINCT FROM now()` on its
   `DO UPDATE`: within one transaction `now()` is fixed, so the first row marks the event and the other 4,999 leave the
   row alone instead of writing 4,999 versions of one row (a chain each later write walks). Same meaning for the ranking
   worker (the row is marked at this transaction's time). Only if the profile shows it above 0.1 ms a row.
3. Nothing else is changed unless the profile shows a single trigger above 0.2 ms a row; then it goes back to the
   coordinator as a finding instead of growing this task.

The decision push stays a row trigger calling `notice_create` (one insert, ADR-353); see "Decision push" below.

### Why not a seat counter (Q-590)

A counter on the event (or an `event_seat` row) kept by every write that seats or frees a player:
- **Drift risk.** It must be right after every path listed above, including the player's own leave in TypeScript, erase,
  the rehearsal wipe's `DELETE`, the review-demo seed, admin direct writes, `TRUNCATE` in tests and any future writer.
  A row trigger could keep it, but one missed path (or a disabled trigger during a restore) seats beyond the limit
  silently, and it needs a reconciliation check and a backfill of every event at migration time.
- **The same hot row.** A per-row trigger updates the counter row 5,000 times in one accept-all transaction; PostgreSQL
  cannot prune versions its own open transaction made, so each update walks a growing chain (quadratic again, smaller
  constant). Keeping it per statement brings back the statement trigger anyway.
- **New contention.** Joins on an event without a hard limit take no seat lock today; a counter row updated by every
  join serialises them on that row during a door rush.
- What it would buy, an O(1) `free_seats` on every join, is a few ms per join at 20,000 seated; not worth the drift
  risk now. Recorded in Q-590 as the option to revisit if a join rush profile shows the count.

A partial index on seated enrollments only lowers the cost of each count; with one count per statement it is not
needed, so no index is built on the big table.

## Hot path

The UPDATE statement trigger fires for every `UPDATE enrollment` statement, including the score update that 0012 runs
for every ledger entry (each quest scan) and the ranking's `score_version` update. Its cost there: a one-row
transition table and one early-exit query that finds no seated row. Budget: under 50 µs a statement and under 5% of a
quest scan's time (measured, phase 4). Inside accept-all, the welcome ledger insert's nested score update fires it once
per accepted row (5,000 early exits); counted in the phase 4 number.

## Lock order (join, leave, accept-all, limit change)

| Path | Order | Change |
|---|---|---|
| join / invitation / waiting list / operator / decide / accept-all | event (SHARE) → event KEY SHARE + seat lock (`free_seats`) → enrollment rows → statement trigger (same locks again, re-entrant) | none: no new lock |
| leave, ban, erase, ban lift | enrollment row only; the trigger finds no seated row and locks nothing | none |
| admin limit change | event FOR UPDATE → seat lock | none |
| admin direct write into `active` | enrollment rows → event KEY SHARE → seat lock | was: the first row locked, then the seat lock (the row trigger), then the other rows under it; now every row of the statement before the seat lock, so the deadlock window with a definer grows from the first row to all the statement's rows. Such a deadlock is detected and one side gets `40P01` (no admin path in code writes status directly; noted, not tested) |

Accept-all's `FOR UPDATE SKIP LOCKED` stays: a request a concurrent decide or leave holds is skipped and stays pending
for the next press.

## Exactly the limit under concurrency (tests)

New file `apps/api/test/db/seat-limit.int.test.ts` (and the existing `join-requests.int` cases kept green). Three
connections with explicit transactions; a blocked call is proven waiting through `pg_stat_activity.wait_event_type =
'Lock'` (advisory) before the holder commits, never by a sleep.

1. **Accept-all first, then a join and a second accept-all:** hard limit = seated + 3, 10 pending, one outside player.
   A runs accept-all (holds the seat lock, not committed); B's `join_event` and C's accept-all are seen waiting; A
   commits (3 accepted); B answers `full` (waiting list offered), C accepts 0; seats = limit exactly.
2. **Join first, then two accept-alls:** same fixture; B's join holds the lock (1 seat), A and C wait; after B commits A
   accepts 2, C 0; seats = limit.
3. **Two accept-alls, no join:** one accepts all free seats, the other 0, in either commit order.
4. **Direct writes racing** (owner connection, admin): two `UPDATE ... SET status = 'active'` statements each seating
   the last free seat: the first commits, the second raises `QL409` and moved nothing.
5. **Statement guard alone** (owner connection): N pending → active at limit − N + 1 raises `QL409` and moves none;
   exactly to the limit passes; a direct INSERT at the limit raises; `INSERT ... ON CONFLICT DO NOTHING` for a player
   already seated at a full event does not; a two-event statement with one event over is refused whole; a limit lowered
   below the seats refuses one more seat but not a leave, a ban, an erase or a ban lift; rehearsal rows neither count nor
   are refused; a suspended event still answers `ES423`.
6. **Marks:** soft limit 10, 7 seated, accept-all of 5 → mark 80 recorded with players 8, mark 100 with players 10 (the
   row-by-row values); hard limit the same; no duplicate marks on a second call.
7. **Accept-all cap:** 5,001 pending without a limit → (5000, 1) then (1, 0); a hard limit with 7 free and 20 pending →
   (7, 13) in one call; each accepted player gets one welcome, one audit row and one `join_accepted` notice. Replaces the
   1,001 case in `test/db/push-producers.int`.
8. Security suites: `enrollment_seat_limit` and `record_limit_crossings` closed to PUBLIC (outsider), the function
   inventories updated, `enrollment_player_limit` gone; `test/db/rehearsal.int`'s lists updated.

Hand mutants (SQL is outside Stryker; each must fail a test above): drop the `>` to `>=`; count seats before taking the
lock; skip the `OLD.status IN ('active','banned')` exclusion; forget rehearsal; iterate events unordered (case 5's
two-event test with crossed locks); `LIMIT 5000` without `free`.

## Decision push batching

- Producer: unchanged, one `join_accepted` notice per accepted player from the row trigger, through `notice_create` (one
  insert, ADR-353). The markers stay unique within one call (`join:<enrollment>:<status>:<transaction time>`).
  A statement-level producer was weighed: it would save only the trigger call (about 20 µs a row) and add a second
  statement trigger on the hot path; not taken.
- Delivery: the push worker's personal pass takes 500 due notices a call (`push_personal_due`, 0076), so 5,000 go out in
  10 passes. Phase 4 times that fan-out (the timing file already does it) and the push copy is unchanged.

## Migration 0146 safety

- `SET LOCAL lock_timeout = '1s'`, below the app pool's 2 s (`src/db/pool-options.ts`): while the ACCESS EXCLUSIVE
  request waits, every reader and writer of `enrollment` queues behind it, and an app statement queued longer than its
  own 2 s fails with `55P03`. At 1 s the migration gives up first, so no player request fails because of it; the
  runner retries `55P03` three times (T-022, ADR-580). RUNBOOK deploy note: do not deploy 0146 during a live event's
  peak (a long join or scan transaction then makes every retry miss and the deploy stops).
- `LOCK TABLE enrollment IN ACCESS EXCLUSIVE MODE` first (`DROP TRIGGER` needs it; taken once up front so nothing
  upgrades a lock mid-file), then: drop the old trigger and function, create the function and two triggers, restate
  `accept_all_join_requests`, `souvenir_enqueue` (and `grant_welcome` if phase 0 keeps 3.2). Revokes next to each create.
- No table rewrite, no index, no backfill, no data change: the DDL is catalog-only and instant once the lock is held.
- Function signatures unchanged, so the running API works before and after (deploy order free).
- Migrations 0145 and earlier untouched (0036 and 0077 are deployed).

## Measurement plan (20,000 fixture)

`apps/api/test/perf/seat-limit-timing.int.test.ts`, run by hand (`SEAT_TIMING=<file>`), never in CI, same style as
`push-producers-timing.int`:

- **Fixture:** a live Private event, hard limit 25,000, 20,000 `active` and 5,000 `pending` players (one bulk insert
  each, then `ANALYZE`), welcome points on, one active souvenir rule, the decision push trigger on (the realistic worst).
- **Phase 0 (before the migration, on 0145):** one call (250 today) and a profile of the per-row cost: the same call
  with each AFTER trigger disabled in turn (`ALTER TABLE ... DISABLE TRIGGER`, superuser test database), three runs
  each, median. Decides 3.2.
- **After:** one accept-all of 5,000: time (median of three fresh fixtures), `accepted = 5000`, `remaining = 0`, 5,000
  notices; `EXPLAIN (ANALYZE, BUFFERS)` of the one seat count. Gate: under 5 s required, under 3.5 s targeted on the
  laptop.
- **Hot path:** 10,000 single-row `UPDATE enrollment SET score = score + 1` and 1,000 `record_completion` calls on the
  fixture, before and after: overhead under 5%.
- **Bulk ledger writers:** the 0012 ledger trigger runs one `UPDATE enrollment` per ledger row, so a bulk writer fires
  the statement trigger once per row. The largest is the bulk award (up to 2,000 enrollments a request); the community
  payout takes 1,000 a call. One insert of 2,000 award rows, before and after.
- **Fan-out:** the personal passes for the 5,000 notices: passes and total time.
- Results go into the TASKS note and ADR-631 (numbers, machine, PostgreSQL version). CranL staging is at 0117 and
  cannot run it; ADR-631 says the cap is lowered by a one-line restatement if production timing differs.

## Phases (one worker, one commit each)

0. Timing file and the before profile (no schema change).
1. Migration 0146 part 1: the statement guard, alert crossings; tests 1 to 6 and 8 first (red on 0145 where they test
   the new semantics), then green.
2. Accept-all cap 5,000; test 7; `push-producers.int` 1,001 case moved; the web comment.
3. Per-row trims per the profile (souvenir PL/pgSQL; welcome upsert if shown); their existing suites
   (`souvenirs*`, `ranking*`, `join-requests`, `push-producers`).
4. Measurement after; touched suites, security suites, then the full vitest once into a log.
5. Docs: TASKS (tick with numbers), STATE, API.md (accept-all per call), DATA_MODEL.md (the seat triggers), the
   push-producers timing header, Q-323 answered by Q-590, FOLLOWUPS if anything is left.

## Risks

- Per-row cost after the trims stays above the 3.5 s target: the cap drops (ADR-631) and Done-when is reported as
  missed with the measured number.
- The statement trigger on every enrollment update costs the scan path more than budgeted (PostgreSQL gives no column
  filter with transition tables): the builder stops and reports the numbers to the coordinator; moving the score off
  `enrollment` or a deferred per-event check are larger changes outside this task.
- CranL may be slower than the laptop; only measurable after deploy. The post-deploy timing probe is a required
  RUNBOOK step for the deploy that carries 0146 (one accept-all on a staging event sized like the fixture); above 3.5 s
  the planned response is lowering the cap by a one-line restatement of `accept_all_join_requests` (ADR-631).
- An admin direct status write can now deadlock with a definer on the same row (detected, retried by the caller).

## Mutation

Stryker mutates TypeScript only; this task changes no TypeScript logic (the web file changes a comment). No Stryker
globs; the SQL hand mutants above stand in, run by the builder and listed in the TASKS note.

## Plan review (2026-11-03, scored 88), folded in before the build

- MAJOR 1: migration `lock_timeout` 1 s, below the app pool's 2 s, with the reason, and a RUNBOOK deploy note (not
  during a live event's peak). "Migration 0146 safety".
- MINOR 2: READ COMMITTED only: header comment plus a raise under another level, with a test. "Chosen design" 1.
- MINOR 3: the bulk ledger writers (one nested `UPDATE enrollment` per ledger row) are measured too. "Measurement plan".
- MINOR 4: `TG_OP` branches with separate queries; the INSERT path is tested. "Chosen design" 1.
- MINOR 5: the post-deploy timing probe is a required RUNBOOK step; lowering the cap is the planned response. "Risks".
- NITs 6 to 8: the lock-order wording, the trigger inventory (`mark_ranking_on_enrollment`, the three exit
  triggers), and `record_limit_crossings` reusing `ceil(cap * 0.8)`.

## Build result (2026-11-03)

Built as planned except the cap: 5,000 a call measured 14 to 29 s after the trims (about 3 ms a row, linear), so
ADR-631's fallback applied and the cap is 1,000 in both modes (median 2.78 s on the fixture). The trigger exits through
one `EXISTS` before aggregating (32 µs a firing in the profile, within the 50 µs budget). Numbers in the TASKS note.
