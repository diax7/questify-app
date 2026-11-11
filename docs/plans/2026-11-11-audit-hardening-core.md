# Audit hardening, core walls (plan, tier A: tenant isolation, points walls)

Source: security audit run 1 hardening notes (w2-seats 1 and 2, w2-flows 2 and 3, w3-proofs 1, hunter-tenant 6). Migration
**0190** (0189 restates none of the objects below). TypeScript: `src/players/guard.ts`, `src/events/suspended-set.ts`, one
export from `src/maintenance/gate.ts`, two entries leave `test/db/sql-settings-allowlist.json`. No new table, grant, route or
string. Delivers no FR. One Proposed ADR amending ADR-406 (3.3).

**Done when:** a player route that names a quest, step, category, reward, session, desk sale or game round of a suspended event
answers `404 event_unavailable`, as `:eventId` routes already do; a device seat marks no ranking repair; a suspended event
grants no souvenir, and the souvenirs it owes arrive after the suspension is lifted.

**Order.** (1) failing tests (section 4), (2) 0190 and the TypeScript, (3) hand mutants (section 5), (4) docs. Run after
step 2: touched suites, `test/security/*`, `test/db/hot-path-plpgsql.int.test.ts`, `src/events/suspended-set.test.ts`.

## 1. Latest definitions (migrations searched up to 0189)

| Object | Latest | Today |
|---|---|---|
| player guard suspension wall | src/players/guard.ts:103-105 | only `request.params.eventId` checked against the suspended set |
| `play_event_id(text, text)` | 0134:37 (`LANGUAGE sql` definer, allowlist :258) | used only by the maintenance gate (gate.ts:99-108) |
| `SuspendedSet` | src/events/suspended-set.ts:6, 52 | `has` and `invalidate` only |
| `ranking_system()` | 0015:81 | player, organizer, staff all NULL and not admin; a device seat passes |
| `mark_ranking_repair(uuid)` | 0095:11 (`LANGUAGE sql` definer, allowlist :197) | first branch `ranking_system()` |
| `stamp_step` / `record_completion` | 0098:1066 / 0170:12 | replay (`earlier`) answers before `quest_open_check` |
| `souvenir_scan_batch`, `souvenir_claim_work`, `souvenir_evaluate` | 0064:394, ~424, 474 | no suspension check |
| `event_suspended(uuid)` | 0148:153 | event `suspended_at` or organizer `status = 'paused'` |
| `invitation_claim_at` | 0173:25 | fixed quiet band only (`invitation_sms_quiet`, 0073:299) |
| HTTP idempotency store | src/idempotency-store.ts:39, src/server.ts:121-124 | in memory, per process |

## 2. Verdicts

- **w2-seats 1: real (FR-1607), kept.** Indirect routes (rating, survey, poll, quiz, game, passport reads, meet-pass, desk-sale
  decline, operator session check-in) answer while suspended; economic ones are walled only in SQL (ES423, ADR-406).
  `POST /v1/me/tickets` has no event (FR-1822). `POST /v1/reports` stays open (a safety tool; refusing it is a product
  change). Body-only doors (`/v1/join`, `/v1/operator/scan`, `/v1/operator/award`) keep their SQL walls. Redemption cancel and
  decline stay open on purpose (they give points back).
- **w2-seats 2: real, defence in depth, kept narrowed.** The app marks in an empty context (ranking.ts:101-105) and no device
  path reaches it. Fix locally, as three device-aware gates do (0064:163, 0073:118, 0076:179). Changing `ranking_system()`
  itself touches 18 gates: FOLLOWUPS.
- **w3-proofs 1: dropped.** Writes nothing, returns only the caller's own earlier answer; the HTTP idempotency layer replays
  first anyway (passport/routes.ts:25, conventions.ts:230-260); all doors share this order. FOLLOWUPS: one optional sweep.
- **w2-flows 2: real, kept.** `souvenir_evaluate` inserts `player_item` with no ledger row, so no guard fires. Souvenirs must
  **wait**, not be lost (ADR-406); returning 0 would let `souvenir_ack` delete the work row (0064:521).
