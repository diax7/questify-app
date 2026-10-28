# Coordinator handoff — 2026-10-28 (lean rules adopted, ADR-355)

Repo: `C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App`, branch `main`. The older chat cwd
`.../Github coding/Questify` is a different repository.

Read first: `CLAUDE.md` (coordinator mode: the **three tiers**, one review per task, rule 6: Dhia is the product
manager and the coordinator is the developer who decides technical calls; the cost cap: one sub-agent at a time),
then STATE.md "Next", `docs/agents/WORKER_BRIEF.md` and `docs/agents/REVIEW_BRIEF.md`.

## Checkpoint

- Progress **105/177 tasks (about 59%)**. Done, reviewed and pushed since the 2026-10-27 handoff: T-408c, T-406d,
  T-409, T-409b, T-410, T-410b, T-411, T-501, T-501b, T-501c, T-501d.
- **T-501e** (event pushes, migration 0078) is built, reviewed (re-review 91) and its minors folded; it was committed
  locally but may not be pushed yet. Check `git log origin/main..main` first, then run the push checks below.
- No worker is running and no mutation run is active. The last mutation runs (40628312029, 40641367106) left only push
  files `doors.ts` (60.5%) and `round.ts` (80.6%) under 90%; under ADR-355 push code is outside the mutation scope, so
  they are recorded in `docs/FOLLOWUPS.md` and not chased.
- Migrations 0057 to 0078 are undeployed (CranL is at 0056) and may still be edited. Deploying needs a new app build
  first (RUNBOOK has the release step). The app now also needs a new development build for the native modules
  `expo-notifications`, `expo-application`, `react-native-view-shot` and `expo-sharing`.
- Process changed on 2026-10-28 (ADR-355, Dhia chose "lean rules now"): see below.

## Lean rules in one screen

- **Tier A** (ledger, sign-in, tenant isolation, redemptions and prize handover, admin powers, wallet signing, signed
  proofs, code that stores or sends personal data outside): plan, plan review, build, ONE code review, mutation.
  Strongest model. **Tier B** (everything else with logic): mid-tier build and one mid-tier review; no plan review, no
  mutation. **Tier C** (docs, copy, config, small fixes): no review.
- Fix BLOCKER and MAJOR now. MINOR and NIT go to `docs/FOLLOWUPS.md`; a cheap Sonnet batch clears it about every five
  tasks. Re-review only after a BLOCKER, only the changed part.
- Never resume a worker with a large context (about 200k tokens or more). Fixes after a review go to a fresh Sonnet
  worker given the findings and files, or the coordinator makes the one- or two-line fix.
- Mutation: one run per three tier A tasks, ledger, sign-in, tenant isolation and redemption code only, one chase
  round at most.
- Full test suite once per task. Short prompts: point at the briefs, do not restate them. Put CI minutes and a rough
  token figure in each task's STATE bullet. Do not split a task into slices unless each delivers value alone.

## What to do next

1. Push T-501e if it is still local (checks below). Nothing else of it is owed.
2. **T-501f** (reminders and promotion by push: streak reminder, shop closing, push as an invitation channel, daily
   reminder): tier A (promotional sends and consent). Then **T-501g** (hidden-category hint push, Could, tier B).
3. Then T-502 (announcements) and onward in `docs/TASKS.md` order. T-221 (check the seat limit once per statement so
   the accept-all cap can go) is a tier A follow-up: schedule it when the join area is next touched.
4. **T-408d** (Redis copy of the boards) waits for the RUNBOOK ranked-count check to pass about 30,000.
5. Open suggestion for Dhia (he has not chosen it): pause new feature slices and prepare a "first real run": CranL
   deploy, one EAS development build, the push keys and his phone checks. Everything built so far is only verified on a
   laptop; the timing gates (1 s a call, 30 s for 50,000 members) must be re-measured on CranL (RUNBOOK).

## Commands

- **Push:**
  - Check `git log origin/main..main` and `git status`; push only commits that are reviewed. If a worker's unreviewed
    commits are stacked above reviewed ones, push the reviewed one by hash (`git push origin <hash>:main`).
  - Run `pnpm format:check` (it covers the Markdown docs and `CLAUDE.md`: a docs-only edit turned CI red on
    2026-10-28 because only `lint:limits`, audit and gitleaks had been run), `pnpm lint:limits`, plain `pnpm audit` (CI fails on any severity, not only moderate; an unpatched advisory in
    Expo's build tooling goes into `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml` with a note), and gitleaks in
    Docker: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo
    zricethezav/gitleaks:v8.30.1 git --redact --no-banner --log-opts="origin/main..HEAD" .`
  - Push only when no CI run is active: a push cancels the run in progress and a cancelled run still bills.
- **Mutation:**
  - Dispatch with `gh workflow run mutation.yml --ref main -f mutate="<globs>"` (add `-f force=true` after a chase that
    only added tests). A new dispatch cancels the running one.
  - Read the result with `gh run view <id> --log | sed -E 's/^[^\t]*\t[^\t]*\t[0-9TZ:.-]+ ?//'`. Only files named in
    the "Found N of M" line are new; the score table also lists stale files from earlier incremental reports.

## Waiting on Dhia or counsel (nothing blocks the build)

- **Counsel:** Q-280 (sponsor disclosure wording), Q-286 (marketing consent age), Q-288 (consent wording), Q-289 (proof of
  consent after deletion), Q-095 (player consent).
- **Only Dhia can do:**
  - Phone checks, owed for T-403c, T-406b, T-407b, T-408b, T-409b, T-410b and T-501c (RUNBOOK lists them).
  - Deployment and the CranL migrations after 0056, and the EAS builds (a new development build is needed).
  - Store accounts (T-010) and the storage bucket (Q-149).
  - The APNs key (Team Scoped, All Topics), the Firebase project, Android's `google-services.json` and a notification icon;
    real pushes cannot be tested without them (RUNBOOK go-live checklist, a gate in T-806).
  - The registered "-AD" promotional SMS sender (Q-034) before invitations can be switched on.

## Lessons

- Every worker brief ends with "run `pnpm lint:limits`". Workers skip it otherwise.
- CI's `pnpm audit` has no level flag: a new low advisory fails the audit step while a local `--audit-level moderate`
  passes. Run the plain command.
- When a log is checked for leaked digit runs, drop numeric fields first; a short digit string in a regex also matches
  random UUIDs (a test asserting `not.toMatch(/…50/)` failed one run in five).
- When a review asks for a fix to one copy of a pattern, check for other copies.
- Waking a long idle session or resuming a worker with a large context re-reads all of it. A fresh session that reads
  this file is cheaper. This is the biggest avoidable cost of the 2026-10-27/28 session.
- Postgres 17 re-plans a SQL function (and any nested ones) at every call: shared visibility checks that run per member
  must be PL/pgSQL (`docs/rules.md`). The 5 s statement limit and the pool's 6 s client timeout both apply to long fills.
