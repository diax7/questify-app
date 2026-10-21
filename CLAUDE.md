# Questify — Agent Instructions

Questify gamifies events. Attendees complete quests at an event (scan a QR code, finish a challenge,
submit something, vote, answer a question), earn the event's points, climb a live leaderboard, and
redeem points for real prizes. Organizers run everything from an admin dashboard. One app serves
any organizer anywhere; Saudi Arabia is the first market (Arabic + English, RTL).

## Current phase: BUILD (planning ended 2026-10-19, ADR-108)

- The plan is approved (`docs/_blueprint/STATE.md`). Build in the order of `docs/TASKS.md`; pick up the
  next unchecked task. Never build what `docs/SCOPE.md` excludes.
- Process: `docs/TASKS.md` + the Superpowers skills (test-first, small steps) + the `cto-cycle` skill for
  core phases. GitHub Spec Kit is not used. Standards: `docs/QUALITY_BASELINE.md`; code rules: `docs/rules.md`.
- Docs stay alive: any idea, change or discovery lands in a doc in the same session. A disagreement
  between code and docs goes to `docs/OPEN_QUESTIONS.md`, never a silent override. Tick finished tasks in
  `docs/TASKS.md`.

## Token budget (Dhia, 2026-10-21: all five rules approved)

1. **One task per session.** Finish the task, commit, update `docs/_blueprint/STATE.md`, then stop and tell
   Dhia to start a fresh session (`/clear`). Never carry several tasks in one conversation.
2. **One CTO review per task.** Core tasks (see Quality bar) get one plan review and one code review. Every
   other task gets one code review only, with no plan review. Re-review only when a BLOCKER or MAJOR finding
   was fixed; fold minor findings in without asking again.
3. **The reviewer's model:** Opus for core tasks. Sonnet (`model: "sonnet"`) for every other review: screens,
   copy, docs, config.
4. **Mutation testing only on core code** (QUALITY_BASELINE, ADR-111), never on screens or app UI modules.
5. **Short messages.** Brief prompts to subagents (point at files; don't restate them), brief status to Dhia,
   no long recaps. Read only the part of a file that is needed; avoid full-size image reads unless new art
   is being adopted.

## Read order at the start of every session

1. `docs/_blueprint/STATE.md`: where the project stands and what comes next
2. `docs/PROJECT_BRIEF.md` and `docs/SCOPE.md`: what we are building and what we never build
3. `docs/SRS.md` and `docs/FEATURES.md`: what it must do
4. `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/API.md`, `docs/SECURITY.md`, `docs/CONFIGURABILITY.md`
5. `docs/rules.md` and `docs/QUALITY_BASELINE.md`
6. `docs/TASKS.md`: pick up the next unchecked task
7. `docs/README.md` is the map of every file

## How the docs are kept

- **Raw input first goes to `docs/INBOX.md`**, dated, close to the user's words. Then it is
  processed into the right doc and marked processed. Nothing the user says is lost.
- **Decisions go to `docs/DECISIONS.md`**. A decision is `Accepted` only when the user said so.
  Claude's recommendations are `Proposed` until then.
- **Unknowns go to `docs/OPEN_QUESTIONS.md`**, never as TODOs inside other docs.
- **Requirement IDs (`FR-###`, `NFR-###`) are permanent.** A removed requirement's ID is never
  reused.
- **Design references from the user** go in `docs/design/references/`, each indexed in
  `docs/design/REFERENCES.md` with what to take from it.
- **Update `docs/_blueprint/STATE.md`** at the end of every working session.

## Product principles (apply to every requirement and design)

1. **Configuration over code.** Anything an organizer or Questify admin may want to change
   (features on/off, currency name, quest types, rewards, branding, copy) is data edited from the
   admin dashboard, not a code change or a store release.
2. **Store-compliant from the first submission.** `docs/STORE_COMPLIANCE.md` is a gate. A feature
   that conflicts with it is redesigned, not shipped and hoped for.
3. **Arabic is first-class.** RTL layout, Arabic typography and Arabic microcopy (use the
   `ux-araby` skill) are designed in from the start, not translated afterwards.
   - Fonts: Baloo Bhaijaan 2 for display, Rubik for body (ADR-017).
   - Numbers always use Western digits (0–9) in both languages (ADR-018).
4. **The brand deck is the design source of truth** (`docs/design/references/Questify-brand-deck.pdf`,
   ADR-013). Every screen, component, icon and animation follows its adventure-game style: wood,
   parchment, gold, 3D icons, purposeful motion. No generic AI-template look.

## Hard rules (docs/rules.md has the detail)

1. Authorize on the server for every action; the client is untrusted.
2. Deny by default: every table, function and storage area is closed to the public in the change that
   creates it, with an outsider test.
3. Personal data stays in Saudi Arabia and out of logs, errors and push text.
4. Every user-facing string exists in Arabic and English; check right-to-left; Western digits.
5. Every outside call has a timeout, a safe retry and a fallback.
6. The points record and audit logs are append-only; unsafe actions take an idempotency key.
7. Configuration is data and never downloads a feature; `docs/STORE_COMPLIANCE.md` is a gate.
8. `docs/` is the source of truth; a new dependency needs a reason.

## Quality bar

Max on the core (points and XP ledger, sign-in, tenant isolation, prize handover, wallet signing, signed
QR/NFC proofs, admin powers); Standard everywhere else. Security target: OWASP ASVS 5.0 L2 for the core,
L1 elsewhere, MASVS for the app (`docs/QUALITY_BASELINE.md`).

## Tech stack (summary; reasons in docs/TECH_STACK.md)

- Player app: Expo SDK 57 (React Native) + TypeScript, development builds, EAS Build and Submit.
- Server: Node 22 + Fastify, one modular monolith; PostgreSQL with a shared schema and row-level security;
  Redis-compatible ranking cache; pg-boss jobs.
- Web: one Next.js app (event page, station, big screen, dashboard, console).
- Hosting: CranL Pro, `riyadh-1` (ADR-107). SMS: Msegat (ADR-103).

## Architecture (summary; detail in docs/ARCHITECTURE.md)

Clients call an internal REST API (`/v1`). Every quest scan is one database transaction that writes the
completion, the append-only ledger entry and the score. Rankings live in the cache and are rebuilt from
the ledger. Workers send SMS, email and push. Configuration is composed on the server and cached on the
phone with a last-working copy.

## Tooling for this project

- Library and framework docs: context7. Web and market research: Exa.
- Planning runs on the `blueprint` skill. Its stage files are read when each stage starts.
