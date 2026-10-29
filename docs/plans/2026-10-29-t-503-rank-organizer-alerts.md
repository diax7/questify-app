# T-503 — Top-10 transitions and organizer email alerts

2026-10-29. **PLAN ONLY. Tier A; independent plan review before implementation.**
Base main `0818a3d`; T-502 application `e28a1e4`, CI 40828699004 green. The resumed queue overrides historical
stop-after-T-502 notes. No application changes, external calls, push, deployment, EAS, mutation or next task.

## Evidence and scope

- FR-613/F-160 requires BOTH entry and exit, not the task's entry-only done condition; FR-1727/F-253 requires
  switches per team member. ADR-359/Q-328 and ADR-360/Q-329 are recommendations pending independent review.
- `apps/api/src/ranking/ranking.ts`: afterCompletion updates only the completing player's Redis entry; repairDue
  returns without Redis and consumes marks before rebuild. Neither is a durable transition source. Comparing only
  the completing player's position misses the displaced player's exit. store.ts versions/tombstones protect cache,
  not notification episodes. Reads can fall back to PostgreSQL; cache failure must not disable production.
- Canonical eligibility/order: migrations 0015, 0019, 0026; active player/enrollment, positive score/version, no
  organizer-team player, exclusion or event operator; score DESC, score_version ASC (Redis agrees). 0035's today
  board is separate; 0032 rehearsal may rank for preview but must not send. 0025 spending/refunds also move rank.
- 0076/0077 provide notice_create, personal fan-out/claim/center, mute and consent. Personal membership alone does
  NOT check live lifecycle/team/operator ranking exclusion. Add kind-specific checks, preserve later kind cases.
  Shared routes.ts already reserves rank_top_ten -> ranking (and has a route test), but no template/DB kind/producer
  exists. Reuse that entry-kind name; add rank_top_ten_exit with the same target instead of orphaning the placeholder.
- 0027 event_limit_alert is unique by event/level but activation/limit changes delete/recompute marks: that key
  alone is not an email episode. 0031 inserts flags and updates open burst evidence; evidence updates are not new
  flags. Inventory facts exist in 0025 and subsequent desk/rehearsal/item migrations; use latest definitions.
- 0061 already audits console.ticket_read per event, a limited real support-access producer. General support access
  and content unpublishing are future T-701; player moderation is NOT unpublishing. Do not fabricate that producer.
- Identity is organizer_member plus active staff_user, not invites/operators. Existing auth/email sender, Gmail,
  Resend and failover are wired by server.ts. Foreign auth exception ADR-112/Q-083 is not new operational-mail
  approval. Failover Promise.race does not cancel the original send; EmailSender offers no external idempotency.

## Rank defaults — Proposed ADR-359 / Q-328

1. Overall board only, effectively live, activated, ranking enabled, real participation. Not today/global/final
   prize rank. Existing live events silently seed current top ten on deployment. Newly live empty board starts
   empty; first earned entry sends. Ranking-off/end/archive/suspension/rehearsal wipe clear/reseed silently.
2. Serialized coalesced checkpoints, target one-second cadence and <=5s propagation. Compare durable old/new
   top-ten sets: old-minus-new exits, new-minus-old entries; 5th->3rd silent. Observed exit then re-entry is a NEW
   episode. This deliberately does not promise transient crossings between observations. Review must accept that
   interpretation of FR-613's ranking updates; otherwise redesign ordered transaction-level facts BEFORE build.
3. Score-zero drop still gets exit if otherwise eligible: positive-score ranking_eligible is NOT an exit recipient
   gate. Leave/remove/ban/erase/exclude/become operator/team suppresses that person's exit; eligible replacement
   can get entry. Recheck kind-specific lifecycle and recipient eligibility at fan-out AND claim.
4. New PostgreSQL rank-change inbox + per-event snapshot (<=10 ids)/revision, separate from cache repair marks.
   Source triggers append ids-only signals for score/version/enrollment, player status/contact, team/assignment/
   exclusion, lifecycle and rehearsal. Bulk sources signal distinct affected event ids set-wise; no rank query,
   network or member fan-out inside score triggers. Cover spend/refund, manual/bulk awards, submissions and all
   non-HTTP producers, not just afterCompletion.
5. Worker order: event FOR SHARE -> snapshot lock -> bounded visible inbox rows FOR UPDATE SKIP LOCKED. Read
   canonical committed top ten in a fresh READ COMMITTED statement AFTER locks. Snapshot/revision, notice inserts
   and deletion of ONLY captured signal ids commit together. Never delete by sequence high-water: a lower sequence
   may commit late. Producers append without snapshot locks; worker never locks enrollment/ledger/player. Sort
   multi-event ids. Concurrent later signals remain; rollback/crash retains work; two workers serialize snapshot.
