# T-503 — Top-10 transitions and organizer email alerts

2026-10-29. **PLAN CORRECTIONS ONLY. Tier A review80 NO-GO; coordinator inspection required before implementation.**
Correction base main `bca5223`; T-502 application `e28a1e4`, CI 40828699004 green. The resumed queue overrides historical
stop-after-T-502 notes. No application changes, external calls, push, deployment, EAS, mutation or next task.

## Evidence and scope

- FR-613/F-160 requires BOTH entry and exit, not the task's entry-only done condition; FR-1727/F-253 requires
  switches per team member. ADR-359/Q-328 and ADR-360/Q-329 remain Proposed/Open pending coordinator inspection.
  MAJOR-only corrections need no additional independent plan review (ADR-355); this document grants no build approval.
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

1. Overall, live, activated, ranking-enabled real board only, not today/global/final-prize rank. Deployment
   silently seeds existing boards. Newly live empty board starts empty; first earned entry sends. FR-613 is NOT
   relaxed: a published 11->9->11 between worker ticks creates entry AND exit facts. Coalescing is rejected.
2. Recommend **ordered durable transaction facts plus one PostgreSQL overall publication boundary**, not a
   distributed Redis/SQL commit protocol. Every rank-affecting transaction takes the source guards below BEFORE
   any existing row locks, updates the indexed eligible projection and, at transaction end under the event rank
   lock, compares canonical top ten with the preceding committed snapshot. Persist old/new sets, monotonic event
   revision, lifecycle generation and per-enrollment entry/exit facts atomically with the source change. Deferred
   finalization is once per event/transaction, not per ledger row: uncommitted statements cannot publish; rollback
   leaves neither score nor fact. No network/member fan-out in score triggers. Source failure rolls back the
   transaction rather than exposing a rank change without its durable fact; kind installation cannot block source.
3. Deliberate ranking adapter amendment: overall `read` and overall `afterCompletion` place use a single coherent
   PostgreSQL snapshot, NOT incremental Redis state. Redis overall upserts/removals/rebuilds must not feed any
   response; skip those operations. Today-cache semantics remain unchanged. Preserve API fields, canonical order,
   eligibility, own-rank, total, score, privacy and live freshness. No full-board cache rebuild per completion.
   See exact publication inventory and performance gate below. A revision label on mixed cache paths is NOT safe.
4. Durable inbox holds **already determined transitions**, not ids-only final-state dirtiness. Drain per event
   in revision order under a drain lock; claim bounded visible rows FOR UPDATE SKIP LOCKED, insert notices and
   delete ONLY captured fact ids in one transaction. Never delete by sequence high-water: lower ids may commit
   late. Source event lock orders revisions; parallel workers cannot skip an earlier revision in the same event.
   Missing either notice kind preserves facts and reports a safe metric; source fact production is independent
   of notice kinds. No Redis dependency, and no source locks during network dispatch.
5. Persist reset/baseline generation **at source**, even if off->on, suspend->resume or rehearsal wipe/reactivation
   happen before a drain. Each reset edge invalidates old-generation work immediately; re-enable/live-start writes
   a silent canonical baseline in its transaction. Empty first board still alerts on the first earned entry.
   A generation tombstone outlives old work; erasure removes member identifiers in projection/snapshot/facts/notices.
   Timed effective lifecycle changes go through the same guarded DB finalization before a write/read can expose
   the new lifecycle, not only a delayed timer. Historical/off/rehearsal crossings never turn into notices.
6. Personal rank_top_ten/rank_top_ten_exit, rank topic, priority 1, five-minute TTL; dedupe includes
   `(event, lifecycle_generation, transition_revision, enrollment, direction)`. Persist exact latest transition
   identity per enrollment/generation **in the source transaction**. BOTH fan-out and claim require equality with
   that identity and current generation, not opposite-only suppression. Delayed entry1 after exit2/entry3 is stale
   although entry3 has the same direction. Replay cannot move latest backward. Preserve crossing facts; staleness
   may suppress obsolete external delivery, never erase history. Muted topic blocks delivery, not center.
