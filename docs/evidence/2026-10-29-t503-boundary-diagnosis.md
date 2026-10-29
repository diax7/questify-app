# T-503 independent boundary diagnosis: NO-GO

2026-10-29, main `61b5368b8695343d22f47160f9086bfabd528513`. Review only,
except this document. No replacement implementation, protocol acceptance or task tick.
All historical red gates and probes remain unchanged.

## Defensible hypothesis, not an accepted boundary

The automatic pending-row callback is not after-all-business: its inner constraint
drain returned, E was acquired, and an already queued business callback then ran
(`2026-10-29-t503-auto-gate.md:24`,
`apps/api/test/support/t503-auto-probe.sql:127`). Renaming/requeueing triggers or
removing guards does not repair closure. The explicit terminal helper also allowed
a real completion to commit without publication, revision 355 unchanged
(`2026-10-29-t503-terminal-gate.md:141`). Both remain rejected.

A defensible hypothesis is the outer transaction owner's final explicit operation
BEFORE COMMIT, outside deferred-trigger dispatch, with this mandatory contract:

1. G precedes every source/authorization lock; choose shared/exclusive before work.
   No shared-to-exclusive upgrade when nested work discovers global impact.
2. Finish normal statements and synchronous triggers/cascades. Selectively set ALL
   business deferred constraints/triggers IMMEDIATE, excluding only the mandatory
   publication assertion. Recursively queued work must finish before sealing; keep
   business constraints immediate. Include any preliminary finalizer business work.
3. Seal business entry; freeze all dirty events/reset edges. Reject finalization inside
   an active business statement. Take all E keys once in collision-aware global order;
   use fresh READ COMMITTED reads after waiting. Publish snapshot/revision/facts/latest
   atomically and retain E through actual COMMIT.
4. Certify each dirty event/reset edge in protected transactional state, not a
   caller-settable GUC or mere lock ownership. No business locks after sealing.
5. A mandatory deferred read/assert-only check validates CURRENT dirty/certificate
   state. Missing/stale/incomplete finalization aborts COMMIT. It never publishes,
   drains, waits for business locks, or passes merely because the phase is not ready.

This is NOT an optional publisher: omission must fail COMMIT. It does not automatically
make old transactions succeed. Every supported dirty transaction owner must adopt
the boundary or start failing. No complete production boundary is currently proved.

## Selective draining and premature assertion

ALL IMMEDIATE before sealing would fire the assertion too: fail closed, never silently
consume its only callback. An early named assertion may abort or be rolled back to a
savepoint; after finalization, immediate assertion is safe only with unbypassable
sealing. Rolling back finalization must roll back its certificate. The tiny proof
below establishes these limited semantics, not production correctness.

A release manifest must inspect both deferrable pg_constraint and pg_trigger entries,
their functions and cascades, including schema/name resolution. New/unclassified
constraints must block release; selected public-FK metadata is insufficient.

## Architectural blockers

**BLOCKER: transaction ownership.** withRequestContext commits after arbitrary work
(`apps/api/src/db/context.ts:48`); pre-identity commits independently
(`apps/api/src/db/pre-identity.ts:96`), as does staff administration
(`apps/api/src/auth/staff-admin.ts:84`). Background lifecycle calls use the request
wrapper with empty context (`apps/api/src/events/tick.ts:29`); HTTP-only adoption
misses them. withConnection owns no transaction (`apps/api/src/db/connection.ts:7`).
Practice rolls back (`apps/api/src/db/context.ts:68`). Classify direct app-role SQL,
autocommit, SQL functions, owner maintenance and migration paths separately.

