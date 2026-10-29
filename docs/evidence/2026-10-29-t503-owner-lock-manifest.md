# T-503 terminal boundary: owner/writer/constraint/pre-lock manifest

2026-10-29. DESIGN ONLY. **NO-GO under the unchanged contract; closure is not proved.**
This source-evidenced inventory records negative/unresolved entries, not a closed enforcement
certificate, new candidate, requirement waiver or performance claim.

## Authority and evidence boundary

- Initial HEAD `61b5368b8695343d22f47160f9086bfabd528513`; the uncommitted top STATE checkpoint
  authorized this manifest only. Read CLAUDE, WORKER_BRIEF, rules, QUALITY_BASELINE, the T-503 plan,
  ADR-359/360/361 and the independent boundary diagnosis before tracing source.
- During inspection another coordinator committed `842df54`, replacing that checkpoint, accepting
  ADR-362, superseding ADR-359/361 and deleting opt-in probes. This worker neither made nor undoes
  that reset. Preserve current coordinator text; it does not satisfy this unchanged-contract assignment.
  At final validation, concurrent uncommitted 0082_rank_push_organizer_alerts.sql and application/shared
  changes also appeared. Left untouched and NOT inventoried here: this report is bounded to inspected
  migrations 0001..0081, not a certificate for the evolving working tree. That drift itself blocks closure.
- Evaluate every committed crossing, source-time generations, canonical eligibility, atomic publication
  and no business-lock acquisition after E. Periodic/coalescing publication is outside this evaluation.
- **Covered** means located/inspected, not compliant with a new protocol. **Requires-change** identifies
  an absent hook/guard. **Unsupported-by-existing-contract** means preserving existing successful SQL
  behavior and the proposed boundary are unreconciled. **Unresolved** means no complete catalog/graph/
  race proof. Classifications overlap; no unknown entry is deemed harmless.
- Explicit outer selective draining is a defensible semantic hypothesis for controlled owners only.
  Universal adoption is not a drop-in wrapper fix: raw SQL, row-mark SQL, autocommit and owner work
  lack universal outer hooks/protected pre-lock walls. Do not start a correctness candidate yet.

References are repository-relative; migration prefixes identify files. Latest-by-name lexical discovery
was followed by source inspection, but is not signature-aware catalog closure.

## Transaction owners

| Owner/entry | Source and present boundary | Classification / obligation |
| --- | --- | --- |
| Requests/services | `apps/api/src/db/context.ts:42`: BEGIN, identity, callback, COMMIT :52. `db/connection.ts:7` only borrows/releases. | Covered; requires-change at actual outer COMMIT, including recorded refusals, no-op work and multi-event callbacks. Store hooks alone are insufficient. |
| Preidentity/promotion | `db/pre-identity.ts:89`, BEGIN :96, promotion settings, COMMIT :110; sign-up/sign-in/reset/session/invite callers. | Covered; requires-change before identity/invite/member locks, not after promotion. Membership/contact changes can affect other events; authentication-only work is not automatically dirty. |
| Staff-admin owner | `auth/staff-admin.ts:24` owner staff creation; inTransaction :84 commits :88. `auth/staff-store.ts:92` another staff insert. Owner trust explicit in `0005_harden_core.sql:35`. | Covered; requires-change outside request wrapper. Owner bypass is not protected enforcement. Staff creation alone need not alter team matching without membership/contact. |
| Background/system | `events/tick.ts:30` wraps each lifecycle call in request context {}; lifecycle/wipe/expiry/quiz/game/archive. `community/payer.ts:24/:34` wraps EACH batch; `rehearsal/service.ts:257` wipe calls. Further invitation/push/daily/questify ticks use system callbacks. | Covered family; requires-change per transaction, not per whole tick. Empty identity is not read-only. Full per-callsite transitive closure remains unresolved. |
| Practice | `db/context.ts:67` always ROLLBACKs; `operators/practice.ts:96` uses it. `0062:1114 operator_practice_scan` runs the real door in an exception subtransaction then undoes PX000. | Covered rollback owner: no committed publication. Marker/certificate/event set must roll back with subtransactions; preserve refusal colors. Direct SQL practice invocation still needs correct rollback semantics. |
| Direct app-role SQL | Table/column grants `0001:163` restricted by `0005:25-62`. `test/db/organizer-team.int.test.ts:63/:201/:229` executes caller/member SQL; `test/db/completion-engine.int.test.ts:47` calls complete_quest directly. | Covered surface; unsupported-by-existing-contract for an application-only finalizer. Existing successful BEGIN/source/COMMIT cannot silently become omitted-finalizer failure. Row-mark SELECT is not intercepted by DML guards. |
| Autocommit/function statements | `0058_kiosks.sql:327` kiosk_complete_quest has EXECUTE grant :361; other definer doors remain ordinarily callable through pg clients. withConnection does not impose BEGIN. | Supported SQL execution surface, not proof every successful door is currently used in autocommit. No universal explicit outer pre-COMMIT hook exists. Requiring BEGIN/finalize/COMMIT changes contract; finalizing in one function is too early for later expressions/triggers/doors. |
| SQL functions/nested payers | complete/operator/kiosk/tap, submission/quiz/game/passport/meeting, community and bulk run in caller transaction. | Covered; not separate commit owners. Guard earliest outer entry and callback closure; never finalize each nested payer or statement independently. |
| Maintenance/bootstrap/support | `db/migrate.ts:31` session advisory lock, :63/:70 per-migration BEGIN/COMMIT; `migrate-cli.ts:24` direct verification SQL; staff CLI/support owner trust in 0005. `test/support/test-db.ts:81` creates/migrates throwaway DBs. | Covered classes; unresolved operational contract. Owner DML, DDL/backfills/TRUNCATE/trigger disable/replication mode cannot be silently exempted. Maintenance exclusion and revalidation require a proved explicit contract. |

