# Coding Standards — Questify

> How code gets written here, and the bar a change must clear to ship. Drafted in Stage 7,
> 2026-10-17. Applies once the build phase starts (see `_blueprint/STATE.md`); until then no
> application code is written. Tool versions are looked up when installed, never assumed.

## Hard rules (ADR-104)

1. **Authorize on the server for every action.** The phone, browser and any link are untrusted. Each
   request re-checks the player, role, organizer and event (NFR-016).
2. **Deny by default.** Every table, function, storage area and queue is closed to the public in the
   same change that creates it. Each grant is explicit and has a test from an outsider's seat
   (NFR-018).
3. **Personal data stays in Saudi Arabia and out of logs.** No phone, email, free text or photo
   in logs, error reports or push text. Every vendor that receives personal data is in the data map
   (NFR-020, ADR-070).
4. **Every user-facing string exists in Arabic and English.** Both directions are checked on every
   screen; numbers use Western digits (NFR-011, NFR-012, ADR-018).
5. **Every outside call has a timeout, a safe retry and a fallback.** A retry never double-sends or
   double-pays (`INTEGRATIONS.md`).
6. **The points record and audit logs are append-only.** Corrections are new entries. Every action that
   must not run twice takes an idempotency key (NFR-019, `API.md`).
7. **Configuration is data and never downloads a feature.** Anything that conflicts with
   `STORE_COMPLIANCE.md` is redesigned, not shipped (ADR-007).
8. **`docs/` is the source of truth.** A disagreement goes to `OPEN_QUESTIONS.md`, never a silent
   override. A new dependency needs a stated reason, and an ADR if significant.

## How we work (ADR-108)

- **Driver:** `TASKS.md` (the build order) plus the Superpowers skills (test-first, small steps, review) and the `cto-cycle` skill for core phases. Spec Kit is not used (ADR-108). OpenSpec may be adopted after launch for changes.
- **Gates:** the gstack skills `/review`, `/qa` and `/cso` run at phase gates; the standards they check against are in `docs/QUALITY_BASELINE.md` (OWASP ASVS 5.0 L2 for the core, MASVS for the app, test pyramid with mutation tests on the core, infrastructure as code, runbooks, independent penetration test).
- **Source of truth:** `docs/`. After a task is done, tick it in `TASKS.md` and update any doc it changed.

## Quality bar (ADR-104)

- **Max** for the core: the points and XP ledger, sign-in and sessions, tenant isolation and
  row-level security, prize reservation and handover, wallet-pass signing, rotating and signed QR/NFC
  proofs, and anything that touches admin power. Every failure is observable and recoverable; nothing
  merges without tests; each core change gets a second read (a review pass) before merge.
- **Standard** for everything else: every feature ships with tests, error/empty/loading states and
  updated docs.

## Naming

TypeScript: `camelCase` for values and functions, `PascalCase` for types and components, `UPPER_CASE`
for constants, `kebab-case` for file names (one exported thing per file where practical). Database:
`snake_case` tables (singular) and columns. API JSON: `camelCase`. Quest types, flag types and event
states are string unions defined once in `shared` and reused everywhere.

## Structure

One monorepo (pnpm workspaces): `app` (Expo), `web` (Next.js), `api` (Fastify), `shared` (types,
Zod schemas, the quest-type schemas, the configuration schema). Modules inside `api` are the ones in
`ARCHITECTURE.md`; a module is used only through its exported functions, never by reaching into
another module's tables. New code goes in the module that owns the data. No relative `..` imports:
use absolute package paths.

Database and routes (foundation review, 2026-10-19):
- Every query states its own filter; row-level security is the second wall. Leaving the choice to a policy is allowed only
  for retention sweeps, with a comment saying why.
- A column that holds money, standing or power (points, balances, statuses, roles) gets a column grant or a guard
  trigger in the same migration that creates it, with a test from the API role's seat.
- Every route declares `config.access`. A public route never takes idempotency keys.
- Services open the transaction; store functions take the client and never open their own.

## Error handling

Fail fast with a message that says what failed and what to do next. Never swallow an error. Server
errors use the one envelope in `API.md`. A failed network action in the app is never silently lost or
half-applied (NFR-007): the player sees it and can retry. No personal data in error messages.

