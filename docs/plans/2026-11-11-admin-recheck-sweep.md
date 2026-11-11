# Audit hardening, admin re-check sweep (plan, tier A: admin powers, tenant isolation)

Source: docs/FOLLOWUPS.md:112-118 (0189 hunter-tenant 4 and its CTO NIT; 0190 w2-seats 2 and its CTO NIT). Migration **0191** (0190 is the newest; 0156 stays reserved). TypeScript: test fixtures only, plus two entries leaving `test/db/sql-settings-allowlist.json`. No new table, grant, route or string. Delivers no FR. No ADR: one docs/rules.md line instead (CLAUDE.md coordinator rule 8: a finding that repeats becomes a check).

**Done when:** the admin flag without an active admin account behind it opens no row-level policy and no trigger or definer gate. Every policy asks `(SELECT app_admin_id()) IS NOT NULL`, which runs once per query, not once per row. A catalog test fails on any new bare `app_is_admin()` outside a fixed list of four refusals. A device seat passes no `ranking_system()` gate.

**Order.** (1) failing tests (section 4), (2) 0191 and the fixture fixes, (3) hand mutants (section 5), (4) docs. After step 2, run: the touched suites, `test/security/*`, `test/db/hot-path-plpgsql.int.test.ts`, then the full DB suite once into a log. 52 test contexts set `{ isAdmin: true }` with no `staffUserId`. Most of them expect a refusal, but some depend on the flag alone.

## 1. Latest definitions (all of `apps/api/migrations` searched up to 0190)

I did this textually; there is no migrated database locally. The catalog test in section 4, run on 0190, is the arbiter: its failure list must equal this table.

| Object | Latest | Today |
|---|---|---|
| `app_is_admin()` | 0001:21 (`sql STABLE`, inlined) | reads `app.is_admin` only |
| `app_admin_id()` | 0027:17 (`sql STABLE SECURITY DEFINER SET`, allowlist :22) | flag + `staff_user` admin, active; never inlined, so it runs once per row in a policy |
| 42 policies with bare `app_is_admin()` | staff_user_own 0114:18; player_own 0019:9; event_read 0008:58, event_write 0008:66, event_update 0008:68, event_delete 0009:96; enrollment_read 0008:77, enrollment_insert 0018:11, enrollment_update 0019:56; member_read 0005:147, member_update 0005:153, member_delete 0008:126; player_contact_own 0005:24; entitlement_insert 0003:44, entitlement_delete 0003:46; audit_insert 0006:34, audit_read 0008:112; session_read 0002:74; acceptance_read 0008:144; invite_read 0008:278; category_member 0010:123, quest_member 0010:126; quest_completion_read 0012:118, ledger_entry_read 0012:122; event_exclusion_read 0019:125; reward_member 0024:133, redemption_read 0024:136; reward_code_read 0025:90; staff_assignment_read 0026:103, operator_invite_read 0026:108; activation_request_read 0027:41, limit_alert_read 0027:59; event_join_field_team 0028:86, join_answer_read 0028:111, event_guest_team 0028:156; bulk_award_read 0030:124, ledger_note_read 0030:126; event_rehearsal_read 0032:54; rank_prize_member 0034:82; passport_step_member 0045:77; quest_item_member 0047:41; content_hold_team 0121:49 | flag alone grants |
| already gone | organizer_insert/update (dropped 0114:11-12), member_tenant (0005:145), member_insert (0008:121), platform_setting_* (0134:13-19), translation_* (0116:13-18) | nothing to do |
| 11 policies with bare `app_admin_id()` | translation_insert/update/delete 0116:13,15,17; platform_setting_insert/update 0134:15,17; feature_override_read/insert/update/delete 0136:33,36,38,40; feature_request_read 0189:63 (ALTER), feature_request_close 0141:243 | re-checked, but one query per row (feature_override_read is on the public config read) |
| trigger guards | enrollment_status_guard 0019:37 (flag :44); event_spend_rank_guard 0025:14 (:19); player_status_guard 0038:13 (:19); rank_prize_guard 0034:106 (:115) | flag alone grants |
| `results_frozen(uuid)` | 0034:89 (`sql` definer, flag :92, allowlist :361) | flag alone reads any event's result |
| refusals on the flag | `ranking_system` 0015:84 (`NOT app_is_admin()`); `souvenir_event` 0064:177; `invitation_team_event` 0073:435 (`OR app_is_admin()` → refuse) | **stay bare**: `app_admin_id()` would refuse *fewer* seats |
| done in 0189 | add_reward_codes 0189:72, end_event_early :126, operator_event_of :152, create_operator_invites :160, revoke_operator_invite :216, set_operator :245, remove_operator :298 | `app_admin_id() IS NOT NULL` (0189 bodies hold no `app_is_admin()`, only comments outside `$$` at :69, :122) |
| `ranking_system()` | 0015:81 (`sql` definer, allowlist :343) | a device seat passes |
| `preview_device` | 0189:329 (operator branch :337-346) | two `staff_assignment` reads; the table has UNIQUE (event_id, player_id), 0026 |
| `play_event_id` | 0190:24 (`found uuid` :27) | local `found` shadows PL/pgSQL `FOUND` |