- **w2-flows 3: dropped.** ADR-333 (4) keeps only the fixed band in SQL; PostgreSQL has no Umm al-Qura calendar, and a wrong
  date list stops SMS or sends inside the band. The caller checks first (tick.ts:141). FOLLOWUPS: the date-list option.
- **hunter-tenant 6: no code change.** Points doors carry database keys (T-105); a PostgreSQL store is feature-sized. Correct
  the stale comment at server.ts:121 and add an OPEN_QUESTIONS entry: before a second API instance or rolling deploys with
  retries, list idempotent routes without a database key and move the store or give them keys.

## 3. Changes

### 3.1 API suspension wall by object (w2-seats 1)
- `SuspendedSet.any(): Promise<boolean>`, true when the set is non-empty; same 10 s read, no new query.
- gate.ts: export `eventOf` as `eventOfRef(pool, ref)`, no behaviour change.
- guard.ts: `DERIVED_PARAMS = { questId: "quest", stepId: "step", categoryId: "category", rewardId: "reward", saleId:
  "desk_sale", roundId: "game_round", sessionId: "session" }`. When the route has no `:eventId` and `await suspended.any()`,
  take the first matching param, call `eventOfRef`, and throw `eventUnavailable()` if the event is in the set. Before the
  legal hold, every method. Unknown id: null, the route answers its own 404. Cost: one primary-key lookup per such request,
  only while some event is suspended.

### 3.2 Migration 0190 (`SET LOCAL lock_timeout = '10s'`; header lists each object and its source file)
- `play_event_id` (from 0134): PL/pgSQL, same signature and grants, `IF/ELSIF` with `SELECT ... INTO` (rules.md:71); keep
  the UUID and whole-number shape checks; delete its allowlist entry.
- `mark_ranking_repair` (from 0095): first branch `(ranking_system() AND app_device_id() IS NULL)`; PL/pgSQL (void); delete
  its allowlist entry.
- `souvenir_scan_batch` (from 0064): `JOIN organizer o ON o.id = e.organizer_id` and `AND e.suspended_at IS NULL AND
  o.status <> 'paused'` in the choice of scan row, inline (rules.md:65-70). The scan row waits.
- `souvenir_claim_work` (from 0064): the `due` CTE joins event and organizer with the same predicate, `FOR UPDATE OF w SKIP
  LOCKED`. No new lock order.
- `souvenir_evaluate` (from 0064): after the locked re-check (:495), `IF event_suspended(member.event_id) THEN RAISE
  EXCEPTION 'event suspended' USING ERRCODE = 'ES423'; END IF;` (a claim taken before the suspension committed; the payer
  acks the failure, the row is kept with back-off).
- Diff each restated body against its source; only these lines change.

### 3.3 Proposed ADR (amends ADR-406)
The API player wall derives the event from the object id, as the maintenance gate does; souvenirs of a suspended event wait
and are delivered after reactivation.

## 4. Tests (written first, failing on 0189)
- New `test/security/suspension-doors.int.test.ts`: suspend event A; A's player gets 404 `event_unavailable` from
  `PUT /v1/quests/:questId/rating`, `GET /v1/quests/:questId/survey`, `POST /v1/steps/:stepId/stamp`,
  `POST /v1/rewards/:rewardId/reserve`, `POST /v1/desk-sales/:saleId/decline`; one route again with the organizer suspended;
  event B unaffected; all works after reactivation; `POST /v1/redemptions/:id/cancel` unchanged. Inventory walk (pattern:
  maintenance-doors.int.test.ts): every `*Id` param of a player route other than `eventId` is in `DERIVED_PARAMS` or on an
  open list with a reason.
- `src/events/suspended-set.test.ts`: `any()` false when empty, true with one id, follows `invalidate`, no extra read.
- With nothing suspended, a quest route sends no `play_event_id` query (pool spy).
- `test/db/ranking-repair-seats.int.test.ts`: `{deviceId: <paired kiosk>}` and `{deviceId: randomUUID()}` mark nothing; the
  empty context still marks; other seats unchanged.
