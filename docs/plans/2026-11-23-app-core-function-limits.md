# App core function limits: 6 sign-in, session and signed-QR offenders (plan)

Tier A (player sign-in, the app's session, signed QR scans, staff code step), the app sibling of "Core function limits"
and "Ledger and access function limits" (same day). Same style: small named helpers next to the function, pure helpers
exported and unit-tested, then `node scripts/function-limits.mjs --update` (the baseline only shrinks; six entries leave
it). No request path, body, header, secure-store key, error kind, copy, markup, aria or test-id change. App code runs on
release Hermes: no `toSorted`, `Object.groupBy`, Set methods or `structuredClone` (`apps/app/src/hermes-runtime.test.ts`).
Tests have no React renderer, so every split is a pure function or a closure factory testable with fakes.

**Rules for every split.** (1) Same network calls and secure-store reads, writes and deletes, in the same order, on
every path; nothing moves across an `await`. (2) Same checks in the same order, so the first answer for any input is
unchanged. (3) Refresh stays single-flight: one `inFlight` promise, set with `??=` before any await, cleared in
`finally`. (4) Every `// Stryker disable` comment moves with its line. **Abort rule:** if a split cannot meet (1)–(3),
or any existing test below needs an edit, keep that function as it is and leave it in the baseline; that is acceptable.

| # | Function (limit broken: lines or complexity) | What it does | Split |
|---|---|---|---|
| 1 | `api/session.ts` `createSession` (148 lines) | Player tokens in one secure item; refresh before expiry and once after a 401; single-flight refresh; sign-out after an in-flight refresh; ended and legal-hold notifiers | `createSessionStore(storage, now)` (exported): `dropAccountItems`, `forget`, `load`, `save`, moved word for word (`forget` deletes `SESSION_KEY` then `MY_QR_KEY`; an unreadable `get` forgets and answers no session; a bad JSON or shape answers no session without deleting; `save` writes one item, `expiresAt = now() + s*1000`). `createRefresher({ client, store, end })` (exported): owns `inFlight` and `runRefresh` unchanged (no pair → `"ended"` with no call; ok + issued → save, a failed save → `"unreachable"`; 401 → `end()` → `"ended"`; anything else → `"unreachable"`); returns `refresh()` and `settled()` = `inFlight?.catch(() => undefined)`. `end` stays in `createSession`, since it reads `signingOut`. `createSession` keeps `signingOut`, the notifiers, `access`, `renewed` and the returned object; `signOut` awaits `refresher.settled()` where it awaited `inFlight?.catch(...)`. About 70 lines left. |
| 2 | `auth/sign-in-flow.ts` `signInStep` (14) | Pure sign-in state machine | `anyStep(state, event)`: `closed` → closed, `signed_in` → done with `pendingOf(state)`, `versions_changed` → consent, else `undefined`. `fromConsent` (versions_loaded; accepted only with versions, channel `"phone"`) and `fromProfile` (refused; expired → contact keeping the join) next to `fromCode`/`fromContact`. `signInStep`: `hasEnded` first, then `anyStep(...) ?? ` the four-way switch. Precedence kept: ended > closed > signed_in > versions_changed > step. |
| 3 | `auth/sign-in-api.ts` `requestCode` (9) | `POST /v1/auth/code`, answer to an event | Pure `codeBody(input)` (the same keys in the same order, `previous` only when defined). `codeSentOf(answer, input, () => deps.now())`: the `code_sent` event or `undefined`; `now()` is still called only on success. Pure `codeRefusal(answer)`: `acceptance_required` → `versions_changed` (checked before `emailOffered`), else `refused` with `problemOf` and `offerEmail === true`. |
| 4 | `auth/player-state.ts` `reload` (9) | Signed-in check, `/v1/me`, publish, with generation guards | Pure exported `meOf(answer)`: `ok` and `isMe` → the spread with `levelOf`, `equipmentOf`, `dailyStreakOf` (same keys, same order), else `undefined`. All guards (`signingOut \|\| disposed`, both `current !== generation`) and the three publishes stay in `reload`. |
| 5 | `event/scan.ts` `readScan` (18) | Camera text to a scan; the server verifies every signature | Order kept: trim → meet code → `HTTPS_LINK` (no link → other) → `parseJoinLink` → host. `isQuestCodeHost(host, extraOrigin)`: `QUEST_CODE_HOSTS` or exactly `https://${host}`; an unknown host → other (today an unknown host reaches `!known` → other on every path, so returning early is the same answer). `stationScan(path)`: `/s/{token}` → screen or other, `undefined` when not `/s/`. `printedScan(path)`: `/q/{token}` → quest (0x01), then step (0x04), then reveal (0x05), else other. `readScan` ends `stationScan(path) ?? printedScan(path)`. |
| 6 | `apps/web/src/components/CodeStep.tsx` `CodeStep` (9) | Staff code form (sign-in, sign-up, invite) | Two module-level components (not defined inside `CodeStep`, so the countdown's re-render never remounts the buttons and loses focus) with the same JSX: `CodeNotices({ problem, notice })` (alert then status `Notice`) and `CodeActions({ t, busy, wait, onResend, onRestart })` (the `Toolbar`, resend label and disabled rules, "other account"). `useCodeRequests` untouched. |

**Must not change.** #1: refresh margin 60 s (exactly 60 s refreshes); one refresh for many concurrent 401s; a late 401
for an already-replaced token uses the stored token, no second rotation; one retry after a 401, never a loop; only a
refresh 401 ends the session; a chosen sign-out tells nobody; `start` drops My QR and saves in parallel; legal hold
only for `legal_acceptance_required`; result kinds `signed_out`, `network`, the client's own. #2: every transition and
event type. #3–4: error kinds `code_sent`, `versions_changed`, `refused`; publishes `loading`, `signed_out{ended}`,
`signed_in{me}`. #5: accepted forms are exactly: a meet token (whole text), a join link, `https://{known}/s/{0x07}`,
`https://{known}/q/{0x01|0x04|0x05}` with an optional trailing slash, host case-insensitive; refused: bare words,
`http`, userinfo, other hosts, other paths, extra segments, other formats and lengths. #6: markup, order, aria.

**Skips:** none expected. #1 carries the abort rule explicitly: if `git diff --color-moved=dimmed-zebra` shows anything
in `load`/`save`/`forget`/`runRefresh` but moved lines and the `store.`/`refresher.` prefixes, keep it baselined.
#6 has no unit render: if `sign-in.spec.ts` needs any change, keep it baselined.

**Found while planning (not changed here; for `docs/FOLLOWUPS.md`, a tier A fix of its own).** `signOut` waits only
for the refresh in flight when it starts. A request that hits a 401 (or near expiry) after that wait starts a new
refresh; if its answer lands after `forget`, `save` writes a pair back after sign-out, and `signingOut` is already false
when a later refresh 401 ends it, so the app says "session ended". A second concurrent `signOut` also clears
`signingOut` early. Fix idea: a sign-out generation that `refresh()` and `save` check. This refactor keeps the
behaviour exactly; no test pins it. Filed as T-815.

## Tests

Existing pins (must pass unchanged): #1 `apps/app/src/api/session.test.ts` (one refresh for many 401s, retry once,
ends only on a refresh 401, keeps tokens on network/5xx/429, wrong-shape answers, exactly one minute, the failing secure
store block, a token another request renewed, sign-out after an in-flight refresh, no "ended" on a chosen sign-out,
legal hold), `apps/app/src/auth/player-state.test.ts` (uses `createSession`); #2 `apps/app/src/auth/sign-in-flow.test.ts`;
#3 `apps/app/src/auth/sign-in-api.test.ts` (`requestCode`, "the terms changing under the person"); #4
`apps/app/src/auth/player-state.test.ts`; #5 `apps/app/src/event/scan.test.ts`, `apps/app/src/event/scan-flow.test.ts`;
#6 `apps/web/e2e/sign-in.spec.ts` (wrong code with attempts left, resend wait, other account, keyboard only),
run once locally with one worker (WORKER_BRIEF), CI runs the rest.

New tests: `session.test.ts`: `createSessionStore` (an unreadable get deletes the session then My QR, in that order;
bad JSON answers none and deletes nothing; `save` writes one item with `expiresAt`), `createRefresher` (two calls in
the same tick give one POST and the same promise; a call after it settles makes a new POST; `settled()` resolves when
the refresh rejects; no pair → `"ended"` with no call). `sign-in-flow.test.ts`: each of `closed`, `signed_in`, `versions_changed`
from each live step (consent, contact, code, profile) and from each ended step (state unchanged); `accepted` without versions stays. `sign-in-api.test.ts`: `codeBody` has no `previous`
key when undefined; `now` not called on a refusal; `acceptance_required` with `emailOffered` → `versions_changed`.
`player-state.test.ts`: `meOf` for network, a malformed body and an ok body. `scan.test.ts`: a table of format ×
path (0x01/0x04/0x05/0x07 under `/q/` and `/s/`, on a known host, the extra origin and an unknown host).

Checks: types (`apps/app`, `apps/web`), lint, format, `pnpm lint:limits` (6 entries leave), the suites above; the full
`npx vitest run` once into a log.

## Mutation (GitHub only)

`stryker.config.json` covers `apps/app/src/api/session.ts` (and `client.ts`, `cookie-session.ts`) but **not**
`apps/app/src/auth/**`, `apps/app/src/event/scan.ts` or `apps/web/src/components/**`. One dispatch after the build
review with the `mutate` input (which overrides the config): `apps/app/src/api/session.ts`,
`apps/app/src/auth/sign-in-flow.ts`, `apps/app/src/auth/sign-in-api.ts`, `apps/app/src/auth/player-state.ts`,
`apps/app/src/event/scan.ts`, each `!**/*.test.ts`. Not mutated: `CodeStep.tsx` (JSX, no unit runner).
Whether the four new files join `stryker.config.json` for good is the coordinator's call. Chase only files under 90%,
one round.

## Plan review (92/100 GO, folded in)

- MINOR (#6): the new pieces are module-level components, so the countdown re-render does not remount the resend and
  "other account" buttons (focus kept).
- MINOR (mutation): `apps/app/src/auth/player-state.ts` joins the mutate globs.
- MINOR (tests): the precedence test covers each of `closed`, `signed_in`, `versions_changed` from each live step and
  from each ended step (state unchanged).
- NITs: `codeSentOf(answer, input, () => deps.now())`; the table's function column names the limit broken.
- The sign-out race is confirmed and not fixed here (no behaviour change): tier A task T-815 in `docs/TASKS.md`.
