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
- A check run once per row of a large set (the push fan-out and claim, a trigger, a per-member rule) never calls a SQL
  function with a `SET` clause from inside a query: PostgreSQL plans that function, and every such function nested in
  it, again at every call. Write the check in PL/pgSQL, call such functions in plain expressions (`IF`, `RETURN`
  without a subquery), and keep the queries free of them, or give the function no `SET` clause so it is inlined (T-501e,
  ADR-354 (5): a live poll's fan-out to 50,000 members fell from 336 s to about 27 s).

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

**The first-N bonus's lock order (T-313, ADR-260).** A completion takes the rehearsal row, the enrollment(s), the
items, the XP row(s), the category bonus, then the bonus's advisory lock `first-bonus:<quest>` shared and one slot `FOR
UPDATE SKIP LOCKED` per side, last (the meet claims both sides after both are paid). The setter takes the rehearsal
row, the same advisory lock exclusive, the bonus row, then slots, never an enrollment, an item or an XP row; the quest
save calls it after its quest write. No claim takes another lock after its slot.

**The streak's lock order (T-405, ADR-296, ADR-297).** The `ledger_streak` trigger fires after `apply_ledger_entry`
and before `ledger_xp` (triggers of one kind fire in name order), so it runs inside the payer's enrollment lock and
before the `player_xp` lock; it takes no row lock of its own (its inserts key-share only rows the quest entry already
names). The only wait it adds is one player's first completions of the day in two events at once (the second waits on
the first's Questify day row, holding no XP row). The settings door `set_event_streak` takes the event FOR KEY SHARE (a results confirmation in flight finishes first), then only its `event_streak` row,
never an enrollment, a completion or an XP row. `questify_sync` pays the milestones under its usual player KEY SHARE,
then `player_xp` FOR UPDATE.

**The daily games' lock order (T-406, ADR-309).** A player door takes the player FOR KEY SHARE, then today's
governing `daily_cadence` row FOR KEY SHARE (the period is worked out in a later statement), then the content row
(challenge or word) FOR KEY SHARE, then its `daily_play` row (INSERT … ON CONFLICT DO NOTHING, then FOR UPDATE), appends
the move, and only on a finish the `questify_streak_day` row (probe, then INSERT … ON CONFLICT DO NOTHING) before
`player_xp` FOR UPDATE, as the completion trigger does. A move that does not finish takes no `player_xp` lock. The
cadence door locks every cadence row of its kind FOR UPDATE, then reads the clock once (today, the governing row and
tomorrow from that one read). Content doors never lock `daily_cadence` (the period start is read without a lock); they
take an explicit FOR UPDATE on the content row (a question save its challenge first, then the question) and check the
clock (`clock_timestamp()`) after that lock; they never lock a player, a play or an XP row.

**The invitation sender's lock order (T-409, ADR-333, ADR-334).** Event (`FOR SHARE`: request, approve, start) →
campaigns → recipient rows → the channel hold row. Campaigns: `FOR UPDATE` for a state change by a door (approve,
refuse, either cancel, the start); every path that touches more than one campaign takes all of them in one statement in
id order before any row: the claim locks every sending campaign and every campaign with an expired lease `FOR NO KEY
UPDATE` (not `FOR KEY SHARE`: it moves the skipped counter, and a later upgrade could deadlock with a cancel), and settle
locks every campaign it may change (approved, sending, ended with results open, an expired lease) `FOR UPDATE`.
Acknowledgement and open read the row's campaign id unlocked, then take that one campaign `FOR NO KEY UPDATE`, then the
row. Recipient rows: `FOR UPDATE`, `SKIP LOCKED` in the claim, lease expiry, the skips, the joined pass and the purge.
The fill takes `pg_try_advisory_xact_lock(hashtext('invitation_fill'))` before anything and skips the tick when it is
taken. No T-409 door locks a player, an enrollment, a consent row or a ledger row (`invitation_recipient` has no foreign
key, ADR-334, so no check locks a player); erasure deletes recipient rows under its own player lock and never touches a
campaign. No outside call runs inside a transaction.

**The push store's lock order (T-501, ADR-345).** A producer inserts one notice (`notice_create`) **after** every lock
its own door takes and reads nothing of the push store, so the notice comes last in every producer's order. A trigger
producer (T-501d) inserts at the end of its triggering statement, so a door may take a lock after it (a review marks
`ranking_repair` after its submission update): the notice takes only `FOR KEY SHARE` on its event and kind through the
foreign keys, which conflicts only with a key change or `FOR UPDATE` of that event. Decide (its event `FOR SHARE`),
review (`FOR KEY SHARE` first) and the reveal (its redemptions' foreign key) already hold that lock; the help-desk
answers take it last, after their ticket, and no door that holds an event `FOR UPDATE` then locks a ticket. A door's
own row locks already cover the once-only marker. The event pushes (T-501e): Launch and Send poll in a live event take
the event first (the go-live wipe's check), but **in the rehearsal phase they take their first event lock late**, the
notice's `FOR KEY SHARE` after their quest row `FOR UPDATE`, so an event write that holds the event `FOR UPDATE` and
then locks quest rows can deadlock with them (`40P01`, one side undone). Rare (a rehearsal launch racing such an event
write) and safe to retry: the undone call changed nothing, and a retry that finds the launch or send done answers it.
Save boost takes its advisory lock and the boost row before the notice; the community settle holds only its goal. The
due scans (`push_due`) read without locks and write notices only. The
fan-out: notice `FOR UPDATE SKIP LOCKED` → center rows (insert) → sends (insert, which takes `FOR KEY SHARE` on the
device rows through the foreign key); enrollments, players, categories, mutes, devices and consent are read without
locks. The claim, lease expiry, expiry and the purges: sends `FOR UPDATE SKIP LOCKED`, nothing else locked. The
acknowledgement: sends by id, then devices `FOR NO KEY UPDATE` in id order when marking invalid. Register: the device row by
family `FOR UPDATE`, then the other row holding the token (deleted); two sign-ins racing for one token retry once. No
push door locks a player, an enrollment, a consent row or a ledger row; the foreign keys on `push_device` and
`push_topic_mute` take `FOR KEY SHARE` on the player, which no player write conflicts with. No outside call runs inside
a transaction. The notice carries no counters (no hot row). A fan-out planning a send for a device that a register is
replacing can deadlock with it; PostgreSQL ends one and the other side retries (the worker's next loop, the app's next
launch). A register that moves a token to this sign-in deletes the other sign-in's device, which cascades to its
sends, while an acknowledgement holding one of those sends `FOR UPDATE` may wait for that device to mark it invalid:
the two can deadlock. PostgreSQL ends one; the register answers 503 and the app tries again at its next launch, or the
acknowledgement is logged (`push.ack_failed`) and its rows expire to `unknown` (never sent twice). Devices are locked
`FOR NO KEY UPDATE` by the acknowledgement, so it never waits on the fan-out's `FOR KEY SHARE`.

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
  The first two are held by a ratchet (`pnpm lint:limits`, part of `ci:changed`; T-023): oxlint with
  `.oxlintrc.limits.json` (kept apart so the normal lint gate stays clean) is compared with the committed
  `scripts/function-limits-baseline.json`. A new function over a limit, or a baselined one that grew, fails; a
  renamed offender counts as new. When you touch a baselined function, split it, then run
  `node scripts/function-limits.mjs --update`, which only ever lowers the baseline. Tests are not measured, and neither are `scripts/*.mjs` or TypeScript files at the repo root (the ratchet scans `apps` and `packages`).
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