BEGIN/COMMIT search is not closure: enumerate Pool.query, Client.query, borrowed clients, CLIs,
function EXECUTE privileges, triggers, owner support and raw-SQL tests too. No transaction-control
interception layer appears in these wrappers.

## Ranking, eligibility, defaults, resets and cascades

Canonical dependencies: `0015_ranking.sql:36 organizer_team_players`, latest
`0026_operators.sql:139 ranking_eligible` / :149 ranked_enrollments, and
`0019_bans_and_exclusions.sql:204 excluded_from_event`. Active enrollment/player, positive score,
non-null version, team email matching, contact phone/domain exclusions and staff_assignment matter.
AfterCompletion, board/own/total, fallback and repair must remain equivalent. Scope/disable may affect
mail authorization without changing the current canonical team-email ranking predicate.

| Writer family | Located actual writers/doors | Dirty/reset obligation and status |
| --- | --- | --- |
| Ledger/score/version | `0015:10 apply_ledger_entry`, AFTER INSERT attachment `0012:107`; `0057:949 complete_quest` -> `0062:306 record_completion` -> `0055:391 pay_completion`, `0047:251 pay_category_bonus`, `0062:84 pay_first_bonus`. `0068:270 ledger_streak` fans into streak/XP/bonus. | Requires-change before outer door's first lock. Include initial score/version, actual changed enrollment OLD/NEW events and zero-score exits, not just scan result. Balance-only work still takes source locks. |
| Other payers | `0062:461 pay_submission`, :475 finish_quiz, :523 finish_game_round, :617 stamp_step, :721 pay_meeting; `0056:431 tap_quest`; `0030:316 operator_complete_quest`; `0058:327 kiosk_complete_quest`; `0053:483 pay_community_batch`; accept-all submissions/sweeps. | Located; requires-change. Nested completion/bonus/item/category/XP/notice calls are one transaction; full reverse caller/signature closure unresolved. |
| Join/enrollment | `0038:322 join_event` -> join_core -> `0037:167 join_write`; `0038:382 enroll_operator`, :454 join_rehearsal; `0036:376 set_enrollment_ban`, :479 decide_join_request; `0077:103 accept_all_join_requests`; `0031:605 set_redeem_pause`, `0037:284 set_goal`; raw `src/join/join.ts:649`. | Requires-change: I/U/D, status, player/event/organizer moves, rehearsal identity. Non-ranking fields are negative controls, not lock exemptions. Capture BOTH event sets on reassignment and rollback; owner/cascade writes count. |
| Award/spend/refund | `0032:950 bulk_award`, `0068:614 remove_award`, `0074:83 reserve_reward`, `0047:576 end_reservation`, :625 cancel_redemption, `0029:341 expire_one_reservation`. | Requires-change; refund/zero-score and stock changes cannot be assumed no-op. Actual ledger deltas/rows decide rank impact; ADR-360 counters need separate coverage. |
| Player/contact | `0038:169 create_player`, :263 confirm_contact_change, :742 erase_player -> `0076:1110 erase_rows`; guarded direct status/contact writes in 0005. Adjacent negative controls: `0016:209 rename_player`, `0026:391 reset_my_qr`, `0063:112 equip_player`. | Requires-change: status/delete, email/phone/identity affect all joined events/team matches. Username/avatar/QR are not eligibility predicates but display/privacy dependencies need separate closure. |
| Staff/team/operator/exclusion | `0008:229 complete_signup`, :363 accept_invite_new, :303 apply_invite, :288 swap_owner, :154 insert_organizer; `0005:126 transfer_ownership`; `0009:167 prune_event_scopes`; `0026:557 claim_operator_invite`, :604 set_operator, :658 remove_operator; `0019:133 add_exclusion`, :177 remove_exclusion; raw `src/organizers/team.ts:295/:350` and staff stores above. | Requires-change: I/U/D, membership/contact email matching, organizer moves and OLD/NEW staff/player links. Role/scope/disable also affect mail; do not invent absent staff-status rank predicates. Cross-event discovery must be stable under G. |
| Lifecycle/defaults | Raw `src/events/store.ts:209/:252/:290`, `join/setup.ts:439/:482`, `quests/quests.ts:299`, `results/results.ts:409`, `rewards/builder.ts:615`. `settings/store.ts:50` platform upsert, :76/:102 event JSON/version, :123/:145 entitlements; inheritance `settings/service.ts:119`. SQL `0009:102 end_event_early`, :128 advance_event_lifecycle; `0027:218 activate_event`, :280 set_event_player_limit; `0030:867 set_award_caps`, `0031:636 set_flag_hold`, `0075:42 archive_ended_events`. | Requires-change: off->on, effective inherited defaults, activation/archive and generation edges, including multiple changes in one transaction. Do not collapse to final JSON. Clock-only transitions need an explicit reset owner, not DML-only watching. Global defaults require exclusive G before settings lock. |
| Rehearsal/erasure/cascade | `0032:268 ensure_rehearsal_wiped` can call latest `0062:927 wipe_rehearsal`; `0032:384 erase_rehearsal` enters rehearsal_event_of first; `0038:742 erase_player` locks challenge/player/enrollments before `0076:1110 erase_rows` locks XP, deletes contacts/assignments/notices/notifications and changes enrollment. | Requires-change, nested global mode unresolved. Preserve tombstones/captured-id deletion/privacy. Enumerate every FK ON DELETE/UPDATE cascade/set-null and downstream trigger, including event/member/scope deletion. UPDATE-only hooks miss INSERT/DELETE. |