7. Eligible score-zero drop can receive exit: positive score is NOT an exit-recipient gate. Leave/remove/ban/
   erasure/exclude/operator/team suppress that person's exit; eligible replacement still enters. Recheck these,
   lifecycle, generation and latest identity at fan-out AND claim; preserve 0078-0081 cases. No cap/cooldown/quiet
   hours; no device/permission still allows center history. Reuse renderer/allowlists/settings, no new screen.
8. Fixed EN: You entered the top ten. / You left the top ten. AR: أصبحت ضمن العشرة الأوائل. /
   لم تعد ضمن العشرة الأوائل. No exact rank number, points, username or free text (ADR-346). Event id only in refs,
   existing event-ranking target. Muted rank topic blocks delivery, not center; no permission/device still gets
   center history. Reuse shared renderer/allowlists/app settings, no new permission prompt or ranking screen.

## Publication inventory and correctness proof (recommended, not accepted)

| Current source/read path | Required amendment; publication boundary |
| --- | --- |
| ranking/ranking.ts afterCompletion:298 -> ranking_entry_of -> placeAfter -> store.upsert/remove/read/rebuild | Return overall place from the guarded canonical DB read; no Redis overall publication, even with store absent. Retain best-effort error/null contract and dayAfter for today only. |
| completions/routes.ts; plays/routes.ts quiz/vote/survey/share/meet/game; nfc/routes.ts; passport/routes.ts; submissions/routes.ts; operators/routes.ts; devices/kiosk.ts | All call afterCompletion after commit; their returned rank uses the same DB revision, never a second cache-derived place. No producer is limited to HTTP or these callers. |
| ranking/routes.ts GET -> read -> ownIn/todayIn -> boardView -> fromRedis/fromPostgres | New overall DB door returns top/own/total/score/eligibility/lifecycle from ONE statement snapshot; current separate own/top/position statements must not be mixed. Route feature checks are repeated in that door. Keep not_enrolled, today_off and ranking-off semantics. |
| fromRedis: missing-copy rebuild; stale-member remove + mark; store.ts Lua UPSERT/REMOVE/READ/SWAP | No overall client may reach these paths. Keep store primitives only for today; cache contents cannot invent, omit or reorder overall publications. |
| repairDue, rebuildEvent, staleLiveEvents; ranking/tick.ts backstop; no-Redis fallback | Repair today only; overall reads always use the same DB door. Transition drain is separate from destructively claimed ranking_repair marks. Restart, Redis eviction/down, repair racing source or live read cannot lose a fact. |
| SQL ranking_entries/entry_of/rows/top/position, ranked_enrollments (0015/0019/0026); ranking_day_* (0035) | Overall projections match the canonical relation exactly; top and own place keep score DESC/score_version ASC. DB-direct canonical reads see only committed revisions. Today/global/result ranking are not FR-613 producers. |

Proof obligation: before a committed board can be read, that transaction has finalized its projection, top snapshot,
revision and every crossing fact. Same-event writers serialize until commit; a reader sees all or none, not half
an upserted Redis board. Each consecutive committed top-set difference is retained, including 11->9->11 across two
commits between ticks; internal 5->3 is silent. A bulk transaction publishes its final state once, since intermediate
statements cannot be observed. This preserves FR-613 rather than redefining updates as worker observations.
The board projection retains canonical rehearsal preview rows and existing read/afterCompletion place contracts;
live/real/activated requirements gate NOTICES, not previously permitted preview reads. Do not hide a board/own place
solely to simplify alert generation. Completion place is read after its source commit (as today), not promised as
that transaction's frozen result if a later transaction already committed. The intervening crossings still exist.
Independent historical Redis revisions cannot be reconstructed reliably; cut over all overall publications atomically
with a silent baseline, never run the old mixed publisher beside the new detector. Coordinator must inspect this
cache-authority change before implementation. Compared with a Redis/DB two-phase publication protocol or full-board
rebuild per write, it removes the least reliable boundary and reuses existing PostgreSQL ranking semantics.

### Exhaustive rank producers and maintained eligibility