`ranking_system()` call sites, latest definitions. FOLLOWUPS' "18" counts text lines, including the superseded 0015:103, 0041:579 and 0095:15.

| # | Gate | Device-aware today | Test that covers it |
|---|---|---|---|
| 1-3 | claim_ranking_repairs 0015:114, live_ranking_events 0015:125, ranking_entries 0015:188 | no | db/ranking.int.test.ts:292-301 (seat loop) + device row (new) |
| 4-5 | ranking_today 0035:53, ranking_day_entries 0035:62 | no | db/today-ranking.int.test.ts + device row (new) |
| 6 | finish_one_due_quiz 0098:1275 (RETURN NULL) | no | db/vote-quiz.int.test.ts + device (new) |
| 7 | close_one_due_round 0050:463 (RETURN NULL) | no | db/games.int.test.ts:721 + device (new) |
| 8 | community_system_only 0053:200 (CS403), called by community_tick_goals 0053:421, community_health 0053:458, settle_goal 0141:59, pay_community_batch 0114:607 | no | db/community.int.test.ts:562-585 + device (new) |
| 9 | review_demo_tick 0144:893 (RD403) | no | db/review-demo.int.test.ts:606 + device (new) |
| 10-14 | souvenir_system_only 0064:163, marketing_audience 0073:118, invitation_system_only 0073:264, push_system_only 0076:179, mark_ranking_repair 0190:78 | yes, locally | db/ranking-repair-seats.int.test.ts:141-142, souvenirs, invitation, push suites (unchanged, must stay green) |

No device path reaches 1-9. The app runs them in `{}` (src/ranking/ranking.ts:101-123, :582, :698; src/events/tick.ts:63; src/plays/quizzes.ts:219). The big screen reads `screen_ranking` (0109:284), which does not use `ranking_system()`. Device contexts are only src/devices/kiosk.ts:171, src/devices/devices.ts:202 and :296, and src/screen/scenes.ts:63.

## 2. Verdicts
- **Sweep: real, defence in depth.** Every `isAdmin: true` context in src carries the admin's `staffUserId` (16 sites, e.g. src/console/doors.ts:79, src/activation/service.ts:144-145).
- **Restatement: explicit `ALTER POLICY ... USING/WITH CHECK`.** It keeps the name, command and roles, and each statement can be diffed against its source line. Two alternatives are rejected:
  - **A catalog `DO` block with `regexp_replace` + `EXECUTE`:** it rewrites deparsed text and nothing can be diffed.
  - **Redefining `app_is_admin()` to re-check:** it would weaken the three refusals, it would recurse in `app_admin_id()`, and every inlined use would become a definer call.
