# T-804e - Profile the completion's database work (plan, tier A: ledger)

Source: `docs/TASKS.md` T-804e; Q-641 (the 10 ms not reached); ADR-674 (how the hot path is measured); the T-804a plan
(`docs/plans/2026-11-04-t-804a-completion-hot-path.md`, sections 1 and 9) and the T-804c notes in STATE.md.
Decisions: ADR-730 to ADR-734 (Proposed). Questions: Q-697 to Q-699.
Migration: **0158** (new). 0156 is held by unmerged T-810d and 0157 is T-810f's.
Delivers no FR (quality gate).

**Done when** (TASKS.md): the profile script gives the same number twice on one container, and the completion's
statements are at or under ADR-674's 10 ms, or the gap is written down with what it would cost to close.

This plan step already did the measuring half (section 1). Sections 3 to 6 are the plan as written; section 8 records the
plan review and the narrower scope the coordinator chose, and section 9 what was built and measured.

## 1. The profile, committed and run twice

`ops/load/profile.mjs` (RUNBOOK, "The one-at-a-time profile"), with `ops/load/local.mjs` (what it shares with
`run.mjs`: the bundle, the seed commands, one load API, the disk check; `run.mjs` now imports it unchanged in
behaviour) and `ops/load/profile-stats.mjs` (the arithmetic, `profile-stats.test.ts`, 7 tests).