Use transaction-maintained eligible entries indexed `(event_id, score DESC, score_version ASC, enrollment_id)`;
positive score/version, active player/enrollment, contact exclusions, organizer-team mapping and staff_assignment
exclusion must equal canonical ranked_enrollments. Do NOT LIMIT 10 then filter excluded candidates. Projection
updates affect changed enrollments only; broad exclusion/team/contact operations may update their actual affected
set once under the multi-event guard, never a 50,000-member rebuild per normal completion. Cover:
- ledger_entry -> enrollment score/version: completions and bonuses, welcome/join, manual/bulk award/remove,
  submission acceptance/accept-all, all play/operator/kiosk/NFC doors; 0025 spending and cancellation/expiry refunds.
- enrollment INSERT/DELETE and status/score/version/event/player/organizer/rehearsal changes, player INSERT/DELETE/
  status, player_contact INSERT/DELETE/email/phone, organizer_member INSERT/DELETE/identity/organizer updates,
  staff_user email/identity mapping changes used by organizer_team_players, staff_assignment INSERT/DELETE/UPDATE,
  event_exclusion INSERT/DELETE/UPDATE (both old and new event/value), including FK cascades.
- event lifecycle/activation/start/end/suspension/archive and ranking feature override/default writes affecting
  effective settings; rehearsal open/erase/wipe/go-live, ensure_rehearsal_wiped/due wipes; player erasure/erase_rows.
  Exact raw writers include `events/store.ts` event INSERT/UPDATE/DELETE; `settings/store.ts` platform_setting
  upsert, event.config feature/tuning UPDATE and event_entitlement INSERT/DELETE; `settings/service.ts` inheritance
  and its cache cannot override the source DB generation. Include end_event_early/advance_event_lifecycle (0009).
  Enumerate settings inheritance/default writers, not just a per-event toggle route. Every affected event gets
  source-time generation resets, including an off->on inside one transaction (record edges, not final value only).
- Source schema guards reject uncovered direct writes; a column writer test inventory lists every executable
  function, service raw SQL and background door, using its latest definition through 0081, not just old triggers.
  Compare projection AND top/own/total with ranked_enrollments after each producer. A missing writer is a build
  gate, not a backstop repair excuse. Eligibility changes create replacement crossings in that same transaction.

### Source writer / lock matrix (also organizer authorization)

Proposed concrete pre-lock protocol: advisory transaction gate G is SHARED for ordinary sources/dispatch and
EXCLUSIVE for global membership/contact/eligibility/revocation/lifecycle/bulk/erasure work. Per-event advisory
rank locks E are EXCLUSIVE for rank/reset writers and SHARED for overall readers. Acquire G before ANY existing
device/rehearsal/player/event/quest/reward/enrollment locks; then sorted E ids; then retain each door's documented
legacy row order. Never upgrade G: classify the door on entry. Global writers hold exclusive G before discovering
affected events, preventing membership/enrollment phantom discovery. Conservative advisory hash collisions only
serialize extra work. Do not introduce event-row-before-device inversions into ADR-244/260 or erasure locks.
If a read discovers a due clock boundary while holding shared G/E, release that read transaction, finalize via
exclusive-G/source-reset door, then retry the coherent read. NEVER upgrade a held shared gate. Timer/source/read
finalizers dedupe by persisted boundary identity; a repeated read cannot reseed or advance generation again.
Crossings cannot be silently dropped when a bounded batch fills: defer remaining fact ids, not source transitions.