**BLOCKER: pre-lock closure.** The automatic probe guards complete_quest,
record_completion and BEFORE-statement DML on five tables only
(`apps/api/test/support/t503-auto-probe.sql:29`, `:50`, `:63`, `:91`). Current
record_completion calls ensure_rehearsal_wiped before its enrollment lock
(`apps/api/migrations/0062_first_bonus.sql:339`). Outer callers need guards before
their FIRST lock, not just at ledger INSERT or enrollment AFTER. Statement guards
cannot intercept SELECT FOR UPDATE/SHARE, explicit LOCK or functions locking before
DML. They follow relation-lock acquisition: concurrent DDL needs maintenance exclusion.
Classify/reject TRUNCATE, trigger bypass and raw row-mark SQL. A late exception does
not prevent a deadlock; prove refusal while another backend holds the legacy lock.

**BLOCKER: publication back-edges.** FKs to enrollment/player/event can take business
key-share locks; publication triggers/cascades/auth checks may do more. Satisfy/prove
these obligations before E or prove rank-private publication without reverse
dependencies. Private probe tables and synthetic resets do not prove that graph.

**MAJOR: concurrency and budget.** Freeze the complete multi-event set; coordinate
lifecycle/defaults/contact/team/erasure/dispatch/reset under G in both orders. Readers
holding E must not wait on business locks. Prove actual function/snapshot freshness,
overall/own/total equivalence, consecutive committed crossings and atomic real-source
rollback. Hard mean <3 ms, target <=1.5 ms, NFR-003/backlog and <=5 s propagation
remain UNPROVEN. No old red timing is superseded by a semantic proof.

## Real writer/dependency inventory seed (not a closure certificate)

Migration references below are under apps/api/migrations; use these latest relevant
definitions rather than assuming the original payer still executes:

- Completion: complete_quest `0057_device_pairing.sql:949` -> record_completion
  `0062_first_bonus.sql:306`; pay_completion `0055_flash_boosts.sql:391`,
  pay_category_bonus `0047_quest_items.sql:251`, pay_first_bonus `0062_first_bonus.sql:84`.
  Guard before device/rehearsal/event/quest/enrollment/bonus locks, not the last payer.
- Other completion doors: pay_submission `0062_first_bonus.sql:461`, finish_quiz `:475`,
  finish_game_round `:523`, stamp_step `:617`, pay_meeting `:721`; NFC tap_quest
  `0056_nfc_tags.sql:431`, kiosk/operator entry points, submission accept-all and
  community pay_community_batch `0053_community_quests.sql:483`. Close every outer caller.
- Ledger/join/bulk: apply_ledger_entry `0015_ranking.sql:10`; join_event
  `0038_account_deletion.sql:322`, accept_all_join_requests `0077_personal_pushes.sql:103`,
  bulk_award `0032_rehearsal.sql:950`, remove_award `0068_streaks.sql:614`. Include initial
  score/version and actual affected rows, not only paid scans.
- Spending/refunds: reserve_reward `0074_after_the_event.sql:83`, end_reservation
  `0047_quest_items.sql:576`, cancel_redemption `:625`, expire_one_reservation
  `0029_prize_desk.sql:341`; include reward/redemption/code/item locks and zero-score cases.
- Trigger fan-out: apply_ledger_entry AFTER ledger INSERT `0012_completion_engine.sql:107`,
  ledger_streak `0068_streaks.sql:279`; follow XP, items/category/first-bonus and personal
  notices, every downstream FK/trigger, not just the probe's five guarded tables.
- Eligibility: canonical ranking_eligible/ranked_enrollments `0026_operators.sql:139`/`:149`,
  organizer_team_players `0015_ranking.sql:36`. Inventory enrollment insert/delete and
  identity/event/organizer/rehearsal/status/score/version updates; player status/delete;
  player_contact email/phone/identity; organizer_member/staff_user identity/email mapping;
  staff_assignment and event_exclusion insert/update/delete; all FK cascades. Dirty OLD
  and NEW events. The probe UPDATE hook misses INSERT/DELETE and these other writers;
  its upsert does not move event_id or dirty the old event on reassignment
  (`apps/api/test/support/t503-auto-probe.sql:74`).