6. Top selection uses `(event_id, score DESC, score_version)` index and canonical eligibility anti-joins; LIMIT 10
   before materializing a whole board. Prove equivalent to ranked_enrollments. No N+1 eligibility or 50,000-member
   scan/write per completion/notice fan-out. Many excluded leaders can still require scanning many indexed
   candidates: measure the worst case, not a constant-time claim. <=20 notices/checkpoint. DB drain runs without
   Redis; repair/backstop is supplementary, never sole source. No DB locks across cache/network work.
7. Personal rank_top_ten/rank_top_ten_exit kinds, rank topic, active membership, priority 1, five-minute TTL. Dedupe
   `rank:<event>:<revision>:<enrollment>:<entry|exit>` through notice_create. Missing kind never rolls back source;
   drain retains signals/snapshot and emits safe metric until BOTH kinds exist. No cap/cooldown/quiet hours.
   Latest recorded transition suppresses obsolete opposite entry/exit at fan-out/claim. Preserve 0078-0081 cases.
8. Fixed EN: You entered the top ten. / You left the top ten. AR: أصبحت ضمن العشرة الأوائل. /
   لم تعد ضمن العشرة الأوائل. No exact rank number, points, username or free text (ADR-346). Event id only in refs,
   existing event-ranking target. Muted rank topic blocks delivery, not center; no permission/device still gets
   center history. Reuse shared renderer/allowlists/app settings, no new permission prompt or ranking screen.

## Organizer defaults — Proposed ADR-360 / Q-329

### Scope, ownership and authorization

- T-503 owns preferences, durable facts/deliveries, existing-source producers, safe worker and minimal team UI.
  T-609 reuses those for usage-view groundwork/future hookups, not another store/sender/switch UI. T-701 owns
  general unpublish/support actions. No artificial slices; no FR-1727 fully-delivered claim with missing general
  unpublish producer or live-email authorization. No request to Dhia needed to review technical defaults.
- Seven switches: activated, stock_low, codes_low, new_flags, content_unpublished, support_access, size_limit.
  80/100 are two facts under size_limit. Operational defaults ON for accepted members, no marketing consent implied.
  Each member edits ONLY their own organizer-specific switches; owner cannot override someone else's opt-out.
  Removal deletes preferences; reacceptance starts fresh membership generation, no old delivery/history. No custom
  recipient address. Operators and pending invites are not organizer email recipients.
- GET/PUT `/v1/organizers/:organizerId/alerts/me`: session-derived identity, active membership, declared access,
  origin/CSRF checks, strict full boolean object/unknown-key refusal, idempotent PUT; reauthorize after locks.
  Only own preferences returned, never email; audit ids/booleans. Authenticated settings link, no new public token
  auth/unsubscribe scheme. Apply event scope at enqueue AND final dispatch, even for an owner with limited scope.

| Type | Existing source / episode | Rearming default |
| --- | --- | --- |
| activated | first successful activate_event; request/rejection/settings edits none | once/event, not scheduled->live |
| stock_low | finite physical reward stock_total - units_out; reserve/return/expiry/adjustment | above -> <= max(1, ceil(stock_total * 0.1)); recovery above rearms |
| codes_low | digital available stock, reconciled with unused reward_code | same threshold; restock above rearms |
| new_flags | new flag.id INSERT, all producers | each new row, not evidence/last_seen updates |
| content_unpublished | no general producer yet; typed hook for T-701/T-609 | future action id, not player moderation |
| support_access | console.ticket_read audit fact now; T-701 extends same hook | once/audit id, no ticket/admin text |
| size_limit | inserted event_limit_alert 80/100 plus limit revision | once/revision/level, not attendance decline/rejoin |

- Jump across both levels creates two facts. Same mode/cap recomputation none; genuinely changed mode/cap starts
  revision and can immediately emit reached levels. Unlimited/zero cap none. Zero during same low-stock episode
  adds no email. First positive load already low opens episode; partial refill without recovery does not rearm.
  Threshold/total change evaluated atomically under existing reward lock. Digital/physical types exclusive.
  Exclude never-stocked zero, unlimited, removed, rehearsal and frozen-result stock not yet offered. Quest-item
  pools only where model has finite stock; no invented rank-prize quantities. Test every current inventory path.
- Bounded recipient rows capture eligible staff ids at source time (team, not players). Recheck active staff,
  current matching membership generation, event scope, opt-out and eligible nonremoved/activated source on dispatch.
  Removal/disable/opt-out/scope shrink before dispatch cancels. Newly joined/enabled/expanded scope never backfills.
  Composite constraints bind facts/events/members to tenant; no email/contact or rendered content in outbox.