| Writer / exact current boundary | Pre-lock mode and finalization |
| --- | --- |
| record_completion/complete_quest/operator_complete_quest; pay_submission; grant_welcome; reserve_reward/end_reservation (latest 0025/0029/0074); route callers above | G shared, E exclusive before existing first lock; ledger/enrollment/projection updates; deferred finalization before COMMIT. Cross-event meet/bulk doors use G exclusive and sorted E. |
| grant_manual_award/remove_award/bulk_award, submission accept-all, any multi-enrollment source | G exclusive before selection/first row, sorted E for affected events; set-wise updates; finalize once/event/transaction. Existing hard batch limits remain; no new arbitrary slices. |
| organizers/team.ts scope UPDATE:295 and membership DELETE:350; apply_invite/accept_invite/accept_invite_new, swap_owner (0008) | G exclusive before current membership/audit locks; source recipient generation persists on acceptance, delete invalidates it, scope updates cancel pending out-of-scope rows. Membership delete/cascade does not lock a delivery then request G. |
| staff_user disable/delete/email; player status/contact; event_exclusion/staff_assignment writers | G exclusive before staff/player/assignment/device locks; discover old+new affected events, sorted E; update eligibility and generations/contact version. No existing staff-disable HTTP producer was found: enforce table-level guarded SQL writes, test privileged disable, do not invent an alert producer. |
| own preference PUT (new), organizer scope/role/bulk team changes | G exclusive before preference/membership locks; reread authenticated identity after locks; final matching generation/scope/opt-out governs. New/expanded scope never backfills a source fact. |
| event settings/activation/limits, events tick, archive_ended_events (0075), rehearsal doors/wipe_rehearsal (latest 0055), inherited feature defaults | G exclusive before existing event/rehearsal/child locks; sorted E; persist every reset edge and silent baseline in source transaction. Shared-scope settings changes enumerate all affected events. |
| erasure/erase_rows (latest 0076), staff removal cascades and rehearsal deletion | G exclusive acquired in outermost door BEFORE player/device locks, sorted E; remove identifiers/projection and invalidate generations BEFORE dependent inbox/center cleanup; tombstone has no erased member ids. |
| organizer fact insertion: activate_event/record_limit_alerts/set_event_player_limit; reward/code/item writers; flag INSERT; console.ticket_read audit INSERT | G shared (exclusive if enclosing door above), before existing source locks; reward/limit revision lock serializes episode changes; capture source-time eligible staff+membership generation inside transaction. |
| final dispatch (new), delivery ACK/expiry/purge | Dispatch G shared -> event FOR SHARE -> staff FOR SHARE -> membership FOR SHARE -> preferences FOR SHARE -> delivery FOR UPDATE, stable ids; recheck then commit dispatch_started. ACK/expiry/purge delivery-only, never subsequently take G or a source row. |
| rank drain/fan-out/claim | G shared before E shared/source checks, then drain/latest/notice/delivery state; same-event drain serialized, exact latest+generation equality. No network under locks; no reverse acquisition from a claimed delivery. |

Because a conflicting revoker owns exclusive G before its existing locks, it cannot hold staff/membership then wait
for an event held by dispatch: dispatch holds shared G first. Existing nonconflicting source orders remain intact;
all rank E locks precede legacy locks; no G/E acquisition in an AFTER row trigger after legacy locks. Enforce this
by explicit guarded definer doors/outer service transaction prefixes and revoke direct source-column/table grants
where needed. Guard assertions inspect held DB advisory locks (not a spoofable session boolean); privileged source
maintenance obeys the same entry protocol. Inventory all cascades and nested callers; an uncovered path blocks build.
Final authorization linearizes at marker commit; revocation committed first cancels, marker first may send once
even if revocation follows. No transaction lock spans token or mail network activity.

### Cost and throughput acceptance, not an unmeasured performance claim

Normal completion: one shared G, one exclusive E (per event), O(log N) changed-candidate maintenance, indexed
O(log N + 10) top lookup and at most 20 crossing facts/transaction, no attendee fan-out. Eligible-only index bounds
top scan to 10 even with 49,990 excluded leaders. Exact own-place counting may still be O(N), as current DB fallback;
measure it separately, do not claim constant-time own rank. Source locks last through finalization/commit only.
Bulk/global G exclusive pauses ordinary sources, so the cost of exclusion/domain/team updates and erasure is real.
At 20,000 completions/minute = 333.34/s in ONE hot event, serialized E hold must average below 3 ms just for queue
stability (target <=1.5 ms for headroom). Measure full transaction lock residence, not only top query CPU. Across-event
shared G must not become an exclusive bottleneck. If these bounds fail, stop for coordinator redesign; do NOT
coalesce transitions or weaken FR-613. This is an explicit feasibility risk awaiting measurements after acceptance.
Planned local-fake/perf proof: 50,000 active then 49,990 excluded leaders, cold/warm projection indexes, ties, bursts,
manual/bulk awards, concurrent reads/afterCompletion, Redis down/repair, inherited-setting reset, and worst global
G holder. EXPLAIN ANALYZE must bound candidate scan; record p50/p95/p99 completion/own-read latency, G/E wait/hold,
queue age, drain rate and worst global pause. Sustain launch rate without growth and <=5s steady notice propagation;
compare existing completion/read latency budgets and baseline. No perf/full tests run during these plan corrections.

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
- Final authorization follows the explicit G/writer matrix above, then event FOR SHARE -> staff FOR SHARE ->
  membership FOR SHARE -> preferences FOR SHARE -> delivery FOR UPDATE. Re-read and commit marker. No vague
  post-hoc narrow guard: source revokers must acquire exclusive G before any existing lock. Earlier revocation wins;
  marker is dispatch authorization linearization, and later
  revocation cannot recall handed-off mail. No DB locks across network. Initially one email concurrently, bounded
  await/shutdown, 5s HTTP step and <=8s whole attempt with REAL cancellation (including Gmail token + send), not
  Promise.race leaving requests alive. Cancellation and refusal contract below is mandatory; preserve auth behavior.