This is lexical/body evidence, not an ACL-aware exhaustive transitive closure. ADR-360 still needs
its full seven-alert producer/counter/claim graph: physical/code stock, reservations, caps/totals,
threshold revisions, membership generations, revocation and final scope/staff/opt-out authorization.
That graph is not certified here. Transport stays OFF, automatic retry allowlist empty.

## Earliest locks and G mode

G/E are proposed protocol locks, not production locks. Fix G mode BEFORE the first reachable
business lock, including initializers, validation, RLS/definer helpers, FKs and implicit relation locks.
Acquire sorted E once over the complete event set, only after drain/seal.

| Entry | Concrete early lock evidence (earlier transitive locks may exist) | Mode / missing proof |
| --- | --- | --- |
| Plain completion | `0062:339` ensure_rehearsal_wiped, :340 enrollment FOR NO KEY UPDATE; helper `0032:282` rehearsal FOR SHARE or calls wipe. | Shared G only if global effects excluded before entry; otherwise exclusive from outset. Guarding ledger trigger is too late. |
| Operator/kiosk | `0030:334` assignment FOR SHARE; `0058:334` paired_device FOR SHARE, before rehearsal/payer. | G must precede device/operator authorization too. |
| NFC/game/passport/meeting | NFC `0056:449` rehearsal; game `0062:563/:564/:568` rehearsal/enrollment/game; stamp :646/:648 rehearsal/enrollment; meeting :730 items, :735 device advisory locks. | Outer entry/initializer graph unresolved. First lock in pay_meeting is not necessarily first in its caller. |
| Bonus/items/fanout | `0062:103` first-bonus shared advisory, :112 slot FOR UPDATE SKIP LOCKED; `0047:238 lock_quest_items`; ledger UPDATE enrollment, streak/XP trigger chain. | Never invoke after seal/E. SKIP LOCKED is not a publication-safe lock exception. |
| Join/bulk/community | `0038:342` event FOR SHARE; community `0053:498/:507` rehearsal, :515 job locks, :521 sorted enrollment; bulk `0032:973` rehearsal, :1016 enrollment order. | Shared only with fixed scope/no global nested reset. Complete multi-event discovery before E; never add smaller E later. |
| Reward/refund | reserve `0074:111/:112/:135/:180`: rehearsal/enrollment/reward/code; end_reservation `0047:588-592`: rehearsal/enrollment/reward/item/redemption. | Requires-change at earliest caller, not just refund helper. |
| Global/default/reset | erase `0038:754/:763/:768`: challenge/player/enrollment; `0076:1113` XP; wipe `0062:936/:942` rehearsal/enrollments; `settings/store.ts:37/:62` settings/event FOR UPDATE. | Exclusive G before these for global impact; late shared-to-exclusive upgrade is not acceptable. |
| Other initial advisory locks | `src/auth/outbound.ts:24`, `players/sign-in-limits.ts:109`, `tickets/routes.ts:182`; migration session advisory `db/migrate.ts:31`. | Trace whether later callback work reaches a source. G at the later source can invert order. Migration lock is not G. |
| Raw SQL/relation/row marks | Granted DML, SELECT ... FOR UPDATE/SHARE, RI checks, referenced table/index relation locks. | Unsupported pre-lock closure with DML triggers alone. BEFORE ROW cannot guarantee refusal before tuple lock; BEFORE STATEMENT cannot precede initial statement relation locks. Row-mark SELECT fires no DML trigger. |

