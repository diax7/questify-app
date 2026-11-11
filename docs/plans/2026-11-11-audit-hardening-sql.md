# Audit hardening, SQL walls (plan, tier A: tenant isolation, admin powers)

Source: security audit run 1 hardening notes (hunter-tenant 1-5, hunter-auth 5). Migration: **0189** (0188 is the newest;
0156 stays reserved). Only one TypeScript change: two entries leave `test/db/sql-settings-allowlist.json`. No new table,
grant, route or string. Delivers no FR. Decisions: one Proposed ADR for the ability choice in 3.4.

**Done when:** a scoped editor reads nothing of another event through `submitters_of`, `stamped_steps` or `feature_request`.
The admin flag on its own, without an active admin account behind it, opens none of the seven definers in 3.3. An operator
without the matching ability gets no pairing preview and no scanned player's name.

**Order.** (1) failing tests (section 4), (2) 0189, (3) hand mutants (section 5), (4) docs. Run after step 2: the touched
suites, `test/security/*`, `test/db/hot-path-plpgsql.int.test.ts`.

## 1. Latest definitions (all of `apps/api/migrations` searched up to 0188)

| Object | Latest | Today |
|---|---|---|
| `submitters_of(uuid[])` | 0050:558 (`LANGUAGE sql` definer) | `organizer_id = app_organizer_id()` per branch, no scope |
| `stamped_steps(uuid)` | 0045:165 (`LANGUAGE sql` definer) | the same |
| policy `feature_request_read` | 0141:241 | `app_admin_id() IS NOT NULL OR organizer_id = app_organizer_id()` |
| policies `entitlement_read`, `feature_override_read` | 0003:42, 0136:33 | any caller who can see one of the events |
| `add_reward_codes` | 0157:23 (gate 40-42) | `app_is_admin() OR (member and in scope)` |
| `end_event_early` | 0009:102 (gate 109-110, audit 119) | `app_is_admin() OR owner` |
| `create_operator_invites`, `revoke_operator_invite`, `set_operator`, `remove_operator` | 0026:426, 482, 604, 658 | `app_is_owner(..) OR app_is_admin()`; audit `CASE WHEN app_is_admin()` |
| `operator_event_of` | 0026:415 (`LANGUAGE sql`, SET) | `... OR app_is_admin()`, the first gate of the four above plus `event_operators` and `event_operator_invites` |
| `preview_device` | 0057:625 (operator branch 633-637) | operator: any `staff_assignment` |
| `operator_scan_subject` | 0109:364 (`LANGUAGE sql` definer) | joins `staff_assignment`, no ability |

`app_is_admin()` (0001:21) reads only the setting. `app_admin_id()` (0027:17) re-checks `staff_user` (admin role, active),
and questify_app already holds EXECUTE on it (0116:7).

## 2. Verdicts

- **hunter-tenant 1: real, defence in depth.** The API passes only quests it can already see (`completionsOf`,
  src/quests/builder.ts:818; `stampedSteps`, src/quests/store.ts:472). A direct call with another event's quest id still
  answers. Fix in 3.1.
- **hunter-tenant 2: real, defence in depth.** `readEventRequests` (src/settings/feature-requests.ts:79) filters by an event
  already checked by the switches door. Fix in 3.2.
- **hunter-tenant 3: dropped.** The public `GET /v1/config?event=` (src/settings/routes.ts:28) reads `readEntitlements` and
  `readEventOverrides` under these policies in a player's or an empty context (src/settings/service.ts:271-290). Scoping them
  to members would drop an organizer's Off override from every player's config, so a switched-off feature would come back on.
  Both migrations say the read is meant to be open (0003:40-41, 0136:12-13).
- **hunter-tenant 4: real, safe for the six definers plus `operator_event_of`.** Every `isAdmin: true` context in src comes
  with the admin's own `staffUserId` (e.g. src/console/doors.ts:79, src/settings/organizer-overrides.ts:92), and none of the
  seven is reached from an admin seat. The 115 `app_is_admin()` uses in policies stay; that sweep goes to FOLLOWUPS.
- **hunter-tenant 5: real, small leak.** `operatorScan` reads the subject even after the door refused with `ability_off`
  (src/operators/scan.ts:146-147, refusals.int.test.ts:465). Fix in 3.4.
- **hunter-auth 5: dropped, by design.** A device paired by an operator is paused as soon as the operator loses the ability
  (`device_paused`, 0057:391-405; DV403, 0058:338; 0057:448) and resumes when it comes back (SECURITY.md:345, API.md:326).

## 3. Migration 0189 (`SET LOCAL lock_timeout = '10s'`; header lists each object and the file it is restated from)

