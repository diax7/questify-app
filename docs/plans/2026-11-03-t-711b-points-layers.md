# T-711b - Feature layers, part 2: the points-path features and the recorded Ask Questify request (plan, tier A)

Delivers FR-1826 (completes it: the per-organizer override reaches `boosts`, `community`, `meetSomeone`, `miniGames`)
and FR-1827 (the recorded Ask Questify request). Depends on T-711 (migration 0136, `organizer_feature_override`,
`platform_feature_on`, `platformForOrganizer`, ADR-500 to ADR-504). Migration **0139**. ADR-540 to ADR-546 Proposed;
Q-500 to Q-503 Proposed. Tier A for part 1 (points path): plan review, build, one code review, mutation on GitHub for
the touched TypeScript. Part 2 (the request) is tier B logic riding in the same task; no mutation for it.

**Amended 2026-11-03 after the plan review (score 86).** (1) MAJOR: a boost saved earlier with a later start still begins
paying once its window opens under a layer Off (as under the platform switch, ADR-233), but its "boost started" push and
notice now wait for `feature_enabled(ev, 'boosts')` (the event switch and the layer): `push_on_boost_start`,
`push_due_boost` and `notice_audience_ok` are restated (section 3, item 5); the scan path is untouched. (2) The old
`settle_*` signatures are still dropped; RUNBOOK gets the deploy note, and `community.settle_failed` is a log line, not an
alert (no alert rules exist before T-018, whose note now says to alert on repeats, never on one line). (3) `REVOKE ALL ...
FROM PUBLIC` on every new function; Allow runs in TypeScript as the admin, so it closes the request through an admin RLS
policy; Allow closes any open row (whether the unlock was new or already there) and the console list hides open rows
whose add-on is already unlocked (an owner asking while an admin unlocks). (4) `requested_by` and `decided_by` are staff
ids with no foreign key, listed as ADMIN in `test/db/personal-data-catalog.ts`; the new routes are staff and admin routes,
so maintenance's `PLAY_DOORS` does not apply. (5) Notes: test 5 (`meet_player` checks the switch before its replay
lookup, as before), Q-500 (with the layer Off the owner cannot switch the event's boosts off, the switch is hidden; checked in build: Stop on
the Boosts page still ends a running boost, `end_boost` has no switch check, and a test holds that).
Deviation found in build: `platformOnFor` answers undefined (not false) for an event that is not the caller's
organizer's, so the door answers 404 as before instead of a 403 that would tell one organizer about another's layer.

## 1. What exists (read for this plan)

**The four SQL rules and every caller** (latest restatement of each caller in brackets):

| Rule | Body today | Callers |
|---|---|---|
| `boosts_on(event)` (0055, IMMUTABLE) | the event's switch only | `boost_in_force` (0055; every payer and reader of a boost, so **inside `pay_completion`**), `notice_audience_ok` boost_start (0080), `push_on_boost_start` trigger (0078), `push_due_boost` (0078) |
| `community_on(event)` (0053, IMMUTABLE) | the event's switch only | `settle_goal_at` start branch and running branch (0053), `member_community` (0054), `notice_audience_ok` community_step (0080), the big screen scene and finale (0083, 0084, 0109; these also call `feature_enabled(ev,'community')`) |
| `games_on(uuid)` (0050, STABLE) | the event's switch only | `start_game_round` (0050) only; `finish_game_round` (0062) never reads it |
| `meet_on(uuid)` (0049, STABLE) | the event's switch only | `issue_meet_pass` (0049), `meet_player` (0098) |

**The platform switch of the four is read in TypeScript, platform-wide** (`settings.forEvent(undefined)`):
`boostsPlatformOn` (`saveBoost`), `communityPlatformOn` (`saveGoal`, `deleteGoal`, the tick's and the owner's settle
`mayStart`, `live.ts` community card), `gamesPlatformOn` (`startRound`), `meetPlatformOn` (`issueMeetPass`,
`meetPlayer`). Their behaviour today (ADR-233, ADR-226): **the platform switch stops new things only** (no boost saved,
no goal saved or started, no round started, no pass issued, no meet scan); **the event's switch also stops running
things** (a boost in force stops paying at once; `event_community_off` finishes running goals: reached if the goal step
was reached, else missed, reached steps still pay). A started round always finishes and pays.