**Nested global blocker:** ensure_rehearsal_wiped can discover go-live wipe during ordinary completion.
Erasure reaches XP and all enrolled events; meeting pays two players; batch/lifecycle can span events.
If these require exclusive G, the outer owner must choose it before business locks. Preflight under shared
G then upgrade is insufficient: state can change while waiting; concurrent upgrades can deadlock.
Exclusive G for every potentially affected call changes serialization/cost and needs unchanged-gate proof.
An alternative proving an event-local wipe safe under shared G needs the global/XP graph and both orders;
none exists here. No rare/rehearsal-only path is waived.

## Actual deferred constraints and publication back-edges

Static migrations 0001..0081 contain exactly four CREATE CONSTRAINT TRIGGER declarations:

| Name / table | Definition and body | Deferred work |
| --- | --- | --- |
| quest_passport_steps / quest | `0045_passport.sql:140`, callback :133 -> passport_shape_check :121 | AFTER INSERT or UPDATE OF type_config with passport WHEN; reads quest/passport_step, raises QT422 on insufficient steps. |
| passport_step_shape / passport_step | `0045:150`, callback :143 -> same checker | AFTER DELETE, validates OLD.quest_id. |
| daily_challenge_three / daily_challenge | `0069_daily.sql:460`, checker :441 | AFTER INSERT; reads challenge/questions, exactly three when parent remains. |
| daily_challenge_question_three / daily_challenge_question | `0069:462`, same checker | AFTER INSERT/DELETE, OLD/NEW challenge; both daily triggers ENABLE ALWAYS :464/:465. |

All four DEFERRABLE INITIALLY DEFERRED. No DEFERRABLE FK declaration or later named DROP of these
four was found. Ordinary FKs still have internal RI triggers/locks. This is NOT a live catalog count:
there was no application schema to inspect. Bodies validate shape, not a production deferred payer.
Diagnosis synthetic rearmed callbacks demonstrate semantics, not a fifth production constraint.

