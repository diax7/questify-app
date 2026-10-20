# T-104 — Quest QR codes: signed, versioned, printable, regenerable

Delivers FR-301, 302, 305, 1711 (docs/TASKS.md). Depends on T-103. "Signed QR proofs" are core (ADR-104): Max quality,
mutation-tested.

## Scope note

- The docs fix the behaviour only: a quest QR is signed and carries a version; regenerating makes the old printed code
  fail at once; the server checks it (SECURITY abuse case 2, ARCHITECTURE "checks the QR's signature", API.md
  `proof {type, code}`, 422 "bad or old code"; Done-when: "a regenerated QR makes the old printed code fail
  immediately; a forged payload is rejected"). The payload format, the algorithm, the key, the landing for a phone
  camera, and the QR library are not decided anywhere. This plan decides them.
- The completion engine that accepts a scan is T-105. T-104 builds the code (issue, verify, regenerate) and the
  dashboard's print page; T-105 calls `verifyQuestCode` inside its transaction.
- Reuse: the quest builder's `withEvent` (lock, not found, closed), path-scoped `readQuest`, `recordAudit`, the
  organizer pages (`organizerPage`, `OrganizerShell`), `requestJson`, the route walk.

## Decisions (tactical; for the CTO to challenge)

1. **The payload is an https URL on the dashboard's origin:** `{DASHBOARD_ORIGIN}/q/{token}`. A phone camera that scans
   it without the app opens a small bilingual page ("Scan this code inside the Questify app, from the event's Quests
   tab"), never a dead string; the app reads the token from the URL (T-105/T-115). No new domain and no new setting:
   production's dashboard is `questify.nafes.com` (ADR-112). Universal links that open the app straight from the camera
   are a later step (with the join links, Q-070).
2. **The token** is base64url of 37 bytes: `format (1) | quest id (16) | version (4, big-endian) | HMAC-SHA256
   truncated to 16 bytes`. 50 characters, a small QR (version 4–5 at medium correction). The format byte names the
   layout and the key generation, so a rotation can be told apart. Nothing personal and nothing secret in it; the quest
   id alone opens nothing (every read is scoped).
3. **The key is its own secret, `QR_SECRET`** (≥ 32 characters, required in production like `AUTH_SECRET`), with the
   per-purpose derivation of `auth/keys.ts` (`HMAC(secret, "questify/qr/v1")`). Not `AUTH_SECRET`: printed codes live
   for a whole event, and rotating the auth secret (on a staff departure, RUNBOOK) must not force every organizer to
   reprint. RUNBOOK gains the rotation procedure (abuse case 10): rotating `QR_SECRET` voids every printed code, so it
   is done only on a leak, with a new format byte and a notice to organizers to reprint.
4. **The version** is `quest.qr_version int NOT NULL DEFAULT 1`; regenerating increments it (definer-free: a column
   grant for the API's role, audited `quest.qr_regenerate`). A code verifies only when its version equals the quest's
   current one, so the old printed code fails at once (FR-1711). A deleted quest's code finds no quest (FR-305).
5. **`verifyQuestCode(token, key)`** is a pure function in the API (`apps/api/src/quests/qr.ts`): decode, check length
   and format byte, constant-time MAC compare, return `{questId, version}` or a refusal kind (`not_questify`,
   `forged`). The database check of the version is T-105's, in its transaction; T-104 tests it end to end with a
   helper query so the Done-when is proven now.
6. **Which quests have a code:** a registry flag `usesQuestQr` (`scan_qr: true`, `enter_code: false`), so each later
   type says whether it has one (location's QR fallback, FR-216, sets it in T-303). This is the T-103 note's per-type
   flag. **No `verification` column yet:** today every quest that has a code is verified by that code alone. The
   column and its "at least one" rule arrive with the second method (My QR, T-205), when there is a real choice; FR-301
   is partly delivered (the quest-QR method), FR-302 is enforced by T-105. Recorded in TASKS.
7. **QR library: `uqr` 0.1.3** (unjs, MIT, zero dependencies, 79 kB, SVG output, published 2026-04-03), in the web
   app only. Writing a QR encoder (Reed–Solomon, masks, version tables) is not worth owning; `qrcode` pulls in yargs and
   pngjs. ADR-115 (Proposed) records the choice. The API never draws codes; it signs them.
8. **Download and print without a PDF library:** each card downloads its SVG (a vector, crisp at any print size); the
   print sheet is the page itself with print CSS (title in both languages, the category, the quest's code, two sizes),
   printed or saved as PDF by the browser (UX assumption A15). "Download all (PDF)" is the browser's "Save as PDF" from
   the same sheet.
9. **Regenerate** asks first ("The printed code stops working at once. Reprint it before players scan.", UX §3.5); no
   second live confirmation (UX table: "none"). Refused in an ended event (`event_closed`), as every builder change.

## Behaviour

### Migration 0011

- `ALTER TABLE quest ADD COLUMN qr_version integer NOT NULL DEFAULT 1 CHECK (qr_version >= 1)`; `GRANT UPDATE
  (qr_version)` to `questify_app` (the closed-event guard of 0010 covers it).

### API

- `GET …/events/{eventId}/codes` (member) → `{codes: [{questId, categoryId, title, version, url}]}` for the quests whose
  type uses a quest QR, in builder order. Members see codes (they print them); `Cache-Control: no-store` as every
  organizer route.
- `POST …/events/{eventId}/quests/{questId}/qr/regenerate` (member) → `{version, url}`; 404 outside reach or for a type
  without a code, 409 `event_closed`. Audit `quest.qr_regenerate {before: {version}, after: {version}}` (never the
  token).
- `config.qr.secret` from `QR_SECRET` (required in production, a fixed test value in tests); `createQrKeys(secret)`.
- API.md: replace the old `POST …/events/{id}/qr/regenerate` row.

### Web

- `/[lang]/organizers/:id/events/:eventId/codes` "Print codes": a grid of cards (QR as inline SVG from `uqr`, the title
  in both languages, the category), Size small/large, "Print sheet" (`window.print()`), per card "Download SVG" and
  "Regenerate" (with the confirmation; then "New code made. The old code no longer works. Print it again."). Empty
  state with a link to the builder. Print CSS hides the controls.
- `/q/[token]` (public, no data, no API call): both languages on one page, the app's name, how to scan inside the app.
- Links: "Print codes" from the builder header; "Print QR" on a `scan_qr` quest row.

## Tests

- Unit (`qr.test.ts`): round trip; every refusal (wrong length, wrong format byte, a flipped bit in each part, another
  key, not base64url); constant-time compare used; property test over random ids and versions.
- Integration: codes listed only for code-bearing types, in order, scoped (404 for another event and a limited editor);
  regenerate increments, audits without the token, refused when ended; the old URL's token no longer matches the
  quest's version (helper check standing in for T-105) and the new one does; a deleted quest's token finds nothing.
- Shared: the registry flag present for every type.
- Web unit: card helpers; e2e: open Print codes, see one card per scan quest, regenerate with the confirmation, the
  code changes; `/q/{token}` renders both languages.
- Route walk; mutation scope adds `apps/api/src/quests/qr.ts`.

## Phases

1. **Signing, migration, API:** 0011, `qr.ts`, config, routes, tests, mutation.
2. **Web and docs:** print page, landing page, e2e, API.md, SECURITY.md (the QR key), RUNBOOK (rotation), ADR-115,
   TASKS, STATE.

## Revision 1 (after CTO plan review 1, 87/100) — overrides the sections above where they differ

- **M1, the landing page lives at `app/[lang]/q/[token]`.** The printed URL stays `/q/{token}` (short; the app parses
  the printed text). The web proxy's language redirect sends `/q/…` to `/{lang}/q/…`, and the page renders in that
  language with the usual switch (not both languages on one page). It sets `robots: noindex` and
  `Referrer-Policy: no-referrer` (the token in its URL completes that quest for whoever holds it). e2e: `/q/{token}`
  with no prefix lands on the page, in Arabic and in English.
- **M2, strict and canonical decoding.** `verifyQuestCode` checks `^[A-Za-z0-9_-]{50}$` before decoding, re-encodes
  the decoded bytes and requires the exact input back (37 bytes leave 4 spare bits, so 16 strings would otherwise
  decode alike), then the format byte, then the MAC with `safeEqual`. Tests: a non-canonical last character, padding,
  whitespace and a foreign alphabet are each refused for the right reason.
- **m1, the binding rule for T-105:** `verifyQuestCode(token, key, expectedQuestId)` refuses a code of another quest
  (`wrong_quest`), so quest A's code never completes quest B through `POST /v1/quests/{B}/complete`. T-105 answers a
  version mismatch with the same 422 as a forged code and logs `forged` apart (ADR-041 flags). Written in the
  function's doc and in TASKS under T-105.
- **m2, what the MAC covers:** `HMAC(K, bytes[0..21))`: the format byte, the quest id and the version. The key is
  `HMAC(QR_SECRET, "questify/qr/v1/quest")`, so My QR (T-205) and rotating station codes (FR-314) take their own keys
  from the same secret. The format byte names layout and purpose (not a key generation: a rotation voids every code).
- **m3, `QR_SECRET` is required everywhere**, at least 32 characters, validated in `config.ts` like `AUTH_SECRET`. The
  same change adds it to the test config, `apps/api/test/e2e-server.ts`, the RUNBOOK settings line and the staging
  checklist in STATE (staging deploys are manual; it is set there before the next deploy, by Dhia through the secret
  store).
- **m4:** the property test is a seeded loop of 1,000 random ids and versions; no new test dependency.
- **m5:** the page draws the code with `uqr`'s `encode()` into a React `<svg>` (one `<path>` of modules, a 4-module
  quiet zone, error correction M); `renderSVG` only for the "Download SVG" file. No raw HTML injection.
- **m6, print:** black on white whatever the theme (`print-color-adjust: exact`), the quiet zone kept, one card never
  split across pages, and no mirroring under right-to-left (a unit check that the code's SVG carries no transform).
- **m7, UX §3.5:** titles in the event's languages (an English-only event prints English); the category stands in for
  the station name until stations exist (T-205/T-309); one primary button "Print or save as PDF" (no separate
  "Download all"); Size: Small is a grid of several per page, Large is one per page; Regenerate is disabled while its
  request runs. UX §3.5 is updated in the same change.
- **m8, TASKS:** T-104 partly delivers FR-301 (the quest-QR method); T-105 gains FR-302's enforcement; T-205 gains the
  rest of FR-301 (the `verification` column and its at-least-one rule).
- **n1:** `qr.ts` is already in the mutation scope (`apps/api/src/quests/**`); no config change.
- **User's calls, built on as Proposed:** `uqr` 0.1.3 pinned exactly in `apps/web` (ADR-115), and the new production
  secret `QR_SECRET` (ADR-116). `qrcode-generator` is the zero-dependency fallback if `uqr` stalls.

## Build notes

- Phase 1 code review: 93, GO (then about 96 with a limited-editor test and an ended event's codes still listed).
  Phase 2: 92, GO; folded in: "Print QR" scrolls to and focuses its card once the codes load; the UX error lines ("We
  could not make the codes." with Retry, "No new code was made, so the old code still works."); print in normal flow
  (no visibility trick); the download's object URL revoked a tick later; the scan page answers 404 for anything not
  shaped like a code; the category printed in every language the event wrote it in.
- The scan page has no dashboard bar (players see it), only its own language switch.
- The codes list carries the category's name: it stands in for the station name until stations exist.
- `e2e/builder.ts` holds `openBuilder` (third copy: quests and codes specs).

