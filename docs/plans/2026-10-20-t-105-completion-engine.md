# T-105 — Completion engine: one transaction, the points ledger, scan and entry-code quests

Delivers FR-201, 211, 202, 304, 316, 317, 401, 402, 322, 303 and FR-302's enforcement (carried from T-104). Depends on
T-104, T-005. Core (ADR-104): the points ledger and the completion are Max quality, mutation-tested.

Done when (TASKS): two simultaneous scans produce one completion; a retry with the same key never pays twice; a gallery
image is never accepted as a scan; the ledger cannot be edited.

## Scope note

- **No player can sign in yet.** T-107 (phone/email code sign-in) waits on the Msegat credentials; T-111 (join) on
  T-107. T-105 does not depend on either. This plan builds the engine, its database rules and its endpoint behind a
  minimal player bearer token (a session table and a guard), which T-107 will issue; tests seed sessions and
  enrollments through the owner connection. Nothing here signs a player in.
- **Not in T-105:** XP and gems (T-401), ranking store (T-106; the answer carries `score`, not a rank), flags (T-209;
  forged and old codes are logged apart now, for T-209 to read later), the player's quest list `GET
  /v1/events/{id}/quests` (T-114, with the Quests tab that needs it), operator and My QR (T-205), manual awards (T-207),
  the app's scanner (T-115). The camera-only rule (FR-201/303) is the app's (T-115); the server's part is that a scan
  proof is a signed code, which a photo of a printed code also carries, so FR-201's guarantee is the live-camera UI.
  T-105 records `method` so T-115's demo-only picker can be told apart.
- Reuse: `verifyQuestCode` (T-104), the throttle tables and `tryLock` (`auth/throttle.ts`), the idempotency convention
  (`conventions.ts`), `withRequestContext` (player context `app.player_id` already exists), `event_status_now`
  (0009), the route walk and the outsider/cross-tenant suites.

## Decisions (tactical; for the CTO to challenge)

1. **The rules live in the database: one definer function, `complete_quest`.** The API checks what needs the secret
   (the QR signature, the entry code's throttle) and then calls `complete_quest(quest, method, proof_version,
   typed_code, idempotency_key, device)`. The function, in the API's transaction, locks the player's enrollment row,
   and checks every other rule itself: the quest exists, is visible, of a type the method fits (FR-302: `scan_qr` ↔
   `qr`, `enter_code` ↔ `code`), the event's status at this moment is `live`, the quest's window is open (FR-225), the
   QR's version is the quest's current one (FR-1711), the typed code matches, the repeat cap is not reached
   (FR-202/227). It then writes the completion and the ledger entry; a trigger moves the score and balance. The points
   come from the quest row, never from the request. An API bug cannot give a player points the rules would refuse.
   Refusals raise named SQLSTATEs the API maps to answers.
2. **One completion per occurrence, enforced twice.** `quest_completion` has `occurrence` (1 … the quest's cap) and
   `UNIQUE (enrollment_id, quest_id, occurrence)`; the function computes the next occurrence under the enrollment
   row's lock, so two simultaneous scans are serialized and the second sees the first (Done-when 1); the unique index
   is the backstop if anything ever skips the lock.
3. **Idempotency in the business transaction (ADR-111).** `UNIQUE (enrollment_id, idempotency_key)` on
   `quest_completion`; a retry with the same key finds the first completion and returns it unchanged
   (`replayed`), whatever has happened since (Done-when 2). The route also keeps the convention layer's 24-hour replay
   (memory store) for speed, but the database is the guarantee; the "database-backed store" note in `server.ts` is
   corrected.
4. **The ledger (`ledger_entry`) is append-only for every role.** `REVOKE UPDATE, DELETE, TRUNCATE` from everyone and a
   trigger that raises on any UPDATE or DELETE, the owner included (FR-317, NFR-019; Done-when 4). Columns: `id`,
   `organizer_id`, `event_id`, `enrollment_id`, `delta`, `kind` (`quest` only for now; each later task widens the
   check), `completion_id`, `quest_id`, `actor` (`player` here; `operator`, `staff` later), `operator_id` (null here),
   `device` (the app's install id when sent), `reason` (`quest`), `created_at`. That answers FR-316's "reason, quest,
   operator, device and time" in columns, not prose.
5. **Score and balance are caches moved by a definer trigger** on ledger INSERT: `score += delta`,
   `balance += delta` for `quest` entries (later kinds say which they move). The API role keeps no write right on them
   (0005). A test checks `score` and `balance` equal the ledger's sums after a burst.
6. **Player bearer token, minimal:** `player_session (id, player_id, token_hash, created_at, expires_at, revoked_at)`,
   deny-by-default (no policy for the API role but its own session lookup through a definer `player_session_owner(hash)`
   returning the player id). A new access kind `player` in `route-access.ts`; the guard reads `Authorization: Bearer
   <token>`, sets `request.player` and the idempotency principal `player:<id>`. T-107 adds issuing, refresh and
   sign-out; T-105 adds only the lookup.
7. **Device id:** an optional `X-Device-Id` header (a UUID the app makes once per install) is recorded on the ledger
   entry and used as the second throttle key (FR-322 "per player and per device"). Without it, the player key alone
   applies. Device registration is T-501.
8. **Typed-code limits (FR-322):** wrong entry codes are counted per player per event and per device (keyed hashes in
   the existing `auth_throttle` table, new buckets): 5 wrong in 10 minutes per player per quest, 20 wrong in 10 minutes
   per player per event, 30 per device; over a limit → 429 `too_many_attempts {retryAfterSeconds}`. Correct codes are
   not counted. The numbers live in one place (`limits.ts`), tuning in the console later (Q-074).
9. **Answers:** 200 `{completionId, points, score, balance, occurrence, replayed}`; 404 quest not found or not enrolled
   (one answer, so quest ids of other events leak nothing); 403 `quest_not_open` (event not live, window not open or
   closed, hidden); 409 `already_completed` (cap reached); 422 `invalid_code` (forged, old version, wrong quest, wrong
   typed code, wrong method; one answer, logged apart: `quest.code_forged`, `quest.code_old`, `quest.code_wrong`); 429
   `too_many_attempts`. A forged or old QR is logged with the player's id and the quest, never the token.
10. **Deleting a quest or category with completions:** the completion's foreign key to the quest is RESTRICT; the
    builder answers 409 `has_completions` ("hide it instead") until T-604 offers keep or remove.

## Behaviour

### Migration 0012

- `player_session` (above), `player_session_owner(hash bytea)` definer, nothing granted on the table.
- `quest_completion (id bigint identity, organizer_id, event_id, enrollment_id, quest_id, occurrence, method
  CHECK IN ('qr','code'), idempotency_key text CHECK length 1..255, device uuid, created_at)`; uniques as above; FKs to
  enrollment and quest (RESTRICT); forced RLS: the organizer's members read their events' completions (dashboard, in
  scope), a player reads their own; no INSERT/UPDATE/DELETE grant for the API role (only the function writes).
- `ledger_entry` (above); forced RLS reads as for completions; no write grant; the append-only trigger; indexes
  `(enrollment_id, id)`, `(event_id, created_at)`.
- `apply_ledger_entry()` AFTER INSERT trigger (definer) on `ledger_entry` updating the enrollment's caches.
- `complete_quest(...)` definer with pinned `search_path`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO
  questify_app`; it reads `app_player_id()` itself (never a player id argument).