Immediate fanout matters too: ledger AFTER INSERT apply_ledger_entry (`0012:107`, latest `0015:10`),
ledger_streak (`0068:270/:279`), enrollment_push_decision (`0077:89`), submission/result/reward/event
producers and downstream FKs. Finish all business callbacks, shape/RI checks before E, not merely before
assertion. Use a schema-qualified drain allowlist including every same-named constraint selected by
SET CONSTRAINTS. Unknown additions fail readiness closed. Trigger enabled modes still need catalog proof.

No production T-503 publication schema exists in the inspected 0001..0081 snapshot, hence no actual
T-503 FK graph can be certified. Concurrent uncommitted 0082 is outside this inventory, not absent.
Known reusable path: `0077:38 notice_create` inserts notice with unique dedupe and reads event. Notice
in `0076_push.sql:46` references notice_kind (:48), and event(id,organizer_id) ON DELETE CASCADE (:63).
It is NOT business-free because player_id lacks an FK there. Notification/device/send add player,
notification and device FKs (`0076:94/:121/:134/:135`); fanout cannot be presumed safe inside E.
Parent key-share checks, unique conflicts, publication relation/index locks and triggers can wait after E.
Differentiate compatible non-key updates from conflicting key updates/deletion; not all parent UPDATEs
conflict. Actual event FK is a concrete back-edge, not proof that every FK check can be pre-held.

For EVERY proposed projection/snapshot/fact/inbox/revision/certificate write enumerate parent FKs,
unique/exclusion indexes, defaults, generated expressions, policies, triggers and functions. Hold all
necessary stable business-parent protection BEFORE seal, or prove a business-free publication structure
preserving tenant/FK/erasure semantics. Do not drop constraints for timing. Include event DELETE CASCADE,
reassignment and reverse-order erasure. New publication dependencies are unresolved until specified.

## Required protected protocol (not installed)

1. **Open:** fix/acquire G before business locking. Protected transactional metadata records full
   transaction identity, exact dirty events, generations and monotonic dirty epoch. Every reachable
   source/authorization/row-mark path participates before its first prohibited lock. Capture moves,
   cascades and multiple in-transaction generation/reset edges.
2. **Drain:** explicit OUTER owner, before E, makes complete named business allowlist IMMEDIATE,
   excluding mandatory assertion. Prove callback rearming reaches quiescence; keeping business checks
   immediate executes later rearming before seal. Exclude assertion even if caller previously changed
   its mode. COMMIT callback is not this earlier barrier: preserve the automatic candidate failure.
3. **Seal:** inaccessible transactional certificate records drained epoch/events/schema version/phase.
   Reject subsequent source entry BEFORE business locks; allow only controlled publication transitions.
   Caller-writable GUC, temp table, advisory lock, app.is_admin setting or E ownership is NOT proof.
4. **Publish:** sorted E once, then freshly read authoritative committed predecessor state after waits;
   persist every ordered fact atomically with source. No remaining business callback/row/advisory/FK
   back-edge may be discovered. Complete event membership must already be sealed.
5. **Assert:** always-effective protected deferred assertion verifies drain/seal/published epoch and
   generations at COMMIT. Metadata/publication-only verification: no drain/republish/business locks.
   Omission/stale certificate/failure aborts source and facts together. Dirty source cannot omit marker.

Require non-app-owned schema/table, revoked PUBLIC/app DML/TRUNCATE/DDL, fixed definer owner/search_path,
qualified objects and no caller-supplied identity. Full transaction identity cannot alias across xid
wrap/reuse, backend/pool reuse or savepoint rollback. Only guarded internal paths can update state.
Prove app-role inability to call certificate writers, replace/shadow functions via temp objects, spoof
phase/epoch, delete markers or bypass triggers. Include roles, memberships, enablement and reachable
definers in inventory. Owner/superuser can alter enforcement: an explicit maintenance trust/exclusion
contract is needed, not a claim that protected tables make the owner untrusted-proof.

