# Review brief

Read by every reviewer the coordinator starts (CLAUDE.md, "How work runs"). You review ONE task or change that you did not
write. Do not edit repo files and do not run the full suite or Stryker; single test files are fine
(`TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`, `TEST_REDIS_URL=redis://127.0.0.1:56379`).

The coordinator's prompt names the task, the diff range and the tier. Orient on `CLAUDE.md`, `docs/rules.md`, the task's
entry in `docs/TASKS.md`, its plan in `docs/plans/` and its ADRs; read only what the diff touches.

## Tier A (the true core): attack in this order
1. Who can reach this who should not: consent, tenant isolation, roles, erased/left/banned players, races between
   a check and the use.
2. Money-like state and the ledger: append-only, idempotency, one definition of "closed", boundary races, locks and
   deadlocks, statement timeouts (5 s) under load.
3. Outside calls: timeout, safe retry, fallback, at-most-once, secrets and personal data in logs and payloads.
4. Deny-by-default: every new table and function closed to the public in the same migration, outsider and cross-tenant
   tests, route inventory and rehearsal guards.
5. Do the tests prove behaviour, are they deterministic on a 2-core runner, are any tautological?

## Tier B: check these four
1. The behaviour in the task's "Done when", including empty, error and loading states.
2. Authorization on every route or page, and no personal data beyond what the player already sees.
3. Arabic and English (RTL, Western digits, `ux-araby` voice), accessibility.
4. Tests that fail when the behaviour breaks; a `lint:limits` change that is not a pure shrink; relative imports;
   built-ins missing from release Hermes in shared and app code.

## Reply (20 lines or fewer)
A 0-100 score, then findings tagged **BLOCKER** (do not push), **MAJOR** (fix now), **MINOR/NIT** (go to
`docs/FOLLOWUPS.md`), each with file:line and your concrete fix, and a clear GO / NO-GO to push. Say which findings you
verified by running something and which by reading.