- Terminal delivery rows expire after 30 days; retain bounded ids-only source/episode dedupe for the event's lifetime
  under existing event-retention policy (Q-075), not recipient addresses. Membership removal deletes recipient rows;
  account erasure/rehearsal cleanup purges rank identifiers. A definitive permanent-address refusal suppresses future
  operational attempts for that staff contact version; clear only after a verified contact change. Do not claim
  bounce/complaint webhook coverage exists: provider-specific signed callbacks remain a real-delivery release check.
- Existing foreign auth exception is NOT blanket transfer approval. Update SRS NFR-020 data map, INTEGRATIONS,
  SECURITY and RUNBOOK: new purpose, recipient-address transfer, provider, retention/suppression. Real operational
  email remains OFF until Saudi-region transport OR explicit counsel-approved extension of foreign-transfer grounds
  (Q-083/T-807). Local fake work unblocked. Existing credentials imply neither authorization nor legal compliance.

### Mandatory token cancellation and structured provider outcomes

- Explicitly amend `apps/api/src/auth/google-token.ts:115` and `auth/google-token.test.ts`: `get()` currently shares
  one `pending` request and accepts no signal. Add optional **per-waiter** cancellation: an already-aborted waiter
  rejects without joining; an abort while awaiting detaches that waiter's continuation/listener and prevents its
  later send. The shared refresh/cache may finish for other auth callers; NEVER abort or drop their token because
  one operational waiter cancelled. Default `get()` callers keep existing sharing, cache/drop and failure behavior.
  Token HTTP retains its own bounded timeout. Do not pretend cancelling a waiter cancels the shared token request.
- Gmail checks the whole-attempt signal before token wait, immediately after token resolution and immediately
  before send fetch. Resend checks before fetch. Compose HTTP-step/whole-attempt/shutdown abort signals; remove
  listeners/timers on every completion. An abort during send cancels its fetch but does NOT prove nonacceptance.
  A token wait that settles after its operational waiter aborted can never initiate a send. No DB locks held.
- Operational adapter outcome is a discriminated structure, not `EmailSendError.message` inspection:
  `accepted {provider}`, `proven_refusal {provider, phase, safe_code, retryable, evidence}` or
  `uncertain {provider, phase, safe_code}`. Codes are finite allowlisted enums; provider evidence is structured
  status/protocol fields, never raw response or tokens. Current EmailSendError conflates these outcomes and must
  not determine retry eligibility. Preserve the auth EmailSender/failover interface and behavior via a separate
  operational adapter/entrypoint; no incidental auth failover fix.
- Proof table required in provider tests: local refusal/abort **before any mail fetch** has no mail effect;
  token-stage failure likewise has no mail effect (provider=gmail, phase=token). Gmail send 2xx is accepted;
  validated Gmail 401 authentication rejection is a proven refusal and can invalidate only the refused token;
  Resend validated 401 authentication rejection is a proven refusal. Both are configuration failures, not blind
  retry/failover triggers. Any other send response is uncertain unless an explicit provider-specific rule proves
  nonacceptance. In particular Gmail/Resend 429/5xx, timeout, disconnect, malformed response, abort after fetch,
  body-read failure or lost ACK are NOT inferred safe to retry. No generic HTTP-status or message-regex rule.
  Retry allowlist starts empty for provider-send failures; documented provider evidence and tests are required to
  expand it. Local transient pre-fetch/token-unavailable outcomes may use the existing bounded retry schedule.
