# T-110 — Player legal steps: terms and privacy before data, recorded acceptance, guidelines, Legal pages

Delivers FR-1705, FR-1706 (the server half: the recorded acceptance and the check the submission screen reads; the
screen is T-301's), FR-1707 in part (the Legal pages and the contact page on the web, which the app's Settings opens;
an event's official rules page arrives with the event rules, T-214). Depends on T-109, T-119. Core (sign-in and
account data): Max.

## Scope note

- **Server and web only.** The app's consent screen is part of the sign-in screens (T-111, waiting for the app shell);
  this task gives it the documents, the versions, the acceptance in the code request, and the re-acceptance call.
- **Reuse:** the organizer pattern (`organizerDocuments()` with versions in `packages/shared`, `organizer_acceptance`
  append-only, the web legal page that serves only known ids from `docs/legal/`, `legalBlocks`), `create_player`, the
  player guard, `GET /v1/me`.

## Decisions (tactical; for the CTO to challenge)

1. **The documents:** `playerDocuments()` in `packages/shared/src/legal/documents.ts`: `terms_of_use` (field `terms`),
   `privacy_policy` (`privacy`), `community_guidelines` (`guidelines`), each version `0.1`, texts in `docs/legal/`
   (T-119). Sign-up requires terms and privacy; the guidelines are accepted before a first submission (FR-1706).
2. **Nothing stored before acceptance (FR-1705):** `POST /v1/auth/code` gains a required `accept: {terms, privacy}`
   (the versions the app showed). A missing or stale version is 422 `acceptance_required {documents}` and no
   challenge is written. The accepted versions travel with the challenge (`player_login_challenge.accepted`, jsonb)
   and `create_player` copies them into `player_acceptance` with the sign-up time, in the same transaction as the
   player. A returning player's sign-in records nothing new.