- `test/db/souvenirs.int.test.ts`: event suspended (and once organizer paused): scan batch returns 0 and keeps its row; claim
  skips the row; evaluate raises ES423 and grants nothing; after reactivation `paySouvenirs` grants it.
- Green with no edits: `test/console/maintenance.int.test.ts`, `test/security/maintenance-doors`, `outsider`,
  `cross-tenant`, `test/console/organizers.int.test.ts:180`.

## 5. Hand mutants (each must turn a section 4 test red)
Remove the derived branch; `any()` returns false; map `questId` to `"step"`; drop one `DERIVED_PARAMS` entry; remove `AND
app_device_id() IS NULL`; remove the scan predicate; remove the claim predicate; evaluate `RAISE` replaced by `RETURN 0`; remove
the organizer half in one place.

## 6. Risks
- Economic indirect routes change from `423 event_suspended` to `404 event_unavailable` while suspended; both final for the
  app's queue (confirm the scan answer handling); update API.md:980-985.
- A long organizer suspension adds one lookup to every quest or step request until lifted; fallback a bounded id-to-event map
  (as `MAP_CAP`, scenes.ts:28) once `event_id` is confirmed immutable on these objects.
- Held souvenir work raises `souvenir_health` `due` and `oldestAt`; check RUNBOOK alerts on them.
- Up to 10 s lag, as the set it reads (ADR-406).

## 7. Docs
API.md (suspension answers), SECURITY.md (suspension rows), DECISIONS and OPEN_QUESTIONS (3.3 ADR, idempotency store
question), FOLLOWUPS (device predicate in `ranking_system()`, replay-order sweep, Ramadan list option), server.ts:121 comment,
STATE.md.

## 8. Plan review (CTO, 84) and decisions

The coordinator's decisions on the review; where they differ from sections 1 to 7, they win.

1. **Meet-pass.** `passId: "meet_pass"` joins `DERIVED_PARAMS`; 0190's `play_event_id` gains a `meet_pass` branch (whole
   number, as `game_round`), with a test.
2. **Open while suspended, by route.** guard.ts gets `OPEN_WHILE_SUSPENDED`: `POST /v1/desk-sales/:saleId/decline`,
   `POST /v1/operator/desk/sales/:saleId/withdraw`, and the redemption cancel and decline routes (player and operator).
   The inventory walk asserts every player route with a derived param is either walled or in this set. The section 4
   test calls `POST /v1/game-rounds/:roundId/result` instead of the desk-sale decline (it covers the whole-number path).
3. **`:redemptionId`.** A new `redemption` kind in `DERIVED_PARAMS` and `play_event_id`; accept, collect and hand-over
   are walled; cancel and decline are in `OPEN_WHILE_SUSPENDED`.
4. **Held souvenir work.** `souvenir_health` (0064:530) leaves held rows (suspended event or paused organizer) out of
   `due`, `failed` and `oldestAt` and reports them as `held`; `console_health`'s `sv_wait` (0162, the admin health view)
   leaves them out too and the view reports `held`; tick.ts logs `souvenir.pending` only for work that is not held, so a
   suspension does not log every 5 s (RUNBOOK). Tests for each.
5. **Evaluate's check is unlocked.** The `event_suspended` check in `souvenir_evaluate` sits in the unlocked pre-check,
   before `FOR SHARE` (0064:490). The ADR states that a suspension committed while an evaluation runs can still grant (the
   same lag as the other unlocked reads), and that a row acked with ES423 may wait up to the 300 s back-off after
   reactivation.
6. **Organizer paused.** Scan, claim and evaluate each get an organizer-paused case, so the organizer-half mutant dies in
   all three.
7. **App.** `apps/app/src/event/quest-rating.ts` `sendRating` maps a 404 to `none`, not `network`, with its unit test.
8. **One lookup per request.** `play_event_id` is memoized per request when both the maintenance gate and the guard ask;
   the `eventId` param is lowercased before `suspended.has`.
