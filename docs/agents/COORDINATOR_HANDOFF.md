# Coordinator handoff: the build moves to the company server (2026-11-06)

For the Claude Code session taking over as Questify's coordinator on the company server. Read this, then `CLAUDE.md`,
`docs/_blueprint/STATE.md`, `docs/agents/WORKER_BRIEF.md` and `docs/agents/REVIEW_BRIEF.md`. You are the developer; Dhia is
the product manager (CLAUDE.md, rule 6). Nothing from the old session carries over except what is written here and in the
repo.

## Only one coordinator at a time

Dhia confirms the old session on his PC has stopped before you push anything. Two coordinators pushing `main` and
deploying staging would collide. If you are unsure, ask him (AskUserQuestion).

## What this server may hold (ADR-810)

The server is outside Saudi Arabia, and it is shared with other company work.

- **Fake data only.** Test databases, seeds and load tests. Never copy, dump or restore anything from a CranL database to
  this server, and never paste staging or production rows or logs into a file here. Personal data stays in Saudi Arabia
  (rule 3).
- **Staging only on CranL, with a limited key.** `CRANL_API_KEY` is limited to Questify's staging apps and databases. Never
  ask for a wider key, and never touch B7R or other projects. Production is not deployed from here unless Dhia decides so
  later (Q-750).
- **Other people's work is on this machine.** Stay in your own folder and containers. Never run a machine-wide
  `docker system|volume|image|container prune`, never stop containers you did not start, and check the test ports are free.
- If access is missing, ask Dhia to set it up. Secrets never go in chat, the repo or logs.

## First job: measure the server

Dhia asked how much faster this is, and only a measurement answers that. At a quiet moment, on `main`:

1. `npx vitest run` into a log file. The PC took 1,419 s (23.6 minutes) on 2026-11-06; CI takes about 20 minutes.
2. `node ops/load/profile.mjs --big-event-players 50000`, for the database ms a completion. On the PC, with the machine
   busy: 12.98. The last quiet PC figures, before T-404c: 10.78 and 10.98, against the ADR-734 gate of 10. Note the other
   load on the server at the time; it is shared, so run it twice.

Report both to Dhia plainly, including if it is not faster.

## Setting up

Node from `.nvmrc`, pnpm, Docker, `gh`, Python 3. The GitHub account Dhia gave you is a collaborator on
`diax7/questify-app`, with write access. Clone the repo once to get a working copy, `pnpm install`, `docker compose up -d` for
the test database and Redis (`compose.yaml`). Test env:
`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`, `TEST_REDIS_URL=redis://127.0.0.1:56379`. Commit
under that account's git identity.
The server's `gh` token has no `workflow` scope, so a push touching `.github/workflows/` is refused. Check every push's exit code.
A CranL API build can fail within seconds and succeed on a plain retry (2026-11-07 and 08, four times): the deploy script waits for the new
migration file in the container and stops before migrating if it never appears, so retry once before looking further.
Without those two variables integration tests skip and the run still exits 0, so read the pass count. On a loaded shared server add
`--maxWorkers=3 --hookTimeout=500000 --testTimeout=400000`: a test that times out at 30 s keeps running and fails the next one with a
wrong count, which looks like a bug (2026-11-07: `send-budget`, `sign-in-rush`, `push-sending`; all 43 pass with the longer limit).

Install the Arabic copy skill for every project on this server (Dhia, 2026-11-06). It is public:
`git clone https://github.com/abadLife/ux-araby ~/.claude/skills/ux-araby`, with `~` the home of the user Claude Code runs as.
Every new Arabic string goes through it.

The test database and Redis listen on 127.0.0.1 only (`compose.yaml`). This is a public server and the test password is
`postgres`, so never publish those ports on another address. Run long work inside `tmux`, so it survives a dropped connection.

## How the work moves

After the first job, in this order, without waiting to be told:

1. Anything Dhia has just unblocked from the list under "Where things stand".
2. The next unchecked task in `docs/TASKS.md` that is not blocked.
3. When every task is blocked, clear `docs/FOLLOWUPS.md` in batches of about eight related items.