- Outsider and cross-tenant classification for the three tables and the new functions.

### API

- `apps/api/src/players/session.ts`: the bearer guard and `player` access kind.
- `apps/api/src/completions/`: `complete.ts` (verify proof → throttle → `complete_quest` → answer), `routes.ts`
  (`POST /v1/quests/:questId/complete`, player, Idempotency-Key, body `{proof: {type: "qr", code} | {type: "code",
  code}}`), the entry-code normalizer (Arabic-Indic and Persian digits to Western, trim, upper-case).
- Builder: `has_completions` on delete.

## Tests

- Database: the ledger refuses UPDATE/DELETE for the API role and the owner; caches equal ledger sums; the function
  refuses each rule (status, window, hidden, method, version, code, cap, not enrolled, other organizer); a forged
  player id is impossible (no argument); 50 concurrent calls on one quest (cap 1) → one completion, one entry; cap 3 →
  three; the same key twice → one completion, `replayed` the second time.
- API: every answer above; idempotent replay through the route; throttle limits and `retry-after`; the device header
  (shape-checked; a malformed one is ignored, not trusted); the bearer guard (missing, wrong, expired, revoked → 401);
  outsider: no route touches a completion without a session; route walk.
- Mutation scope: `apps/api/src/completions/`, `apps/api/src/players/`.

