# Coordinator handoff — 2026-10-27 (paused for compaction and a model switch)

Repo: `C:/Users/xdhia/Downloads/Github coding/NAFES/Questify App`, branch `main`. The older chat cwd
`.../Github coding/Questify` is a different repository.

Read first: `CLAUDE.md` (coordinator mode, rule 6: Dhia is the product manager, the coordinator is the developer and
decides technical calls; the **cost cap**: one sub-agent at a time, two only for a reviewer plus the next build;
strongest model only for core builds and reviews), then STATE.md "Next" and `docs/agents/WORKER_BRIEF.md`.

## Checkpoint

- Progress **92/167 tasks (55.1%)**. Since the last handoff, these were done, reviewed and pushed:
  T-404, T-404b, T-405, T-405b, T-023, T-406, T-406b, T-406c, T-407, T-407b, T-407c, T-408 and T-408b.
- No worker is running, and no mutation run is active. The push of this file starts the only CI run.
- Every core mutation score is at 90 or above. The latest runs:
  - T-406 forced run 40487686895
  - T-407c run 40491590598
  - T-408 run 40499485325
- Migrations 0057 to 0072 are undeployed (CranL is at 0056) and may still be edited.
- Deploying 0071 needs a new app build first. RUNBOOK has the release step.

## What to do next

1. **T-408c**, the console's Seasons page (standard): a Sonnet worker, then one Sonnet code review.
2. **T-408d**, a Redis copy of the boards. Start it when the RUNBOOK ranked-count check passes about 30,000.
3. **T-406d**, sourcing the word lists. Q-281 is answered: open lists licensed for commercial use, plus the team's
   picks.
4. Then **T-409**, and onward in `docs/TASKS.md` order.

The loop per task:
1. A fresh worker.
2. A core task gets a plan, a plan review, the build, then a code review. Any other task gets one code review.
3. Minor findings are folded into the same worker with no re-review. After a BLOCKER, re-review.
4. Accept the ADRs and answer the questions as `(developer, delegated by Dhia, <date>)`.
5. Push.
6. Core tasks only: dispatch `mutation.yml` on the task's globs.

## Commands

- **Mutation:**
  - Dispatch with `gh workflow run mutation.yml --ref main -f mutate="<globs>"`.
  - Read the result with `gh run view <id> --log | sed -E 's/^[^\t]*\t[^\t]*\t[0-9TZ:.-]+ ?//'`.
  - Only files named in the "Found N of M" line are new.
  - After a survivor chase that only added tests, re-run with `-f force=true`. The incremental report keeps stale
    survivors for schema code.
- **Push:**
  - Check `git log origin/main..main`.
  - Run gitleaks in Docker: `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" -w /repo
    zricethezav/gitleaks:v8.30.1 git --redact --no-banner --log-opts="origin/main..HEAD" .`
  - Push only when no CI run is active.
- **Before every push, run `pnpm lint:limits` yourself.** Workers forgot it twice and CI would have gone red.

## Waiting on Dhia or counsel (nothing blocks the build)

- **Counsel:**
  - Q-280: the sponsor disclosure wording.
  - Q-286: the marketing consent age.
  - Q-288: the consent wording.
  - Q-289: proof of consent after deletion.
  - Q-095: player consent.
- **Things only Dhia can do:**
  - Phone checks, owed for T-403c, T-406b, T-407b and T-408b.
  - Deployment and the CranL migrations after 0056.
  - EAS builds.
  - Store accounts (T-010).
  - The storage bucket (Q-149).

## Lessons

- Every worker brief should end with "run `pnpm lint:limits`". It is in `ci:changed`, and workers skip it.
- When a log is checked for leaked digit runs, numeric fields must be dropped first. A `responseTime` float once
  matched a phone number's digits (fixed in `555559c`).
- When a review asks for a fix to one copy of a pattern, check for other copies. The idempotency key reset was needed in
  `ConsoleQuestify` too.
- Waking a long idle session after the 1-hour cache window re-reads its whole context. A fresh session that reads this
  file is cheaper than resuming an old one.