- Lifecycle/defaults: raw event writes `apps/api/src/events/store.ts:209`/`:252`/`:290`;
  platform_setting upsert, feature/tuning and entitlement writes
  `apps/api/src/settings/store.ts:50`/`:76`/`:102`/`:123`/`:145`; inheritance in
  `apps/api/src/settings/service.ts`. end_event_early/advance_event_lifecycle
  `0009_event_builder.sql:102`/`:128`. Capture off->on and generation edges within one
  transaction, not just its final value; a cache cannot override DB generations.
- Rehearsal/erasure: ensure_rehearsal_wiped `0032_rehearsal.sql:268`, latest wipe_rehearsal
  `0062_first_bonus.sql:927`, erase_rehearsal `0032_rehearsal.sql:384`, erase_player
  `0038_account_deletion.sql:742`, latest erase_rows `0076_push.sql:1110`. Select exclusive
  G where needed BEFORE player/XP/rehearsal locks; cover manual deletion/cascades,
  tombstones and notification identifiers, not merely final enrollment status.
- Existing real deferred checks: quest_passport_steps/passport_step_shape
  `0045_passport.sql:140`/`:150`, daily_challenge_three/daily_challenge_question_three
  `0069_daily.sql:460`/`:462`. Inspected bodies validate shape, not synthetic deferred
  score jobs. Drain/check before E nonetheless. The test-only deferred business/FK
  counterexample does NOT establish an equivalent production deferred payer exists.

Every family needs role/grant reachability, outer transaction owner, earliest lock,
G mode, affected events/reset edges, downstream trigger/FK graph and both-order tests.
This review seeds that manifest; it does not claim exhaustive catalog-verified closure.

## Tiny disposable semantic proof

Executed once from this checkout against local Docker PostgreSQL, session temp tables
and pg_temp functions only. No application schema read/write, fixture, real service,
performance harness or Vitest. The exact command follows. psql exits 0 because expected
error sections deliberately disable ON_ERROR_STOP; exit code alone is not the verdict.

```powershell
@'
\set ON_ERROR_STOP on
SELECT version();
CREATE TEMP TABLE review_state(phase text, dirty integer, finalized integer, jobs integer);
INSERT INTO review_state VALUES ('open',0,0,0);
CREATE TEMP TABLE review_source(value integer);
INSERT INTO review_source VALUES (0);
CREATE TEMP TABLE review_pending(transaction_id bigint PRIMARY KEY);
CREATE TEMP TABLE review_jobs(remaining integer);
CREATE FUNCTION pg_temp.review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT phase FROM review_state) <> 'open' THEN
    RAISE EXCEPTION 'source denied before tuple lock' USING ERRCODE='42501';
  END IF;
  UPDATE review_state SET dirty=dirty+1;
  INSERT INTO review_pending VALUES(txid_current()) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER review_guard BEFORE UPDATE ON review_source FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.review_guard();
CREATE FUNCTION pg_temp.review_assert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT FROM review_state WHERE phase<>'finalized' OR dirty<>finalized) THEN
    RAISE EXCEPTION 'mandatory finalization missing or stale' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER review_assert AFTER INSERT ON review_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.review_assert();
CREATE FUNCTION pg_temp.review_business() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE review_source SET value=value+1;
  UPDATE review_state SET jobs=jobs+1;
  IF NEW.remaining>0 THEN INSERT INTO review_jobs VALUES(NEW.remaining-1); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER review_business AFTER INSERT ON review_jobs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.review_business();
CREATE FUNCTION pg_temp.review_finish() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET CONSTRAINTS review_business IMMEDIATE;
  UPDATE review_state SET phase='sealed';
  PERFORM pg_advisory_xact_lock(9503,1);
  UPDATE review_state SET finalized=dirty,phase='finalized';
END $$;
\echo CASE_1_SELECTIVE_DRAIN_REARM
BEGIN;
UPDATE review_source SET value=value+1;
INSERT INTO review_jobs VALUES(2);
SELECT pg_temp.review_finish();
SELECT * FROM review_state;
COMMIT;
SELECT value FROM review_source;
\set ON_ERROR_STOP off
\echo CASE_2_OMITTED_FINALIZER
BEGIN;
UPDATE review_state SET phase='open';
UPDATE review_source SET value=value+10;
COMMIT;
SELECT value FROM review_source;
\echo CASE_3_PREMATURE_ALL_IMMEDIATE
BEGIN;
UPDATE review_state SET phase='open';
UPDATE review_source SET value=value+10;
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;
SELECT value FROM review_source;
\echo CASE_4_POST_FENCE_SOURCE
BEGIN;
UPDATE review_state SET phase='open';
UPDATE review_source SET value=value+10;
SELECT pg_temp.review_finish();
UPDATE review_source SET value=value+100;
ROLLBACK;
SELECT value FROM review_source;
\set ON_ERROR_STOP on
\echo CASE_5_PREMATURE_ASSERT_SAVEPOINT_RECOVERY
BEGIN;
UPDATE review_state SET phase='open';
UPDATE review_source SET value=value+1;
SAVEPOINT early_assert;
\set ON_ERROR_STOP off
SET CONSTRAINTS review_assert IMMEDIATE;
\set ON_ERROR_STOP on
ROLLBACK TO early_assert;
SELECT pg_temp.review_finish();
COMMIT;
SELECT value FROM review_source;
\echo CASE_6_ROLLBACK_FINALIZER_AND_OMIT
BEGIN;
UPDATE review_state SET phase='open';
UPDATE review_source SET value=value+10;
SAVEPOINT before_finish;
SELECT pg_temp.review_finish();
ROLLBACK TO before_finish;
\set ON_ERROR_STOP off
COMMIT;
\set ON_ERROR_STOP on
SELECT value FROM review_source;
SELECT count(*) AS remaining_fence_locks FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND classid=9503;
'@ | docker exec -i questifyapp-postgres-1 psql -X -U postgres -d postgres -v VERBOSITY=terse
```

