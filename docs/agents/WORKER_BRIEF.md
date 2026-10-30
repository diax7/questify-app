# Worker brief

Read by every worker the coordinator starts (CLAUDE.md, "How work runs"). You build ONE task end to end, alone,
then reply and stop.

## Ground rules
- **Model and reasoning (ADR-265):** GPT-6.1 Sol (`gpt-6.1-sol`, pinned in `config.toml`) for everything;
  GPT-6 Luna at High is allowed only for purely mechanical edits. High for the coordinator, all plans, all reviews
  and core builds; Medium for standard builds; Max only for the riskiest reviews. Every review, including a
  re-review, uses a fresh session or subagent, never the code author.
- Repo: this folder, branch `main` (already checked out). Never switch branches, never push (the coordinator
  pushes), never open PRs. Commit locally on main.
- Follow `CLAUDE.md` and its read order, but read only what your task needs. Standards: `docs/rules.md`,
  `docs/QUALITY_BASELINE.md`. Copy patterns from the nearest finished task (latest plans in `docs/plans/`,
  latest migrations in `apps/api/migrations/`).
- **No questions to Dhia.** Where the cto-cycle would interview him, take the option you would mark
  "Recommended", write it as a **Proposed** ADR in `docs/DECISIONS.md` (next free number) and an entry in
  `docs/OPEN_QUESTIONS.md` (next free Q number) so he can overturn it. If a task truly cannot proceed without
  him (accounts, money, legal, external services), skip it, write why in STATE.md "Waiting on Dhia", and stop.
- **Tier A tasks** (CLAUDE.md, "Three tiers": ledger, sign-in, tenant isolation, redemptions, admin powers, outside
  personal data): write the plan (`docs/plans/<date>-<task>.md`), commit it, then stop and reply so the coordinator
  can run the plan review. Tier B tasks: a short plan note, then build. Tier C: just do it.
- A task too big for one worker: split it in `docs/TASKS.md` (T-xxx, T-xxxb…) with a recorded reason.
- Test first where practical. Migrations: deny by default, outsider and cross-tenant suites updated
  (`apps/api/test/security/*`), DB tests for every refusal and race. Arabic and English for every string
  (`packages/shared/src/i18n/messages.ts`), RTL, Western digits.
- Functions ≤100 lines. Absolute imports. No commented-out code.
- **Deployed migrations are frozen.** Never edit a migration CranL has run (see STATE.md for the deployed
  number); write a new one. Only undeployed migrations may be edited in place.
- **Evidence images:** a screenshot folder under `docs/evidence/` holds only the few images that prove the change (about 10, each
  under 300 KB, cropped or scaled); a larger set stays out of git.
- **Release-safety:** never use JS built-ins missing in release Hermes (`toSorted`, `toReversed`,
  `Object.groupBy`, the new Set methods, `structuredClone`); `apps/app/src/hermes-runtime.test.ts` enforces it.

## Local checks (Docker is running)
- `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`
- `TEST_REDIS_URL=redis://127.0.0.1:56379`
- Lint, format, types: `npx oxfmt <paths>`, `npx oxlint --deny-warnings <dirs>`, `npx tsc --noEmit -p apps/<x>`.
- Tests: `npx vitest run <paths>` from the repo root. Run only the suites your change touches, plus
  `apps/api/test/security` when the schema changes. Browser tests (RUNBOOK, `pnpm --filter @questify/web e2e`):
  the full browser suite after a fresh web build for UI copy changes; otherwise only the specs you touched.
  `npx expo export` when app screens change.
- Before reporting a task done, run the full `npx vitest run` ONCE with both URLs set, into a log file, and read
  only the summary line: list-style guards (`test/db/rehearsal.int.test.ts`, the security suites, the community gate
  map) fail on any new table or function. Between edits run only the touched suites, types and lint; do not re-run
  the full suite after each small fix (CI is the full gate).
- A new owner-only event switch adds one "Only the owner can change this." note: update its count in
  `apps/web/e2e/organizers.spec.ts` and run that spec.
- **Never run Stryker or any mutation testing locally** (ADR-174: about 18 GB, can crash the PC). It runs on
  GitHub (`.github/workflows/mutation.yml`), started by the coordinator. In your reply list the mutation target
  globs: core code only, only files this task changed. When results come back, kill survivors only while a file
  is under 90%.
- Avoid heredocs with nested quotes in Bash (they break here); write scripts to files instead.

## Finishing
1. All checks green. Tick the task in `docs/TASKS.md` with a short "Done <date>" note; update the docs the task
   touches (API.md, DATA_MODEL.md, SRS amendments, notes on later tasks).
2. Add one dated bullet to `docs/_blueprint/STATE.md` (same style as the others) and fix its "Next" list.
3. Commit (imperative subject ≤72 chars, no AI attribution lines). Several commits are fine.
4. Reply to the coordinator in ≤15 lines: what shipped, tests run and results, ADRs/Qs added, mutation globs
   (tier A ledger and access code only), anything left. You are usually not resumed after a review; if you are, fix
   the BLOCKER/MAJOR findings only and commit. MINOR and NIT findings are not yours to fix: the coordinator lists
   them in `docs/FOLLOWUPS.md`.
5. Do not split the task into slices on your own unless each slice delivers value alone; say so in the reply.