**Premature assertion/savepoints:** named assertion or ALL IMMEDIATE before seal must fail, never
auto-finalize. Catch/ROLLBACK TO restores metadata and constraint state; normal finalization can follow.
Rolling back a successful finalizer must roll back seal/facts/revision/assertion satisfaction too; COMMIT
without refinalizing must fail if earlier source changes remain. Wholly undone source leaves no dirty
certificate/facts. Assertion mode already immediate after legitimate seal does not excuse later source:
refuse at pre-lock wall, not merely assertion. PL/pgSQL exception/practice blocks are subtransactions.
The six independent diagnosis cases prove temporary-object semantics, NOT protected enforcement.

**READ COMMITTED:** do not reuse pre-wait CTE, STABLE function/outer-statement snapshot, cached board
or pre-wait eligibility after acquiring E/G. Separate wait and fresh authoritative read commands with
proved snapshot behavior; VOLATILE labeling alone is not proof. Re-evaluate defaults/lifecycle/full
event membership after G wait; after E wait observe previous committed source/publication plus own
writes. Wrappers do not fix isolation: server default does not certify every raw caller. Reject or
explicitly support other isolation levels; READ COMMITTED is the proof target. Two-backend tests need
both orders, rolled-back predecessor, moved OLD/NEW events and stale-generation refusal. None ran here.

## Reproducible inventory and fail-closed drift gate

Read-only local Docker check: questifyapp-postgres-1, database postgres, PostgreSQL 17.11. Roles:
postgres superuser/bypass; questify_app and questify_outsider neither. Only postgres is connectable
and non-template. **Zero public application tables**, zero deferrable constraints, zero user deferred
triggers there. EMPTY catalog is not production absence evidence. Harness creates/migrates disposable
DBs (`test/support/test-db.ts:81/:90/:102`); none was available. No database creation, migrations,
fixtures or application writes were run. Live schema/ACL/RLS/trigger equivalence is unresolved.

Static procedure used: sorted all migration filenames; searched CREATE/REPLACE/DROP/ALTER functions,
constraint triggers/DEFERRABLE/FKs/GRANT/REVOKE; scanned latest named bodies for DML/locks and non-test
TypeScript for owners/direct DML; inspected cited bodies/security callsites. Regex latest-by-name
is discovery only: overloads, DROP/rename, effective ACL, dynamic SQL and execution order need actual
reconciliation. No dynamic EXECUTE body candidate appeared in that lexical pass, not a parser proof.

81 SQL migrations 0001..0081. SHA-256 over sorted filename, NUL, raw file bytes, NUL per file:
`c7bb0b0ecd255163d42961c4c688e70f9a1f3be03dae0f4c405517baaab9e552`. Independent diagnosis SHA-256:
`d0134ed88029eaf1651dabd9f3718c37ea428c607a00444ff10a60d4a410906b`; left unchanged. Historical probe
references resolve at 61b5368, not 842df54 which removed them. Reproduce static discovery from root:

```powershell
$migrations = Get-ChildItem apps/api/migrations -Filter *.sql | Sort-Object Name
$migrations | Select-String -Pattern 'CREATE.*FUNCTION|DROP.*FUNCTION|ALTER.*FUNCTION|CONSTRAINT TRIGGER|DEFERRABLE|REFERENCES|GRANT|REVOKE|CREATE.*TRIGGER|ENABLE ALWAYS'
$migrations | Select-String -Pattern 'INSERT INTO|UPDATE |DELETE FROM|TRUNCATE|FOR.*UPDATE|FOR.*SHARE|pg_advisory|LOCK TABLE'
Get-ChildItem apps/api/src -Recurse -Filter *.ts | Where-Object Name -NotLike '*.test.ts' |
  Select-String -Pattern 'BEGIN|COMMIT|ROLLBACK|query\(|withRequestContext|withPreIdentityContext|withRolledBackContext'
```

Reproduce bounded catalog discovery without mutating a service (not a complete closure export):

```powershell
@'
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database(), version(), current_user;
SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY 1;
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1;
SELECT conrelid::regclass, conname, contype, condeferrable, condeferred,
       pg_get_constraintdef(oid)
FROM pg_constraint WHERE condeferrable ORDER BY 1, 2;
SELECT tgrelid::regclass, tgname, tgenabled, tgdeferrable, tginitdeferred,
       pg_get_triggerdef(oid)
FROM pg_trigger WHERE NOT tgisinternal AND tgdeferrable ORDER BY 1, 2;
SELECT n.nspname, count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE c.relkind='r' GROUP BY 1 ORDER BY 1;
ROLLBACK;
'@ | docker exec -i questifyapp-postgres-1 psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -P pager=off
```