T-804a's method, made reproducible and runnable on the **shared test container** (which has no
`pg_stat_statements`): the T-804 seed plus one 50,000-player event, one load API (pool 10), 300 QR completions to warm,
then 2,000 one at a time over HTTP, each a player's first. The database time a completion is the total time of the two
top-level functions the API calls (`complete_quest_answer`, `player_request_gate`) from `pg_stat_user_functions`
(`track_functions = all` is set on the run's database by the seed), between two snapshots taken 11 s after each phase
(a backend flushes its statistics within about 10 s of going idle). BEGIN, `set_config` and COMMIT are not in it
(nothing on the path is deferred to COMMIT; the one deferred key, `ledger_entry_points_change_fkey`, is NULL here).
A second part loads auto_explain on one superuser connection only (`LOAD`, session settings, notices to the client),
switches to `questify_app`, and calls `complete_quest_answer` 200 times after 30 to warm, to break the time down by
statement and trigger. auto_explain's per-node timing makes those calls about 2x slower (21.9 ms against 10.3 ms), so
its rows are read as shares. Running on the shared container departs from ADR-674 ("never the shared test
container"): the script restarts nothing and needs no extension, and auto_explain is loaded only into its own session
(ADR-734, Q-699). Load runs stay on throw-away containers.

PostgreSQL 17.11 (`questifyapp-postgres-1`), this PC (Ryzen 7 1700, Docker Desktop), 2026-11-05:

| `node ops/load/profile.mjs --big-event-players 50000` | Run 1 | Run 2 |
| --- | --- | --- |
| **Database time a completion** | **10.78 ms** | **10.98 ms** |
| of which `complete_quest_answer` / `player_request_gate` | 10.31 / 0.47 | 10.49 / 0.49 |
| Client latency mean (p50, p95) | 24.0 (23.0, 30.4) ms | 24.3 (23.1, 31.2) ms |
| One at a time, completions a second | 41.7 | 41.1 |
| Under auto_explain, the engine call mean | 34.1 ms | 33.4 ms |

The two runs agree within 2%. This matches T-804a's sequential 10.9 ms (another container, `pg_stat_statements`), so
the one-at-a-time number is the same on both methods and both containers.

**Why T-804c's 23.5 ms differed (Q-641).** Not the rate: the same script with a 100 ms pause after each completion
(`--gap-ms 100 --completions 1000 --explain 0`, 7.6 a second, an idle server between calls like T-804c's 10 a
second) gave **11.73 ms** (client mean 25.0 ms), 8% more, and part of that is the API's background ticks spread over
a run 2.7 times longer (`ranking_eligible` 3.3 calls a completion instead of 2.3). The rest of the gap is the method:
T-804c summed `pg_stat_statements` with `track = all` and `track_planning = on`, which times every nested statement
(several dozen on this path) and the planner on top of the work, on a run whose drivers also sent the ranking probe's
repeated 5,000-point completions and its board reads. From now on the gate number is this script's (ADR-734).

## 2. Where the 10.8 ms goes

Uninstrumented (`pg_stat_user_functions`, run 1; run 2 within 0.1 ms on every row), ms a completion. Total time
includes callees; self time is the function's own statements, including the foreign-key checks (C functions, not
tracked) of the rows it inserts.

| Part | ms | Detail |
| --- | --- | --- |
| `player_request_gate` | 0.47 | `player_session_owner` 0.22, `player_legal_held` 0.21 |
| `record_completion` self | 2.37 | quest read twice, enrollment `FOR NO KEY UPDATE`, idempotency probe, count, two inserts and their **7 foreign-key checks** |
| ledger AFTER triggers | 2.99 | `xp_credit` 1.71 (`xp_apply` 0.97, of which `xp_month_of` 0.31, `xp_level_of` x3 0.20, `levels_reach` 0.14), `streak_record` 0.84, `apply_ledger_entry` 0.44 |
| ledger BEFORE triggers | 0.45 | `ledger_player_guard` (locks the enrollment again, `player_may_be_paid`), `ledger_suspension_guard` (`event_suspended`), `ledger_operator_play_guard`, `ledger_stamp_rehearsal` |
| completion AFTER triggers | 0.63 | `raise_completion_flags` 0.44 (`flag_tuning` reads two platform settings, a scan of the player's recent completions, `raise_speed_flag`), `souvenir_enqueue` 0.19 |
| open and repeat checks | 1.0 | `quest_open_check` 0.41, `period_count` 0.26, boosts, items, first and category bonus, rehearsal check, `keep_position` |
| the answer's reads | 2.3 | `own_level` 0.60, `ranking_day_entry_of` 0.59, `ranking_entry_of` 0.41 (`ranking_eligible` runs 2.3 times, 0.66 together), `own_quest_item` 0.20, `own_bonus` 0.19, `own_first_bonus` 0.17, `own_streak_bonus` 0.10, `completion_boost` 0.08 |
| `complete_quest_answer`, `complete_quest` self | 0.5 | |

auto_explain's shares agree: the `ledger_entry` insert is 11.3 of the engine's 21.9 ms (52%): `ledger_xp` 4.4,
`ledger_streak` 2.7, `apply_ledger_entry` 0.9, the four BEFORE triggers 1.6, and the enrollment update's own triggers
(`enrollment_status_guard`, `enrollment_waitlist_clear`, the statement-level `enrollment_seat_limit_update` with its
transition tables) 0.3; the `quest_completion` insert 3.7 (flags 2.2, souvenir 0.7). Each foreign-key check shows as
about 0.2 ms instrumented (about 0.08 uninstrumented); a completion makes 13 of them (3 on `quest_completion`, 4 on
`ledger_entry`, 2 on `xp_entry`, 3 on `event_streak_day`, 1 on `level_reached` when a level is reached).

**What this says.** No single statement is slow: every plan reaches its rows by index, and the largest single item
is 0.8 ms. The cost is the count: about 30 plpgsql function calls, 13 trigger firings and 13 key checks, most with a
`SECURITY DEFINER` or `SET search_path` entry (a configuration save and restore each), and the same rows read again
by each layer (the enrollment four times, the event three times, the new completion and ledger entry again by each
answer part). Cutting it means fewer layers, not better plans.

**`event_timezone_guard` (FOLLOWUPS, 2026-11-05).** It is `BEFORE INSERT OR UPDATE OF timezone ON event` and scans
`pg_timezone_names` (about 50 ms). A completion never inserts an event or updates its time zone (the completion path
writes no `event` row at all; the only `UPDATE event` near it, 0098's `focus_quest_id`, is not on the QR path and does
not name `timezone`), and it did not appear in either run's function list. **It does not touch the completion path**;
it costs event creation and time zone edits only, and stays a FOLLOWUPS item (section 7).

## 3. What to make cheaper (the build, migration 0158)

Ordered by measured gain per risk. Every item keeps each function's answer, refusal codes, lock order and grants; the
T-804a parity method (old body against new body on the same arguments, attributes by `pg_get_functiondef`) holds it.

**A. One BEFORE and one AFTER trigger on `ledger_entry` (ADR-730).** Today four BEFORE triggers fire by name
(`ledger_a_stamp_rehearsal`, `ledger_operator_play_guard`, `ledger_player_guard`, `ledger_suspension_guard`) and three
AFTER ones (`apply_ledger_entry`, `ledger_streak`, `ledger_xp`). They become `ledger_before()` and `ledger_after()`
calling the same steps **in the same order**, each step's `WHEN` condition moved inside as an `IF`. The enrollment row
is read once in `ledger_before` (`FOR NO KEY UPDATE`, as `ledger_player_guard` does now) and the event row once; the
steps take them as arguments (`streak_record(entry, ev, who)`, `xp_credit(entry, who)`), so the enrollment is read
once a ledger row instead of four times and the event once instead of three. The old trigger functions are dropped
(no shims). Every ledger writer (awards, bonuses, redemptions, removals) gains, not only completions.
Expected: 0.6 to 0.9 ms. Risk: order. A test lists `pg_trigger` on `ledger_entry` (exactly the no-update, no-truncate
and the two new ones) and the existing ledger, XP, streak, rehearsal, operator, suspension and safety suites run
unchanged.

**B. Pass what the caller already knows (ADR-731).** `xp_apply(who, made, delta)` looks up the XP entry it was just
handed to find its month (`xp_month_of`, 0.31 ms); for a credit the month is `questify_month(now())` (the entry's
`created_at` default is `now()`), so `xp_credit` passes the month. `xp_reverse` keeps the lookup (its month is the
credit's). (`ledger_player_guard` and `xp_player_guard` both call `player_may_be_paid` for one player in one
transaction, 0.13 ms together; both stay, because each guards writers the other does not see.) Expected: 0.3 ms.

**C. One ranking eligibility a completion (ADR-732).** `ranking_entry_of` and `ranking_day_entry_of` each call
`ranking_eligible` on the same enrollment (2.3 calls, 0.66 ms). `complete_quest_answer` reads the overall entry
first and hands its `ranked` to a new `ranking_day_entry_for(completion, ranked)`; the public `ranking_day_entry_of`
stays for its other callers. Expected: 0.3 ms.

**D. The flag trigger reads its tuning once a transaction (ADR-733).** `flag_tuning()` reads two `platform_setting`
rows on every completion. Within a transaction they are cached in two `set_config(..., true)` values; the platform
setting change takes effect from the next transaction, as now. The speed-flag `EXISTS` on `event` reuses the row
already in `NEW` (`kind` via the completion's event). Expected: 0.15 ms.

**E. The enrollment update's row triggers (ADR-733).** `enrollment_status_guard` and `enrollment_waitlist_clear`
fire on every score write although a score write changes neither the status nor the waiting flag. The guard acts only
when `NEW.status IS DISTINCT FROM OLD.status`, and the clear only rewrites `waitlisted` from `waitlisted` and
`status` (an unchanged row already holds its rule, since every earlier write applied it), so both triggers are
recreated with `WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.waitlisted IS DISTINCT FROM NEW.waitlisted)` (the
guard's on status alone); the clear keeps its `INSERT` trigger without a condition. `enrollment_seat_limit_update`
uses transition tables, which forbid a column list, and already returns at its first `EXISTS`; it stays. Expected:
0.1 ms.

**Together: about 1.4 to 1.8 ms, from 10.8 to about 9.0 to 9.4 ms**, under ADR-674's 10 ms on this method.

## 4. Considered and not recommended now (written down, with what they would cost)

- **Fewer foreign keys** (13 checks, about 1 ms). The pairs `(enrollment_id, event_id)` and `(event_id,
  organizer_id)` on `quest_completion`, `ledger_entry` and `event_streak_day` could become one three-column key to
  enrollment, saving 3 checks (about 0.25 ms). It needs a new unique index on `enrollment`, `NOT VALID` keys validated
  on the biggest tables during a deploy, and a weaker guarantee on organizer and event than two keys give today.
  Not worth 0.25 ms (Q-698).
- **The answer from memory** (2.3 ms of reads). `record_completion` could return the level-up, bonus, item and
  ranking parts it already knows instead of each `own_*` reading them back. It changes the engine's return type, which
  every door (manual awards, kiosks, quizzes, meets, games) shares, and the `own_*` functions stay for the app's later
  reads, so two ways to answer would exist. About 1 ms; a task of its own only if a later rerun needs it (Q-698).
- **Fewer `SECURITY DEFINER`/`SET` entries.** Most of the 30 calls carry `SET search_path`; dropping it (as 0148 did for
  six inlinable ones) on internal plpgsql helpers saves the configuration save and restore (tens of microseconds each)
  but removes ADR-670's search-path pinning on definer code, a security rule. Not proposed.

## 5. Q-641 and the 10 ms

On this script the completion is **10.8 to 11.0 ms**, 0.8 to 1.0 ms over ADR-674's 10 ms, not the 13.5 ms over that
Q-641 feared. Section 3 closes it with about 1.4 to 1.8 ms to spare; if the build lands short, the remaining gap and
section 4's prices are written into TASKS as the Done-when allows.

Two limits of the number, kept in view (Q-697):
- Every measured completion is a player's **first**. A player's later completions read more rows (the day's ledger
  sum in `ranking_day_entry_of`, the flag trigger's scan of recent completions, `period_count`), so they cost more as
  a player's history grows. The build measures `--quests-per-player 10` once before and after, reported beside the
  gate number, not as the gate.
- The function table also holds the load API's background ticks (push queue, souvenirs, ranking marks) for the
  minutes of the run; they are not part of the database time a completion, which counts only the two request
  functions.

## 6. Tests and measurement (build)

- Parity, as T-804a: a fixture of the 0157 bodies of every changed function and trigger; each new body answers as the
  old on the same arguments (`hot-path-plpgsql.int.test.ts` pattern), attributes kept, grants and PUBLIC revokes by
  name (ADR-682 catalog test), the trigger list on `ledger_entry` and `enrollment` asserted.
- Order: a test that inserts a ledger row which fails each guard in turn (rehearsal stamp, operator play, banned
  player, suspended event) gets the same SQLSTATE as before, and a streak bonus row is written after the score update
  and before the XP (the existing streak and XP suites).
- The existing ledger, XP, streak, flags, ranking, completion answer, rehearsal, operator, seat-limit and security
  suites unchanged; green on 17 and once on a throw-away 16.15 (Q-632).
- Measurement: `ops/load/profile.mjs --big-event-players 50000` twice before and twice after on the same container;
  the load rerun of T-804c (240 a second, three APIs) once to check nothing regressed under load.
- Mutation: SQL is held by the parity tests; no TS file of the core changes (the API's call stays
  `complete_quest_answer`).

## 7. Docs

STATE, TASKS (T-804e ticked with both runs' numbers), DATA_MODEL (the two ledger triggers), RUNBOOK (done),
FOLLOWUPS (the time zone guard line stays, with "not on the completion path, T-804e"), DECISIONS, OPEN_QUESTIONS.

## 8. Plan review (84) and coordinator scope

The tier A plan review scored the plan 84. Its findings, as the coordinator passed them on:

- **MAJOR 1 (part A).** `ledger_after` must not trust enrollment or event values read in `ledger_before`: between the
  two, `apply_ledger_entry`'s own UPDATE and other BEFORE triggers change the row. An AFTER step reads what it needs
  itself.
- **MAJOR 2 (part A).** `ledger_player_guard` locks the enrollment `FOR NO KEY UPDATE` only for a paying entry
  (`redeem_return`, `removal` and a lowering `adjust` take no lock). Reading the enrollment once for every kind in
  `ledger_before` would add a lock to those kinds; the lock must stay conditional, as today.
- **MAJOR 3 (part A).** Per-function parity cannot prove a trigger merge: order and interplay are the risk. Equivalence
  needs a scenario test over every ledger kind, rehearsal on and off, comparing the rows and SQLSTATEs of the 0157 and
  0158 versions.
- **Part B.** Prefer `RETURNING id, questify_month(created_at)` in `xp_credit` to `questify_month(now())`: equal by
  construction, no reliance on the column default. `xp_reverse` keeps the lookup.
- **Part C.** `ranking_day_entry_for` keeps the `app_player_id()` filter, and returns no row when the overall entry has
  none (the day entry must not appear without the overall one).
- **Part D.** A per-transaction cache in a custom setting (`set_config(..., true)`) can be set by the session before the
  trigger reads it, so a client could choose its own burst numbers. Not acceptable on a fraud check.
- **Part E.** Sound only if no row is already `waitlisted` outside `pending`; assert it in the migration before relying
  on the `WHEN`.

**Coordinator decision (2026-11-05): build only the low-risk parts now, then measure.**

- ADR-731 as the review prefers (`RETURNING`), xp_reverse's lookup kept.
- ADR-732 with the player filter kept and no day row without an overall one.
- ADR-733 part E with the migration assertion; part D's cache dropped, the tuning row read once instead of twice.
- **ADR-730 (the trigger merge) is not built now** and is Proposed-deferred, with MAJORs 1 to 3 as its conditions.

## 9. Built (migration 0158) and measured

Migration `0158_completion_profile.sql`: `xp_apply(who, made, delta, known_month DEFAULT NULL)` replaces the three-argument
one; `xp_credit` passes the month from `RETURNING`; `ranking_day_entry_for(completion, eligible)` (internal, PUBLIC
revoked, no grant) is called by `complete_quest_answer` only when the overall entry exists; `flag_tuning` reads the
setting row once; `enrollment_status_guard` and `enrollment_waitlist_clear` fire on UPDATE only when what they act on
changed (the insert side is `enrollment_waitlist_clear_insert`); the migration asserts no row is waitlisted outside
pending after taking the table lock. No lock order changes (`docs/rules.md` unchanged).

Rollback: `apps/api/db/rollback/0158_completion_profile.sql` restores the 0157 bodies and triggers (taken from
`pg_get_functiondef` on a 0157 database); run it as the owner, then delete the 0158 row from `schema_migration`.

Equivalence: `apps/api/test/db/completion-profile.int.test.ts` runs one scenario twice in rolled-back transactions on one
database, once after the rollback file, with every sequence reset so ids match: the completion door (first completion
with category bonus, first-N bonus and streak; replay; repeat), and raw entries of every other kind (award, community,
session, redeem, redeem_return, removal, adjust up and down) for a real and a rehearsal member, each guard's refusal
(PB423, QP403, LB500, ES423, the status guard's 42501), the waiting list through a score write, an award, a leave and a
flag set outside pending. Answers, SQLSTATEs, enrollments, ledger, completions, XP entries, boards, totals, levels,
event and Questify streak days and flags must be equal. Two deliberate breaks (a wrong XP month; the waiting-list WHEN
without `waitlisted`) each failed it. A third test proves the migration's assertion refuses a bad row (23514).
`completion-answer.int.test.ts`'s "ranking fails" case now breaks `ranking_day_entry_for`, the function the answer calls.

**Measurement: not taken yet.** `node ops/load/profile.mjs --big-event-players 50000` stopped at its disk check (7.0 GB
free on C:, it needs 8 GB) before it seeded anything. Once there is room it runs twice on an idle container (no other
client database in `pg_stat_activity`). Expected from section 2: about 0.8 to 1.0 ms off (the XP month 0.31, one
eligibility check about 0.3, the enrollment triggers about 0.1, one tuning read about 0.05), so about 9.8 to 10.2 ms.
If the result is over 10 ms the gap goes here and in TASKS: ADR-730, built with the review's MAJORs 1 to 3, would save
about 0.5 to 0.8 ms more (fewer trigger entries and definer switches); its cost is one larger trigger function whose
step order becomes code, a conditional player lock kept by hand, and the scenario test as the gate.
