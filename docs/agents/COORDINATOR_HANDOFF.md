# Coordinator handoff — 2026-10-27 (just before midnight)

Repo: `C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App`, branch `main`. The older chat cwd
`.../Github coding/Questify` is a different repository.

Read first: `CLAUDE.md` (it holds the **cost cap**: one sub-agent at a time, two only for a reviewer plus the next
build; strongest model only for core work), then STATE.md "Next" and `docs/agents/WORKER_BRIEF.md`.
The Sol policy (ADR-265) cannot run in Claude Code: reviews since 2026-10-26 ran on Claude Opus (core) or Sonnet
(standard). STATE.md flags this; Dhia has not objected.

## Checkpoint

- Progress **79/155 tasks (50.97%)**: T-402, T-402b, T-403, T-403b and T-403c are done, reviewed (GO 93, 94, 92) and
  pushed. Remote `main` is `9345a17`. The only open PR (Dependabot zod bump #3, stale, `main` already had zod 4.6.7)
  was closed by Dhia. No open PRs.
- Last full local suite (T-403b): 5892 passed / 4 skipped / 0 failed. CI on `e150f5a` was green (the earlier red CI on
  `569190d` was a test fixture, fixed). Migrations 0063-0066 are undeployed (CranL is at 0056) and may still be edited.
- **CI run 40398827005** (on `9345a17`, the mutation-chase tests) was still running when this was written.
- Mutation results so far (GitHub run 40386286433, commit `7a0faa8`): souvenir files 96.9-98.7, players
  items/item-routes 100, `questify/admin.ts` 100, `questify/routes.ts` 91.8: all pass. Under 90 then: `questify.ts`
  67.7, `admin-routes.ts` 88.6, shared `questify/{quests,events,achievements}.ts` 0 / 29.6 / 27.3, shared
  `players/items.ts` 23.6, shared `souvenirs.ts` 81.1. Commit `9345a17` adds 163 tests for them (verified tests-only).
  For the two older shared files the survivors are probably Stryker incremental-report leftovers (9 of 10 sampled
  survivors were killed by the existing tests, the tenth is equivalent); a forced run decides.
- **A forced mutation run should now exist or be about to start.** A background script of the previous session waits
  for CI 40398827005 and, only if it is green, dispatches `mutation.yml` with `force=true` for
  `packages/shared/src/players/items.ts`, `packages/shared/src/souvenirs.ts`, `packages/shared/src/questify/*.ts`,
  `apps/api/src/questify/**/*.ts` (tests excluded). Check `gh run list --workflow mutation.yml --limit 3`: the newest
  `workflow_dispatch` run started after 2026-10-26 20:50 UTC is it (about 40 to 60 minutes). If none exists and CI is
  green, dispatch it yourself with the same inputs. If CI is red: reproduce locally, fix, one re-run.

## What to do next (Dhia chose: chase mutants, then pause)

1. Wait for the forced run to finish (`gh run view <id> --json status,conclusion`; never dispatch another mutation run
   while one is active, a new dispatch cancels it).
2. `gh run view <id> --log > <temp file>`; strip the log prefix with
   `sed -E 's/^[^\t]*\t[^\t]*\t[0-9TZ:.-]+ ?//'`. The table lists stale rows of earlier runs too; only files named
   in the "Found N of M file(s) to be mutated" line are new. Survivors are `path:line:col` entries with `-` original
   and `+` mutant lines. Chase only files under 90% with one Sonnet worker, tests only, no production change, no
   local Stryker. If shared schema files still survive although unit tests kill them by hand, tests cannot fix it:
   propose `ignoreStatic` for those files in `stryker.config.json` and ASK Dhia (it is a config change).
3. Record the final scores in STATE.md (one bullet), refresh this file, then push once. Before any push:
   `git log origin/main..main`, gitleaks in Docker
   (`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo zricethezav/gitleaks:v8.30.1 git --redact
   --no-banner --log-opts="<last pushed>..HEAD" .`). A docs-only push starts a full CI run and cancels one in flight,
   so push only when no CI run is active. Read the CI result with `gh run view <id> --json conclusion` (a
   `gh run watch` exit code can hide a red run).
4. Stop and report. T-404 (gems and the Questify shop, core) is next but **not started**: plan, plan review, build and
   code review, about 8 runs. Ask Dhia before starting it.

## Waiting on Dhia

- Q-247 items 2 and 3 (public badge names need an API change; history shows no points), Q-248 (confirm before
  publishing a campaign), Q-246, and the Proposed ADR-272 to ADR-281.
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
