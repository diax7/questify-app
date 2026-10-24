# T-306b — Community quests

Community quests (F-101): FR-243 to FR-246, FR-248 to FR-250, FR-1620 and FR-247's points, "a real-world moment" and
"nothing" (the unlocks are T-306c, ADR-219). The design was fixed and CTO-reviewed in the T-306 plan
(`docs/plans/2026-10-24-t-306-live-polls.md`, section "T-306b", ADR-222, ADR-223); this plan builds it and records the
few places where building it showed a gap (listed under "Changes from the fixed design"). **Core bar**: the payer pays
many players at once and writes the ledger: one Opus plan review, one Opus code review, mutation on GitHub.
Migration **0053** (reserved; CranL runs through 0047, so 0052's functions are changed here by restating them, never by
editing 0052). Depends on T-306 (`live_state`, `/live`, `polls_shown`), T-304 (the `bonus` kind this copies), T-211
(rehearsal), T-303c (the lock order and its crossed-lock test), all done.

Dhia is away: open choices are my recommendation, written as **Proposed** ADR-224 to ADR-226 and Q-188 to Q-190.

## What T-306 built that this plan builds on

- `live_state(target)` (0052:391) returns `community: NULL`; `apps/api/src/plays/live.ts` types it `null` and skips the
  per-player query when `event_has_open_poll` is false (3 s per-event cache). Both are extended here.
- **The go-live wipe runs first.** 0052's CTO fix: `vote_quest` calls `ensure_rehearsal_wiped` before it reads the
  quest. Every community writer does the same, as its **first statement**, before it reads any quest, goal, enrollment
  or ledger row: `settle_goal`, `pay_community_batch`, `settle_community`, the goal builder. So a rehearsal account is
  deleted before anything could count it, list it or pay it, and no community row ever names one (the wipe could not
  delete an enrollment a community row references; a test proves no rehearsal account ever lands in one).
- `polls_shown(ev)` hides rehearsal-sent polls between go-live and the wipe; community goals never run before the wipe
  (above), so `live_state.community` needs no such guard beyond the event being live or ended.

## Changes from the fixed design (each folded into the sections below)

1. **Who the settle point must see** (ADR-224). Only `questify_app` and the owner can write ledger rows, so the settle
   point is bounded by their open transactions only. The owner is made a member of `questify_app` in 0053, which lets
   the definer read those sessions' `xact_start` without `pg_read_all_stats`; any of their client backends that still
   reads `state IS NULL` makes the settle refuse loudly (`CV500 settle_blind`), never "no transaction". Other roles'
   sessions (the host's monitoring, an admin's `psql`) are ignored: they cannot block settling forever, and they cannot
   write the ledger through the app.
2. **Tail contributors are not lost** (ADR-225). The fixed design froze the payee list from `community_contributor`,
   filled from settled slices only, while reaching is judged on settled plus tail: a player whose only row sat in the
   tail at the reach would be missed. Contributors are now written from every row read (tail included; they are
   committed rows, and a contributor never stops being one), and each later settle **tops up** a reached
   `contributors` step with contributors whose first counted row is older than the reach, until the settled point
   passes the reach. Same rule as before ("contributed by the time it was reached"), now exact.
3. **A removal counts only when it reverses a counted entry** (inside the window, not rehearsal), so removing a point
   earned before the window never lowers the bar.
4. **Reaching the goal step finishes the goal** at once (`reached`): there is nothing above it to count. The window's
   end only matters for a goal not yet reached.
5. **The payer takes the event `FOR KEY SHARE`** after the rehearsal row and before the enrollments, as
   `remove_award` does (0047), so `confirm_results` (event `FOR UPDATE`) and a batch serialise; no new lock order.
6. **Closing** happens once the settled point passes `least(ends_at, event end)`, which is at least 30 s after it (the
   lag); the separate 15 s from the fixed design adds nothing and is dropped.