3. **`player_acceptance (player_id, document, version, accepted_at)`,** primary key (player, document, version),
   append-only (ALWAYS triggers; erasure as for the username history), no grant to the API role; read through
   `GET /v1/me` (`legal: {toAccept: [ids]}`: documents whose version in force is not accepted, the guidelines only
   once a submission is the player's next step, so `toAccept` lists terms and privacy only) and written through
   `accept_player_documents(documents jsonb)` (a definer bound to `app_player_id()`, accepting only the versions in
   force: the API passes the shared table's versions).
4. **Re-acceptance (FR-1705's second case):** `POST /v1/me/acceptances {terms?, privacy?, guidelines?}` records the
   versions in force; a stale version is 422 `acceptance_required`. Player routes do not block until re-accepted
   (the app shows the screen on launch when `toAccept` is not empty); blocking every route is out of scope until
   counsel asks for it (Q-095).
5. **Guidelines before a first submission (FR-1706):** `GET /v1/me` also answers `legal.guidelinesAccepted`; T-301's
   submission route will refuse a first submission without it. Recorded now, enforced there (a note on T-301).
6. **Web pages (FR-1707):** the legal page serves the three player documents by their ids (`/ar/legal/terms_of_use`
   and so on), as it serves the organizer ones; `/[lang]/contact` shows the support contact from the legal drafts'
   placeholder until the entity details exist (`{{CONTACT_EMAIL}}` → `support@questify.sa` is not real: it shows the
   placeholder text "سيُضاف قريبًا / Coming soon" and the page lists the in-app help). An event's rules page arrives
   with T-214.
7. **Audit:** `player.legal.accept` audit entries for re-acceptances; the sign-up's acceptances are part of
   `player.signup`'s entry (`after: {accepted: {...}}`).

## Tests

- Shared: `playerDocuments`, `missingPlayerAcceptances`.
- Database: the challenge holds the accepted versions; `create_player` writes them; `player_acceptance` append-only,
  closed; `accept_player_documents` bound to the caller, refuses an unknown document or version; outsider.
- HTTP: `/v1/auth/code` without `accept` or with a stale version is 422 and writes no challenge; with it, sign-up
  records both; `GET /v1/me` `legal`; `POST /v1/me/acceptances` (new version flow by changing the version in force in
  a test registry is not possible with a constant: the test inserts an old version for the player and checks
  `toAccept`); the web legal pages for the three player ids (e2e), the contact page.
- Mutation on the new modules.

## Phases

1. **Database and shared:** migration 0017, `playerDocuments`, tests.
2. **API:** the code request's `accept`, sign-up, `/v1/me` legal block, acceptances route, tests, mutation.
3. **Web and docs:** the legal ids, the contact page, e2e; API.md, DATA_MODEL, SECURITY, STORE_COMPLIANCE check,
   OPEN_QUESTIONS (Q-095), TASKS, STATE.

## Revision 1 (after CTO plan review 1, 84/100) — overrides the sections above where they differ

- **M1, versions come from the server:** the composed `GET /v1/config` (public, ETag, cached by the app) gains, at
  platform level, `legal: {documents: [{id, version}]}` (the three player documents in force). The 422
  `acceptance_required` carries `details.documents: [{id, version}]` too, so a stale app re-shows the web page and
  retries without refetching. The app always opens the documents as the web pages, so the text matches the version.
- **M2, the database holds the rule:** `player_login_challenge` gains `terms_version text NOT NULL` and
  `privacy_version text NOT NULL` (CHECK `^[0-9]+(\.[0-9]+){0,2}$`, like `organizer_acceptance.version`); 0017 first
  deletes live challenges (minutes old; nothing is launched). `start_player_challenge` is dropped and recreated with
  the two versions (`REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO questify_app`); `create_player` keeps its signature
  and copies both rows from the challenge, so no player can exist without them. A test: NULL or malformed versions
  raise.
- **M3, a returning player's acceptance counts:** `sign_in_player`'s `signed_in` branch inserts the challenge's
  versions into `player_acceptance` (`ON CONFLICT DO NOTHING`, method `sign_in`). Test: a player with an old version
  signs in with the current one and `toAccept` is empty.
- **m1, where the check runs:** in `requestCode` before `openChallenge` (so before `takeSend`'s throttle rows, budget
  and logs); the HTTP test asserts a refused request writes no challenge, no throttle row, no budget row and logs no
  `player.*` event. SECURITY.md records that request logs hold method and path only.
- **m2:** a missing or malformed `accept` is 400 `invalid_request` (strict body, as the organizer route); stale or
  incomplete versions are 422 `acceptance_required`.
- **m3:** `accepted_at` is the challenge's `created_at` (when the person ticked) for sign-up and sign-in; `method`
  (`signup` | `sign_in` | `reaccept` | `submission`) is recorded.
- **m4:** `accept_player_documents(documents jsonb)` inserts with `ON CONFLICT DO NOTHING` (re-accepting is fine); the
  database checks the document id (CHECK) and the version format; the API decides what is in force, as for organizers.
- **m5, the read path:** `player_acceptance` has forced RLS, `GRANT SELECT` to `questify_app` with policy
  `player_id = app_player_id()`, no INSERT/UPDATE/DELETE, `REVOKE ALL FROM PUBLIC`; writes only through the definers;
  append-only (ALWAYS triggers, erasure flag as `username_history`). Outsider and cross-tenant tests.
- **m6:** no audit entries for re-acceptance (the table is the record); sign-up's `player.signup` entry keeps
  `accepted`.
- **m7, an honest contact page:** a heading and one line ("the support details are being prepared" in both languages),
  no made-up email, no help links; STORE_COMPLIANCE §4 gains the release gate (a real support email, company name, CR
  number and address on the support page and the legal pages' placeholders before submission); notes on T-706 and
  T-807.
- **m8:** no backfill: players created before 0017 have no acceptance and get a non-empty `toAccept`.
- **m9:** notes on T-217 (erase under `app.erasure` or keep as proof per counsel, Q-051/Q-075), T-301 (enforce the
  guidelines before a first submission), T-111 (the consent screen, decline, re-accept on launch, versions from
  `/v1/config`).
- **NITs:** T-109 is committed before 0017; the legal page looks up `[...organizerDocuments(), ...playerDocuments()]`
  with e2e for the three ids in both languages and a 404; `missingPlayerAcceptances` takes the sign-up pair and the
  guidelines separately so `toAccept` never lists the guidelines. Q-095 notes that a 13–17-year-old accepts before the
  birth year is asked (counsel, Q-042).

## Result (2026-10-21)

CTO: plan 84 → 93; phases 94, 93, 94 (GO). Mutation on `players/{profile,sign-in,routes}.ts`, `legal/documents.ts`
and `config/compose.ts`: 93.6% (722 killed, 41 survived, 8 without coverage). The T-110 survivors (the version format
on both routes, the acceptances refusal's `details`) are killed by tests added after the run and checked by hand; the
rest predate T-110 (T-107's row guards, T-109's change-limit fallbacks) and are equivalent or unobservable.
`ComposedConfig.legal.documents[].id` stays a plain string (F-282); the consent screen narrows it (T-111's note).
