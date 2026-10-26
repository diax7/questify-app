# Coordinator handoff — 2026-10-27

Repo: `C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App`, branch `main`. The older chat cwd
`.../Github coding/Questify` is a different repository.

Read first: `CLAUDE.md` (it holds the **cost cap**: one sub-agent at a time, two only for a reviewer plus the next
build; strongest model only for core work), then STATE.md "Next" and `docs/agents/WORKER_BRIEF.md`.
The Sol policy (ADR-265) cannot run in Claude Code: reviews since 2026-10-26 ran on Claude Opus (core) or Sonnet
(standard). STATE.md flags this; Dhia has not objected.

## Checkpoint

- Progress **79/155 tasks (50.97%)**: T-402, T-402b, T-403, T-403b and T-403c are done, reviewed (GO 93, 94, 92) and
  pushed. No open PRs. No mutation or CI run is active apart from the CI run started by the push of this file.
- Last full local suite (T-403b): 5892 passed / 4 skipped / 0 failed. CI on `9345a17` (run 40398827005) was green.
  Migrations 0063-0066 are undeployed (CranL is at 0056) and may still be edited.
- **The mutation chase is closed.** Forced run 40400940399 on `9345a17` retested all 9 files: API `questify/`
  admin-routes, admin, routes 100, questify.ts 98.53; shared `questify/*` 100, `players/items.ts` 94.55,
  `souvenirs.ts` 98.20. No file is under 90, so no `ignoreStatic` proposal is needed.

## What to do next

1. T-404 (gems and the Questify shop, core) is next but **not started**: plan, plan review, build and code review,
   about 8 runs. Ask Dhia before starting it.
2. Mutation reading, for later runs: `gh run view <id> --log`, strip the prefix with
   `sed -E 's/^[^\t]*\t[^\t]*\t[0-9TZ:.-]+ ?//'`; only files named in the "Found N of M file(s) to be mutated" line are
   new, the rest of the table is stale rows of earlier runs. Incremental runs can keep stale survivors for import-time
   schema code; a `force=true` dispatch settles it.
3. Before any push: `git log origin/main..main`, gitleaks in Docker
   (`MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo zricethezav/gitleaks:v8.30.1 git --redact
   --no-banner --log-opts="<last pushed>..HEAD" .`). Push only when no CI run is active; read results with
   `gh run view <id> --json conclusion`.

## Waiting on Dhia

- Q-247 items 2 and 3 (public badge names need an API change; history shows no points), Q-248 (confirm before
  publishing a campaign), Q-246, and the Proposed ADR-272 to ADR-281.
- Proposal: add `apps/api/src/souvenirs/**`, `apps/api/src/questify/**`, `packages/shared/src/souvenirs.ts` and
  `packages/shared/src/questify/**` to the default `mutate` list in `stryker.config.json` (needs his OK).
- Physical-phone checks (release Hermes, RTL, Reduce Motion, toasts, level-up card, badges at 64 pt), deployment,
  CranL migrations after 0056 and EAS builds remain deferred.

## Lessons

- After a shared-schema change, workers must also run the unit tests of every package that imports it
  (`npx vitest run apps/api/src/<area>`), not only the integration suites.
- Workers must run the full suite once into a log file and read the summary; three overlapping runs wasted CPU.
- Waking a long idle session after the 1-hour cache window re-reads its whole context; a fresh session that reads this
  file is cheaper than resuming an old one.
