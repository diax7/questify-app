# Core function limits: 11 apps/api offenders in audit, sign-in, invites, SMS, devices (plan)

Tier A (sign-in, audit, tenant-facing code), the core sibling of the four tier B splits ("Split 11 apps/web…",
"Split 11 apps/app…", "Split 9 apps/api…", "Split 5 packages/shared…"). Same style: small named helpers next to the
function, pure helpers exported and unit-tested, a `refusalThrower` table (`apps/api/src/refusal-table.ts`) for a
result-to-error switch, then `node scripts/function-limits.mjs --update` (the baseline only shrinks). No SQL, migration,
error code, status, header, log event or log field changes. Measured today with `.oxlintrc.limits.json`.

**Rules for every split.** (1) Same database calls in the same order on every path, same transaction boundaries (no
helper opens or closes one, no `withConnection` moves). (2) Same checks in the same order, so the first refusal for any
input is unchanged. (3) `safeEqual`, lock (`tryLock`) and rate-limit (`countRecent`/`record`) calls are not touched or
moved. (4) Logs and errors keep exactly their current fields; no helper writes an email, phone, password, code, SMS text or
token hash into a log line or an error message. (5) Every `// Stryker disable` comment moves with its line. Abort rule: if a split cannot meet (1)–(3), keep
the function as is and leave it in the baseline.

| # | Function (complexity) | What it does | Split |
|---|---|---|---|
| 1 | `audit/entry.ts` `findSecretKey` (9) | Depth-first search for the first deny-listed key in a value | `firstSecretIn(items)` (array branch) and `secretInEntries(object)` (key checked before its value); the main function only dispatches. Same visit order, so the same key is named first. |
| 2 | `audit/record.ts` `recordAudit` (10) | Validates then inserts one `audit_log` row in the caller's transaction | `assertAuditable(entry)` (the action check, then the secret check, same messages: action name and key name only, never a value) and pure `auditRow(entry)` (the ten parameters). One `INSERT`, unchanged. |
| 3 | `auth/breached.ts` check (9) | HIBP k-anonymity lookup: one deadline, one retry, fail closed | `rangeOf(password)` (`{prefix, suffix}`), `askRange(call, prefix, signal)` (the current `attempt`), `bodyOf(outcome)` (status/body to `BreachCheckUnavailable`), pure `listsSuffix(body, suffix)`. `signal` and `started` are still taken once, before the first call; `now()` is still called only after `isRetryable` is true (the `&&` stays in the closure), so the deadline tests see the same clock reads. |
| 4 | `auth/sign-in.ts` `codeStep` transaction (10) | Locks the challenge, promotes, reads the account, judges the code, consumes, opens the session | Export pure `challengeUnusable(challenge)` (missing, consumed, expired, attempts ≥ 5) with its Stryker comment. Nothing else moves: `lockChallenge` → `promote` → `readAccount` → `judgeCode` (lock, window, bump, `safeEqual`, `recordFailure`) → `consumeChallenge` → `openSession`; logging after the transaction unchanged. |
| 5 | `auth/sign-in.ts` `resend` transaction (9) | Same lock, then resend limit, spacing, account, `replaceCode` | Uses the same `challengeUnusable`. Order kept: unusable → `resend_limit` → `resend_too_soon` → promote/read → `replaceCode`. `admitResend` (address throttle before the token lookup) untouched. |
| 6 | `auth/sign-up.ts` `start` (9) | Step 1: checks, throttle, breach + hash, existence, outbound cap, insert, mail | `checkSignUpForm(deps, input, email)` takes the first three refusals (`invalid_email`, then `checkForm` incl. its `readInForce` read, then `weak`) and returns the organizer name or the refusal. `issueSignup(deps, caller, …)` takes id/token/code generation, the insert, `deliver`, `dropSignup` and the `staff.sign_up_started` log. Both branches (new and existing email) still pay the hash, the `accountExists` read, the outbound cap and the insert in that order, so timing does not tell them apart. |
| 7 | `organizers/routes.ts` `answerInvite` (10) | Maps an invite result to 201 or an error | `refuseTeamInvite = refusalThrower<Exclude<InviteResult, { kind: "invited" }>, [reply]>({...})`; `throttled` sets `retry-after` (`waitThen`) then returns `tooManyAttempts`. `answerInvite` keeps the 201 and calls the table. The `RefusalTable` type forces every kind. |
| 8 | `organizers/team.ts` `admitInvite` (9) | Scope, membership, organizer lock, facts, daily count, caps, record | Pure exported `capRefusal(fact, today)` (per-day limit from `activated`; `pending_full` before `throttled`, as now). Reads stay in place: scope → member → `tryLock` → facts → `countRecent` → decision → `record`. Only the per-day ternary moves after `countRecent`, which is pure. |
| 9 | `players/sms.ts` attempt (11) | One Msegat POST; maps the outcome | `callFailed(error)` (`"retry"` only for the never-left codes, else `unknown` timeout/network) and `answerOf(response)` (`sent`, `refused` with Msegat's code, `unknown http_<status>`). Number and text stay only in the request body; reasons stay codes. Retry-once logic in `send` unchanged. |
| 10 | `devices/claims.ts` `viewOf` (12) | Row to `DeviceView` (no secret or code) | Pure `questOf(row)` and `pairedByOf(by)`. Fields still picked one by one (no spread of the row). |
| 11 | `db/pre-identity.ts` `lookupSetting` (11) | Validates a lookup and names its one setting, before `BEGIN` | `checkedEmail(email)` (length, lowercase, control characters, pattern; same order and message) and a `TOKEN_SETTINGS` record for the five token kinds, each value through `checkedHash("tokenHash", …)`. Still runs before `BEGIN`; same `RangeError` texts. |

**Skips:** none needed; each split keeps SQL order, timing and transactions. Two carry the abort rule explicitly:
#3 (if the fake-clock tests in `breached.test.ts` need any change, stop and keep it baselined) and #6 (if the split
would let the existing-email branch skip any step, stop).