### Transport, privacy and races

- Reuse EmailSender/provider adapters, NOT unmodified auth failover. Operational transport disabled by default,
  isolated from login-mail budget/concurrency. No new dependency/provider/account. Fetch current staff email only
  into memory for final authorized send. Fixed bilingual alert-type plain text and authenticated dashboard link
  (ids only), no names, amounts, codes, flags, free text, CC/BCC/recipient list. Never log email/rendered mail/raw
  provider body/error/credentials; finite safe error enums/opaque ids/metrics only.
- No external exactly-once claim: Gmail lacks application idempotency. Unique delivery key dedupes jobs, not effects.
  Commit fenced dispatch_started BEFORE network. Timeout/disconnect/crash after marker/lost ACK/ambiguous response
  -> uncertain, NEVER automatic resend/failover. Only proven pre-acceptance refusal retries at 1m/5m/30m (max three
  retries, 24h TTL), rechecking authorization each time. SKIP LOCKED leases + token fence late ACKs. Reclaim abandoned
  pre-dispatch claims only, never started/uncertain attempts. No manual arbitrary-recipient resend door.
- Final authorization locks: event FOR SHARE -> staff FOR SHARE -> membership FOR SHARE -> preferences FOR SHARE
  -> delivery FOR UPDATE, stable ids. Re-read and commit marker. Writers use compatible ordering; narrow guards if
  existing updates permit a cycle. Marker is dispatch authorization linearization: earlier revocation wins, later
  revocation cannot recall handed-off mail. No DB locks across network. Initially one email concurrently, bounded
  await/shutdown, 5s HTTP step and <=8s whole attempt with REAL cancellation (including Gmail token + send), not
  Promise.race leaving requests alive. Extend AbortSignal only as needed, preserve auth behavior, fake-test it.
- Terminal delivery rows expire after 30 days; retain bounded ids-only source/episode dedupe for the event's lifetime
  under existing event-retention policy (Q-075), not recipient addresses. Membership removal deletes recipient rows;
  account erasure/rehearsal cleanup purges rank identifiers. A definitive permanent-address refusal suppresses future
  operational attempts for that staff contact version; clear only after a verified contact change. Do not claim
  bounce/complaint webhook coverage exists: provider-specific signed callbacks remain a real-delivery release check.
- Existing foreign auth exception is NOT blanket transfer approval. Update SRS NFR-020 data map, INTEGRATIONS,
  SECURITY and RUNBOOK: new purpose, recipient-address transfer, provider, retention/suppression. Real operational
  email remains OFF until Saudi-region transport OR explicit counsel-approved extension of foreign-transfer grounds
  (Q-083/T-807). Local fake work unblocked. Existing credentials imply neither authorization nor legal compliance.

## Exact planned file inventory

- New `apps/api/migrations/0082_rank_organizer_alerts.sql`: 0081 is highest inspected; verify next free number
  before build. Do not edit deployed 0001-0056 or replace 0081. Rank inbox/snapshot; alert preferences/events/
  deliveries/threshold state; due/dedupe/episode indexes, narrow doors/source triggers. FORCE RLS; revoke PUBLIC
  and questify_app; grant only own-preference/system doors; definers pin search_path and system drains refuse ANY
  identity context. No ledger/redemption semantics change. Snapshot ids without player FKs need explicit erasure/
  rehearsal-wipe cleanup (no orphan ids or wipe cycles), exercised by inventory guards.
- New `apps/api/src/ranking/transitions.ts` and `.test.ts`; modify `ranking/{tick.ts,tick.test.ts}`, `app.ts`,
  `server.ts` for DB drain without Redis, non-overlap/backpressure/bounded shutdown. Keep ranking.ts/store.ts cache
  semantics unchanged; only a justified wake-up if needed. Shared `packages/shared/src/push/{push,templates,routes}.ts`
  and their tests: two kinds, copy and existing target; preserve later SQL kind cases. Reuse app push center/topic
  controls; app files change only if routing contract test demonstrates need, not a new screen or prompt.
- New `apps/api/src/organizer-alerts/{alerts,routes,worker,templates}.ts` and matching tests;
  `packages/shared/src/organizer-alerts.ts`, export from `packages/shared/src/index.ts`. Wire
  `apps/api/src/{app,server,config}.ts` and `organizers/routes.ts`. Conditional cancellation changes to
  `auth/email/{sender,gmail,resend}.ts` with regression tests; no incidental auth failover redesign.
- New `apps/web/src/components/OrganizerAlertPreferences.tsx`, `apps/web/src/lib/organizer-alerts.ts` and tests;
  compose in `apps/web/src/app/[lang]/organizers/[organizerId]/team/page.tsx`; bilingual messages in
  `packages/shared/src/i18n/messages.ts`. Accessible own toggles, loading/error/retry/saved, Arabic RTL/Western digits.
  No owner-only note/count change: self-service controls. Follow apps/web/AGENTS.md before UI implementation.