### 3.1 `submitters_of`, `stamped_steps`: event scope
Rewrite both in PL/pgSQL with the same signatures (grants stay), per docs/rules.md:71, reading the context once:
`DECLARE org uuid := app_organizer_id(); scope uuid[] := app_event_scope();`, `IF org IS NULL THEN RETURN; END IF;`, then each
of 0050's four branches (submission, quiz_attempt, passport_stamp, game_round) with `organizer_id = org AND
in_event_scope(event_id, scope)`; `#variable_conflict use_column`. `stamped_steps` the same. Delete both entries from
`sql-settings-allowlist.json` (hot-path-plpgsql.int.test.ts:373-374 requires it).

### 3.2 `feature_request_read`
`ALTER POLICY feature_request_read ON feature_request USING (app_admin_id() IS NOT NULL OR (organizer_id = app_organizer_id()
AND in_event_scope(event_id, app_event_scope())));` (the shape of `event_read`, 0008).

### 3.3 Admin re-check
Restate the seven functions as they are, changing only `app_is_admin()` to `app_admin_id() IS NOT NULL`: in the gates
(add_reward_codes 0157:40, end_event_early 0009:109, create_operator_invites 0026:440, revoke_operator_invite 0026:494,
set_operator 0026:620, remove_operator 0026:676, operator_event_of 0026:419) and in the audit `actor_type` CASE (0009:119,
0026:473, 501, 644, 676). `operator_event_of` stays `LANGUAGE sql`. Diff each restated body against its source.

### 3.4 Operator abilities (Proposed ADR: "seeing needs the ability that acting needs")
- `operator_scan_subject`: add `AND 'scan_quests' = ANY (sa.abilities)` to its `staff_assignment` join; stays `LANGUAGE sql`.
- `preview_device`: operator branch requires `sa.abilities && ARRAY['scan_quests', 'show_rotating_qr']`, else OA403
  (`deviceErrorOf` maps it to `ability_off`). The claim still enforces the kind's own ability (0057:484).

## 4. Tests (written first, failing on 0188)

- `test/db/passport.int.test.ts` and `test/db/games.int.test.ts` (~:830): an editor scoped to A1 gets `[]` for A2's quest
  from `stamped_steps` and `submitters_of` (all four branches covered); unscoped editor and owner see A2's rows.
- `test/events/feature-layers.int.test.ts`: scoped editor reads A1's `feature_request` row only; owner and admin read both.
- Forged flag (pattern: activation.int.test.ts:245): `{isAdmin: true, staffUserId: <owner of org B>}` and `{isAdmin: true}`
  against org A: `end_event_early` QE403, `add_reward_codes` RN404, the four operator definers ON404 or `not_found`,
  `event_operators` no rows. A real admin still passes one. An owner carrying the flag is audited as `staff`.
- `test/db/devices.int.test.ts` (:554): operator with only `hand_over` gets OA403 from `preview_device`; defaults unchanged.
- `test/db/name-display.int.test.ts`: operator without `scan_quests` gets `[]` from `operator_scan_subject`;
  `test/operators/refusals.int.test.ts:465`: the `ability_off` scan has `player: null`.
- `outsider`, `cross-tenant` and `player-name-reads` security suites stay green with no edits.

## 5. Hand mutants (each must turn a section 4 test red)
Remove `in_event_scope` from one branch at a time; put back the policy's organizer-only check; put back `app_is_admin()` in
one gate; drop each ability predicate.

## 6. Risks
A later admin path into the seven definers needs a real admin (intended). `ALTER POLICY` takes an ACCESS EXCLUSIVE lock on the
small `feature_request` table (lock_timeout covers it). Practice and station scans lose the subject on `ability_off`
(intended).

## 7. Docs
SECURITY.md tenant section (one line each), FOLLOWUPS (the policy sweep of `app_is_admin()`), DECISIONS and OPEN_QUESTIONS
(the 3.4 ADR), STATE.md.

## 8. Plan review (CTO, 92, GO) — apply while building
1. Corrected line numbers for 3.3: end_event_early gate 0009:108, audit 118; add_reward_codes gate 0157:41;
   revoke_operator_invite 0026:496/504; set_operator 0026:621/646; remove_operator gate 0026:672, audit 678;
   create_operator_invites audit 0026:474.
2. `operator_scan_subject` also gets the quest-limit predicate, written as in `device_paused` (`NOT EXISTS
   staff_assignment_quest ... OR EXISTS ... quest_id = q.id`), so an `outside_station` refusal (OS403) shows no subject either;
   one more name-display test.
3. Section 5: one hand mutant per gate (7) and one for the audit CASE.
4. `operator_event_of` is not a definer: say "six definers plus `operator_event_of`".
5. Restate `end_event_early` with `SET search_path = public, pg_temp` (say so in the header).
6. Cite the latest `event_read` policy, not 0008.