Server: `PostgreSQL 17.11 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0)
15.2.0, 64-bit`. All CREATE statements succeeded. Exact material results:

| Case | Observed result |
| --- | --- |
| 1 selective drain/rearm | phase=finalized, dirty=4, finalized=4, jobs=3; COMMIT succeeds; value=4. Assertion marker queued before business callbacks. |
| 2 omitted finalizer | COMMIT: ERROR: mandatory finalization missing or stale; value remains 4. |
| 3 premature ALL IMMEDIATE | SET: ERROR: mandatory finalization missing or stale; ROLLBACK; value=4. |
| 4 post-fence source UPDATE | ERROR: source denied before tuple lock; ROLLBACK; value=4. No competing-backend lock-wait proof attempted. |
| 5 premature named assertion/savepoint | SET: ERROR: mandatory finalization missing or stale; ROLLBACK TO, explicit finalization and COMMIT succeed; value=5. |
| 6 rollback finalizer then omit | COMMIT: ERROR: mandatory finalization missing or stale; value remains 5; remaining_fence_locks=0. |

Only semantics are proved. Fixture-writable phase/state is NOT protected enforcement.
No real-source rollback, multi-event closure, FK locking, roles or timing is proved.

## Next bounded action; stop here

Coordinator decision first: authorize a design-only closed writer/lock/constraint
manifest and determine whether EVERY supported owner can adopt explicit pre-COMMIT
finalization with fail-closed DB enforcement. Resolve exclusive-G nesting and
business-free publication dependencies on paper. If any reachable owner/lock path
cannot obey, this terminal approach is infeasible under the unchanged contract;
return to full-source optimization/redesign, not callback-order tricks.

Only with separate authorization: one tiny real-source correctness proof, no 50k
timing. Include actual deferred checks plus rearmed synthetic work; omitted finalizer,
premature assertion and injected failure must roll back real business/publication;
two-backend pre-lock refusal, post-wait snapshot/commit order, sorted multi-event and
both-order global resets. Exhaustive writer coverage and unchanged performance gates
would still precede acceptance. This diagnosis starts no candidate.
