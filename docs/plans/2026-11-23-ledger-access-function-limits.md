# Ledger and access function limits: the last 6 apps/api offenders (plan)

Tier A (points ledger, prize handover, redemptions, route access), the sibling of "Core function limits" (same day).
Same style: small named helpers next to the function, pure helpers exported and unit-tested, `refusalThrower`
(`apps/api/src/refusal-table.ts`) for a result-to-error switch, then `node scripts/function-limits.mjs --update` (the
baseline only shrinks; all six `apps/api` entries leave it). No SQL, migration, error code, status, header, log event or
log field changes. Measured today with `.oxlintrc.limits.json`.

**Rules for every split.** (1) Same database calls in the same order on every path, same transaction boundaries (no
helper opens or closes a `withConnection`/`withRequestContext`/`asPlayer`; each stays wrapped around exactly what it
wraps now). (2) Same checks in the same order, so the first refusal for any input is unchanged. (3) Idempotency keys are
passed through untouched (same value, same parameter position); reserve/release of attempt limits is not moved.
(4) Logs and errors keep their fields; no code, token, position or distance in a log. (5) Every `// Stryker disable`
comment moves with its line, unless a new test kills the mutant (then it is dropped and the reply says so). **Abort
rule:** if a split cannot meet (1)–(3), or any pinning test below needs an edit, keep that function as it is and leave
it in the baseline.

| # | Function | What it does | Split |
|---|---|---|---|
| 1 | `completions/complete.ts` `completeQuest` (12) | Location switch, `prepare` (signature check or attempt reservation), the one engine transaction, release, log | `askedOf(deps, request)`: reads `locationQuestsOn` under the same condition (never for a scan without a reading), returns `"feature_off"` for a check-in while off, else the request with `position` nulled while off. `runEngine(deps, asked, prepared, caller)`: the unchanged `withConnection(withRequestContext(callEngine))`, release-then-rethrow on a throw, release after unless `countsAsRefused`. `completeQuest` keeps: `askedOf` → `refused(feature_off)` (logged with `request`, as now) → `prepare` → `refused` → `runEngine` → `quest.completed` log or `refused`. Release still happens before the log. |
| 2 | `completions/routes.ts` `answer` (12) | Completion refusal to HTTP error | `refuseCompletion = refusalThrower<Exclude<CompletionResult, {kind:"completed"}>, [reply]>({...})`. `invalid_code` keeps `problem === "expired" ? screenCodeExpired() : questCodeInvalid()`; `too_many_attempts` sets `retry-after` then returns `tooManyAttempts({retryAfterSeconds})`; `location_refused` keeps the `distanceM` omission when null. The handler calls `return refuseCompletion(result, reply)` (the thrower takes the result first). The `RefusalTable` type forces every kind. |
| 3 | `desk/routes.ts` `refuse` (16) | Desk refusal to HTTP error | `refuse = refusalThrower<DeskRefusal>({...})`: `not_found`, `not_in_event`, `old_code` all `notFound()`; `held` keeps `hold === "paused" ? pausedAtDesk() : heldAtDesk()`. `valueOf`, the lookup route's own `refused` answers, the find route's `throttled` branch and the accept route's held→`offerGone` stay where they are, before `refuse`. The `old_code` Stryker comment is dropped: the new per-kind test pins it. |
| 4 | `rewards/shop.ts` `reserveReward` callback (13) | One `reserve_reward($1,$2)` call, row to `Reservation` | Exported helper `reservationOf(deps, rewardId, row)` taking `row ?? {}` (all 13 points are `row?.[…]`; an absent row reads the same `undefined` values as today). Same key order (`...reveal(...)` last in `redemption`), `reveal` called once with the same four ids, so `reward.code_unreadable` logs as now. Query, its parameters (`rewardId`, `idempotencyKey`) and `asPlayer`'s SQLSTATE mapping unchanged. `cancelRedemption` is under the limit: not touched. |
| 5 | `route-access.ts` `onRoute` hook (20) | Refuses any route without a known access kind or outside its guarded path | Deny by default kept: the hook still runs on every route, and `isAccess` is still the first check per method, throwing the same message. The seven later checks become an ordered `ROUTE_RULES` array of small pure rules over `{name, url, access, idempotent, hasDecorator}`, each returning its exact current message or `undefined`; the hook throws the first message, in today's order (staff, organizer, admin, player guard, device path, device guard, public idempotent). No rule can pass a route early: every rule runs until one refuses; `inventory.push` still comes only after all. `idempotent` stays `=== true`. `isDevicePath`, the prefixes and decorator names unchanged. |
| 6 | `app.ts` `buildApp` (174 lines) | Builds every dep and registers every hook and route | Three helpers whose bodies, concatenated, are today's body in today's order: `registerPlayerCore(app, options, auth)` (quest/step/reveal keys through `registerPlayDoors`; returns keys, settings, firstBonus, ranking, suspended, rehearsal, operatorDeps, screenKey), `registerDevicesAndShop(app, options, auth, core)` (device claims through the ranking-repair `onClose`; returns deviceClaims, rewardCodeKey), `registerStaffSide(app, options, auth, core, devices)` (activation through `registerPublicLinkRoutes`; returns invitations, translations). `buildApp` keeps `createServer` → `registerConventions` → auth deps → `drainedDeferred` → `registerStaff` → the three helpers → `startTicks` → `registerPlatformReads` → `registerHealthRoutes`. Each service is still made once (one `settings`, one `ranking`, one `suspended`, one `createSessions` per site as now). `registerPlayerGuard` stays before the first player route, `registerDeviceGuard` before the first device route, `onClose` hooks in the same order. |