## Phases

1. **Database:** migration 0012, the function, triggers, database tests (concurrency included).
2. **API:** the guard, the route, throttle, normalizer, builder `has_completions`, integration tests, mutation.
3. **Docs:** API.md, DATA_MODEL.md (ledger columns, the function), SECURITY.md, RUNBOOK (limits), TASKS (partly:
   FR-201/303 are the app's in T-115), STATE.

## Revision 1 (after CTO plan review 1, 83/100) — overrides the sections above where they differ

- **M1, only an active player in an active enrollment earns.** `complete_quest` requires `enrollment.status =
  'active'`; any other status raises and the API answers 403 `enrollment_inactive {reason: pending | left | removed |
  banned}` (the player knows they joined; only their own row is read). `player_session_owner(hash)` returns a player
  only when `player.status = 'active'`, the session has not expired and is not revoked; anything else is 401. One
  database test per status.
- **M2, the ledger's columns are settled now (append-only makes them near permanent).** `score_delta` and
  `balance_delta`, both written explicitly by the writing function under the enrollment lock; the cache trigger is
  `score += score_delta, balance += balance_delta` for every kind, so "score and balance are the sums of this table"
  stays true for spending (T-202) and removals after spending (FR-1601). For a quest entry both equal the quest's
  points (`CHECK (kind <> 'quest' OR (score_delta >= 0 AND balance_delta >= 0))`; a 0-point quest writes a 0 entry).
  No `device` on the ledger (an install id is personal data and an append-only row cannot be anonymised at account
  deletion): `device_id` lives on `quest_completion`, which T-217 can null; FR-316's device is reached through
  `completion_id`. No `reason` column yet (T-207 adds a note when manual awards need it). A partial `UNIQUE
  (completion_id) WHERE kind = 'quest'` is a second guard against paying twice.
- **M3, the wrong-code throttle uses the reservation pattern of `auth/sign-in.ts`.** For `enter_code` only: in its own
  short transaction, `tryLock` on the player-and-quest key, count the window, answer 429 when full, otherwise `record`
  a reservation and commit; run the business transaction; `forget` the reservation for every outcome except a wrong
  code. So a burst of 50 wrong codes cannot slip past the count, and the count survives the business transaction's
  rollback. Limits (`COMPLETION_LIMITS` in `limits.ts`): 5 wrong per player per quest, 20 per player across all
  events, 30 per device, each per 10 minutes (a player is at one event at a time, so "per player" needs no event lookup
  the API cannot make).
- **M4, a reused key never answers for another quest.** In the database, the key lookup runs after the enrollment lock
  and before every rule (so a replay still succeeds after the event ends or the cap is reached); a hit for another
  quest or method raises and the API answers 422 `idempotency_key_reused`. In the convention layer, `bodyHash` hashes
  the request's real path (`request.url` without the query), not the route pattern; a convention test covers it.
- **Minor 1, append-only exactly as 0006:** row triggers BEFORE UPDATE OR DELETE, a BEFORE TRUNCATE statement
  trigger, both `ENABLE ALWAYS`; foreign keys RESTRICT, never CASCADE. SECURITY.md says plainly: no DML path changes
  the ledger; DDL goes through reviewed migrations (the owner could drop a trigger).
- **Minor 2, the `player` access kind:** one `onRequest` hook runs when `routeOptions.config.access === "player"`,
  reads the bearer token, sets `request.player` and `principalId = "player:<id>"`, before the conventions'
  `preHandler`; the route inventory refuses a `player` route when that hook is not registered.
- **Minor 3:** 403 `quest_not_open {reason: not_started | ended | hidden | event_not_live}`; 409 `already_completed
  {cap}`.
- **Minor 4, the SQL rules get a recorded manual mutation pass:** each rule line of `complete_quest` deleted or
  inverted once, a database test confirmed failing, the result listed in the build notes.
- **Minor 5, real concurrency:** 50 separate connections with a barrier; distinct keys (cap 1 → one completion, cap 3
  → three) and the same key (one completion; the rest replays or `request_in_progress`).
- **Minor 6, tenant consistency in the schema:** composite foreign keys `(event_id, organizer_id) → event (id,
  organizer_id)` on both tables; `UNIQUE (id, event_id)` on `enrollment` so the completion references
  `(enrollment_id, event_id)`; the function derives every tenant column; read policies include
  `in_event_scope(event_id, app_event_scope())`.
- **Minor 7, observability:** a log line per completion and per refusal with its reason (`invalid_code` split into
  forged, old, wrong quest, wrong code, wrong method), never the token or the code; a RUNBOOK entry on a spike of
  forged codes and on clearing a locked player.
- **Minor 8, FR-201/303 honestly:** the server cannot tell a live camera from a picture, so "a gallery image is never
  accepted as a scan" moves to T-115 in TASKS with a dated note; the `method` claim about the demo picker is dropped.
  What T-105 claims: a scan completes only with a Questify-signed, current-version code bound to its quest.
- **Minor 9, a replay** answers the original `completionId`, `points` and `occurrence` with the current `score` and
  `balance`, `replayed: true`. API.md says the convention layer replays 4xx answers for 24 hours, so the app makes a
  new key per tap and reuses a key only to retry after a dropped connection.
- **Minor 10:** the table stays `player_session` (like `staff_session`), `token_hash bytea UNIQUE` (SHA-256 of a
  32-byte random token); DATA_MODEL's `auth_session` row is updated; T-107/T-108 own its final shape (refresh, ADR-030).
- **NITs taken:** the enrollment lock is `FOR NO KEY UPDATE`; the quest row is not locked (a completion that started
  before a regenerate commits may pass; commit order decides; said in the function's comment); no "logs for T-209"
  claim; `X-Device-Id` is a claim from an honest client (SECURITY.md); an organizer's paused state waits for its FR.
- **Conflicts recorded in this change:** DATA_MODEL (`quest_completion` keys and occurrence; `ledger_entry` typed
  foreign keys and two deltas; `player_session`), API.md (the answer without rank and XP), OPEN_QUESTIONS (T-217's
  "remove the points" against the append-only ledger: proposed, deletion anonymises the player, the ledger stays, the
  completion's device is nulled).

## Build notes

- Phases 1 and 2 code review: 93, GO. Folded in: a thrown engine error gives the wrong-code reservation back (a busy
  database never locks an honest player out; tested by making the engine fail five times); the typed-code check
  refuses a missing code outright; a completion committing between the builder's check and its delete answers
  `has_completions`, not a 500; API.md promises `Retry-After` (not `RateLimit-*` headers).
- Manual mutation pass over `complete_quest` and its triggers and session lookup: 26 rules broken one at a time,
  25 caught by the database tests; the survivor (the unique occurrence index, which the enrollment lock already
  enforces) now has its own test (an owner insert of a duplicate occurrence answers 23505).
- Concurrency proven over 25 separate connections, not 50: enough to show one player's calls serialize under a real
  overlapping burst, within the test container's connection limit while other test files run.
- Observability is log lines (`quest.completed`, `quest.refused {refusal, reason}`) until T-018's metrics; their fields
  are stable so a metric can be derived later.
- Two bugs caught by the first test runs: a plpgsql variable named `found` shadowed `FOUND`; the idempotency hash used
  the route pattern, so one quest's answer could replay for another (fixed in `conventions.ts`, with a test).
- Mutation (Stryker): first run 87.58% over completions, players, conventions and route-access (complete.ts 73.2%);
  after the flow tests, complete.ts 94.44%. Its last survivors are equivalent (a missing SQLSTATE indexes nothing; the
  release on a throw with no reservation is caught and logged; `problem` exists only on `invalid_code`). Phase 3: 95.
