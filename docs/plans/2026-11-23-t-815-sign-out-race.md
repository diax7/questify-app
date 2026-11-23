# T-815: the app's sign-out race with a token refresh (plan)

Tier A (player sign-in, the app session). One file: `apps/app/src/api/session.ts`. No dependency, no change to the
`Session` type, request path, body, secure-store key, error kind or copy. Callers: only `createPlayerLoader.signOut`
(`auth/player-state.ts`, its own `signingOut` guard), from `ProfileScreen`; `cookie-session.ts` (web) is untouched.

**Why not a counter bumped at the start of `signOut`.** The refresh already in flight when `signOut` starts must still
save: `signOut` awaits it and signs out with the newest token (pinned: "signs out with the newest refresh token, after a
refresh in flight"). A counter bumped at the start would void that refresh and send `refresh-1`. A counter bumped at
the end adds nothing: single-flight means the only refresh started before a sign-out is that one, and `signOut` waits
for it. And "a refresh started during a sign-out answers `ended` without a call" breaks the pinned "does not say the
session ended…" test, which expects the `/v1/auth/refresh` call. So the generation becomes one flag per refresh,
**captured when the refresh starts**: "a sign-out was running". The call still goes out; its answer is dropped.

## Code changes

1. `createRefresher` deps gain an optional `signingOut?: () => boolean` (default `() => false`, so
   `session-parts.test.ts` passes unchanged). `refresh()` becomes `inFlight ??= runRefresh(signingOut()).finally(…)`:
   the flag is read synchronously, only when a new refresh starts. A call that joins one already in flight shares that
   refresh's flag.
2. `runRefresh(late: boolean)`: right after `client.request` returns, `if (late) return "ended";`. That one check comes
   before both `store.save` and `end()`, so a late refresh never writes, forgets or notifies.
3. `createSession`: `let signingOut = false` becomes `let leaving: Promise<void> | undefined`. The old `try` body moves
   into `const leave = async () => {…}` with the same steps in the same order: `settled()`, `load`, logout POST if a
   pair exists, `forget`. `signOut: () => (leaving ??= leave().finally(() => { leaving = undefined; }))` is shared
   like the refresh: a second call during a sign-out gets the same promise and sends no second logout. `end()` checks
   `leaving !== undefined`. The refresher gets `signingOut: () => leaving !== undefined`. If `pnpm lint:limits` flags
   `createSession`, `leave` moves to a module-level `createLeave({ client, load, forget, settled })`.

## What the player sees (each interleaving)

| Interleaving | Before | After |
|---|---|---|
| Refresh in flight when sign-out starts (ok or 401) | waits, logout with newest token, signed out | same (the refresh is not late) |
| Refresh starts during the logout call, ok lands after `forget` (path 1) | pair written back: still signed in on next launch | dropped; request answers `signed_out`; signed out |
| Same, 401 lands after the `finally` (path 2) | `forget` + "your session ended" banner | nothing; plain signed-out screen (`ended: false`) |
| Same 401 lands after the player signed in again | wipes the new account's pair | new pair kept |
| Two `signOut` calls at once (path 3) | two logout POSTs; flag cleared by the first | one POST, both promises settle together; flag held till then |
| Session ends on its own after a finished sign-out | "session ended" | same (`leaving` cleared) |

**Secure-store write order.** Only `leave` deletes during a sign-out: `set(session)` (the in-flight refresh, awaited)
→ logout POST → `delete(session)` → `delete(myQr)`. A late refresh issues no `set` and no `delete`, so no write can
follow the sign-out's delete, and no late `end()` can delete a later sign-in. Single-flight is kept: one `inFlight`, set
with `??=` before any await, cleared in `finally`. A late refresh blocks other callers only for its own round trip, as
today.

## Tests first (each fails on today's code)

Deterministic: `deferred()` gates hold `/v1/auth/logout` and `/v1/auth/refresh`; a `flush()` (`setTimeout` 0) lets
microtasks run; storage records an op log (`recordingStorage` style). In `session.test.ts` (new `it`s only):
- **Path 1:** start(1); `out = signOut()` (logout held); a request meets 401 → refresh held (answers `issued(2)`);
  release logout, `await out`; release refresh. Expect request `signed_out`, `signedIn()` false, no `set session` after
  `delete session` in the log. Fails today: the pair comes back.
- **Path 2:** same, refresh answers 401 after `await out`. Expect `ended === 0` and no `delete` after the sign-out's
  two. Variant: `start(issued(3))` before the 401 lands; expect `access-3` still used. Both fail today.
- **Path 3:** two `signOut()` calls while logout is held, a request's refresh held answering 401; release logout, then
  refresh. Expect one logout POST (`refresh-1`), `first === second` promise, `ended === 0`, store empty. Fails today:
  two POSTs and `ended === 1`.
- **Cleared after:** same session object: sign out, `start(3)`, request 401 + refresh 401 → `ended === 1`; and
  `start(3)`, request 401 + refresh ok → `access-4` saved (kills a `leaving` never cleared).

In `session-parts.test.ts`: `signingOut: () => true` → the POST happens, `"ended"`, no `set`, `end` not called (ok and
401 answers); a flag that turns true after the refresh started → still `"refreshed"` and saved (read at start only).
Unchanged and green: `session.test.ts`, `session-parts.test.ts`, `auth/player-state.test.ts`.

Checks: `npx tsc --noEmit -p apps/app`, oxlint, oxfmt, `pnpm lint:limits`, `apps/app/src/hermes-runtime.test.ts`, the
three suites; full `npx vitest run` once into a log.

## Mutation (GitHub only, ADR-174)

Glob: `apps/app/src/api/session.ts` (`!**/*.test.ts`). It is already in `stryker.config.json`. Chase survivors only
under 90%.