**Skips:** none expected. Two carry the abort rule explicitly: #5 (if any message text or check order would change, or
an existing case in `route-access.test.ts` or the security inventory needs an edit, keep it baselined: access rules matter more than a lint
number) and #6 (if `git diff --color-moved=dimmed-zebra` shows anything but moved lines, renamed locals into the returned
objects and the three calls, or the route-order test below differs, keep it baselined).

## Tests

Existing pins (must pass unchanged): #1 `src/completions/complete.test.ts` (release on engine failure, nothing to
release for a QR scan, switch not read for a scan without a reading, check-in refused while off without the engine,
one statement inside the player's transaction), `test/completions/complete.int.test.ts` (`idempotency_key_reused`,
`retry-after`, `location_refused`, `feature_off`), `test/completions/flow.int.test.ts`; #2 the same two int suites;
#3 `test/desk/routes.int.test.ts` (`not_ready`, `reservation_ended`, `handover_mode`, `offer_gone`, `ability_off`,
`not_operator`, `desk_closed`, `paused`, `redeem_paused`), `test/desk/desk.int.test.ts`; #4 `src/rewards/shop.test.ts`,
`test/rewards/reserve-order.int.test.ts`, `test/rewards/spend-and-codes.int.test.ts`, `test/rewards/routes.int.test.ts`,
`test/rewards/codes-routes.int.test.ts`; #5 `src/route-access.test.ts` (exact messages), `test/security/routes.int.test.ts`
("every route is accounted for"); #6 `src/app.test.ts`, `test/security/routes.int.test.ts`, `test/security/*-doors.int.test.ts`.

New tests (pure, no database): `src/completions/routes-answer.test.ts` (every kind's code and status; `expired` vs
any other problem; `retry-after` set; `distanceM` absent when null), `src/desk/routes-refuse.test.ts` (every kind incl.
`old_code` and `not_in_event` → 404; `held` paused vs held), `src/rewards/shop.test.ts` (`reservationOf` on an empty row
matches today's output; `replayed` only for `true`), `src/route-access.test.ts` (first rule wins: a `player` route under
`/v1/admin/` without the guard names the admin rule; a `device` route outside `/v1/device` without the guard names the
path; each rule alone on a clean route returns `undefined`), `src/completions/complete.test.ts` (`askedOf`: a check-in
off → `feature_off` with no `prepare`; a scan with a reading while off reaches the engine with `position: null`).
`src/app.test.ts` gains a route-order test written and committed **before** the split: it builds the app with the
existing fakes and pins the `routeInventory` sequence (method, url, access) as an inline list; the split must leave it
identical.

Checks: types, lint, format, `pnpm lint:limits` (6 entries leave the baseline, a pure shrink), the suites above; full
`npx vitest run` once into a log.

## Mutation (ADR-355: ledger, redemption, access; GitHub only)

One dispatch after the build review: `apps/api/src/completions/complete.ts`, `apps/api/src/completions/routes.ts`
(ledger), `apps/api/src/desk/routes.ts`, `apps/api/src/rewards/shop.ts` (prize handover, redemptions),
`apps/api/src/route-access.ts` (access), each `!**/*.test.ts`. Not mutated: `apps/api/src/app.ts` (wiring, outside
`stryker.config.json`; pinned by the route-order test and the security inventory). Chase only files under 90%, one round.

## Plan review (91/100 GO, folded in)

- MAJOR (#6): no committed inline route-order test. A one-off before/after dump of the `routeInventory` JSON is diffed
  and the result quoted in the reply. The #6 abort rule also covers: the count of each `createSettingsService`,
  `createRanking`, `createSuspendedSet`, `createSessions`, `createFirstBonusCache`, `createActivation` call is unchanged;
  the one `settings` is the one given to `createActivation({ onAddonsChanged: settings.forget })`, the player guard and
  the shop; hook order (conventions, player guard, device guard, console hooks) and `onClose` order unchanged.
- MINOR (#6): each helper destructures its inputs at the top (`const { settings, ranking, … } = core`), so the bodies
  move word for word; `registerStaffSide` keeps ≤5 positional parameters.
- MINOR (#5): one table test of rule-pair conflicts with the exact message (staff vs organizer under
  `/v1/organizers/:organizerId`, admin vs public-idempotent, and the pairs above). Rules call `hasDecorator` on the
  captured root `app`, not the hook's `this`.
- NITs: "seven later checks" (not eight); the abort rule means the existing cases in `route-access.test.ts` stay
  unchanged; `reservationOf` is a helper, not pure (it calls `reveal`, which logs); `refuseCompletion` and `refuse` are
  exported for their tests.