## 2. The rule: the override acts exactly where the platform switch acts (ADR-540)

The override is "the platform switch as one organizer sees it" (ADR-501). So it replaces the platform reading wherever
the platform is read today, and nowhere else. Concretely:

| Feature | "New" (refused when the layer is Off) | "In flight" (unchanged: event switch only) |
|---|---|---|
| boosts | saving or editing a boost; the start push and notice | a boost in force pays until its end (at most 1,440 minutes); a boost saved earlier pays once its window opens (ADR-233) |
| community | saving or deleting a goal; a scheduled goal starting | a running goal settles, finishes and pays reached steps |
| miniGames | starting a round | a started round finishes and pays |
| meetSomeone | issuing a pass; a meet scan | nothing is in flight (a pass is not a payment) |

So `boosts_on` and `community_on` **are not restated** (no change to `boost_in_force`, hence none to `pay_completion`, and
none to `settle_goal_at`). `games_on` and `meet_on` are restated to call `feature_enabled`, because their doors are the
"new" point and the event is only known inside SQL (a meet scan finds its event from the token). This departs from the
task note "make the four SQL rules call `feature_enabled`": doing that would also change the **global** platform switch
for boosts and community from "stops new" to "stops running" (ADR-233, ADR-226) and add two lookups to every scan's
`boost_in_force`. Q-500 asks whether a layer Off should stop running boosts and goals; recommended no.

## 3. Migration 0139 (diff-minimal)

Header comment in the style of 0136; `SET LOCAL lock_timeout = '10s'`; lock order up front: `event`, then `organizer`
(foreign-key targets of the new table, SHARE ROW EXCLUSIVE), then `organizer_feature_override` (ACCESS EXCLUSIVE for the
CHECK change). A scan only reads these; the migration holds them for milliseconds (the override table has at most a few
rows per organizer, the widened CHECK is satisfied by every existing row).

1. **Widen the CHECK** of `organizer_feature_override.feature` to the 16 keys (the 12 plus `boosts`, `community`,
   `meetSomeone`, `miniGames`): one `ALTER TABLE … DROP CONSTRAINT organizer_feature_override_feature_check, ADD
   CONSTRAINT … CHECK (…)`. 0136 stays untouched.
2. **`games_on(uuid)` and `meet_on(uuid)`**, `CREATE OR REPLACE`, same signature, still STABLE, no grant:
   `SELECT coalesce((SELECT feature_enabled(e, 'miniGames') FROM event e WHERE e.id = target_event), true)` (and
   `'meetSomeone'`). An unknown event stays `true` (the doors refuse it themselves, as before).
3. **`settle_goal(uuid)` and `settle_community(uuid, uuid)`** replace `settle_goal(uuid, boolean)` and
   `settle_community(uuid, boolean, uuid)` (`DROP FUNCTION` of the old signatures, then create, `REVOKE … FROM PUBLIC`,
   `GRANT EXECUTE … TO questify_app` in the same group). Body: 0114's `settle_goal` and 0053's `settle_community`
   verbatim, except `may_start` becomes a local `platform_feature_on(ev.organizer_id, 'community')`, read **once per
   call** (once per goal in the tick, once per event before the loop in `settle_community`). `settle_goal_at` keeps its
   `may_start` parameter and is not restated. Reason for dropping the parameter (ADR-542): the platform now has a per-
   organizer value that only the database can give per goal; a boolean from the caller would be dead.
4. **`feature_request`** and its doors (section 7).
5. **The boost-start push and notice (review MAJOR 1)**: `push_on_boost_start` (0078), `push_due_boost` (0078) and
   `notice_audience_ok` (0080) are restated with `feature_enabled(e, 'boosts')` in place of `boosts_on(e)` for the boost
   kind, nothing else changed. A scheduled boost whose window opens under a layer Off pays (the scan path reads
   `boost_in_force`, unchanged) but nobody is told of a feature the app hides; the due scan pushes it if the layer comes
   back On while it still runs. The global platform switch now also silences that push (it hides the feature too).
