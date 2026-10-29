# T-503 terminal-publication investigation: FAIL / STOP

2026-10-29; recovered from main `4ff69c5ba1ffee3bb00816948ed7f3d6e66fb38c`.
ADR-361 permits this LOCAL test-only investigation, not design acceptance. T-503 remains incomplete.
**Correctness FAIL; mean E <3 ms UNPROVEN; <=1.5 ms target FAIL in four of five measured runs.**
No migration, application adapter, production function, email/UI, dependency, live external service,
deployment, mutation, push, task tick or next task is part of this checkpoint. Coordinator decides.

## Recovery and reproducibility

Preserved and inspected all three previously untracked artifacts: the terminal gate test, fixture helper,
and private SQL probe. The old red `t503-rank-gate.int.test.ts` and `t503-rank-probe.sql` remain byte-unchanged.
All original `t503-terminal-{initial,development,types,limits}.log` files remain local and unchanged.
The committed companion JSON records their SHA-256 hashes, all final aggregates, complete function-profile
rows, bounded constraint/trigger inventory, machine configuration and diagnostic outcomes. Logs are ignored
artifacts, not the only evidence. PowerShell produced UTF-16LE logs; decode accordingly.

The original logs did NOT establish a passing harness: initial fixture join-code check failure; development
5 pass/1 outsider relation-resolution failure; 14 TypeScript index-signature errors; limits alone passed.
The recovered artifacts already use valid join codes and public-qualified enrollment access. Fixed evidence
index access and test-helper lint; added real non-replay/25-point completion validation, complete transaction
profiling, machine/settings capture, owner rollback cleanup and committed-source confirmation. A recovery
instrumentation query incorrectly used quest_completion.player_id; that run is preserved in
`t503-terminal-final.log`, then corrected to enrollment_id. It is NOT accepted as final proof.
Repeated top-member awards were also incorrectly labeled a crossing workload; corrected labels and counted
actual facts. The last two runs generated only 2 / 0 facts INCLUDING warmup: no crossing-heavy load claim.

Run from the repository root with the opt-ins below (PowerShell environment assignments):

```powershell
$env:TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:55432/postgres'
$env:TEST_REDIS_URL='redis://127.0.0.1:56379'
$env:T503_TERMINAL_GATE='1'
npx.cmd vitest run apps/api/test/db/t503-terminal-gate.int.test.ts
```

The expected current exit is 1, solely the deliberately RED missing-publication feasibility assertion.
Without T503_TERMINAL_GATE=1 the 12 tests skip; no probe DB is created. The test helper creates/drops only
disposable local databases and installs the probe there after existing migrations through 0081; 0082 stays free.

## Real source, setup and measurement boundaries