- After approved implementation update TASKS, SRS traceability/data map, API, DATA_MODEL, SECURITY, INTEGRATIONS,
  RUNBOOK, STATE/handoff. Keep future content/support hookups explicit in T-609/T-701. No tasks ticked in planning.

## Test-first proof and release gates

- New `apps/api/test/db/rank-transitions.int.test.ts`: entry AND displaced exit; 5th->3rd silent; equal-score tie;
  zero-score exit; spend/refund/manual/bulk/submission sources; re-entry; duplicate signal/Redis loss/repair/restart;
  contact/team/assignment/exclusion, leave/ban/erasure; lifecycle/switch/rehearsal/silent seed; topic mute/no device/
  permission, TTL/latest-transition staleness and canonical top equivalence. Test coalesced vs transient semantics.
- New `apps/api/test/db/organizer-alerts.int.test.ts`: each existing producer/switch, no replay/backfill/evidence
  update email; 80/100 jump/same-cap/reset/rearm; finite/unlimited/zero/removed/frozen stock; partial/full refill;
  code upload/dedup/assignment/refund, unused-code/counter consistency and rehearsal exclusion. Internal future
  content/support hook rejects untrusted seats and cross-tenant refs; missing producer is not a passing FR claim.
- New `apps/api/test/organizer-alerts/routes.int.test.ts`; fake worker/template/cancellation tests; UI unit tests;
  extend `apps/web/e2e/organizers.spec.ts` (owner AND scoped editor self-controls, AR/EN, error/saved states).
  Extend `apps/api/test/db/{push-producers,push-store,organizer-team,rehearsal}.int.test.ts`, existing ranking/
  activation/inventory suites, `apps/api/test/security/{outsider,cross-tenant,routes}.int.test.ts`, API/OpenAPI and
  table/function inventories. Prove disabled/removed/reinvited/pending member refusals, own-v-other edits, empty
  scope, spoofed id, cross-tenant event/member injection, grants/RLS/search_path, system-door identity refusals.
- Races: two checkpoints/claimers; source commit during snapshot; lower sequence commits late; rollback after
  snapshot/notice; reserve vs restock, cap vs join; removal/opt-out/scope shrink/disable vs final dispatch marker in
  BOTH orders; lease expiry/stale ACK, crash-after-send and timeout-after-acceptance. Fakes only, no real service.
  Assert no duplicate uncertain external attempt and no email/PII/provider body in captured logs/traces.
- New manual `apps/api/test/perf/rank-alerts-timing.int.test.ts`: 50,000 members, many excluded leaders, bursts/bulk
  awards/concurrent workers; EXPLAIN ANALYZE index use, completion latency overhead with/without signals, <=20
  notices/checkpoint, no per-member fan-out. Checkpoint <5s, steady propagation <=5s; launch budget 20,000
  completions/minute. Record measured candidate scan/queue age/timings. Failure revises plan, not eligibility or
  silent per-player polling. Organizer email fan-out scales with team count, never attendees.
- AFTER independent plan approval: targeted tests/types/lint/format/limits between edits, security on schema change,
  full Vitest ONCE, API/web builds + fresh-build browser suite, native export only if app changes; audit/secret scan,
  independent Tier A code review and full coordinator CI. Worker never pushes. Real phones/provider setup, Saudi
  transfer authorization, cancellation drill and suppressed/uncertain-mail runbook remain release gates.
- ADR-355 mutation: push/templates/timers/cache files are NOT eligible just because T-503 is Tier A. Only changed
  access/tenant code: `apps/api/src/organizer-alerts/{alerts,routes}.ts`, `apps/api/src/organizers/routes.ts` if touched,
  restricted to access checks. Ledger/redemption changes not planned; SQL authorization/races get DB tests.
  Coordinator batches eligible targets on GitHub only, never local Stryker.

## Independent review handoff and effort

Review checkpoint interpretation/lock order, threshold episodes, seven own-member defaults, current-v-future source
coverage, revocation linearization, uncertain-send behavior and foreign-mail prohibition. No external-only blocker
to plan/local fake implementation; real delivery is gated. One substantial task, estimated 3-5 focused build days
plus review/CI, no dependencies. Planning checks only: targeted Markdown format and git diff check. CI minutes 0;
rough planning effort 25k agent tokens, no children. Repository oxfmt excludes Markdown (no eligible targets), so
formatting evidence is Markdown whitespace/link checks and git diff --check, not a formatter-pass claim.
Stop for independent plan review; no T-504 work.
