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

Updated 2026-10-31 by the Claude Code coordinator (sessions of 2026-10-30 and 2026-10-31).

1. **Staging (CranL) runs migrations through 0099**, all frozen; the next migration is 0100. Staging's
   `DASHBOARD_ORIGIN` is `https://questify.nafes.com`. Deploy: connect the owner URL, deploy the API, then run
   `test -f /srv/migrations/<new file> && node /srv/migrate.cjs` in a loop until it answers `alreadyApplied` (CranL's
   deploy call can answer 504 while the old image still runs), `--verify`, unset the owner URL, restart, deploy web.
2. **Queue:** T-605 (setup wizard) is being built. Then T-606 onward in TASKS order. Open tier A tasks: none queued;
   group the next tier A tasks two at a time (one plan, one plan review, one mutation run).
3. **Process that worked:** a fresh Sonnet worker per tier B task with a token cap (about 600k to 800k) and "one
   full suite, one targeted rerun"; a lean Sonnet review (cap 250k); Opus for tier A plans, plan reviews, builds and
   code reviews. Fix MAJORs with a fresh worker; minors to FOLLOWUPS. Workers must go easy on Dhia's PC (it crashed
   twice on 2026-10-30/31; browser suite on one worker, one heavy job at a time).
4. **Dhia owes:** a Firebase project for push (he chose "Later"), a phone run of the latest APK, a look on a real TV.
   The latest preview APK is EAS build f42d3f24 (Cheers buttons, ratings); T-602d's Home card needs a new build.
5. **FOLLOWUPS** has a batch due (T-505 to T-604b minors, the invitation-sending test that fails only in the full
   local run, the `X-App-Version` header the app never sends).
6. **T-408d** (Redis copy of the boards) still waits for the RUNBOOK ranked-count check to pass about 30,000.

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