- **Performance: the initplan form is required, not optional.** Today `app_is_admin()` inlines to a `current_setting` compare. A bare `app_admin_id()` (definer + SET: never inlined, planned on every call, rules.md:66-73) would run once per row whenever the earlier OR branches are false. That is every row a player reads in `ledger_entry_read` or `quest_completion_read`, and every row an admin reads. `(SELECT app_admin_id()) IS NOT NULL` is an uncorrelated InitPlan: once per query. Definer and trigger gates call it once in an `IF` and keep the bare form.
- **Refusals stay bare** (allowlisted with reasons): `ranking_system`, `souvenir_event`, `invitation_team_event`. `app_admin_id` itself is also allowlisted (it is the re-check).
- **`ranking_system()` device: real, defence in depth.** Fix it once in the function. The five local predicates (rows 10-14) stay; they are redundant but harmless, and removing them is churn.
- **Recursion check:** staff_user is FORCE RLS (0001:114), and `staff_user_own` will call `app_admin_id()`, which reads staff_user. This is safe only because the migration owner is a superuser (OPEN_QUESTIONS.md:436, RUNBOOK.md:1329). Say so in the 0191 header.

## 3. Migration 0191 (`SET LOCAL lock_timeout = '10s'`; the header lists each object and its source file:line)
### 3.1 Policies (53 `ALTER POLICY`)
- For the 42 policies: restate each USING and WITH CHECK verbatim from its source, changing only `app_is_admin()` to `(SELECT app_admin_id()) IS NOT NULL`.
- In `audit_insert`, keep `AND actor_id = app_staff_user_id()`.
- For the 11 policies: change only `app_admin_id() IS NOT NULL` to `(SELECT app_admin_id()) IS NOT NULL`.
- Group the statements by source migration, one comment line each.
### 3.2 Guards and `results_frozen`
- `CREATE OR REPLACE` enrollment_status_guard (from 0019), event_spend_rank_guard (0025), player_status_guard (0038) and rank_prize_guard (0034). Change only the flag: `IF app_admin_id() IS NOT NULL`, `NOT (app_admin_id() IS NOT NULL OR ...)`, `AND app_admin_id() IS NULL`, `OR app_admin_id() IS NOT NULL`.
- Triggers keep their bindings (same function names).
- `results_frozen`: PL/pgSQL with the same signature and grants: `SELECT EXISTS (...) INTO frozen; RETURN frozen;` with `OR app_admin_id() IS NOT NULL`. Delete its allowlist entry (hot-path-plpgsql.int.test.ts:364-375 requires that both lists match exactly).
### 3.3 `ranking_system()` (from 0015)
PL/pgSQL `STABLE SECURITY DEFINER SET search_path = public, pg_temp`: `RETURN app_player_id() IS NULL AND app_organizer_id() IS NULL AND app_staff_user_id() IS NULL AND app_device_id() IS NULL AND NOT app_is_admin();` (the flag stays bare: it is a refusal).
- Delete the allowlist entry at :343.
- Callers that use `WHERE ranking_system()` keep it as a one-time filter (no Vars).
- `app_device_id()` (0057:118) already exists.
### 3.4 `preview_device` (from 0189)
- In the operator branch, add `DECLARE granted text[];` and read once: `SELECT sa.abilities INTO granted FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = app_player_id();`
- Then `IF NOT FOUND THEN` OP403, `IF NOT (granted && ARRAY['scan_quests','show_rotating_qr']) THEN` OA403. `abilities` is NOT NULL.
- The rest of the function is verbatim.
### 3.5 `play_event_id` (from 0190)
Rename the local `found` to `owner_event`; nothing else changes. Other record variables named `found` (e.g. 0189:250, :302) use `found.id IS NULL`, never `FOUND`; leave them.

## 4. Tests (written first, failing on 0190)
- **New `test/db/admin-recheck-catalog.int.test.ts`:**
  - (a) `pg_policies` (public): no `qual`/`with_check` matches `app_is_admin\(\)`.
  - (b) In every policy, `regexp_count(txt,'app_admin_id\(\)') = regexp_count(txt,'SELECT app_admin_id\(\)')` (the deparsed form is `( SELECT app_admin_id() AS app_admin_id)`).
  - (c) The `pg_proc` public functions whose `prosrc` matches `app_is_admin\(\)` equal exactly `{app_admin_id, ranking_system, souvenir_event, invitation_team_event}`, each with its reason. Check both directions, as hot-path :373-374 does.
  - (d) `pg_views.definition` has none.
  - (e) Call count, following the hot-path :248-269 `pg_stat_get_xact_function_calls` pattern: a player reading 20 `ledger_entry` rows and an admin reading 20 rows call `app_admin_id` at most once per policy reference, not 20 times.