## Tests

Existing pins (all must pass unchanged): #1 `src/audit/entry.test.ts`; #2 `test/audit/audit.int.test.ts`; #3
`src/auth/breached.test.ts`, `src/outbound-redirect.outsider.test.ts`; #4–5 `test/auth/sign-in.int.test.ts`
(`challenge_expired`, `invalid_code`, `resend_limit`, `resend_too_soon`, `email_unavailable`),
`src/players/sign-in-limits.test.ts`; #6 `test/auth/sign-up.int.test.ts`, `src/auth/routes.test.ts`; #7–8
`test/organizers/team.int.test.ts` (`invite_self`, `already_member`, `invalid_scope`, `invites_pending_full`,
`mail_cap`), `test/organizers/paths.int.test.ts`, `test/db/organizer-team.int.test.ts`; #9 `src/players/sms.test.ts`;
#10 `src/devices/claims.test.ts`; #11 `src/db/pre-identity.test.ts` and the `test/db/*` pre-identity suites.

New unit tests (pure, no database): `audit/entry.test.ts` (key named before a deeper secret in its value; array order),
new `audit/record.test.ts` (`auditRow` system actor → null id, JSON before/after; `assertAuditable` order: a bad action
with a secret names the action), `auth/breached.test.ts` (`listsSuffix` count 0 and other suffixes), new
`auth/sign-in-challenge.test.ts` (`challengeUnusable`: each of the four reasons and a usable one, attempts 4 vs 5),
new `organizers/routes-invite.test.ts` (every kind's code and status; `throttled` sets `retry-after`; `invalid_email`
→ 400), new `organizers/invite-caps.test.ts` (`capRefusal`: pending at the limit wins over the daily cap; activated vs
not activated limits; one below each limit admits), `players/sms.test.ts` (`answerOf` unreadable body with 200 →
`unknown http_200`), `db/pre-identity.test.ts` (each token kind names its own setting; an email with uppercase).

Checks: types, lint, format, `pnpm lint:limits` (11 entries leave the baseline), the suites above; full `npx vitest run`
once into a log.

## Mutation (ADR-355: ledger, sign-in, tenant isolation, redemption; GitHub only)

Run after the build review, one dispatch: `apps/api/src/auth/sign-in.ts`, `apps/api/src/auth/sign-up.ts`,
`apps/api/src/auth/breached.ts`, `apps/api/src/db/pre-identity.ts` (sign-in), `apps/api/src/organizers/team.ts`
(tenant isolation: invites and team caps), `apps/api/src/players/sms.ts` (sign-in codes; review MINOR 4), each `!**/*.test.ts`. Not mutated: `audit/*` (append-only audit, not one of
the four areas), `organizers/routes.ts` (a mapping table, pinned by the new per-kind test), `devices/claims.ts` (view mapper, outside `stryker.config.json`). Chase only files under 90%, one round.

## Plan review (92/100 GO, folded in)

- MINOR 1: #4–5 use a positive guard `isUsable(challenge): challenge is LockedChallenge` and
  `if (!isUsable(challenge)) return expired`. The Stryker disable on the attempts line is dropped, not moved: the new
  attempts 4-vs-5 test kills that mutant.
- MINOR 2: #11 `TOKEN_SETTINGS` is a `Map` (as `refusal-table.ts`), so an inherited key (`toString`) never matches; an
  unknown kind throws `RangeError` before `BEGIN` (new test).
- MINOR 3: two new sign-up integration tests: an existing email with the mail budget used up gets 503; an existing
  email with the breach check down gets the same 503 as a new email.
- MINOR 4: `apps/api/src/players/sms.ts` joins the mutation scope.
- MINOR 5: rule (4) reworded (above).
- NITs: `audit/record.test.ts` is new; in #3 `rangeOf(password)` still runs before `AbortSignal.timeout`, and the
  response-cleanup block stays in the main function; `lint:limits` is a pure shrink, 36 to 25 violations.