6. No other function is restated. `boosts_on`, `community_on`, `boost_in_force`, `pay_completion`, `meet_player`,
   `issue_meet_pass`, `start_game_round`, `finish_game_round`, `member_community` keep their
   bodies; `meet_player` and `start_game_round` pick the new `meet_on`/`games_on` by name.

Deploy window: between the migration and the new API, the old API calls `settle_goal(uuid, boolean)`, which no longer
exists. The tick logs `community.settle_failed` and the next run (new code) settles; the settle point catches up (0053).
The owner's "Settle and pay now" answers 500 for those seconds. Accepted, noted in RUNBOOK's deploy notes.
`community.settle_failed` is a log line, not an alert (no alert rule exists before T-018; its task note says to alert on
repeats over several ticks, never on one line). Every function the migration creates gets `REVOKE ALL ... FROM PUBLIC`
in the same group.

## 4. TypeScript

- **Registry** (`packages/shared/src/config/registry.ts`): drop `noOrganizerOverride` from the four entries, then drop the
  field from `FeatureDefinition` and from `isOrganizerOverridable` (no other user; replace, don't deprecate). The console
  panel, `platformForOrganizer`, `firstSwitchOnRefused` and the owner's list pick up the four from the registry. The
  owner's switch-on refusal (ADR-503) now covers them too.
- **One helper** (`apps/api/src/settings/layers.ts`): `platformOnFor(db, registries, eventId, feature)` answers the
  platform switch as the event's organizer sees it, from `readEventLayerInputs` inside the caller's transaction
  (undefined event → `false`). Used by `saveBoost`, `saveGoal`, `deleteGoal` (three callers).
- **Boosts** (`boosts.ts`): `boostsPlatformOn` is removed. `saveBoost` reads `platformOnFor(…, 'boosts')` and the event's
  own switch in one `asTeam` call; `feature_off` (platform layer) and `event_feature_off` stay distinct answers.
- **Community** (`goals.ts`, `tick.ts`, `payer.ts`, `live.ts`): `communityPlatformOn` is removed. `saveGoal` and
  `deleteGoal` read `platformOnFor(…, 'community')` inside their `asTeam` call. The tick calls `settle_goal($1)`, the
  owner's settle `settle_community($1, $2)`. `live.ts` shows the card when `eventFeatureOn(settings, eventId, playerId,
  'community')` (composed configuration, cached per event and player like the polls check beside it).
- **Meet and games** (`meet.ts`, `games.ts`): `meetPlatformOn` and `gamesPlatformOn` and their three pre-checks are
  removed; the SQL door answers QF403, which `run.ts` already maps to `feature_off` (same 403 body as before). A refused
  QF403 meet scan must not count toward `REFUSED_LIMIT` (only bad codes do); the builder checks the counting rule and
  adds a test.
- **Owner pages** need no change: the four switches already come from `GET …/events/{id}/features`.

## 5. Cost per scan (lock-free reads, per event, never per row)

| Door | Added work |
|---|---|
| quest scan / completion (`pay_completion`, `boost_in_force`) | **none** |
| community reach (ledger rows counted by the settle) | **none** in the scan; the settle reads one override PK and the platform row once per goal |
| meet scan (`meet_player`), pass (`issue_meet_pass`) | `feature_enabled`: one override PK probe and the platform row's PK probe, once per call, before any lock |
| game round start (`start_game_round`) | the same, once per call; the result (`finish_game_round`) none |
| `push_due_boost`, notice filtering | none |

The meet and game doors add two index probes on single-page tables, not one: the platform switch was read from the API's
cache before and is now read in the door (that is what makes it per organizer and atomic). `flash_on` and `shop_on` pay
the same since 0136. The builder records `EXPLAIN (ANALYZE, BUFFERS)` of `meet_player` before and after in the test log
(no budget change expected).

## 6. Locks, waits and a switch-off racing a payment (ADR-546)

- **No new lock anywhere in a payment.** The gates are plain reads under READ COMMITTED; a reader never waits on the
  admin's row lock on `organizer_feature_override` or on its advisory lock. The gate is read first in each door, before
  `meet_player`'s and `start_game_round`'s enrollment locks, so the lock order of those doors is unchanged.
- **The admin's write** (T-711: advisory lock, then the row) takes no lock a payer holds, so it never waits on a scan.
- **The race.** Order A: the override Off commits, then the door reads it: refused, nothing written. Order B: the door
  read the gate before the commit: the action completes and pays. Either way the points stand (never clawed back) and the
  next door call is refused. For boosts and community the override never changes a running payment (section 2).
- **A feature switched off mid-event** (layer Off): a running boost pays to its end; a running goal settles, finishes and
  pays its reached steps; a scheduled goal stays scheduled (and is missed once its window ends, as today); a started round
  finishes and pays; a meet pass already shown is refused when scanned; no new boost, goal, round or pass. Switching back
  On lets a scheduled goal whose window is still open start on the next tick. The owner's event switch keeps its stronger
  effect (ADR-233, ADR-226). Nothing is reversed in the ledger.

## 7. The recorded Ask Questify request (FR-1827, ADR-545)

- **Table `feature_request`** (forced RLS, no PUBLIC): `id`, `organizer_id`, `event_id` (FK, cascade), `feature` (CHECK:
  the gated features, compared with the registry by a test), `status` (`open`, `allowed`, `declined`), `requested_by`
  (staff user id), `requested_at`, `decided_by` (admin id, null while open), `decided_at`. Unique partial index: one
  `open` row per (event, feature). Ids, a key and times only: no message text, no names, no contact fields.
- **Who records it:** the event's **owner** only (switches are owner-only; Q-502), for an add-on Questify has not
  unlocked for that event. Door `request_feature(event, feature, request)` (SECURITY DEFINER, granted to `questify_app`):
  RQ403 not the owner, RQ422 not an add-on, RQ409 already unlocked, the open row returned again on a repeat (natural
  idempotency), RQ429 within 24 hours of a decline of the same event and feature. Audited `feature_request.create`.
- **Rate limit:** the API's `holdBack` bucket `featureRequest`, 20 an hour per staff account, on top of the one-open rule.
- **Where admins see it:** a Requests list on the console home (`GET /v1/admin/feature-requests`, open first, oldest
  first, 50 a page by cursor; event name, organizer name, feature, time): business names only. Each row: **Allow** is
  the existing `PUT /v1/admin/events/{id}/addons/{feature}`, which now also closes the open request (`allowed`) in the
  same transaction; **Decline** is `POST /v1/admin/feature-requests/{id}/decline` (audited `feature_request.decline`).
  Both through `throttled`. A lock (`DELETE …/addons/…`) never reopens a request. Admin notification: Q-501.
  Allow runs in TypeScript as the admin (`insertEntitlement` inside `asAdmin`), so the close is an UPDATE allowed by an
  admin RLS policy (`app_admin_id()`), the same transaction as the unlock. Allow closes any open row, whether the unlock
  was new or already there; the console list hides open rows whose add-on is already unlocked (the owner asked in the
  instant an admin unlocked). `requested_by` and `decided_by` are staff ids with no foreign key (ADMIN in
  `test/db/personal-data-catalog.ts`). The new routes are staff and console routes: maintenance's `PLAY_DOORS` does not
  apply.
- **Owner's card** (event page and guided setup): locked add-on card shows Ask Questify, then "Requested" (button off),
  then the unlocked switch after Allow, or "Not approved" with Ask again after 24 hours. `GET …/events/{id}/features`
  rows gain `request: {status, at} | null`. Arabic and English strings in `messages.ts` (ux-araby), RTL, Western digits.
  The Contact page link stays as a second line.
- **Security suites:** route inventory, outsider (no grant on the table; the doors refuse the public role), cross-tenant
  (another organizer's owner cannot request, read or see a request), console-only for the list and decline.

## 8. Tests

**Database** (`test/db/feature-layers-points.int.test.ts`, new; `test/db/feature-layers.int.test.ts` updated):
1. The CHECK holds exactly the 16 overridable registry features (existing parity test, now 16).
2. `games_on` and `meet_on` agree with `composeConfig` in every state of platform, override and event switch (extend the
   existing parity table); `boosts_on` and `community_on` read the event switch only in every layer state (the split is
   asserted, not accidental).
3. `start_game_round`, `issue_meet_pass`, `meet_player`: refused QF403 with nothing written under override Off with the
   platform On; allowed under override On with the platform Off; another organizer's event unaffected.
4. A round started before override Off finishes with `finish_game_round` and pays once.
5. A pass issued before override Off: the scan after is refused, neither side gets a completion or ledger row. (As
   before this task, `meet_player` checks the switch before its replay lookup, so a replayed scan is refused too.)
6. **Race, both orders, per door (meet scan, round start):** (A) override Off committed, then the door: refused. (B) a
   second session opens a transaction, writes override Off and holds it; the door runs with `lock_timeout = '200ms'` and
   completes without waiting and pays; the admin commits; the points stay; the next call is refused.
7. **Boost racing a layer Off, both orders:** a completion under a running boost pays doubled whether the override Off
   committed before or is held open during the payment; `pay_completion` never waits (200 ms lock timeout). The event
   switch Off still stops it at once (existing test kept). **A scheduled boost under a layer Off (review MAJOR 1):**
   saved before the layer went Off, its window opens: a completion pays doubled, no `boost_start` notice is written by
   the trigger or the due scan and `notice_audience_ok` refuses one written earlier; the layer back On, the due scan
   writes it.
8. **Community:** a scheduled goal does not start under override Off and does for another organizer; override On with
   the platform Off starts it; a running goal under override Off keeps settling, reaches, and its reached step pays;
   `settle_goal` racing the override write in both orders (starts or stays scheduled; no wait); `settle_community`
   reads the layer once per call; the old two- and three-argument functions are gone.
9. The completeness guards (function list, rehearsal, community gate map) list the new and dropped functions.
10. `feature_request`: owner records; editor, another organizer's owner and an outsider refused; one open per event and
    feature; repeat returns the open row; 24-hour wait after a decline; Allow closes it in the unlock's transaction;
    a lock does not reopen it; audit rows hold ids only.

**API**: `boosts` (save refused `feature_off` under override Off, allowed under override On with platform Off;
`event_feature_off` unchanged), `community/goals` (save and delete the same), `plays/meet-games` (the removed pre-checks'
tests replaced by integration tests that the SQL refusal answers the same 403 `feature_off` body; a QF403 scan does not
use the refused-scan limit), `plays/live` (the card follows the override), `test/console/organizer-features` (16 rows),
`test/events/feature-layers` (owner switch-on of the four refused under a layer Off), the request routes (201 then 200
on repeat, 403, 404 for another organizer, 422, 409, 429 both limits), console list and decline, the three security
suites. **Shared**: `layers.test.ts` without `noOrganizerOverride`. **Web**: the card states, the console Requests list,
`e2e/feature-layers.spec.ts` (ask, allow, switch works), `console-organizers` (16 rows).

## 9. Mutation (GitHub, `mutation.yml`, ledger and access code only)

`apps/api/src/boosts/boosts.ts`, `apps/api/src/community/goals.ts`, `apps/api/src/community/tick.ts`,
`apps/api/src/community/payer.ts`, `apps/api/src/plays/meet.ts`, `apps/api/src/plays/games.ts`,
`apps/api/src/settings/layers.ts`, `packages/shared/src/switches/layers.ts`. Not the request code (tier B).

## 10. Docs the build updates

`docs/DATA_MODEL.md` (`feature_request`, the CHECK), `docs/API.md` (request and console routes, the features list's
`request` field, `settle_*` signatures in the function notes), `docs/CONFIGURABILITY.md` (line 67: the four are
overridable; the "new vs in flight" table), SRS FR-1826/FR-1827 status, `docs/TASKS.md`, STATE.

## 11. Risks

- The split "new vs in flight" is a product rule a reader may not expect (an organizer switched Off still sees a running
  boost pay for up to a day). Recorded in ADR-540 and Q-500.
- Dropping the `settle_*` boolean breaks the old API for the seconds of a deploy (section 3).
- The two probes on the meet and game doors read the platform row live instead of the API cache; a platform switch now
  takes effect on those doors at once rather than after the cache time (a gain, but a visible change).
- Nine test files call `settle_goal(…, true)`; the change is mechanical, but tests passing `false` to mean "platform Off"
  must now write the platform or override row instead.
