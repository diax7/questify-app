# Questify — Agent Instructions

Questify gamifies events. Attendees complete quests at an event (scan a QR code, finish a challenge,
submit something, vote, answer a question), earn the event's points, climb a live leaderboard, and
redeem points for real prizes. Organizers run everything from an admin dashboard. One app serves
any organizer anywhere; Saudi Arabia is the first market (Arabic + English, RTL).

## Current phase: BUILD (planning ended 2026-10-19, ADR-108)

- The plan is approved (`docs/_blueprint/STATE.md`). Build in the order of `docs/TASKS.md`; pick up the
  next unchecked task. Never build what `docs/SCOPE.md` excludes.
- Process: `docs/TASKS.md`, run in coordinator mode (below) with the `cto-cycle` reviews. GitHub Spec Kit is not used. Standards: `docs/QUALITY_BASELINE.md`; code rules: `docs/rules.md`.
- Docs stay alive: any idea, change or discovery lands in a doc in the same session. A disagreement
  between code and docs goes to `docs/OPEN_QUESTIONS.md`, never a silent override. Tick finished tasks in
  `docs/TASKS.md`.

## How work runs: coordinator mode (Dhia, 2026-10-24; replaces "one task per session" of 2026-10-21)

The main session is the **coordinator**. It does not build tasks itself; it runs them one after another:

1. **A fresh worker per task** (Agent tool; model and reasoning policy below), pointed at
   `docs/agents/WORKER_BRIEF.md` and the task id. Prompts stay short: point at files, don't restate them.
   Workers reply in ≤15 lines. A worker is resumed only for quick fixes right after its review; the next task
   gets a new worker (a large context is costly to resume).
2. **One CTO review per task.** Core tasks (see Quality bar) get a plan review and a code review; every other task
   gets one code review. Every review, including a re-review, runs in a fresh session or subagent, never the code
   author. Re-review only after a BLOCKER, or several MAJOR findings, were fixed; fold minor findings in without
   asking again.
3. **Mutation testing batched on GitHub, core code only** (ADR-174): never locally; only the files a task
   changed; one `mutation.yml` run per 2–3 core tasks, dispatched one at a time (a new dispatch cancels the
   running one); survivors chased only while a file is under 90%.
4. **The coordinator pushes `main`** after each finished task (workers commit, never push) and keeps CranL and
   demo builds in step when Dhia asks.
5. **Short messages.** Brief status to Dhia; read only the part of a file that is needed. When the coordinator's
   own context gets long it is summarized automatically and the work carries on; no `/clear` between tasks.
6. **Dhia is not interrupted for decisions inside a task:** workers take the recommended option and record it
   as a Proposed ADR and an OPEN_QUESTIONS entry for him to review.
7. **Whenever Dhia's interaction or input is needed** (an action only he can do, an approval, a choice, a
   credential, a test on his phone), the coordinator asks with the **AskUserQuestion** tool, never buried in a
   status message, and makes clear what is needed and why. Work that doesn't depend on the answer keeps going.

**Model and reasoning policy (Dhia, 2026-10-25; ADR-265):** use GPT-6.1 Sol (`gpt-6.1-sol`, pinned in
`config.toml`) for everything, with GPT-6 Luna at High allowed only for purely mechanical edits. Use High for the
coordinator, all plans, all reviews and core builds; use Medium for standard builds. Max is reserved only for the
riskiest reviews. The review independence rule applies to every model and task, including docs and config.

**Cost cap (Dhia, 2026-10-26):** at most one sub-agent at a time; two only when a reviewer checks finished work
while the next task's worker builds. No extra helper agents alongside them. In a Claude Code session, which cannot
run GPT-6.1 Sol, use the strongest model only for core builds and core reviews (points ledger, sign-in, tenant
isolation, SQL and locking) and the mid-tier model for docs, ticking tasks, copy checks and non-core builds and
reviews. A worker runs the full test suite once into a log file and reads the summary line; no polling or duplicate
wait commands. Minor review findings are folded into the worker that just finished, with no re-review.

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
