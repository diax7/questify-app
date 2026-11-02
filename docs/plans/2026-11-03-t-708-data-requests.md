# T-708 - Legal data requests: export and delete a player's data (plan, tier A)

Delivers FR-1418 (a player downloads their own data from settings), FR-1776 (no restore after deletion) and FR-1778 (an
admin exports or deletes one player's data on a legal request, recorded: what, by whom, when). Tier A: the task reads and
moves every piece of personal data the product holds, adds an admin power that destroys an account, and sends personal
data out of the database. Depends on T-704 (the console player record, `apps/api/src/console/players/*`, migration 0118).
Migration **0129**. Decisions ADR-480 to ADR-485 (Proposed); questions Q-440 to Q-445 (counsel questions stay open).

Inherits the notes under T-708 in `docs/TASKS.md`: T-403 (`achievement_earned`, passport, `own_events`, `final_rank`),
T-403b (`questify_award`), T-404 (`gem_entry`, `gem_purchase`, locker shop items), T-406 (`daily_play`, `daily_answer`,
`daily_guess`, `daily_finish`, `xp_entry` of source `daily`), T-402b (`player_item` sources, `souvenir_receipt`,
recipient-linked `souvenir_work` under an explicit transient-work rule; earned provenance in; other recipients, private
configuration and lease/error metadata out) and T-217 (the admin path erases in `erase_player`'s order, audited with the
admin as actor).

## 1. What exists and is reused

- **Erasure (T-217, migration 0038).** `erase_player(deletion, forfeit, request)` is defined once (0038, frozen: CranL
  runs through 0086). Lock order: the deletion challenge `FOR UPDATE` → player `FOR UPDATE` → the player's enrollments by
  id `FOR NO KEY UPDATE` → `end_reservation(…, 'erasure', 'system', NULL)` per reserved redemption → `erase_marks(me)` →
  the used challenge lets go of the player → `erase_rows(me, enrolled, key)` → `ranking_repair` → `audit_log`
  `player.delete` (actor `system`, counts only). `erase_rows` was restated 19 times; the latest body is **0121**
  (`content_reports`), which is the one 0129 builds on. Append-only tables let a DELETE through only under
  `app.erasure = on` for the transaction (0016, 0017, 0063, 0064, 0067, 0070, 0118; 0122's UPDATE rule).
- The API side (`apps/api/src/deletion/deletion.ts`): after an `erased` outcome it forgets the player's stored idempotent
  answers (`idempotencyStore.forget("player:<id>")`) and logs `player.deleted` with the id only.
- **Tombstone.** `player_tombstone` CHECK (`username IS NULL` iff `status = 'deleted'`); `player_status_guard` stops the
  API role from changing status unless `app_is_admin()`. Nothing yet stops an owner-role write from turning a tombstone
  back into an account (it would need a new username, which the CHECK allows).
- **Console player tools (T-704, 0118; T-705, 0120; T-709c, 0122).** `console_admin()` (QE403), `player_for_admin(target,
  lock)` (PA404 for a tombstone or an unknown id), `player_action_note` (PA400), `player_admin_action` (append-only,
  kinds up to `restore_tiers`), `console_player_record` (a tombstone answers id, status and dates only),
  `console_player_contact` (the audited reveal). Routes in `apps/api/src/console/players/routes.ts`: `personalRead`
  (POST, admin, **not** idempotent, so no personal answer lands in the idempotency store) and `change` (POST, admin,
  idempotent). Per-admin HTTP limits through `BUCKETS` and `holdBack` (`#src/devices/limits`).
- **Own readers** the export reuses where their shape fits: `own_events`, `own_locker`, `own_level_items`,
  `own_achievements`, `own_gems`, `own_daily`, `own_daily_streak`, `own_event_streak`, `own_submissions`, `own_tickets`,
  `own_blocks`, `own_marketing`, `own_preferences`, `own_push_topics`, `own_notifications`. They run as the caller
  (`app_player_id()`); the export core takes a player id instead, so it reads the tables directly (one body, both
  callers) and the own readers stay as they are.
- `audit_log` (0006): append-only, ids and codes only by rule (`console_*` entries name no values), no FK, so it outlives
  the account.
- App: `expo-sharing` is installed; `expo-file-system` is not.
- Email goes through an outside sender; personal data never goes in an email body or attachment (rules.md 3).

## 2. The personal-data catalog (ADR-482)

One list, `apps/api/test/db/personal-data-catalog.ts`, classifies **every table that can hold a row about a player**:

```ts
type CatalogEntry = {
  links: string[];                 // the columns that point at a player, e.g. ["player_id"], ["enrollment_id"],
                                   // ["scanner_enrollment", "shown_enrollment"], ["player_id", "operator_id"]
  export: string | { excluded: string };   // the export section it lands in, or why it is left out
  erasure: "delete" | "clear" | "keep";    // what erase_rows does; "keep" rows must hold nothing personal
  why?: string;                    // required for "keep" and "clear"
};
```

**The discovery query** (`test/db/personal-data-catalog.int.test.ts`) reads `pg_constraint` and
`information_schema.columns` on the migrated test database and collects:

1. every table with a foreign key to `player` or `enrollment` (each such column is a link);
2. every table with a foreign key to a table found in step 1 (one more hop: `quiz_answer` → `quiz_attempt`,
   `push_send` → `push_device`, `ledger_note` → `ledger_entry`, `daily_answer` → `daily_play`);
3. every `uuid` column with no foreign key whose name is `player_id`, `enrollment_id`, ends in `_player_id` or
   `_enrollment`, or is one of `reporter_id`, `blocker_id`, `blocked_id`, `target_id` on a table that has a
   `target_kind` (the FK-less links: `content_report`, `community_contributor`);
4. `audit_log` and `staff_user` by name (no FK by design; `staff_user` is the operator side, see section 9).

**Assertions:**

- the discovered set equals the catalog's keys, both ways (a new table fails CI with its name and the instruction "add
  it to personal-data-catalog.ts: export section, erasure"; a dropped table fails as stale);
- each discovered link column appears in the entry's `links`;
- **export completeness:** a fixture player (`seedFullPlayer`, below) is exported; every entry whose `export` is a
  section name has at least one item in that section;
- **erasure completeness:** the same player is erased by the admin door; for every `delete` entry, `SELECT count(*)`
  over each link column (resolved through `enrollment` for enrollment links, through the parent for hop-2 links) is 0;
  for every `clear` entry the listed columns are NULL; for every `keep` entry every `text`/`jsonb` column is scanned
  for the fixture's username, phone, email, birth year and submission text (none may appear);
- **audit stays clean:** after erasure no `audit_log` row whose `target_id` or `actor_id` is the player holds the
  fixture's username, phone or email anywhere in `before` or `after`.

`seedFullPlayer` (in `test/db/helpers`) writes at least one row in every exportable table through the owner connection,
reusing the existing seed helpers; it is the one place a new exportable table must also be seeded, and the completeness
assertion names the empty section when it is not.

The catalog is test data, not product code: the export SQL and `erase_rows` are the product. The test is what makes them
agree (no phantom feature). `docs/DATA_MODEL.md` gains a "Personal data catalog" section pointing at the file.

## 3. What the export contains (ADR-481)

One JSON document, UTF-8, Western digits, ISO-8601 UTC times, ids as strings, every name in both languages where the
source has both:

```
{ "format": "questify-data-export", "version": 1, "generatedAt", "playerId",
  "about": { "ar", "en" },                      // what each section is, fixed text from messages.ts
  "account":   { username, birthYear, avatar, status, createdAt, level, xp, gems },
  "contacts":  { phone, email },                // in full: it is the owner's own data
  "usernames": [ { username, reason, changedAt } ],
  "acceptances": [ { document, version, method, acceptedAt } ],
  "marketing": { consents: [...], state }, "preferences": {...}, "pushTopics": { muted: [...], on: [...] },
  "devices":   [ { platform, createdAt, lastSeenAt } ],          // no push token
  "sessions":  [ { createdAt, lastUsedAt, endedAt } ],           // no token hashes
  "events": [ {
      eventId, name: { ar, en }, joinedAt, via, status, leftAt,
      joinAnswers: [ { field: { ar, en }, answer } ],
      completions, ledger (kind, score, balance, quest or reward name, at), redemptions (item, status, at),
      submissions (quest, body, status, at), votes, surveyResponses, quizAnswers, gameRounds, ratings, cheers,
      passportStamps, categoryBonuses, streakDays, sessionsRegistered, sessionsAttended, meetings (when, never the
      other player), finalRank, resultPlace, staffRoles (abilities, from, to), tickets, reportsMade
  } ],
  "questify": { levelReached, xpEntries, gemEntries, gemPurchases, achievements, awards, items (with the earned
                source: level, event souvenir or shop, and the source event's name), equipment, souvenirReceipts,
                souvenirsOnTheWay (event and item only), daily: { plays, answers, guesses, finishes, streak } },
  "blocks":        [ { username, at } ],         // whom the player blocked (already shown to them in the app)
  "notifications": [ { kind, title, body, at, readAt } ],
  "questifyActions": [ { kind, reasonCode, at } ],               // what Questify did to the account
  "history":       [ { action, at } ] }          // the player's own audit entries: sign-up, contact changes, exports
```

**Left out, with the reason recorded in the catalog** (ADR-481, Q-442 for counsel):

- keyed fingerprints, token and code hashes, push tokens, sign-in and deletion challenges (security secrets or transient,
  minutes long);
- fraud flags raised about the player and reports other players made about them (fraud prevention and other people's
  data; Q-442);
- the internal note on each Questify action and which admin did it (`questifyActions` keeps kind, reason code, time);
- other players' data: a meeting's other side, another recipient of the same souvenir, a reporter;
- private organizer configuration, souvenir work leases and errors (T-402b); `souvenirsOnTheWay` is the only part of
  `souvenir_work` shown, while a row is pending: event and item, nothing else.

**Format choice (ADR-480):** JSON only. It is machine-readable (FR-1418), one file, and needs no zip or CSV library.
`about` explains it in both languages for a person reading it in a text viewer.

## 4. How it reaches the player and the admin (ADR-480)

- **Never stored, never emailed, never cached.** The file is assembled by the database at the moment it is asked for and
  goes straight back on the same HTTPS response: no copy in object storage (none exists, Q-149), in the idempotency
  store, in Redis, in a log or in an email. `Cache-Control: no-store`, `Content-Disposition: attachment;
  filename="questify-data-<yyyy-mm-dd>.json"`, `X-Content-Type-Options: nosniff`. The data never leaves Saudi Arabia on
  the server side (it goes from the API in `riyadh-1` to the owner's own device or the admin's browser).
- **Why not a signed link:** a link needs a stored file or a bearer secret in a URL (logged by proxies and browsers) and
  it can be forwarded. The app already holds an authenticated session; the console already holds an admin session. A
  link adds a second credential for no gain. Revisit only if Q-441's answer needs a hand-off to someone without an
  account.
- **Player (FR-1418):** `POST /v1/me/data-export` (access `player`, the `personalRead` shape: POST so nothing lands in a
  URL, not idempotent so the body is never kept). The app's Settings gains **Download my data**: a sheet says what the
  file holds and that it may be large, then the app fetches it, writes it with **`expo-file-system`** to the cache
  directory, opens the share sheet (`expo-sharing`), and deletes the cache file when the sheet closes (also on any
  error). New dependency: `expo-file-system`, Expo's own module, the version Expo SDK 57 pins (looked up at build
  time); the alternative (opening a URL in the browser) needs the signed link rejected above.
- **Admin (FR-1778):** `POST /v1/console/players/:id/data-export` (admin, `personalRead`), body `{ reasonCode,
  reference }`. The console's player record gains a **Legal request** card; Export downloads the file in the admin's
  browser. How the admin hands it to the requester is outside the system and goes through the channel counsel names
  (Q-441); the console's confirmation says so.

## 5. The doors (migration 0129)

All definers, `SECURITY DEFINER SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC` in the same statement
group, `GRANT EXECUTE … TO questify_app` only on the three callable ones. Error codes use a new `DR` prefix.

### D1. `player_data_export(target uuid) RETURNS jsonb` (internal, no grant)

Builds section 3 from the tables, one `jsonb_build_object` per section in helper functions of ≤100 lines each
(`export_account`, `export_event`, `export_questify`, `export_support`), all internal, all no grant. Read-only;
`STABLE`. Reads one player and their enrollments; no lock (a read, consistent within the statement's snapshot).
Refuses a tombstone or an unknown id with **DR404** (FR-1418: a deleted account has nothing available).

### D2. `own_data_export(request uuid) RETURNS jsonb` (granted)

The caller is `app_player_id()` and must be `active` (a platform-banned player cannot sign in; their path is the admin
door). Counts the caller's `player.data_export` audit entries of the last 24 hours: 3 or more raises **DR429** with the
seconds until the oldest one leaves the window (ADR-485). Writes `audit_log` (`system`, `player.data_export`, target the
player, `after {source: 'player'}`), creates the personal notice `data_exported` (fixed text, no name, opens the
center; push text carries nothing personal), then returns `player_data_export(me)`. One transaction: the notice and the
audit row exist only if the file was built.

### D3. `console_player_export(target uuid, reason_code text, reference text, request uuid) RETURNS jsonb` (granted)

`console_admin()`; `player_for_admin(target, false)` (PA404 for a tombstone); `data_request_reason(reason_code,
reference)` checks the reason (`legal_request`: an authority or court; `player_request`: the person, verified outside the
system) and the **reference**: an opaque case number, `^[A-Za-z0-9._/-]{3,64}$`, so no name, email or phone can be typed
into the durable record (DR400 otherwise). Writes `audit_log` (`admin`, actor the admin, `player.data_export`, after
`{source: 'admin', reasonCode, reference}`) and returns `player_data_export`. **No notice to the player** (an authority's
request may require silence; Q-444). No `player_admin_action` row: those rows hold free notes and are erased with the
account, while the record FR-1778 needs must outlive it; the audit log is that record (ADR-483).

### D4. `erase_account(me player, key bytea, forfeit boolean) RETURNS TABLE (outcome text, events uuid[], forfeited integer, marks integer)` (internal, no grant)

The body of `erase_player` from "enrollments `FOR NO KEY UPDATE`" to `ranking_repair`, moved verbatim: the caller has
already locked the player `FOR UPDATE`. Outcomes `handover_pending` (nothing changed) or `erased`. Does not write the
audit entry (each caller does, with its own actor).

### D5. `erase_player` restated

Same signature, grants and outcomes; after its challenge and player checks it calls `erase_account`, then writes the
same `player.delete` audit entry. Every existing test in `test/db/account-deletion.int.test.ts` must pass unchanged
(the refactor proof).

### D6. `admin_erase_player(target uuid, reason_code text, reference text, typed_username text, forfeit boolean, request uuid) RETURNS TABLE (outcome text, events uuid[])` (granted)

1. `console_admin()`; `data_request_reason(reason_code, reference)` (DR400).
2. `SELECT … FROM player WHERE id = target FOR UPDATE` (the same first lock as `erase_player`, so a self-deletion and an
   admin deletion of one account run one after the other). Unknown id → PA404. Already `deleted` → outcome
   **`already_deleted`**, no write, no error (a repeat of a finished request is not a failure; ADR-485).
3. `typed_username` must equal the username exactly (DR409 `confirmation`): the console makes the admin type it, and
   the database checks it, so a mistyped id in a script cannot delete the wrong account.
4. `erase_account(me, NULL, forfeit)`: `key` NULL, since there is no deletion challenge; `erase_rows` still drops every
   sign-in challenge that holds the account's contact in clear and every deletion challenge of the player.
   `handover_pending` → return it (the console lists the pending items through `console_player_pending(target)`, the
   player-id twin of `deletion_pending`, and asks for the forfeit).
5. `audit_log` (`admin`, actor the admin, `player.delete`, after `{source: 'admin', reasonCode, reference, events,
   forfeited, marks}`), return `erased` and the events.

The API then does what the self-deletion route does: forget the player's idempotent answers, log `player.deleted` with
the id only, rebuild the boards in `ranking_repair` (already queued by the door).

### D7. The tombstone is final (FR-1776, ADR-484)

`player_tombstone_final` BEFORE UPDATE trigger on `player`, `ENABLE ALWAYS` (fires for the owner and in replica mode):
`OLD.status = 'deleted'` and any column other than the lifetime counters `erase_rows` may still touch changing → raise
`insufficient_privilege` "a deleted account can never be restored". Which columns may change on a tombstone is read
from the current writers at build time (expected: none after `erase_rows` finishes; `my_qr_version` is bumped inside
the same UPDATE that makes the tombstone). A DELETE of a tombstone stays blocked by the FKs of the kept rows.

### D8. Index

`audit_log_data_request_idx ON audit_log (target_id, at) WHERE action IN ('player.data_export', 'player.delete')`:
the 24-hour count in D2 and the tombstone record's legal history read it.

### D9. `console_player_record` restated

A tombstone answers, besides id, status and dates, `legalRequests`: its `player.data_export` and `player.delete` audit
entries (`at`, action, source, reason code, reference; the admin as email for admin rows). An active account's record
answers the same list. No restore action exists anywhere (FR-1776's acceptance).

## 6. API and rate limits (ADR-485)

| Route | Access | Shape | HTTP limit | DB limit |
|---|---|---|---|---|
| `POST /v1/me/data-export` | player | personalRead, no idempotency | `dataExportOwn` 5 an hour per player | 3 per 24 h (DR429 → 429 `too_many_attempts` with `retryAfterSeconds`) |
| `POST /v1/console/players/:id/data-export` | admin | personalRead, no idempotency | `consoleDataExport` 10 an hour per admin | none |
| `GET /v1/console/players/:id/pending` | admin | read | `consolePlayerRead` | none |
| `POST /v1/console/players/:id/erase` | admin | change (Idempotency-Key required) | `consoleDataErase` 10 an hour per admin | the door's own `already_deleted` |

- Errors: DR400 → 400 `invalid_request` (`details.field`), DR404/PA404 → 404, DR409 → 409 `confirmation_required`,
  `handover_pending` → 409 `handover_pending` with the items (the self-deletion route's error body).
- **Idempotency:** the export is a read and is never replayed from a store (a replay would be a copy of personal data
  kept outside the database); a repeat makes a new file and a new audit entry and counts against the limit. The erase
  takes the Idempotency-Key (rule 6); its answer holds no personal data (`{ outcome, events }`), so it may be stored; a
  second key on a deleted account answers `already_deleted`.
- **Logs:** no route logs a body; the URL logger already redacts ids it should; the file's size is logged, never its
  content. `full-name-guard.test.ts` (or its twin) lists the new files so a `log.*(…export…)` call fails the test.
- **Time budget:** the API pool has `statement_timeout` 5 s. Measured target: `player_data_export` under 1 s warm for a
  player with 50 events, 10,000 ledger entries, 2,000 notifications and 500 submissions (fixture in the DB test,
  `EXPLAIN (ANALYZE)` noted in the build notes). Every per-player read uses an existing index on `player_id` or
  `enrollment_id`; any missing index found by the measurement is added in 0129.

## 7. No restore, and backups (FR-1776, ADR-484)

- **In the database:** D7's trigger; `player_for_admin` refuses tombstones; no door, route or console control restores.
- **Re-sign-up:** a new account with a new id, as FR-1704 already does; the marks (ban, welcome) still apply.
- **Backups:** a restore brings erased accounts back. Rule: after **any** restore, before the API takes traffic, the
  runbook step "Re-apply erasures" runs `staff-cli reapply-erasures --since <backup time>`, which reads the ids of
  `player.deleted` log lines (the API's structured log, ids only) and the `player.delete` audit entries of the
  pre-restore database when it is still readable, and calls an owner-only `reapply_erasure(target, request)` for each id
  that is not a tombstone (system actor, `forfeit` true, audit `player.delete` with `source: 'reapply'`). That door is
  owner-only (no grant to `questify_app`), tested, and idempotent (a tombstone is skipped).
- **Retention:** erased data lives on in backups only until they age out. Proposed backup retention: 35 days (T-019
  sets it). The privacy policy must say so (Q-443, counsel). The log store must keep `player.deleted` lines at least as
  long as the oldest backup (Q-443: CranL's log retention is unknown).
- The restore rehearsal (NFR-026, T-019) gains a step: erase a test account after the backup, restore, re-apply, prove
  the account is a tombstone again.

## 8. What stays after a deletion (pseudonymous)

Unchanged from T-217 and its successors, now proven by the catalog: the ledger and its notes (reason cleared),
completions (device cleared), enrollments (status `left` or `banned`), `result_place`, `final_rank`, handed-over
redemptions, `achievement_earned`, `questify_award`, `xp_entry`, `gem_entry`, `gem_purchase`, streak and daily rows,
`community_contributor`, `community_payout`, `quest_rating`, `cheer`, `session_registration`, `session_attendance`,
`submission` rows (body NULL), `content_report` rows the player made (reporter and note cleared), and `audit_log`. They
name the tombstone's id only; nothing maps that id back to a person once `player_contact`, `username_history`,
`player_fingerprint` and the sessions are gone. The catalog's `keep` scan (section 2) is the proof. The build checks each
kept table's text columns while filling the catalog; any free text found about the player becomes a `clear` with a
restated `erase_rows` in 0129.

## 9. Out of scope

- Staff and organizer accounts (`staff_user`): a different identity with its own lifecycle (T-701, T-709); the catalog
  lists `staff_user` as `excluded: operator identity, see Q-445`.
- Photos: uploads are parked (Q-149); when they land, the catalog test forces them into the export and erasure.
- A web download page for players: the app is the only player client with a session (F-318 is Could).
- Merging accounts (F-284) and the support seat (T-712).

## 10. Tests (test first)

`test/db/data-requests.int.test.ts` (DB):

1. Own export: an active player gets every section; the file holds their phone, email and username; a second player's
   data is absent (two players in one event, a meeting between them: neither appears in the other's file).
2. Own export refused: a tombstone (DR404 through the door; no session can exist), a banned player (refused), the fourth
   export in 24 hours (DR429 with retry seconds), and after 24 hours it works again (time moved by the fixture).
3. Own export writes exactly one audit entry and one `data_exported` notice; a failure inside the build writes neither.
4. Admin export: a member is QE403; a bad reason or a reference with `@`, a space or 65 characters is DR400; a tombstone
   is PA404; the audit entry holds the reason and reference, never a value from the file.
5. Admin erase: the typed username wrong (DR409, nothing changed); pending handovers without forfeit (`handover_pending`,
   nothing changed); with forfeit (reservations ended `erasure`, units back); `already_deleted` on a repeat; the audit
   entry names the admin.
6. Race: admin erase and self-erase of one account at once (two connections): one erases, the other answers
   `already_deleted` / `expired`; one `player.delete` entry.
7. Race: an admin erase while a join and a reservation are in flight wait and then refuse (the T-217 race tests,
   parameterized over both erase paths).
8. Tombstone final: an owner-connection UPDATE of a tombstone's status, username or birth year raises; in
   `session_replication_role = replica` too.
9. `reapply_erasure`: an active id becomes a tombstone; a tombstone is skipped; the API role cannot call it.
10. `erase_player` refactor: the whole existing `account-deletion.int.test.ts` passes untouched.
11. Measurement fixture (section 6), timing recorded, not asserted.

`test/db/personal-data-catalog.int.test.ts`: section 2's assertions.

`test/console/data-requests.int.test.ts` (HTTP): the routes' status codes, `no-store` and `attachment` headers, no
Idempotency-Key needed on export and required on erase, the limits (429 with `retry-after`), the erase forgets the
player's stored answers, the export answer is never in the idempotency store.

`test/players/data-export.int.test.ts` (HTTP, player): the same for `/v1/me/data-export`.

Security suites: the route table lists the four routes with their guard; outsider (public key only) gets 401 on all;
cross-tenant: an organizer's staff session gets 403 on the console routes; the closed-door list gains every new
function (only D2, D3, D6 and `console_player_pending` granted).

Shared, web and app unit tests: the reason codes and reference pattern in `packages/shared` (one schema, used by the
console form and the route); the Legal request card (export, erase with typed username, pending list, forfeit); the app's
Download my data (writes, shares, deletes the cache file on success and on error). Browser: `e2e/console-data-requests.spec.ts`
(export downloads; erase needs the typed name; the tombstone record shows the legal history and no restore) plus
`layout.spec.ts`. Every new string in Arabic and English (`ux-araby`), RTL checked, Western digits.

## 11. Build order

1. Catalog test and `seedFullPlayer` first (they fail, listing every unclassified table); fill the catalog.
2. 0129: D4, D5 (refactor; run `account-deletion` until green), D7, D8, D1, D2, D3, D6, D9, `console_player_pending`,
   `reapply_erasure`, the notice kind, any `clear` the catalog found.
3. API routes and limits, then the console card, then the app screen and `expo-file-system`.
4. Docs: `API.md` (four routes), `DATA_MODEL.md` (catalog section, tombstone trigger, index), `SECURITY.md` (export
   delivery, backup rule), `RUNBOOK.md` ("Re-apply erasures"), SRS status of FR-1418, FR-1776, FR-1778, the T-708 notes
   in `TASKS.md` marked as covered.

## 12. Mutation targets (TS only, ADR-355)

`apps/api/src/privacy/**/*.ts` (the export route and its door call), `apps/api/src/console/players/data-request-*.ts`
(the console routes and doors), `packages/shared/src/privacy/**/*.ts` (reason codes and the reference rule),
`apps/api/src/deletion/deletion.ts` (only if the erase follow-up is moved into a shared helper).

## 13. Risks

- **A missed table** is the main risk; the catalog test turns it into a CI failure, but only for tables linked by FK or a
  recognizable column name. A table that holds a player's data under another column name escapes; the review should
  read the discovery rules against the schema once.
- **The refactor of `erase_player`** touches the deletion path every player uses; the unchanged T-217 suite is the gate.
- **Backups** keep erased data until they age out, and re-applying after a restore depends on a log the product does
  not control (Q-443).
- **Large exports** could approach the 5 s statement timeout for a very active player; the measurement decides whether a
  per-section cap (newest N notifications) is needed.
- **A stolen session** can download the owner's full contacts; the notice and the audit entry make it visible, and the
  limit keeps it to three a day. A fresh code before the download is Q-440.
