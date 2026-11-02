# Coordinator handoff — 2026-10-29 (T-502 recovered and reviewed)

Repo: `C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App`, branch `main`. The older chat cwd
`.../Github coding/Questify` is a different repository.

Read first: `CLAUDE.md` (coordinator mode: the **three tiers**, one review per task, rule 6: Dhia is the product
manager and the coordinator is the developer who decides technical calls; the cost cap: one sub-agent at a time),
then STATE.md "Next", `docs/agents/WORKER_BRIEF.md` and `docs/agents/REVIEW_BRIEF.md`.

## Checkpoint

- Progress **108/177 tasks (about 61%)**. T-501e, T-501f and T-501g are reviewed and pushed through fe688dd;
  CI run 40682251115 passed. T-502 build 5dac217, fixes efad9cd and acceptance/handoff e28a1e4 are pushed.
  T-502 CI run 40828699004 PASSED on e28a1e4 at 2026-10-29 06:44 UTC (09:44 Riyadh), including the full tests,
  API/web builds, audit, secret scan and browser suite. ADR-358 Accepted / Q-327 resolved.
- Recovery: the previous coordinator and worker both hit their session limit on 2026-10-28 at 21:41 UTC. The worker
  left a partial uncommitted T-502, not a running build. A fresh worker completed it; one independent review scored 84
  NO-GO with two MAJORs. A fresh fix worker resolved both; coordinator inspection accepts the fixes under ADR-355
  (re-review only for BLOCKER). Event locks close the archive/send race; pending schedules have earliest-first keyset
  pages separate from bounded history. Modal-accessibility MINOR is recorded in FOLLOWUPS.
- Final local evidence: 703 targeted tests / 12 suites; fresh-build browser suite 199 passed / 1 existing skip.
  Original full Vitest ran once: 8759 passed / 13 skipped / 3 guards failed, all fixed with targeted proofs. API/web
  builds, workspace types, lint, limits, format pass; native Android/iOS exports pass. Expo web export remains blocked
  by pre-existing missing react-native-web. Remote CI passed; real-phone/provider checks remain release gates.
- No worker is running and no mutation run is active. The last mutation runs (40628312029, 40641367106) left only push
  files `doors.ts` (60.5%) and `round.ts` (80.6%) under 90%; under ADR-355 push code is outside the mutation scope, so
  they are recorded in `docs/FOLLOWUPS.md` and not chased.
- CranL runs migrations through 0083 (deployed 2026-10-30); 0001 to 0083 are frozen. Earlier note: deploying needed a new app build
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

Updated 2026-11-02 by the Claude Code coordinator at Dhia's break. Progress: 149 of 197 tasks (75.6%).

1. **Staging (CranL) runs migrations through 0117**, all frozen. `main` also has **0119** (T-709b catalog editors,
   pushed, CI green, NOT deployed) and branch `worktree-agent-a5a2d1538fa9b8395` has **0118** (T-704 player tools,
   unpushed). Deploy 0118 and 0119 together, in order, after T-704 merges (the migrator applies any missing file, so
   deploying 0119 first would run 0118 after it).
2. **First job: T-704 tier A code review** (Opus `cto`) of branch `worktree-agent-a5a2d1538fa9b8395` (worktree
   `.claude/worktrees/agent-a5a2d1538fa9b8395`), plan `docs/plans/2026-11-02-t-704-t-705-player-safety.md` (amended
   with the plan review 80 and Dhia's answers: merge dropped, appeals to the `MAIL_FROM` address, no ban email). Fix
   MAJORs with a fresh worker, merge into `main` (expect doc-file conflicts with T-709b), push, deploy 0118+0119.
3. **Then T-705** (ban, block, word lists) and **T-705b** (reports queue, unpublish, flags list) from the same plan;
   one grouped mutation run after T-705 for `apps/api/src/console/players/**` plus the T-705 globs (ADR-355).
4. **Mutation:** the T-701 chase round is done (5b43356, about 10 tests; scores re-measure in the next grouped run).
5. **Other open tasks:** T-709c (tier A: XP curve, level rewards, item editor, achievement thresholds that pay gems),
   T-701b (owner email change, urgent reports), T-703, T-706, T-707, then Phase 8. Photo uploads stay parked (Q-149,
   Dhia "later"); push stays off until Dhia makes a Firebase project.
6. **Process (Dhia approved 2026-11-02):** workers never run the full browser suite locally (layout.spec + their
   area's specs); CI runs it, sharded in two (~16 min). The coordinator makes fixes under ~20 lines itself; deploy
   every 2-3 tasks; parallel tier B pairs in worktrees only when they touch different files and don't run browser
   specs at the same time; worker caps ~400-500k (tier B), ~800-900k (tier A builds). Reviews always run.
7. **Deploy recipe:** connect the owner URL, deploy the API, loop `test -f /srv/migrations/<newest> && node
   /srv/migrate.cjs` until `alreadyApplied`, `--verify`, unset the owner URL, restart, deploy web, probe `/readyz` and
   both sign-in pages. On this PC the web build may need
   `NODE_OPTIONS=--require <scratchpad>/symlink-fallback.cjs` (Windows symlink EPERM).

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