Before closure, use an already available fully migrated disposable catalog (separate authorization
if one must be created), one consistent read-only snapshot and matching schema-version checks. Export
deterministically ordered exact schema/table/partition/view and FUNCTION SIGNATURE identities:

- schema_migration checksums vs source; `pg_proc` bodies/language/volatility/security/owner/proconfig/
  proacl; `pg_roles`, `pg_auth_members` inheritance and privileges.
- `pg_class`, `pg_attribute` column ACLs, `pg_attrdef`, `pg_index`, `pg_constraint` including immediate
  internal FKs, incoming cascades/key columns/validation/deferral; partition ancestry.
- ALL `pg_trigger` rows, including internal RI, enabled modes, WHEN and body dependencies; `pg_rewrite`,
  `pg_policy`, RLS flags, `pg_default_acl`, schema privileges, PUBLIC grants and owner bypass.
- `pg_depend`/rewrite edges PLUS manual SQL/PLpgSQL/dynamic-SQL reverse graph, defaults, casts/operators,
  generated expressions and triggers. Dependency catalogs alone miss function body references.
- Effective app table/COLUMN privileges and EXECUTE for every signature, PUBLIC/inherited reachability,
  policy-callable definers, database settings/isolation and maintenance bypass routes; expected positive
  and denied access, not only explicit GRANT text.

Map each reachable door: owner -> first relation/row/advisory lock -> G mode -> DML/trigger/FK graph ->
dirty/reset events -> drain name -> publication back-edge -> assertion. Every edge ends in reviewed node
or evidenced no-effect/no-lock leaf. Unknown/missing/renamed function, changed body/checksum/trigger mode,
new grant/deferred name/cascade/partition/policy/owner fails readiness closed, not only when exercised.
Bind seal inventory version to the reviewed graph. Startup/migration readiness checks PLUS a proved
maintenance exclusion must prevent concurrent out-of-band DDL; startup hashes alone have a TOCTOU gap.
No such drift enforcement exists today. This report is not a catalog-certified allowlist.

## Exact blockers and next smallest action

1. **Unsupported-by-existing-contract:** direct SQL/autocommit has no outer-finalization handshake;
   row-mark SQL and initial relation locks escape a DML-trigger fence. Error after waiting is not
   pre-lock refusal. Wrapper changes cannot fix this; silently denying successful SQL is a contract change.
2. **Requires-change / unresolved:** outer owners/reverse callers/nested resets lack fixed-before-lock
   G mode. Concrete completion->rehearsal->wipe and erase_player->XP/events defeat blanket shared G.
   No exhaustive multi-event or both-order graph proof exists.
3. **Requires-change:** no protected transaction certificate, mandatory assertion or schema-drift gate
   installed. GUC/temp-object semantics are not app-role tamper/subtransaction safety proofs.
4. **Unresolved:** empty catalog cannot certify effective grants, latest bodies, four-trigger count,
   FK/cascade closure or publication dependencies; the concurrent publication schema is not inventoried.
5. **Unresolved:** post-wait freshness, business-free publication, durability and full source-through-
   COMMIT <3 ms hard / <=1.5 ms target at unchanged load remain unproved. Old red evidence stands.
6. **Authority conflict:** concurrent 842df54 adopts another contract; not a waiver or authorization
   to restore/build this historical protocol. No ADR/Q status or T-503 completion changed here.

**Next is contract/catalog reconciliation, not an executable correctness candidate.** Resolve raw-SQL/
pre-lock and fixed-G obligations and provide matching read-only catalog inventory. If impossible without
weakening the assignment, stop this approach; only an explicitly authorized alternative can proceed.
After closure ONLY, a tiny real-source proof could defensibly combine actual completion, all four named
deferred checks and rearmed synthetic work; protected omission/premature assertion/savepoint rollback;
two-backend pre-lock refusal/post-wait freshness/sorted multi-event/both-order resets, with injected
failure rolling back source AND facts. It still would not prove performance/exhaustive writers. Not started.