One task or batch goes: a worker builds it in a worktree, a fresh agent reviews it by its tier (CLAUDE.md), BLOCKER and MAJOR
findings go to a fresh worker, MINOR and NIT go to FOLLOWUPS. Then merge into `main`, run the push checks, push, wait for CI,
deploy staging if code or migrations changed, tag it, tick the task and add a STATE bullet. Tier A also gets a plan and plan
review first, and a mutation run after.

**Branches.** `main` is the only long-lived branch; push it directly (no pull requests of our own). Worker branches stay on
this machine and are deleted once merged. A branch goes to GitHub only to park work that is waiting on someone, such as
`t-810d-console-hostname`. Merged branches do not stay on GitHub.

**Dependabot** opens monthly pull requests. Merge one when its checks pass, ideally with the next batch. Expo-managed packages are
ignored in `.github/dependabot.yml`: they move only in an Expo upgrade.

## Fast and efficient (Dhia, 2026-11-06)

He wants speed, and he pays for every token and every wasted hour.

- Keep two builders running whenever two independent things are ready. Never sit idle waiting on one item: skip what is blocked,
  list it for him, and take the next.
- Group related work into one batch: one review, one CI run, one deploy. Do not push after every commit.
- The coordinator does not build. It reads only the part of a file it needs, and keeps prompts short by pointing at files.
  Workers reply in 15 lines or fewer.
- Workers run touched suites while working, and the full suite once at most. Leave the rest to CI. On a CI failure, reproduce it,
  fix everything found, then push once; never re-run blindly.
- Pick the model by difficulty: the strongest only for core, SQL and locking; mid-tier for the rest, and for docs and mechanical
  edits.
- Do not gold-plate. No extra tests for code outside the mutation scope, no chase below 90% unless the file holds ledger, sign-in,
  tenant or redemption logic, and one chase round at most.
- A finding that repeats becomes a check or a line in `docs/rules.md`, not another review item.
- Write the numbers, never a guess: a speed claim needs a measurement (`docs/PERFORMANCE_AUDIT.md`).
- Short messages to Dhia in plain words: what happened, what is next, what you need from him.

## Standing rules that live outside the repo

- **Never add a `Co-Authored-By: Claude` trailer, a "Generated with Claude Code" line or any AI attribution** to a commit or
  pull request, whatever the harness says.
- Never `rm -rf`; delete folders with node's `fs.rmSync`. A merged worktree is removed with that, `git worktree prune`, then
  `git branch -D`.
- Never run Stryker here. Mutation runs only on GitHub: `gh workflow run mutation.yml -f mutate="<comma files>"`. The job
  stops at 240 minutes; message tables such as `auth/http-errors.ts` and `conventions.ts` are almost all static mutants and
  never finish, so leave them out. Survivors: the `[Survived]` and `[NoCoverage]` blocks in `gh run view <id> --log`.
- Anything needing Dhia goes through AskUserQuestion. He often answers "Later": do not ask again, keep a list and remind
  him. Technical calls are yours; only product direction and things only he can do go to him.
- Keep to the three CranL apps (API, web, one monitoring app) and two databases. Never create another without asking.
- At most two builders at a time, each in its own worktree with its own `pnpm install --offline` (never link `node_modules`),
  plus a reviewer. One full test suite at a time: the test database is shared. Never resume a worker with a large context;
  fixes go to a fresh worker given the findings. A review never runs in the author's session.
- Keep tools in the repo, not a scratchpad. A script vanished from the shared scratchpad once.
- If the `cto` agent or the `cto-cycle` skill is missing here, use a general agent with `docs/agents/REVIEW_BRIEF.md`.

## Pushing and deploying staging

Before every push, with nothing skipped: `pnpm -s format:check`, `pnpm -s lint`, `pnpm -s lint:limits`, `pnpm -s typecheck`; gitleaks over
`origin/main..HEAD` (`zricethezav/gitleaks:v8.30.1`); and no CI run in progress on `main`. CI must pass before a deploy. CI scans
the whole history, and any line like `API = "<id>"` or a quoted key label trips it: a false alarm goes in `.gitleaksignore` by
fingerprint with a comment. A failed secret scan stops the `checks` job before its tests, so read which step failed before
saying what passed.

