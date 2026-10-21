# T-111 app half — sign-in, the join card and the event switcher in the app

The screens T-107, T-108, T-110 and T-111 left to the app (their server halves are built): the consent step, sign-in by
phone or email code, the profile step, the token store, joining by code or link with the join card, the event switcher,
re-acceptance on launch and the sign-out confirmation. Delivers the app side of FR-101, FR-103, FR-104, FR-111, FR-112,
FR-121, FR-122, FR-123, FR-124, FR-1705. Core (sign-in, tokens): Max for the token store and the API client; Standard
for the screens.

## Scope note

- **The app shell exists** (T-009: Expo SDK 57, Expo Router with five tabs, fonts, tokens, Arabic and English with the
  restart switch), checked everywhere except on a phone. Nothing here can be run on a phone in this session either: the
  screens are type-checked and their logic lives in pure modules tested with Vitest; the device run stays T-009's.
- **Not here:** the scanner (T-115, it needs `expo-camera`; joining by QR uses the phone camera's link until then), the
  Android install referrer and the iPhone paste offer (T-112's app side, after T-010), the add-email card and the contact
  change screens (T-108's app side: a later slice), push (T-501).

## Decisions (tactical; for the CTO to challenge)

1. **The API client (`src/api/client.ts`):** one `request(path, {method, body, auth})` over `fetch` with a 15-second
   timeout, JSON in and out, the `X-Device-Id` install id (a random UUID made once and kept), `Accept-Language`, and an
   Idempotency-Key where the route needs one. It answers `{ok, status, body}` or `{network}` and never throws for HTTP
   errors; the screens show the API's own `message[lang]` (every error carries both languages). The base URL is
   `EXPO_PUBLIC_API_URL` (Expo's build-time variable), defaulting to staging
   (`https://questify-api-staging-3ez01s.cranl.net`); production builds set it in `eas.json` (T-010).
2. **Tokens (`src/api/session.ts`, Max):** the access and refresh tokens live in `expo-secure-store` (Keychain and
   Android Keystore; a new dependency, `expo-secure-store@57.0.4`, Expo's own: MASVS-STORAGE says credentials never go to
   AsyncStorage). The store refreshes before the access token's hour ends and on a 401, with **one refresh in flight**
   (a shared promise): two at once would sign the device out by design (T-107, reuse ends the family). A refused refresh
   signs out locally and sends the person to sign-in with "your session ended". Sign-out calls `/v1/auth/logout` with the
   refresh token and clears the store even when the call fails.
3. **The config (`src/config/remote.ts`):** `GET /v1/config` with `If-None-Match`, the last working copy kept in
   AsyncStorage and used when the network or the parse fails (F-282, `parseComposedConfig`); the consent step needs its
   `legal.documents`, refetched when the cached copy has none (T-110 note).
4. **Sign-in flow (screens under `app/(auth)/`):** consent (the terms and privacy open as the web pages
   `/{lang}/legal/{id}` in the system browser; accepting sends their versions; declining goes back and stores nothing)
   → contact (phone or email; a non-Saudi number offers email) → code (six digits, Arabic-Indic digits accepted, resend
   after 60 seconds, for phone the email offer after 30 seconds with `previous`) → for a new contact the profile step
   (username, avatar from the six, birth year) → signed in. Each step's state machine is a pure reducer
   (`src/auth/flow.ts`) tested with Vitest; the screens render its state.
5. **Joining (screens under `app/join/`):** a code entry on Home (`parseJoinLink` takes a typed code or a pasted link),
   deep links `questify://e/{CODE}` and `https://questify.sa/{lang}/e/{CODE}` (expo-linking; the universal link works
   once T-010 serves the association files) open `app/join/[code]` with the join card from
   `GET /v1/public/events/{code}`: the event, "the organizer will see" list, and one Join button. A signed-out person sees
   the card and is asked to sign in only at Join (FR-112); after sign-in the join goes through with the card version
   shown; closing sign-in joins nothing. Answers: joined, already a member, waiting for approval (private), ended, way
   turned off, not allowed, stale card (re-show), not found.
6. **The event switcher (FR-122):** the Home tab's header shows the current event and a sheet listing
   `GET /v1/me/events` (active and pending, pending marked "waiting for approval"); the choice is kept in AsyncStorage.
   Home's own content stays T-113's.
7. **On launch:** with a session, `GET /v1/me`; a non-empty `legal.toAccept` shows the re-acceptance screen before
   anything else (FR-1705, `POST /v1/me/acceptances`).
8. **Sign-out (FR-124):** Profile has Sign out, with a confirmation that says the phone signs out and the points stay.
9. **Strings:** every new string in both languages in `packages/shared` messages (ux-araby), Western digits.

## Tests

- Vitest (no device): the client (timeout, network failure, headers, error envelope, idempotency key), the token store
  (single-flight refresh under parallel 401s, refresh before expiry, a refused refresh signs out, sign-out clears even
  on failure; the secure store mocked at its boundary), the config cache (304, a failed fetch keeps the last copy, a
  copy without `legal` refetches), the sign-in reducer (every step and error), the join answers' mapping, the deep-link
  parsing.
- `tsc` over the app; `expo-doctor` stays clean; the Android and iOS bundles still export (`npx expo export`).

## Phases

1. **The client, tokens and config** (Max): modules, tests, the new dependency.
2. **Sign-in screens** with the reducer.
3. **Join card, deep links, switcher, re-acceptance, sign-out.**
4. **Docs:** TASKS (T-111 app half, the device run on T-009), STATE.

## Revision 1 (after CTO plan review 1, 82/100) — overrides the sections above where they differ

- **M1, browse before sign-in (FR-104, FR-111):** Home shows a signed-out person the public events list
  (`GET /v1/public/events`, paged by `nextCursor`); tapping one opens its join card with `via: public_list`. Quests
  before sign-in are a link to the card's quests (`GET /v1/public/events/{code}/quests`), shown as a plain list on the
  card; prizes wait for T-201.
- **M2, deep links that route:** `app/+native-intent.tsx` (`redirectSystemPath`) reads an incoming path with
  `parseJoinLink` and redirects to `/join/{CODE}?via=link`; anything else goes to Home. Only the https join link is
  emitted (the QR, the invite link and the web page all use it), so the custom scheme `questify://` gets no route in
  this slice. The path-to-redirect mapping is a pure function tested with Vitest.
- **M3, refresh failure paths (Max):** only a `401` from `/v1/auth/refresh` signs out; a network error or a 5xx keeps
  the stored pair, says "can't reach Questify", and the next refresh retries the same token (inside the server's
  60-second grace). The new pair is written as one secure-store item (JSON `{access, refresh, expiresAt}`) before any
  request uses it. A request that got a 401 is retried once after a refresh, never more. `logout` waits for a refresh in
  flight and sends the newest refresh token, outside the 401 path. Each is a test.
- **M4, no fail-open to staging:** the staging default applies only when `__DEV__`; otherwise a missing
  `EXPO_PUBLIC_API_URL` stops the app at start with a clear message, and a non-https base URL outside development is
  refused (MASVS-NETWORK).
- **M5, mutation on the core:** `apps/app/src/api/{client,session}.ts` join `stryker.config.json` (target 90, floor 80),
  and QUALITY_BASELINE's scope line names them. The session module takes a small storage interface (get, set, delete);
  `expo-secure-store` is plugged in at the app's edge, so Vitest and Stryker run the real logic in node.
- **M6, the pending join:** `{code, via, cardVersion}` lives in the sign-in flow's state in memory only (never stored:
  a later launch cannot join silently) and survives the profile step. Closing sign-in drops it; success fires the join
  once; `card_version_stale` re-shows the new card and needs a new Join tap (the card is the consent). Reducer tests.
- **m7:** no Idempotency-Key support in this slice (no route here takes one). **m8:** refresh on demand before an authed
  request when under 60 seconds remain; no timer. **m9:** secure-store writes use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`;
  on a first launch without the install marker (AsyncStorage), the secure store is cleared (the iOS keychain outlives an
  uninstall); SECURITY.md notes it (MASVS-STORAGE). **m10:** sign-out, forced or chosen, deletes the chosen event and the
  per-player flags; `/v1/me` is held in memory only. **m11:** the code field sets `textContentType="oneTimeCode"` and
  `autoComplete="sms-otp"` (FR-1740 on iOS). **m12:** TASKS records FR-1813 (needs a config key), the referrer and paste
  after T-010, camera joins as `via: link` until T-115. **m13:** the consent narrows `legal.documents` to the known ids;
  when the refetch still lacks the terms or privacy, it shows an error with retry and never sends a code request.
  **m14:** the join card covers 429 (`Retry-After`), offline, a code entry that `parseJoinLink` refuses ("not an event
  code"), and no Join button on an ended event. **m15:** this slice reads only the global config; per-event config comes
  with T-113's switcher.
- **Nits:** the reducer is `src/auth/sign-in-flow.ts`; the install id sits in AsyncStorage.