- **`test/security/cross-tenant.int.test.ts`:** a second `describe.each(probes)` with `contextFor(f, seat)` plus `isAdmin: true` (the flag forged on A's seat). It reuses the three assertions (:644, :653, :665), so the flag alone shows and changes none of B's rows on every owned table.
- **The same new file, for shared tables:** a forged seat (`{isAdmin:true}`, `{isAdmin:true, staffUserId: ownerA}`) reads no other `staff_user`, `staff_session` or `organizer_acceptance` row, cannot write `event_entitlement` (42501), and gets `results_frozen` = false for B's frozen event. A real admin reads and writes each.
- **Guards:**
  - core-columns.int.test.ts:142: a flag-only unban is now refused, and a real admin unbans (fix the fixture).
  - shop-window.int.test.ts: an editor of A with the flag changing `spend_lowers_rank` gets QO403.
  - The rank prize suite (results.int.test.ts): a forged flag on another org's prize skips the guard and is refused by `rank_prize_member`.
  - player_status_guard is unreachable through grants (core-columns :150-156); the catalog covers it.
- **Device seat:** in ranking-repair-seats.int.test.ts, add a table over gates 1-9, using its paired kiosk (:141) and a `randomUUID()` device. Each gate refuses with its own answer (empty, NULL, CS403, RD403); `{}` still passes; ranking.int.test.ts:297 (flag-only refused) stays.
- **preview_device:** the db/devices.int.test.ts OP403/OA403 cases stay green; add a non-operator player (OP403, not OA403).
- **Green with no edits:** souvenirs, invitation, push, maintenance-doors, suspension-doors, outsider, and all console-* suites. A console test that used a flag-only admin to *read* gets a real admin and states that the flag-only seat is refused.

## 5. Hand mutants (each must turn a section 4 test red)
- Put back bare `app_is_admin()` in one read policy (`ledger_entry_read`) and in one write policy (`enrollment_update`).
- Drop the `SELECT` wrapper in one policy.
- Put back the flag in each of the four guards and in `results_frozen`.
- Remove `AND app_device_id() IS NULL`.
- Change `NOT app_is_admin()` in `ranking_system` to `app_admin_id() IS NULL`. The flag-only seat at ranking.int.test.ts:297 must then pass the gate, so that test goes red.
- Add an allowlisted name to the catalog set and remove one from it.
- In `preview_device`, test `FOUND` after the ability check; drop `IF NOT FOUND`.

## 6. Risks
- **Locks:** 53 `ALTER POLICY` take ACCESS EXCLUSIVE on ~40 tables (event, enrollment, ledger_entry, quest_completion, player) until commit. The migrator retries a 55P03/40P01 (src/db/migrate.ts:101-114). Deploy in a quiet window.
- **Fixtures:** test fixtures that used the flag alone break. Fix each with a real admin; never weaken the assertion.
- **Support work** keeps working: it enters through support grants (ADR-407), not the flag (support-grant.int.test.ts:167 stays green).
- **Superuser owner:** if the owner ever loses superuser or BYPASSRLS, `app_admin_id()` reads no staff_user row and every admin is locked out (fail closed). Add this to RUNBOOK beside :1329.

## 7. Docs
- SECURITY.md: the V4 row (:260) becomes "every policy and gate re-checks the admin (0191)", plus the device seat note at :59.
- rules.md, near :60: "a policy asks `(SELECT app_admin_id()) IS NOT NULL`, never `app_is_admin()`; a system gate also refuses a device seat; held by `admin-recheck-catalog.int.test.ts`".
- RUNBOOK: the owner superuser note.
- FOLLOWUPS: strike lines 112, 113, 114 and the `found` half of 116.
- STATE.md.

### Critical Files for Implementation
- /home/deploy/questify-app/apps/api/migrations/0191_admin_recheck_sweep.sql (new; sources 0001, 0002, 0003, 0005, 0006, 0008, 0009, 0010, 0012, 0015, 0018, 0019, 0024-0028, 0030, 0032, 0034, 0038, 0045, 0047, 0116, 0121, 0134, 0136, 0141, 0189, 0190)
- /home/deploy/questify-app/apps/api/test/security/cross-tenant.int.test.ts (forged-flag probe pass, :1603, :2632)
- /home/deploy/questify-app/apps/api/test/db/hot-path-plpgsql.int.test.ts and /home/deploy/questify-app/apps/api/test/db/sql-settings-allowlist.json (remove `ranking_system()` :343, `results_frozen(target uuid)` :361)
- /home/deploy/questify-app/apps/api/test/db/ranking-repair-seats.int.test.ts (device seat table over the 9 gates)
- /home/deploy/questify-app/apps/api/test/db/core-columns.int.test.ts (:142 flag-only fixture)
## 8. Plan review (CTO, 84) and decisions

The coordinator's decisions on the review; where they differ from sections 1 to 7, they win.

1. **Locks (ADR-580, 0146:15-24).** `SET LOCAL lock_timeout = '1s'`, and one `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` of all touched tables at the top in a fixed order (coldest first; event, enrollment, ledger_entry, quest_completion, player, audit_log last). RUNBOOK: quiet window, never during a live event's peak, `--verify` after.
2. **`app_admin_id()` becomes PL/pgSQL** (rules.md:71), same signature and grants, early `RETURN NULL` when the flag is off, then `SELECT ... INTO`. Its allowlist entry (:22) leaves; it stays in catalog set (c). Mutant: `LANGUAGE sql` back turns the hot-path allowlist test red.
3. **Equivalence check in the migration.** Before the ALTERs, `CREATE TEMP TABLE before_0191 ON COMMIT DROP AS SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'`; after them a DO block raises unless every row equals the old text with only the flag (or the bare `app_admin_id() IS NOT NULL`) replaced by the exact deparsed initplan form, captured empirically first. Untouched policies must be identical.
4. `results_frozen` reads `admin boolean := app_admin_id() IS NOT NULL` first; no definer call inside the query.
5. Catalog (c) matches `pg_get_functiondef(p.oid)` (`prokind IN ('f','p')`) against `app_is_admin\(\)|app\.is_admin` (BEGIN ATOMIC bodies and raw settings); (d) also covers `pg_matviews`, `pg_trigger.tgqual`, `pg_constraint`, `pg_attrdef`.
6. Each of the three refusals: the flag appears exactly once and in its refusal form (`NOT app_is_admin()` in `ranking_system`; `OR app_is_admin() OR NOT EXISTS` in `souvenir_event`, `invitation_team_event`).
7. Test (e) runs as `questify_app` (`SET LOCAL ROLE questify_app` in the owner's transaction, `track_functions = 'all'`), on rows where the earlier OR branches are false (a player reading an event's ledger_entry where most rows are other players'; an admin reading 20 rows), with exact call counts.
8. **Fixtures.** Section 4's "console-* green with no edits" is wrong: about 50 flag-only sites in about 35 files (e.g. isolation.int.test.ts:110-111, cross-tenant.int.test.ts:2756, console-items:137, console-players:145). In step 2 list each file with a verdict (refusal stays, or needs a real admin); every changed one keeps the old flag-only line as a "now refused" assertion. Never weaken an assertion.
9. **Owner privilege.** Header wording: `staff_user_own` is `TO questify_app`, so no recursion; the superuser need is not new. Add a DO block (as 0053, RUNBOOK:1329) that raises when the migration owner is neither superuser nor BYPASSRLS.
10. Cross-tenant lines are :2632 (`describe.each`), :2644, :2653, :2665. `audit_insert` keeps the pure substitution. `player_status_guard`'s mutant is caught by catalog (c) only.