- `dispatch_started` commits before token/send network. Only a positively recorded proven_refusal may rearm a
  bounded retry after full reauthorization; a crash before recording that refusal remains uncertain. Abort after
  marker but before mail fetch is safely classifiable only if the same fenced worker records that fact. Neither
  shutdown/lease expiry nor token completion resurrects a started attempt. No ambiguous retry or provider failover.
- Deterministic fake tests: abort before get, abort during shared token wait while an unrelated auth caller
  succeeds with that same refresh, token success/abort scheduling race, abort after token before mail fetch,
  send-fetch abort after provider acceptance, deadline/shutdown, late ACK and crash windows. Assert zero send calls
  for the aborted token waiter, one unaffected auth completion, bounded worker shutdown and no secret/PII logs.

### Exhaustive organizer sources and threshold revision tests

- Source table inventory: first activate_event success -> activated; event_limit_alert INSERT from
  record_limit_alerts/activate_event/set_event_player_limit and enrollment seat guard -> size_limit; flag INSERT
  from raise_completion_flags and any other existing flag insertion -> new_flags (never evidence/resolve UPDATE);
  audit INSERT with action console.ticket_read in 0061's console read door -> support_access. Capture staff ids
  and membership generations with each source fact, not during a later drain. Enumerate grants/definer INSERT
  sites for each table, including system/timer/bulk doors; inventory tests fail on an unclassified new writer.
- Stock/code coverage: rewards/builder.ts create/edit/remove physical reward and add_reward_codes; 0025 code
  import/dedup, reserve_reward, end_reservation; 0029 desk handover/cancel/expiry; latest 0032 rehearsal reservation,
  wipe/counter reconciliation; 0047 quest_item stock edits/grants/returns and latest result prize reservation,
  offer/accept/decline/expiry/release doors. Instrument reward, reward_code and quest_item base changes atomically
  under their existing item/reward lock. Digital unused-code changes and counters are ONE source evaluation,
  not competing per-row code triggers emitting before totals settle. Handover does not restore spent stock.
  Test all latest definitions through 0081, including 0074 shop-window changes; frozen/unoffered result inventory
  is excluded. General content unpublish/support remains T-701; no fabricated player-moderation producer and no
  duplicate T-609 sender/store/UI.
- Persist episode id, effective positive total, threshold revision and low/healthy state under the source lock.
  `low = available <= max(1, ceil(total * 0.1))`. A total/threshold revision alone does NOT reopen an already-low
  episode. Revision-caused healthy->low opens once; low->healthy silently rearms; later healthy->low opens a new
  episode. Same-value edit/dedup/code-counter reconciliation is a no-op. First positive load already low opens
  once. Removed/unlimited/never-stocked/rehearsal pools never alert; source reset invalidates their old deliveries.
- Explicit physical total-edit tests conserve units_out: total100/out89/available11 healthy -> total99/out89/
  available10 opens low; total100/out90/available10 low -> total101/out90/available11 remains SAME low episode
  even though threshold rises 10->11; then total102/out90/available12 recovers silently, reserve one to11 opens
  a new episode. Digital unique uploads test the same 100/out90 -> 101/out90 -> 102/out90 sequence using real
  code rows (no fabricated digital-total edit producer). Equal effective total or threshold edits send nothing
  unless health actually changes. Digital import changes total AND unused count atomically;
  duplicate upload changes neither, assignment decrements unused, refund/release restores at most once. Test
  first positive load, partial refill still low, full recovery then depletion, 10->0 without extra email, and
  simultaneous reserve/import/total edit in both orders. Assert code availability equals authoritative unused
  real codes, not rehearsal codes or an intermediate counter. Size cap revision tests independently cover a
  same-cap reset/recompute, 80->100 jump, genuine mode/cap changes, unlimited/zero cap and decline/rejoin.

## Exact planned file inventory

- New `apps/api/migrations/0082_rank_organizer_alerts.sql`: 0081 is highest inspected; verify next free number
  before build. Do not edit deployed 0001-0056 or replace 0081. Rank eligible projection/fact inbox/snapshot/latest/
  lifecycle generations; alert preferences/events/deliveries/threshold revisions; indexes and guarded source doors.
  FORCE RLS; revoke PUBLIC
  and questify_app; grant only own-preference/system doors; definers pin search_path and system drains refuse ANY
  identity context. No ledger/redemption semantics change. Snapshot ids without player FKs need explicit erasure/
  rehearsal-wipe cleanup (no orphan ids or wipe cycles), exercised by inventory guards.