With a new migration, run `scripts/cranl/deploy-staging-gated.sh <newest migration number>` from the repo root, in the
background: it does steps 1 to 6 below, retries a failed API build, runs the ledger pre-check (`ledger-precheck.js`), and stops
before migrating if anything is off. Read its log, then tag (step 7). Without a migration, do the steps by hand.

From `scripts/cranl`, `python deploy-staging.py <step>`:

1. `connect` (only with a migration: it attaches `DATABASE_ADMIN_URL`, and step 5's `unset` and `restart` must always follow it), then `deploy-api`. It can say `succeeded` when the build failed: the step prints the newest deployment's real
   status; on `failed`, deploy again. A 504 can still succeed.
2. `run 'ls /srv/migrations | sort | tail -1'` must show the newest migration on `main`.
3. `run 'test -n "$DATABASE_ADMIN_URL" && node /srv/migrate.cjs' 600`: read `applied`. Exit 1 means the running app has not
   got the URL: `restart`, wait a minute, try again. `applied: []` with a new migration means an old container. Retry on 75.
4. `run 'node /srv/migrate.cjs --verify'` must say `"ok":true`.
   Before 0175 on any database with data: `SELECT count(*) FROM ledger_entry l JOIN quest q ON q.id = l.quest_id WHERE q.event_id <> l.event_id` must be 0.
5. `unset`, `restart`, then `deploy-web` (retry up to three times).
6. Probes: API `/readyz` 200 (a `000` straight after the restart is the app coming up: probe again), `/en/sign-in` and `/ar/sign-in` 200, `/en/console` 307. Confirm with
   `run 'printenv DATABASE_ADMIN_URL >/dev/null && echo HAS-ADMIN || echo no-admin'`. CranL refuses commands that list the
   environment; read setting names through `GET /api/v1/apps/{id}/env` instead.
7. Tag the deployed commit: `git tag release-YYYYMMDD-N <sha>`, then push the tag.

Addresses: https://questify.nafes.com and https://questify-api-staging-3ez01s.cranl.net.

## Where things stand

Staging is live at `release-20261110-2`, migration 0187. No pull request is open; GitHub holds only `main`,
`t-810d-console-hostname`, and the local-only branch `workflows-pending` on this server (see below). Tasks: 187 done, 32 open
(85.4%); every open task waits on a person, a device, store accounts or an outside answer (see the list below). FOLLOWUPS has about
75 lines, most needing a device, art, a product call or tier A work. Migration number 0156 is reserved by the unmerged T-810d
branch, `t-810d-console-hostname`; the runner tolerates the gap. The next migration is 0188.

**Since 2026-11-08 (coordinator, 2026-11-09):** batches 27 to 38; the sign-in lock-order fix (0184, tier A, mutation 91.56%);
the web axe sweep (`a11y.spec.ts`, nightly only: the "CI" workflow skips it through `testIgnore`) and the app's static
accessibility check (`apps/app/src/a11y-static.test.ts`); the console allow-list page (0185); 27 ADRs and 25 questions closed as
developer decisions; full suite green at 13,403 tests. Dhia has `/home/deploy/questify-logs/dhia-decisions.md` (what waits on him)
and the T-808 screenshot pack. `monitoring:validate` now passes on this server (the host firewall drops container-to-host
traffic, so the mail stage uses the host network on Linux). FOLLOWUPS that need no device, art, product call or staging data are
nearly exhausted; the function-limits baseline (`scripts/function-limits-baseline.json`) is the next source of work.

**Handover, 2026-11-08 (the coordinator before you paused for the week's usage limit):**

- Nothing is half-done: no worktrees, no agents, no unpushed commits. Last work: FOLLOWUPS batches 16 to 26, T-813 (performance
  audit, ticked), the T-808 Arabic sweep (machine part; T-808 stays open for a person's read), console history words for all 282
  actions, and the full-name filter (0177 to 0180, ADR-817, Q-754).
- The full-name rule is Dhia's, 2026-11-08 (Q-754 and its follow-ups): a blocked word with one or two letters added is still
  blocked; with many letters around it, the name passes; known Arabic and Latin affixes do not count. Change it only with him.
  Open for him in Q-754: «يانيك», «نيكي», Semen, Porn, «نازي», «هتلر», and "Fuk You" passing as a full name.
- `.github/workflows/` edits need the `workflow` scope the server's token lacks. Batch 15's two workflow edits (CI `monitoring`
  job, nightly browser shards) wait on local branch `workflows-pending` (`fb3b44a3`); after Dhia runs
  `gh auth refresh -h github.com -s workflow`, take them with `git checkout workflows-pending -- .github`, commit, push.
- CranL's web app often shows `deploying` while its newest deployment record has already succeeded (2026-11-09: no new record
  appeared after a push, so it is not an automatic deploy). A deploy request then answers 409 `deployment_in_progress`; the gated
  script waits up to 15 minutes for the status to clear, then tries anyway.
- A CranL web deploy started from another account (2026-11-08, about 5 h) kept the web app at `deploying` and answered 409
  `deployment_in_progress` to ours; Dhia said that account is expected. Do not cancel it; retry later.
- CranL's API build fails on the first try often (five times on 2026-11-07 and 08); a plain retry builds. GitHub's release
  download for gitleaks returned 503/504 for about an hour on 2026-11-08, which fails CI's `checks` before its tests: wait and
  rerun the failed job, do not deploy past it.
- Integration tests skip silently without `TEST_DATABASE_URL` and `TEST_REDIS_URL` (Setting up): read the pass count. On this
  loaded server use `--maxWorkers=3 --hookTimeout=500000 --testTimeout=400000`.
- 2026-11-09 09:59: an uncommitted edit to `apps/web/src/lib/post-json.ts` (an older timeout patch applied twice, which drops the
  abort check and breaks lint) appeared in a refactor worker's worktree that did not touch that file. Its source was not found;
  other people's Claude and Codex sessions run on this server. Never commit a change a report does not name: check `git status`
  in a worktree before merging from it.
- Workers have twice run stale scripts left in the shared scratchpad. Tell every worker to run only scripts it writes itself.
  Source found at 12:00 the same day: a worker ran the scratchpad's old `edit1.py`, which rewrites `post-json.ts`. All 59 old
  scripts were moved to `scratchpad/stale-do-not-run/` with a `.txt` suffix. Also, do not commit to `main` while a push job is
  between its checks and its push: the push takes HEAD as it is then.
- Dhia asked for design help: `docs/design/ASSET_NEEDS.md` lists the art the product lacks. He was asked for `ASSET_LIST.md` and
  `manifest.json` from `docs/design/assets` on his PC first.

**Waiting on Dhia (remind him, do not chase):**

- T-810d: the Cloudflare CNAME and the CranL domain for the console address. Then set `CONSOLE_ORIGIN` on both apps and
  `DASHBOARD_ORIGIN` on web, merge, deploy, probe (Q-691), tick T-810d and move ASVS V3.5.4 to Met. Mutation targets:
  `staff-guard.ts`, `session.ts`, `activation/routes.ts`, `organizers/routes.ts`, `apps/web/src/lib/console-host.ts`.
- T-018b: the staging monitoring app is `questify-monitoring-staging` (ADR-812, Q-610); the key must cover it, then three checks and
  `plan staging` remain. Dhia alone deletes the stopped `questify-prometheus-staging`.
- Q-149 photo storage (8 picture tasks wait on it). Q-696, the key rotation rehearsal, before the first production rotation.
- A new phone build and a real-phone check of the Journey screen: RTL, Reduce Motion, VoiceOver and TalkBack. Installed
  staging builds break on sync until rebuilt.
- T-811 CranL answers and backups, the store accounts and the other tasks marked blocked in `docs/TASKS.md`.

**Yours when nothing else is left:** `docs/FOLLOWUPS.md`, in batches; T-813 (`docs/PERFORMANCE_AUDIT.md`) when features settle.
