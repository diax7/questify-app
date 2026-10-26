# Coordinator handoff — 2026-10-26 (late evening)

Repo: `C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App`, branch `main`. The older chat cwd
`.../Github coding/Questify` is a different repository.

Read first: `CLAUDE.md` (it holds the **cost cap**: one sub-agent at a time, two only for a reviewer plus the next
build; strongest model only for core work), then STATE.md "Next" and `docs/agents/WORKER_BRIEF.md`.
The Sol policy (ADR-265) cannot run in Claude Code: reviews since 2026-10-26 ran on Claude Opus (core) or Sonnet
(standard). STATE.md flags this; Dhia has not objected.

## Checkpoint

- Progress **79/155 tasks (50.97%)**: T-402, T-402b, T-403, T-403b and T-403c are done, reviewed (GO 93, 94, 92) and
  pushed. Remote `main` is `e150f5a`; this handoff commit is local only and rides with the next push.
- Full DB/Redis last run (T-403b, local): 5892 passed / 4 skipped / 0 failed. Migrations 0063-0066 are undeployed
  (CranL is at 0056) and may still be edited in place until deployed.
- CI on `569190d` failed (3 route tests used a profile fixture without the newly required `achievements`/`passport`);
  fixed in `e150f5a`. **CI run 40393715601** on `e150f5a` must be `success`; check with
  `gh run view 40393715601 --json conclusion`. If red: reproduce locally, fix everything found, one re-run.
- **Mutation run 40386286433** (GitHub, started 2026-10-26 19:23 UTC on `7a0faa8`, about 1.5 to 3 hours) mutates
  `apps/api/src/souvenirs/*.ts`, `apps/api/src/players/{items,item-routes}.ts`, `packages/shared/src/souvenirs.ts`,
  `packages/shared/src/players/items.ts`, `apps/api/src/questify/**/*.ts`, `packages/shared/src/questify/*.ts`
  (tests excluded). The last run (40358820903) left six files under 90 and the chase tests in `7a0faa8` target them.

## What to do next (Dhia chose: chase mutants, then pause)

1. Confirm CI 40393715601 is green and the mutation run has finished (`gh run view 40386286433`). Do not dispatch
   another mutation run while it is active (a new dispatch cancels it).
2. `gh run view 40386286433 --log > <temp file>`. The per-file table lists stale rows of earlier runs too; only
   files named in the "Found N of M file(s) to be mutated" line are new. Survivors are listed as `path:line:col`
   with `-` original and `+` mutant lines. Chase only files under 90%: one Sonnet worker, tests only, no production
   change, no local Stryker. Then one more dispatch only if needed.
3. Before any push: `git log origin/main..main`, gitleaks in Docker
   (`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo zricethezav/gitleaks:v8.30.1 git --redact
   --no-banner --log-opts="<last pushed>..HEAD" .`), then push once and read the CI conclusion with
   `gh run view <id> --json conclusion` (a `gh run watch` wrapper's own exit code can hide a red run).
4. Stop and report. T-404 (gems and the Questify shop, core) is next but **not started**: it needs plan, plan
   review, build and code review, about 8 runs. Ask Dhia before starting it.

## Waiting on Dhia

- Q-247 items 2 and 3 (public badge names need an API change; history shows no points), Q-248 (confirm before
  publishing a campaign), Q-246, ADR-272/273-281 are Proposed.
- Proposal: add `apps/api/src/souvenirs/**`, `apps/api/src/questify/**`, `packages/shared/src/souvenirs.ts` and
  `packages/shared/src/questify/**` to the default `mutate` list in `stryker.config.json` (needs his OK).
- Physical-phone checks (release Hermes, RTL, Reduce Motion, toasts, level-up card, badges at 64 pt), deployment,
  CranL migrations after 0056 and EAS builds remain deferred.

## Lessons from this session

- After a shared-schema change, workers must also run the unit tests of every package that imports it
  (`npx vitest run apps/api/src/<area>`), not only the integration suites.
- Workers must run the full suite once into a log file and read the summary; three overlapping runs wasted CPU.
- Waking a long idle session after the 1-hour cache window re-reads its whole context; a fresh session that reads this
  file is cheaper than resuming an old one.