- New `apps/api/src/ranking/transitions.ts` and `.test.ts`; modify `ranking/{tick.ts,tick.test.ts}`, `app.ts`,
  `server.ts` for DB drain without Redis, non-overlap/backpressure/bounded shutdown. Keep ranking.ts/store.ts cache
  today semantics unchanged; ranking.ts overall publication/afterCompletion MUST change as inventoried above,
  with ranking/store.ts regression tests proving overall cache is unreachable. Shared `packages/shared/src/push/{push,templates,routes}.ts`
  and their tests: two kinds, copy and existing target; preserve later SQL kind cases. Reuse app push center/topic
  controls; app files change only if routing contract test demonstrates need, not a new screen or prompt.
- New `apps/api/src/organizer-alerts/{alerts,routes,worker,templates}.ts` and matching tests;
  `packages/shared/src/organizer-alerts.ts`, export from `packages/shared/src/index.ts`. Wire
  `apps/api/src/{app,server,config}.ts` and `organizers/routes.ts`. Mandatory cancellation/outcome changes to
  `auth/email/{sender,gmail,resend}.ts`, `auth/google-token.ts` and their tests; no auth failover redesign.
  Amend `organizers/team.ts` source transaction prefixes, ranking.ts overall readers, affected raw SQL writer
  services and latest source definer doors via the NEW migration per the lock matrix; never edit old migrations.
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
  permission, TTL/latest-transition staleness and canonical top equivalence. Hold drain, commit 11->9->11 and
  assert BOTH ordered facts exist; read board and completion place after each commit with Redis up/down/repair.
  Hold entry1 through exit2/entry3, then fan-out and claim it: exact identity rejects entry1 at BOTH stages even
  though direction matches entry3; only entry3 remains current. Repeat after lifecycle/enrollment generation reset.
  Ranking off->on between drains and inside one transaction, suspend->resume, end/archive, rehearsal wipe/go-live
  each invalidate old generation and silently reseed; verify no historical crossing/center delivery resurfaces.
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
- Races: two finalizers/drainers/claimers; source commit during snapshot; lower sequence commits late; rollback after
  snapshot/notice; reserve vs restock, cap vs join; removal/opt-out/scope shrink/disable vs final dispatch marker in
  BOTH orders; lease expiry/stale ACK, crash-after-send and timeout-after-acceptance. Fakes only, no real service.
  Use TWO explicit PostgreSQL connections with test barriers at lock acquisition, after authorization, before
  marker and before commit. Assert waits with pg_blocking_pids/held-lock evidence, not sleeps or timing guesses;
  release barriers explicitly. Run BOTH orders for EVERY matrix conflict: membership delete/reaccept, scope
  shrink/expand, staff disable/contact change, preference opt-out, bulk source, lifecycle/settings/rehearsal,
  erasure, reserve/restock/code import and limit/join. Revocation-first yields no marker/fetch; marker-first
  yields at most one authorized attempt and no repeat after revocation. Test G shared/exclusive acquisition
  before legacy device/player locks, multi-event sorted E, rollback, rejected bypass writes, and no deadlock.
  Assert no duplicate uncertain external attempt and no email/PII/provider body in captured logs/traces.
- New manual `apps/api/test/perf/rank-alerts-timing.int.test.ts`: 50,000 members, many excluded leaders, bursts/bulk
  awards/concurrent workers; EXPLAIN ANALYZE index use, completion latency overhead with/without facts, <=20
  crossing facts/transaction, no per-member fan-out. Apply G/E hold/queue gates above, <=5s propagation; 20,000
  completions/minute. Record measured candidate scan/queue age/timings. Failure revises plan, not eligibility or
  silent per-player polling. Organizer email fan-out scales with team count, never attendees.