**The kiosk door's lock order (T-309b, ADR-244).** `kiosk_complete_quest` takes its device `FOR SHARE`, then the
rehearsal row, then the enrollment (`record_completion`'s `FOR NO KEY UPDATE`), then items; it reads the pairing
operator's assignment without a lock, never `FOR SHARE`, since the removal trigger locks the assignment before the
device. A Revoke or removal waits for a scan in flight, and the scan is paid before or refused after (DV401).

**The help desk's lock order (T-310).** `open_ticket` takes the rehearsal row, then the enrollment `FOR NO KEY
UPDATE`, then inserts (a replay by key is read under the enrollment lock, so two sends with one key are one ticket);
an answer takes the rehearsal row, then an advisory lock on its answerer's key, then the ticket `FOR UPDATE`, and never
an enrollment; the retention sweep skips a
ticket an answer holds (`SKIP LOCKED`), and erasure deletes ticket rows only. No path takes an enrollment after a
ticket.

**The ticket center's lock order (T-312).** `open_platform_ticket` takes an advisory lock on `ticket-send:<player>`,
then the player row `FOR KEY SHARE` while active, then inserts (no enrollment, no ticket lock); erasure takes the
player row `FOR UPDATE` and then deletes tickets and never the advisory lock, so no cycle, and no send outlives an
erasure. Escalation, a send-back and every answer take the ticket `FOR UPDATE` (an answer after its key's advisory
lock) and re-read its status and queue; the loser gets `already_closed`, `not_open` or `moved`.

**Lock order during play (ADR-211).** A function that runs during play and locks more than one enrollment takes them
all in one statement, in id order, before any item, redemption or advisory lock, and takes more than one device key
only in ascending key order, and a payer that pays more than one player takes their Questify XP rows in player id
order (the meet payer pays in player id order). Known exception: `confirm_results` (0041:1043-1049) runs after play
and pays in quiz-attempt order; a crossing is rare, Postgres aborts one side (40P01), and the API answers a deadlock
or serialization failure 503 `busy` with Retry-After, so the client retries. A test runs the crossed cases on two
connections (`test/db/meet.int.test.ts`). The community payer (T-306b, ADR-223) takes the rehearsal row, then the
event `FOR KEY SHARE`, then its payout rows `SKIP LOCKED`, then the batch's enrollments in one statement in id order,
and no item, advisory or XP lock; settling a goal locks only the goal (its contributor, reach and payout inserts take
`KEY SHARE` on the enrollments, steps and event through their foreign keys and wait only for a `FOR UPDATE` whose
holder never waits for a goal). Crossed cases: `test/db/community-locks.int.test.ts`. A goal's save (T-306c) takes the
rehearsal row, the builder's advisory lock, the goal, then its steps, whose inserts take `KEY SHARE` on each unlock
target (quest, category, reward) through their keys; `reserve_reward` takes the enrollment then the reward `FOR UPDATE`
and reads the gate in a later statement; the save never locks an enrollment, so the two never cycle (crossed both ways
in `test/db/community-unlocks.int.test.ts`). A boost's save (T-307) takes the rehearsal row, the event's boost advisory
lock, the boost row `FOR UPDATE` (an edit), then reads other boosts; its delete takes the rehearsal row then the boost
row `FOR UPDATE`; Stop takes the row `FOR NO KEY UPDATE` only, so a payer holding the boost's key (`KEY SHARE` through
its entry's foreign key) never waits for it; none locks an enrollment. Launch and End now take the rehearsal row then
the quest `FOR UPDATE`. Payers read the boost with no lock (crossed both ways in `test/db/flash-boosts.int.test.ts`).
Devices (T-309): a claim takes the operator's assignment `FOR SHARE` (or the team check), the pairing request `FOR
UPDATE`, the event's device advisory lock, then the insert; `activate_device` and `revoke_device` take only the device
row `FOR UPDATE`; a station's code is a read with no lock; the removal triggers update devices under the removed row's
delete. No device function takes a device after an enrollment, so none cycles (crossed in `test/db/devices.int.test.ts`).
NFC (T-308): `tap_quest` reads the tag with no lock, then record_completion's order (rehearsal row, enrollment), then
its tap row takes `KEY SHARE` on the tag, so a Revoke (`FOR NO KEY UPDATE`) neither waits nor blocks. `register_nfc_tag`
takes the assignment `FOR SHARE`, the quest row `FOR NO KEY UPDATE`, then the event's `nfc:` advisory lock, then the tag
rows; `move_nfc_tag` takes the target quest row, then the tag row; none locks an enrollment (crossed in
`test/db/nfc-tags.int.test.ts`).

## Testing

- **Unit and integration:** `vitest`, colocated `*.test.ts`. Test behavior, not implementation; test
  edges and error paths; mock only what is slow, random or external (providers, time), never the
  database for core logic.
- **Outsider suite:** a small suite that holds only the public credential and asserts it can do nothing
  (NFR-017, NFR-018). Runs on every pull request. `apps/api/test/security/outsider.int.test.ts` reads the live
  catalog, so a new table, sequence, function or schema is covered without editing it.
- **Cross-tenant suite:** an editor of organizer A against every organizer B route must fail.
  `apps/api/test/security/cross-tenant.int.test.ts` (database) and `routes.int.test.ts` (HTTP).
  **A new table or route fails CI until it is classified there:** a table as owned (by an organizer, a staff
  member or a player, with a forged-insert case) or shared (with the reason); a route with how it keeps callers
  apart, and a test when it touches tenant data.
- **Web end-to-end:** Playwright for the dashboard, console and event page.
- **App flows:** an open-source mobile flow-test tool (verify the current choice when installing) for
  join, scan, reserve, and Arabic/RTL checks on a real device.
- **Load test** at 20,000 completions per minute per event is a launch gate (NFR-003).
- Break the code and watch the test fail before trusting it; use property tests for parsers and the
  mini-game replay checker.

## Comments

Code explains what; comments explain why. No commented-out code. Remove dead code when something
replaces it; do not leave compatibility shims.

## Imports and dependencies

Absolute imports only. Every new dependency needs a reason in the pull request; look up its current
stable version, license and maintenance first. Audit before installing; block install scripts where
the package manager allows; lock files committed. Secrets only in environment variables or the cloud
secret store; a secret scan runs on every change.

## TypeScript tooling

- Runtime Node 22 LTS; ESM only.
- Lint `oxlint` (typescript, import, unicorn plugins); format `oxfmt`; types `tsc --noEmit`; tests
  `vitest`.
- `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`,
  `isolatedModules`.
- Limits: at most 100 lines per function, cyclomatic complexity 8, 5 positional parameters, width 100.
- Zero warnings: fix every warning from every tool, or add an inline ignore with a reason.
- Expo: development builds only (NFC needs native code); build and submit through EAS.
- App and shared code run on the release Hermes, which lacks some built-ins Node has (`toSorted`,
  `Object.groupBy`, Set methods, `structuredClone`, ...). Copy then sort (`[...list].sort()`);
  `unicorn/no-array-sort` is off for `apps/app` and `packages/shared` for that reason, and
  `apps/app/src/hermes-runtime.test.ts` fails on any call to a listed built-in (2026-10-23: the
  preview APK crashed at launch on `toSorted` in `fontFor`).

## Definition of Done

A change is done only when all of these hold:

- [ ] Its acceptance criteria in `SRS.md` / `FEATURES.md` are met
- [ ] Tests written and passing, including the error paths; outsider and cross-tenant suites pass
- [ ] Error, empty and loading states handled (UI changes)
- [ ] Every new string exists in Arabic and English, and the screen was checked right-to-left
- [ ] Lint, format and type checks clean with zero warnings
- [ ] New tables/functions/endpoints are closed by default with explicit, tested grants
- [ ] No personal data in logs or error reports
- [ ] External calls have a timeout, retry and fallback
- [ ] Affected docs updated, including `DECISIONS.md` if a choice was made and `OPEN_QUESTIONS.md` for
      any unknown
- [ ] For **core** changes (see Quality bar): observability added (a metric or alert), a runbook line for any new alert, second read done, mutation check passes on the new code, and the ASVS/MASVS controls touched have evidence