7. `event_has_open_poll` is replaced by `event_has_live` (a poll or a goal to show); no shim.
8. There is no worker process or pg-boss yet (one `Pool` in `server.ts`, the ticks run in the API). The 10 s
   `idle_in_transaction_session_timeout` goes on that pool; T-501's worker task gets a note to set it on its pools too.
9. "Settle and pay now" can answer `409 community_settling` (Retry-After 5) when a transaction that began inside the
   window is still open: it settles past the 30 s lag, never past an open transaction.

## The goal (FR-243, FR-245, FR-246, FR-247, FR-248)

`community_goal`: event, `title_ar`/`title_en` (1..80), `measure` `points` | `completions` | `players`, optional
`quest_id` or `category_id` (not both; only for `completions` and `players`; neither means every quest of the event),
`target` (1..1,000,000,000 for points, 1..1,000,000 otherwise), `starts_at` < `ends_at` (at least 1 minute; inside the
event's start and end when set; a start up to 60 s in the past is taken as now, older is refused), `paid_to`
`contributors` (default) | `everyone`, and the tally columns below. At most 20 goals an event.

`community_step`: up to 5 milestones plus the goal step (`threshold = target`, `is_goal`), thresholds distinct,
1 ≤ threshold ≤ target; `reward` `points` (1..100,000) | `moment` (organizer text ar/en, 1..280) | `nothing`.
T-306c adds `unlock`.

- **One running goal at a time**: windows of one event never overlap, checked in the builder under
  `pg_advisory_xact_lock(hashtextextended('community_goal:' || event, 0))` (as rank prizes), so the home shows one bar.
- **Locked at start**: once `starts_at` passes, only the titles and moment texts change (`GL409 goal_locked {field}`);
  a goal is deleted only before it starts (`GL409 goal_started`). A quest or category a goal counts cannot be deleted
  (`RESTRICT`; the builder answers its existing `in_use`).
- **The switch** `config.features.community` (platform and event, as `miniGames`; FEATURES `community: { gated: false }`).
  See "Switches" for what off means.
- Builder doors (owner or editor; definers, audited `community.goal_create` / `_update` / `_delete`):
  `save_community_goal(event, goal, body jsonb, request)` (insert or replace the goal and its steps wholesale before
  start; texts only after) and `delete_community_goal(event, goal, request)`. Team read: `community_goals(event)` with
  steps, reach times, progress, status and payout counts (due, paid, skipped).

## Counting without a hot row (FR-243 to FR-245; ADR-222)

Nothing in the scan transaction touches a goal. The **community tick** (its own timer, every 5 s, jittered ±20% as the
lifecycle tick; several instances harmless) asks `community_tick_goals()` for the goals with work to do, then runs
`settle_goal(goal)` for each, each its own transaction:

1. `ensure_rehearsal_wiped(event)` (first statement), then the goal `FOR UPDATE SKIP LOCKED` (none: another instance
   has it, `'busy'`, skipped).
2. **The settle point** `p = least(now() − 30 s, community_settle_point(), close_at)`, never below `settled_until`:
   `community_settle_point()` reads `pg_stat_activity` once (its per-transaction snapshot, taken before any slice is
   read) for `datname = current_database()`, `backend_type = 'client backend'`, `pid <> pg_backend_pid()`, `usename IN
   ('questify_app', <owner>)`, and returns the oldest `xact_start`; if any such backend reads `state IS NULL` it raises
   `CV500 settle_blind`. The pure part, `settle_point_of(at, starts timestamptz[], blind integer)` (IMMUTABLE), is
   what the tests drive for the blind and oldest-transaction cases. A row's `created_at` is its transaction's start,
   so every row of a transaction still open has `created_at >= p` and is read by a later run.
3. A `scheduled` goal whose start passed (and whose switch is on) turns `running`, `settled_until = starts_at`.
4. One read of `[settled_until, least(now(), close_at))` by `ledger_entry_event_idx (event_id, created_at)`, split at
   `p`: the slice below `p` is added to `settled_value` and `settled_until = p`; the tail above it is shown only.
   `progress = max(0, settled_value + tail)`; for `players` it is the contributor count. Cached in `progress`,
   `progress_at`.
5. Contributors from every row read: `INSERT … ON CONFLICT (goal_id, enrollment_id) DO UPDATE SET first_at =
   least(…)`.
6. Steps newly at or under `progress`: see "Reaching".
7. Finished when the goal step is reached, or when `p` reaches `close_at` (`reached` if the goal step was reached,
   else `missed`, FR-249); `final_at` is set once `p` has also passed the goal step's `reached_at` (no top-up is left).

What counts (rehearsal entries never; `close_at = least(ends_at, event end)`):

| Measure | Value | Contributor |
|---|---|---|
| `points` (FR-244) | `score_delta` of `quest` and `bonus` entries, plus `removal` entries whose reversed entry is a counted `quest`/`bonus` (same window, not rehearsal) | an entry of those kinds with `score_delta > 0` |
| `completions` | `quest` entries of the quest, the category's quests, or any quest; minus removals of counted ones | a `quest` entry counted |
| `players` | the number of contributors | a `quest` entry of the quest, category or any quest |

Awards, welcome, redemptions and community rewards never count; nothing is taken from anyone (FR-244). A category is
read through the quest's current `category_id` (quests rarely move during a goal; recorded in ADR-225).

**Health** (`community_health()`, read at the end of each tick): goals not final whose `settled_until` is more than
2 minutes behind `now()` → `error` log `community.settle_behind {goals}`; due payout rows older than 2 minutes →
`community.payout_stuck {steps, rows}`; a `CV500` → `community.settle_blind`. Ids and counts only, no personal data.
Each gets a RUNBOOK entry, and T-018 gets a note to turn these log lines into alerts (ADR-079 phone and email).

**Idle transactions end** after 10 s: `-c idle_in_transaction_session_timeout=10000` on the API's pool, beside
`lock_timeout` (`server.ts:66`); a unit test reads the pool options.

## Reaching and the payee list (FR-246, FR-248, FR-1620)

When progress reaches a step, `settle_goal` writes `community_reach (step_id PK, goal_id, reached_at = now(),
progress)` once, audits `community.step_reached` (actor `system`) and, for a `points` step, freezes whom to pay as
`community_payout (step_id, enrollment_id, status 'due', created_at)`, primary key `(step_id, enrollment_id)`:

- `contributors`: every contributor so far (step 5 already wrote the tail's), then each later settle tops up
  contributors with `first_at < reached_at` not yet listed, until `p` passes `reached_at`.
- `everyone`: every enrollment then active (`n.status = 'active'`, `p.status = 'active'`, not `joined_via =
  'rehearsal'`, not an operator who may not play), one `INSERT … SELECT`, no enrollment locked. Later joiners are
  not paid (Q-186).

Reached stays reached, even if a later removal lowers progress. Milestones reached before a miss keep their rewards
(FR-246). A `moment` step's text is shown as a card once; `nothing` shows "Reached!" only (FR-247). The milestone push
is T-501's (note there: once per reached step, active members only).

## The payer (ADR-223)

`pay_community_batch(size, only_event)` (system context only, `CS403` otherwise; granted, as
`advance_event_lifecycle`), one transaction per call:

1. Pick the step with the oldest due row (no lock), then `ensure_rehearsal_wiped(event)`, then the event `FOR KEY
   SHARE`.
2. Up to `size` (500) due rows of that step `ORDER BY enrollment_id FOR UPDATE SKIP LOCKED` (only payers touch payout
   rows, so this never waits and two instances split the work).
3. The batch's enrollments **in one statement, in id order** (`SELECT … WHERE id = ANY(…) ORDER BY id FOR NO KEY
   UPDATE`), before any other row lock (ADR-211). No item, no advisory lock, **no XP** (XP follows `quest` entries only,
   0039:214). A later reward with XP or items must take XP rows in player id order and items after the enrollments.
4. Per row: payable when the enrollment and the player are active, the player may play (no `staff_assignment` with
   `can_play = false`) and no `event_result` exists. Payable: one `ledger_entry` kind `community`, actor `system`,
   `score_delta = points`, `balance_delta = points` while `shop_state` is not `closed`, else 0, `community_step_id`;
   the row turns `paid` with `entry_id`, `paid_at`. Otherwise `skipped` with `skip_reason` `inactive` | `no_play` |
   `results_final`. The skip test is exactly `ledger_operator_play_guard`'s, so the guard never rolls a batch back.
5. `mark_ranking_repair(event)` once per batch (the repair tick moves Redis within seconds; today's ranking sums every
   kind already, 0035).
6. Idempotency: the payout row's status, and `ledger_entry_community_key UNIQUE (community_step_id, enrollment_id)
   WHERE kind = 'community'`. A failed batch rolls back whole and stays due. A deadlock or lock timeout (40P01, 55P03)
   is logged `community.pay_failed {code}` and retried on the next tick; a player request that waited on a batch past
   the lock timeout gets the existing `503 busy` (`conventions.ts`) and the app retries with the same key.
7. Budget: the tick calls batches until 2 s are spent (`COMMUNITY_PAY_BUDGET_MS`, Q-187).

Ledger changes: `ledger_entry_kind_check` and `ledger_entry_system_returns_only` gain `community`;
`ledger_entry_community_shape` (step set, `score_delta > 0`, `balance_delta IN (0, score_delta)`, no completion,
quest, redemption or category, actor `system`); `ledger_entry_community_kinds` (`community_step_id` only on
`community` and `removal`); `ledger_operator_play_guard` gains `community`. `remove_award` (as 0047) accepts a
`community` credit and its removal copies `community_step_id`; `member_ledger` marks it removable; `member_activity`
and `member_ledger` name it by the goal's title.

## Results wait, but never forever (CTO 5)

- `confirm_results` (as 0041), after its `not_ended` check, under its event `FOR UPDATE`: `RF409 community_paying`
  while a goal of the event has `final_at IS NULL` or a step has due rows. The API answers `409 community_paying {goals,
  due}`.
- **Settle and pay now** (owner): `settle_community(event, request)`: `ensure_rehearsal_wiped`, then each goal of the
  event not final whose `close_at` passed, `FOR UPDATE` (waits; 2 s lock timeout → `503 busy`), settled with
  `p = least(community_settle_point(), close_at)` (no 30 s lag): if `p < close_at` a transaction from the window is
  still open → `CS409 community_settling`, `409` with `Retry-After: 5`; else settled to the end and finished. Audited
  `community.settle`. The route then runs `pay_community_batch(500, event)` in a system context until nothing is due
  or 20 s pass, and answers `{status: 'paid' | 'paying', due}`; the dashboard calls again while `paying`, then the
  owner confirms again.
- Due rows older than 2 minutes alert (`community.payout_stuck`, above).

## Switches (ADR-226)

- **Event switch off**: trigger `event_community_off` (AFTER UPDATE OF config ON event, when
  `features.community` turns `false`; covers `saveEventSwitch` and `saveEventSwitches`) finishes every running goal at
  once: `reached` if its goal step was reached, else `missed`, `final_at = now()`. Steps already reached still pay;
  nothing is topped up. Scheduled goals do not start while it is off; if it is still off at their end, the tick
  finishes them `missed` with no progress. Lock order: the event row, then the goal rows (the tick never locks the
  event, the payer takes `KEY SHARE`, which an update of `config` does not block).
- **Platform switch off**: the bar is hidden, the builder refuses (`feature_off`, as `switched-off.ts`), new goals do
  not start; running goals keep counting and paying, so a promise made to players is kept.
- Off or on, the tick still finishes goals whose window ended, so `confirm_results` never waits on a switch.

## Where it shows (FR-250)

`live_state(target)` (restated from 0052) fills `community` for an active member while the event is live or ended and
the switch is on: the goal running now, or the latest one finished in the last 30 minutes:

```
{goalId, title: {ar, en}, measure, target, progress, status, endsAt,
 steps: [{threshold, isGoal, reward: {kind, points?, moment?: {ar, en}}, reachedAt, mine: 'due'|'paid'|'skipped'|null}],
 contributed: boolean}
```

read from the cached columns and primary-key lookups (no aggregate per request). `event_has_live(target)` (replaces
`event_has_open_poll`) is true when a poll is open or closed in the last 15 minutes, or a goal is shown, so the API's
3 s cache still answers empty events at once. The ETag (without `serverNow`) changes as `progress` moves.

- **App, event home**: a wooden bar filling with gold (brand deck), step markers with their reward, "{progress} of
  {target}", the time left, "Counting the last points…" between the end and the finish, "Reached!" or "Not reached";
  a one-time card for a reached `moment` step and for `mine = 'paid'` ("+{points} community reward"), remembered on the
  phone as the poll results card. Accessible: the bar is a progress role with its value read out; RTL fills from the
  right. The big-screen bar is T-504's (note there: read the cached columns).
- **Dashboard**: a Community page on the event (list, form, a static preview of the bar at 0 and at the first
  milestone, since goals do not run in rehearsal (Q-186); while running, progress and payout counts refreshed every
  5 s); the event's switches gain "Community quests"; the results page shows `community_paying` with **Settle and pay
  now** (confirm dialog).

Strings (Arabic via `ux-araby`, Western digits, RTL checked; drafts):

| Key | English | Arabic |
|---|---|---|
| community.title | Community quest | مهمة جماعية |
| community.progress | {progress} of {target} | {progress} من {target} |
| community.measure.points | Points earned by everyone | النقاط التي جمعها الجميع |
| community.measure.completions | Quests completed by everyone | المهام التي أنجزها الجميع |
| community.measure.players | Players taking part | اللاعبون المشاركون |
| community.endsIn | Ends in {time} | ينتهي خلال {time} |
| community.counting | Counting the last points… | نحسب آخر النقاط… |
| community.reached | Reached! | تحقّق الهدف! |
| community.notReached | Not reached | لم يتحقّق الهدف |
| community.forContributors | +{points} for everyone who took part | +{points} لكل من شارك |
| community.forEveryone | +{points} for every player | +{points} لكل لاعب |
| community.paid | +{points} community reward | +{points} مكافأة جماعية |
| community.contributed | You helped | ساهمتَ في التقدّم |
| history.community / awards.kind.community | Community reward | مكافأة جماعية |
| results.communityPaying | Community rewards are still being paid. | ما زالت المكافآت الجماعية قيد الصرف. |
| results.settleNow | Settle and pay now | احسب واصرف الآن |

Plus the builder's labels and errors (`goal_overlap`, `goal_locked`, `goal_started`, `community_settling`).

## API

- Team (owner or editor; idempotency key on writes): `GET …/events/{eventId}/community-goals`, `POST` (create),
  `PATCH …/community-goals/{goalId}`, `DELETE …/community-goals/{goalId}`. Refusals: `422 invalid_goal {issues}`,
  `409 goal_overlap`, `409 goal_locked {field}`, `409 goal_started`, `422 feature_off`, `404`.
- Owner: `POST …/events/{eventId}/community/settle` → `{status, due}`; `409 community_settling` with `Retry-After`.
- `POST …/results/confirm`: `409 community_paying {goals, due}` (`results.ts` `RF409_DETAILS`).
- `GET /v1/events/{id}/live`: `community` as above (`LiveState` type in `live.ts`).
- Every route in `route-access.ts` and classified in `routes.int.test.ts`. Module `apps/api/src/community/`:
  `goals.ts` (builder), `tick.ts` (`startCommunityTick`, registered in `app.ts` with `communityIntervalMs`, stopped
  on close), `payer.ts` (the batch loop shared by the tick and the settle route), `routes.ts`.

## Data (migration 0053)

- Tables `community_goal`, `community_step`, `community_reach`, `community_contributor`, `community_payout`, each with
  `organizer_id`/`event_id` composite foreign keys (as `category_bonus`), RLS **enabled and forced**, `REVOKE ALL …
  FROM PUBLIC`, **no grant**, in the statement block that creates them. Goal and steps cascade with a draft event's
  delete; reach, contributor and payout rows `RESTRICT`. Indexes: goal `(event_id, starts_at)` and a partial
  `(status) WHERE final_at IS NULL`; payout `(step_id, enrollment_id) WHERE status = 'due'` and `(created_at) WHERE
  status = 'due'`; contributor PK `(goal_id, enrollment_id)`.
- `ledger_entry.community_step_id uuid` (FK `RESTRICT`), the constraints and unique index above.
- `GRANT questify_app TO <owner>` when `NOT pg_has_role(current_user, 'questify_app', 'USAGE')` (a failure fails the
  migration, loudly; RUNBOOK deploy note). `--verify` gains the check.
- Functions (every one `REVOKE ALL … FROM PUBLIC` in this file; only the doors granted to `questify_app`):
  internal `community_on`, `community_close_at`, `settle_point_of`, `community_settle_point`, `community_read_slice`,
  `settle_goal_at`, `community_freeze_payees`; system doors `community_tick_goals`, `settle_goal`,
  `pay_community_batch`, `community_health`; team doors `save_community_goal`, `delete_community_goal`,
  `community_goals`, `settle_community`; restated `live_state`, `confirm_results`, `remove_award`, `member_activity`,
  `member_ledger`, `ledger_operator_play_guard`; `event_has_live` replaces `event_has_open_poll` (dropped); trigger
  `event_community_off`.
- `wipe_rehearsal` is not restated: no community row can name a rehearsal account (above, tested).
- Erasure keeps the rows (they name an enrollment, which stays as a tombstone with status `left`); a due row of an
  erased player is skipped `inactive`.

## Lock order (rules.md, ADR-211)

| Function | Order |
|---|---|
| `settle_goal`, `settle_community` | rehearsal row (shared, or the wipe) → goal `FOR UPDATE` (SKIP LOCKED in the tick); no enrollment lock |
| `pay_community_batch` | rehearsal row → event `KEY SHARE` → payout rows SKIP LOCKED → the batch's enrollments, one statement, id order |
| `confirm_results` | rehearsal row → event `FOR UPDATE` → (quiz sweep) enrollments; reads goals and payouts without locks |
| `event_community_off` | event (the config update) → goals |

rules.md's lock-order paragraph gains the payer's line.

## Store compliance

No push is needed (the bar comes from the app's polling; Apple 4.5.4). Points are for playing the event, never for
turning anything on. Remote config changes data only: the feature is in the reviewed binary, the review notes list it,
and the demo event gets a running goal the day a build goes to review (RUNBOOK step).

## Tests (test first)

- **Database** (`test/db/community.int.test.ts`): each measure, with the quest, the category and neither; window edges
  (a row a millisecond before the start and at the end does not count); removals (inside, of a pre-window entry: not
  counted); awards, welcome and redemptions never count; rehearsal rows and accounts never counted, listed or paid
  (an event going live with a rehearsal running and a goal running: the tick wipes first); the settle point held by an
  open transaction on a second connection, and released when it commits; `settle_point_of` blind case raises `CV500`;
  the 30 s lag; the tail shown but not settled; reaching on the tail with a tail-only contributor paid; the top-up of a
  straggler (a row committed after the reach from a transaction that began before it); `everyone` excludes left,
  banned, pending, rehearsal and no-play operators, and later joiners; reaching the goal finishes it; a miss pays
  nothing and keeps the milestones' rewards (FR-246, FR-249); `moment` and `nothing` write no ledger entry; overlap
  refused; edits after start refused except texts; delete after start refused; a counted quest cannot be deleted; the
  switch off finishes running goals (reached stays, missed otherwise) and keeps scheduled ones from starting; payer:
  pays once (a second batch over the same rows pays nothing; the unique index refuses a hand-written second entry),
  skips each reason, balance 0 when the shop is closed, no XP row, one repair mark; `confirm_results` refuses
  `community_paying` until final and paid, then confirms; `settle_community` (owner only; `community_settling` with an
  open transaction; settles and finishes); `remove_award` of a community entry; `live_state.community` (running,
  finished within and past 30 minutes, switch off, not a member, `mine` and `contributed`).
- **Crossed locks** (two connections, as `test/db/meet.int.test.ts`): a payer batch and a meet payment over the same
  two players, both orders; a payer batch and `confirm_results`; a payer batch and a player's completion that waits
  (completes after the batch, under the lock timeout); nobody paid twice, no deadlock, or a deadlock turning into a
  retried batch and a `503 busy`.
- **Timing** (`test/perf/community-payer-timing.int.test.ts`): 10,000 players paid within 30 s on the CI runner, one
  batch of 500 under 250 ms; one `settle_goal` over a minute of 20,000 completions under 100 ms.
- **Security**: outsider (the five tables and every new function, `anon` and `PUBLIC`); cross-tenant (the builder,
  `community_goals`, `settle_community` on organizer B's event; `live` for an event the player is not in); the five
  tables classified in `cross-tenant.int.test.ts`.
- **Route**: the builder's body and refusals, settle (`paid`, `paying`, `community_settling` with `Retry-After`), the
  confirm refusal, `/live` with `community` and its ETag; the tick (unit, with a fake pool: jitter, budget, logs
  without personal data, stop waits for a run).
- **App**: the bar (each status, steps, RTL fill, Arabic), the one-time cards; `expo export`. **Web**: the Community
  page form and preview, the switch, Settle and pay now (desktop and phone).
- **Mutation (GitHub)**: `apps/api/src/community/**`, `apps/api/src/plays/live.ts`, `apps/api/src/results/results.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0053 + database, crossed-lock, timing and security tests.
2. API: builder, tick, payer, settle route, confirm refusal, `/live`, pool option + route and unit tests.
3. App bar and cards, dashboard page, switch and settle button, strings; docs (API.md, DATA_MODEL.md, SRS status of
   FR-243 to FR-250 and FR-1620, FEATURES, STORE_COMPLIANCE review notes, RUNBOOK alerts and deploy note, rules.md lock
   order, notes on T-306c, T-501, T-504, T-018, TASKS, STATE).

## Proposed decisions and questions

- **ADR-224** The settle point reads only the sessions that can write the ledger (`questify_app` and the owner); the
  owner becomes a member of `questify_app` to read them; an unreadable one stops settling loudly. Q-188.
- **ADR-225** Counting details: contributors are written from every row read and a reached `contributors` step is
  topped up with anyone whose first counted row predates the reach; a removal counts only when it reverses a counted
  entry; a 0-point completion makes no contributor of a points goal; reaching the goal finishes it; a category is
  read through the quest's current category; the goal shows in `/live` while running and 30 minutes after. Q-189.
- **ADR-226** Switches and the owner's settle: the event switch off finishes running goals (reached steps still pay)
  and holds scheduled ones; the platform switch off hides the bar and the builder but lets running goals finish and
  pay; Settle and pay now settles past the lag but never past an open transaction, and pays for up to 20 s a call.
  Q-190.
- ADR-222 and ADR-223 gain build notes for changes 2 to 6 and 9.
- **Q-188** On CranL, may the migration make the owner role a member of the app role (so the server can see which of
  its own transactions are still open)? If CranL refuses, the fallback is granting the owner `pg_read_all_stats`.
- **Q-189** Community counting: a player who earned 0 points does not count as taking part in a points goal; reaching
  the goal ends it early; it stays on the home screen 30 minutes after it ends. Agree?
- **Q-190** Switching community quests off for an event ends a running goal at once (rewards already reached are still
  paid); switching them off for the whole platform only hides them and lets running goals finish. Agree?