Same shared Windows developer machine: Windows 10.0.19045, Ryzen 7 1700, 16 logical CPUs,
47.933 GiB RAM, Node v24.14.0 (NOT the repository's Node 22 production baseline). Local Docker PostgreSQL
17.11 Alpine; synchronous_commit, fsync and full_page_writes ON, shared_buffers 128 MB, work_mem 4 MB.
No concurrent test/type/lint command ran during final measurement. Other local services were not stopped;
this is not a dedicated capacity certification. No Redis behavior or network provider is measured.

50,000 active, eligible hot-event members plus an 11-member crossing event; initial scores/versions are bulk
fixture data, not 50,000 earned histories. No excluded leaders, team/device/rehearsal fixtures or cold-cache
eviction. All existing source triggers stay enabled. complete_quest is wrapped only to acquire shared G
before source work; its original body calls real record_completion, quest_completion/ledger/enrollment,
XP/streak/notice/item/bonus checks and writes. Every measured completion must return one fresh 25-point
result, not a replay. The test-only enrollment AFTER trigger updates the private eligible projection.
The caller explicitly invokes terminal publication, which flushes queued deferred constraints before E,
then acquires exclusive E, rereads READ COMMITTED state after waiting, writes snapshot/revision/facts/latest,
and retains E through actual COMMIT. There is NO automatic mandatory terminal finalizer.

Three sequential profile phases each execute 60 actual transactions, discard the first 10 for warm metrics,
and reuse the same 60 participants. BEGIN/SET LOCAL ROLE through COMMIT acknowledgement is timed in full.
Source+context and COMMIT are separately timed. track_functions=all is enabled on this profiling connection.
Source history/cache warmth differs across phases: differences are descriptive, NOT randomized causal overhead.

| Complete client transaction profile | Warm n | Mean ms | p50 ms | p95 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 50 | 15.145 | 14.854 | 16.902 | 17.744 |
| originalEarlyProbe | 50 | 17.753 | 16.676 | 26.700 | 30.041 |
| candidateProfile | 50 | 19.137 | 18.726 | 22.665 | 24.242 |

Baseline source/context warm mean 11.667 ms; terminal source/context
13.126 ms. Baseline COMMIT acknowledgement mean
2.628 ms; terminal 2.561 ms
(60 each, including warmup). The original >14 ms lower-bound result is NOT invalidated by local variability:
historic warm means 14.46488 / 14.20142 ms, confirmation full residence [14.20142,20.262509] ms remain preserved.
This run reinstalls/exercises/removes the unchanged original SQL before installing the terminal candidate:
60 source-inclusive E LOWER samples mean 12.947 ms, p50/p95/p99
12.081 / 21.293 / 28.164 ms;
still decisively fails <3 ms. This 60-sample aggregate includes warmup and is not a historic warm-equivalent sample.

Full source profiling identifies real cost outside indexed top lookup: baseline record_completion totals
647.820 ms / 60 calls (self 110.003), souvenir_enqueue self 65.818, period_count self 53.473,
play_phase self 37.816, streak_record self 37.599, xp_credit self 33.802. These nested totals overlap;
do not sum total_time as independent CPU. Terminal has_event_lock self 69.540 ms /180 calls and
terminal_publish self 47.521 ms /60 calls are also recorded; no production optimization was attempted.

## Full-source terminal E release bounds (milliseconds)

Three runs: 70 single-source transactions each, discard 10; then two runs of 40 alternating one/two-source
transactions, discard 10. The repeated-run client interval starts BEFORE BEGIN and ends AFTER confirmed
COMMIT and the post-release query, including context/source/publication and measurement round trips.
Server acquisition and publication timestamps give only a publication-body lower bound, not full hold.
A server timestamp immediately BEFORE COMMIT gives a stronger lower bound. The timestamp in a statement
AFTER COMMIT gives an upper bound; that same statement asserts E is absent from pg_locks. Both are server-clock
bounds, not subtraction of unrelated client/server clocks. The gap includes COMMIT/WAL and statement overhead;
it is not an exact instant-of-release or pure WAL timing. No observer-poll precision or durable-recovery proof is claimed.

| Run / actual workload | Warm n | Full client mean | Full p50 / p95 / p99 | Publish-body lower mean | Actual E mean bounds: precommit to postrelease | Commit-to-postrelease mean | Facts incl. warmup |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1: noncrossing | 60 | 22.675 | 22.148 / 27.137 / 34.501 | 0.325 | [1.595, 3.484] | 1.889 | 0 |
| 2: noncrossing | 60 | 23.217 | 22.418 / 27.335 / 34.873 | 0.314 | [1.616, 3.612] | 1.996 | 0 |
| 3: noncrossing | 60 | 23.641 | 23.347 / 28.431 / 29.328 | 0.285 | [1.639, 3.597] | 1.958 | 0 |
| 4: alternating-top-members | 30 | 29.909 | 33.392 / 40.574 / 40.975 | 0.258 | [1.481, 3.388] | 1.907 | 2 |
| 5: alternating-top-members | 30 | 37.759 | 42.429 / 51.050 / 52.824 | 0.299 | [1.764, 3.851] | 2.087 | 0 |

Uncontended E wait means 0.016 / 0.016 / 0.016 / 0.012 / 0.015 ms.
All five full-release intervals straddle 3 ms: **hard gate UNPROVEN, not PASS and not demonstrated FAIL solely
from an upper bound >3 ms**. Four pre-COMMIT lower means already exceed 1.5 ms: target FAIL there; run 4
is UNPROVEN. A 0.258-0.325 ms publication-body mean alone cannot pass anything. 20,000 completions/minute
in one hot event, stable queue/drain and <=5 s propagation remain UNPROVEN. No microbenchmark-derived
throughput or across-event multiplication is reported.

## Deterministic ordering, rollback and terminal-boundary findings

- PASS: 11-member fixture commits entry revision1, exit2, entry3 in generation1; all facts survive between
  drains and exact latest identity selects revision3. This is not an all-writers crossing certificate.
- PASS: A begins and mutates first on a distinct member; B publishes first; A's E wait is observed using
  pg_blocking_pids. B commits, A resumes and publishes with a fresh post-wait snapshot; final top matches the
  projection order. Contested E wait 3.542 ms is diagnostic, not a load distribution.
- PASS: same-enrollment A waits on B in business work BEFORE E; B publishes/commits, then A resumes/publishes.
  No cycle occurs in that specific arrangement. Reverse source-start orders and every source pair remain unproved.
- PASS: explicit post-publication ROLLBACK restores captured enrollment values, source/ledger counts, full
  private projection/state/facts/latest. This does NOT compare every XP/streak/notice/bonus/ledger row image,
  nor the separate failed-COMMIT case, nor a waiter resuming after another writer's rollback.
- PASS: synthetic snapshot reader/shared-E and writer/exclusive-E block in both orders; synthetic exclusive-G
  reset and shared-G writer block in both orders; shared-to-exclusive G upgrade is refused. This is not actual
  delivery/drain/claim, lifecycle reset, off/on, wipe_rehearsal or tombstone behavior. In particular, no complete
  post-reset fact/latest/generation equivalence assertion or production global pause measurement is present.
- PASS: API/outsider cannot directly access private relations/helpers or raw score writes; outsider publication
  is refused; ordinary completion after terminal E is refused before its source work. Security regression suites
  concern unchanged production and are not exhaustive candidate authorization proof.
- **FAIL: real nested back-edge.** A second transaction holds an enrollment via the real source. An owner-context
  transaction completes another member, takes E, then calls actual record_completion on the held member.
  It WAITS on that legacy enrollment while holding E. Only after the other transaction rolls back does the
  enrollment AFTER projection guard raise 42501. This is a privileged/internal nested-source counterexample,
  not an assertion that the app role can directly invoke record_completion. A late refusal cannot prove
  no post-E legacy lock acquisition; a reciprocal E waiter could close a cycle. No deliberate deadlock was needed.
- **FAIL / incomplete commit finalization.** Queued synthetic deferred FK/business trigger work flushes before E
  (trace records was_fenced=false). Owner-context SET CONSTRAINTS ALL DEFERRED can re-arm it after publication;
  actual COMMIT reaches the post-fence guard and fails 42501. This proves the phase is not sealed against deferred
  re-entry. Full source/XP/notice rollback equivalence after this failed COMMIT is untested, not a claimed pass.
- **RED mandatory publication assertion:** app-role source on hot member704 commits one quest_completion while
  publication revision stays 355 -> 355 (required 356). Source/ledger success is not atomically guaranteed to
  include terminal publication. No commit-time dirty-event/publication certificate exists. The test stays failing;
  do not convert it to an expected failure or auto-call publish in a way that hides this missing enforcement.

The bounded metadata query lists public deferrable constraints and selected completion/ledger/enrollment/XP FKs
and business triggers, not every transitive source/cascade/default. Existing public deferred shape constraints
include daily_challenge, daily_challenge_question, passport_step and quest. The synthetic deferred-job FK/trigger
is a deliberate counterexample, NOT an assertion that a production FK has that exact mode. Immutable writer
inventory, dependency graph and commit-finalization sealing remain absent.

## Read cost and remaining acceptance proof

Seven warm client reads each: canonical eligible top mean 95.798 ms;
projection top 1.530, total 6.137,
representative near-top own count 1.497 ms.
First-call values, p50/p95/p99 and maxima are in JSON. No cache eviction was performed: first call != cold cache.
Own-rank sampling is not a bottom-ranked worst case; canonical own/total equality and combined API cost are unproved.
The 49,990-excluded-leaders case, EXPLAIN scan bounds, ties/bulk/manual/multi-event writers, live defaults,
actual reset/rehearsal/erasure cascades, all-writer both-order lock proofs, Redis-down/repair/API cutover,
sustained hot-event queue/propagation and exact commit-tail release/durability certification remain UNPROVEN.

## Checks and recommendation

- Final opt-in gate: **11 PASS /1 intentional RED**, 1 failed file, 91.35 s
  (`t503-terminal-confirmation.log`). Earlier recovered diagnostic: 11 PASS /1 intentional RED, 90.47 s.
- Unchanged-production security: **517 PASS /4 files**, 26.17 s (`t503-terminal-security.log`).
- API no-emit types, targeted zero-warning lint and format check PASS; limits PASS, 318 baselined violations,
  none new. Opt-out gate skips all 12. Full Vitest, live services, dependency changes and mutation NOT run.
- **Technical recommendation: stop this candidate at FAIL / UNPROVEN.** Its shorter publication body does not
  repair missing mandatory commit publication or late nested/deferred back-edges, and actual full E <3 ms is not
  established. Do not integrate it, optimize away facts, weaken eligibility or change any recorded budget.
  Coordinator must decide any future bounded investigation/design; no further redesign is attempted here.
- Local test/evidence checkpoint only; no acceptance, task completion or next task. Approximate recovery effort:
  15-20 minutes of local investigation/checks/documentation, zero CI minutes (estimate, not billing).