- AFTER explicit coordinator inspection/acceptance of these corrections (not self-approval): targeted
  tests/types/lint/format/limits between edits, security on schema change,
  full Vitest ONCE, API/web builds + fresh-build browser suite, native export only if app changes; audit/secret scan,
  independent Tier A code review and full coordinator CI. Worker never pushes. Real phones/provider setup, Saudi
  transfer authorization, cancellation drill and suppressed/uncertain-mail runbook remain release gates.
- ADR-355 mutation: push/templates/timers/cache files are NOT eligible just because T-503 is Tier A. Only changed
  access/tenant code: `apps/api/src/organizer-alerts/{alerts,routes}.ts`, `apps/api/src/organizers/routes.ts` if touched,
  restricted to access checks, plus changed `organizers/team.ts` guards. Ledger/redemption value semantics stay
  unchanged, but source lock/finalization doors DO change and need ledger/access review coverage. SQL authorization/
  races get DB tests; coordinator chooses eligible changed core targets, not all transport/cache code.
  Coordinator batches eligible targets on GitHub only, never local Stryker.

## review80 NO-GO resolution map and coordinator handoff

| Finding | Requirement-preserving correction / required proof |
| --- | --- |
| 1: visible 11->9->11 lost by coalesced checkpoints | Ordered source-transaction transition facts; all overall publications become coherent DB reads, including afterCompletion, fallback, repairs and live reads. Exact producer/publication inventory, eligible-only index, lock/cost argument and hot-event throughput gates above. No FR-613 exemption or relaxed product requirement. |
| 2: entry1 survives entry3 because only opposite direction tested | Source-time exact latest transition identity AND generation, equality at fan-out and claim; delayed entry1 after exit2/entry3 tests at both gates. |
| 3: off->on disappears in ids-only dirty inbox | Persist generation/reset edges and silent baseline in source transaction; invalidate prior generations immediately, including lifecycle clock edges and rehearsal wipes. Tests between drains and within a transaction. |
| 4: Gmail token wait remains uncancellable | Explicit google-token.ts/get per-waiter cancellation, post-await/pre-fetch abort checks, unrelated auth caller isolation and deterministic token/send abort tests. |
| 5: EmailSendError conflates refusal and uncertain | Separate structured operational provider/phase outcomes; explicit conservative Gmail/Resend proof rules, no message parsing, timeout retry or auth failover change. |
| 6: vague narrow guards miss writers/deadlocks | Explicit G/E pre-lock matrix covering direct team SQL, deletion/cascade, scope, staff disable, bulk, lifecycle/settings/rehearsal and erasure. Marker-commit linearization; two-connection barriers in BOTH orders, no sleeps. |
| 7: missing total/threshold revision tests | Atomic physical/digital state evaluation and numeric total-change examples; no low-episode reset from revision alone, code-counter/dedup/import/reservation races; cap revisions distinct from stock revisions. |
| Retained strengths/defaults | Durable inbox and captured-id deletion, no Redis dependency, eligible index including worst excluded leaders, transport default OFF, source-time staff ids plus final scope reauth, marker before network, no uncertain retry/failover, membership generations, recovery episodes/genuine cap revisions. No T-609 duplicate infrastructure or invented T-701 producer. |

**Recommendation to coordinator:** accept the ordered-fact/DB-authoritative overall design, subject to checking
the publication/writer inventory and G/E lock/cost trade-off. This is a technical recommendation, NOT acceptance.
ADRs remain Proposed and Qs Open. No implementation until coordinator explicitly accepts this design after inspection;
MAJOR-only corrections do not need another independent plan review under ADR-355. Outstanding technical acceptance:
DB-only overall publication cost, eligible projection maintenance completeness, exclusive global pause budget and
provider refusal allowlist (conservative empty send-retry default). Failure of the planned throughput proof requires
coordinator redesign, never coalescing or a requirement waiver. No new external dependency/account or Dhia question.
Revised build estimate 5-8 focused days plus gated performance proof/review/CI, not authorization or measured effort.
Original planning effort roughly 25k agent tokens; corrections roughly 18k additional tokens (estimates, not billing).
Correction checks: Markdown/source-reference inspection and git diff --check only; CI minutes 0, no children,
code/build/full tests/real services/push/mutation/EAS/deployment/task tick. Markdown excluded by repo oxfmt;
do not claim a formatter pass. Commit corrections locally and STOP for coordinator inspection; no T-504 work.
