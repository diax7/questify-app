# T-107 — Player sign-in: SMS and email codes, sessions, the Msegat adapter

Delivers FR-106, 107, 108, 109, 110, 323, 1109, 1110, 1812, 1813 (FR-1740 auto-fill is the app's). Depends on T-005,
T-013 (Msegat: the user's account, API key and services sender are now in the staging secret store, 2026-10-20). Core
(ADR-104: sign-in): Max quality.

## Scope note

- **Server side only.** The app's sign-in screens need the app shell (T-009, blocked on the store accounts); they land
  with the first app screens (P3 in `ux/PLAYER.md`), using these endpoints. T-107's Done-when "the screen offers an
  email code after 30 s" is met by the API contract (`emailFallbackAfterSeconds: 30`) and moved to the app's task with
  a dated note. FR-1740 (auto-fill) is the app's: the SMS text carries the Android SMS Retriever hash once the app's
  signing key exists (a setting, empty until then).
- **What T-107 builds:** asking for a code by phone or email, verifying it, creating a new player's account with a
  username and birth year (the smallest profile the database requires; avatar, word filter and changes are T-109),
  sessions (a short access token and a rotating refresh token), sign-out of this device, the Msegat SMS adapter, the
  player email sender, and every limit.
- **Reuse:** the staff sign-in machinery (keyed throttle buckets, `tryLock`, `reserveAttempt`, the verify gate, hashed
  tokens, the email failover sender), `player_session` and the player guard (T-105), the conventions.

## Decisions (tactical; for the CTO to challenge)

1. **Endpoints (API.md's shape, made concrete):**
   - `POST /v1/auth/code {channel: phone|email, value, previous?}` → 202 `{challengeToken, expiresInSeconds: 300,
     resendAfterSeconds: 60, emailFallbackAfterSeconds: 30}` (phone only). The same answer whether or not the phone or
     email has an account (no account discovery). `previous` (a challenge token) cancels that earlier challenge: the
     email fallback cancels the SMS code (FR-1812). Public route; throttled; no idempotency key (public).
   - `POST /v1/auth/resend {challengeToken}` → 202.
   - `POST /v1/auth/verify {challengeToken, code}` → existing player: 200 `{accessToken, refreshToken, expiresInSeconds,
     player: {id, username}}`; new contact: 200 `{signupToken, isNew: true}` (no account yet).
   - `POST /v1/auth/signup {signupToken, username, birthYear}` → 201 tokens and player. Under 13 by year (current year
     minus birth year < 13) → 422 `too_young`, nothing created (FR-119's rule; T-109 adds the rest of the profile).
     Username: 3–30 characters, letters (Arabic or Latin), digits and `_`, unique ignoring case → 409 `username_taken`.
   - `POST /v1/auth/refresh {refreshToken}` → new access and refresh tokens; `POST /v1/auth/logout` (player) → 204.
2. **Codes:** 6 digits, valid 5 minutes (SECURITY.md), 3 tries per code (`ux/PLAYER.md`: "three wrong codes asks for a
   new one"), 3 resends 60 s apart; stored only as an HMAC bound to the challenge (as staff). The challenge token is 32
   random bytes, stored hashed.
3. **Limits (FR-110, FR-323), keyed hashes in `auth_throttle`:** codes asked per phone or email 5 an hour; per client
   address 30 an hour; per device (`X-Device-Id`) 10 an hour; failed verifications per phone or email 10 per 15
   minutes. 429 with `retryAfterSeconds`. The numbers in `limits.ts` (`PLAYER_SIGN_IN_LIMITS`); console tuning later.
4. **Phone numbers: +966 mobiles only (FR-106, FR-108).** Accept `05XXXXXXXX`, `5XXXXXXXX`, `+9665XXXXXXXX`,
   `009665XXXXXXXX`, with spaces, dashes and Arabic-Indic digits, normalised to `+9665XXXXXXXX`; anything else → 422
   `phone_not_supported {emailOffered: true}`. Emails: the staff normaliser.
5. **Tables (migration 0013):**
   - `player_login_challenge (id, token_hash UNIQUE, channel, contact_key bytea (keyed hash, for limits and lookup),
     contact text (the phone or email, needed to send and to create the contact; deleted with the row), code_hash,
     attempts, resends, last_sent_at, expires_at, cancelled_at, created_at)`; no grant; read and written through
     definer functions bound to the challenge token in the request context (the staff pattern).
   - `player_refresh (id, player_id, family uuid, token_hash UNIQUE, created_at, expires_at, used_at, revoked_at)`; no
     grant; definers only.
   - Access tokens are `player_session` rows (T-105), 1 hour.
   - Refresh tokens live 180 days and rotate on every use; a refresh token used twice revokes its whole family and
     its sessions (reuse means theft). "Stay signed in until sign-out" (FR-123) is the app refreshing before expiry.
6. **Account creation (ADR-111):** `create_player(signup_token_hash, username, birth_year)` definer: checks the signup
   token (a verified challenge, 15 minutes), inserts `player` and `player_contact` together, consumes the challenge,
   issues nothing itself (the API then issues tokens through `issue_player_session`). The API role keeps no INSERT on
   `player_contact`.
7. **SMS through Msegat (ADR-103, INTEGRATIONS):** `sendsms.php` with `userName`, `apiKey`, `numbers` (`9665…`, no
   plus), `userSender` (`MSEGAT_SENDER`), `msg`, `msgEncoding: UTF8`; 5 s timeout; one retry only when the request
   never reached Msegat (connection refused, DNS); success `1`/`M0000`; other codes logged by code (never the text or
   the number) and answered 503 `sms_unavailable {emailOffered: true}`. The text states its purpose (CST 4.6.2), in the
   language of the request: "رمز الدخول إلى Questify: 123456. لا تشاركه مع أحد." / "Your Questify sign-in code is 123456.
   Do not share it." (one SMS segment each). Behind an `SmsSender` interface, so Taqnyat is configuration (ADR-103).
   Tests use a recording fake; a staging check sends one real code to Dhia's number only when asked.
8. **Email codes:** the existing failover sender (Gmail API, Resend backup; ADR-112) with a player template in both
   languages. Q-034's "player email provider" stays open; this is the interim answer, recorded there.
9. **Not in T-107:** the app's screens (with the app shell), FR-1813 (email first per event: an event setting the join
   card reads, T-111), the reviewer's fixed code (T-710), changing or adding an identifier and the sign-out
   confirmation copy (T-108), avatar and word filter (T-109), consent (T-110).

## Tests

- Database: no grants on the new tables; the definers bound to their tokens; `create_player` refuses a used, expired
  or unverified signup token and a taken username; refresh rotation and reuse revoking the family; outsider suite.
- API: each endpoint's answers; identical answers for known and unknown contacts; code expiry, tries, resends,
  cancellation by the email fallback; every limit and its `retry-after`; phone normalisation table; Msegat adapter
  against a fake HTTP server (success, each error code, timeout, retry only before the request left); tokens work on
  the completion route (T-105) end to end: sign up, sign in, complete a quest.
- Mutation scope: the new `players/` and sign-in modules.

## Phases

1. **Database:** migration 0013, the definers, database tests.
2. **API and adapters:** the endpoints, Msegat and email senders, limits, tests, mutation.
3. **Docs:** API.md, SECURITY.md, RUNBOOK (Msegat errors and balance), INTEGRATIONS (verified parameters), DATA_MODEL,
   OPEN_QUESTIONS, TASKS, STATE.

## Revision 1 (after CTO plan review 1, 83/100) — overrides the sections above where they differ

- **B1, decided by the user (2026-10-20):** player email codes use the staff email path (Gmail, Resend backup). ADR-117
  (Accepted); SECURITY.md's data map names the exception (address and code only).
- **M1, a separate daily budget for player email codes** (`playerEmailCodesPerDay`, a global bucket below the
  mailbox's daily quota, leaving room for staff codes); spent → 503 `email_unavailable`. RUNBOOK line; Gmail's daily
  cap recorded in Q-034 as a large-event limit.
- **M2, per-address limits are an abuse ceiling only:** 200 code requests an hour per client address (IPv6 /64 as
  one); venues and carrier NAT put thousands behind one address. The real walls are per contact and per device;
  SECURITY.md says why.
- **M3, every SMS counts:** each send (first and resends) counts per contact (5 an hour, 10 a day) and per device (10
  an hour); a platform-wide SMS ceiling per hour (default 5,000, a tuning number) logs a warning at half and refuses at
  the full count with 503 `sms_unavailable {emailOffered: true}` (SMS pumping brake, ADR-099). The default goes to
  OPEN_QUESTIONS for Dhia to tune.
- **M4, refresh retry grace:** a refresh token presented again within 60 s of its rotation, while its successor has
  never been used, revokes that unused successor and issues a fresh pair in the same family; outside the window or
  after the successor was used, the whole family is revoked. A test for each branch.
- **M5, tokens bound to proof:** `player_session` gains `refresh_family`; logout revokes the bearer's session and its
  family; a rotation revokes the family's previous access session (one live access token per device). Every issuing
  definer derives the player from proof it consumes in the same transaction, none takes a bare player id:
  `sign_in_player(code_hash)` (bound to the challenge token in context: checks the code, expiry, tries; consumes it),
  `create_player(username, birth_year)` (bound to the signup token in context), `rotate_player_refresh(hash)`,
  `revoke_player_family(session_hash)`; plus `challenge_contact_state()` answering only none / active / banned for a
  proven challenge (`player_contact`'s policy hides the row before the caller is known). The challenge and refresh
  tables have no grant at all; definers only (not the staff table's context policies).
- **M6, banned players:** after a correct code, a banned player gets 403 `account_banned` (possession is proven, so
  this reveals nothing to a stranger); a banned player's refresh answers 401 and revokes the family. A deleted
  player's contact is gone (T-217), so verify falls through to sign-up; T-217's fingerprint check plugs into
  `create_player`.
- **M7, a Msegat timeout is an unknown outcome:** after a timeout or an ambiguous error the challenge stays alive and
  the answer is the normal 202 (the 30-second email offer covers a code that never arrives); 503 `sms_unavailable` only
  for a definite refusal (connection refused, DNS, Msegat codes 1060, 1110, 1120, M0037 …). One retry only when the
  request never left. INTEGRATIONS' "same message id" line is corrected (Msegat has no idempotency key).
- **Minor 1:** 3 tries per code; failures per contact 10 per 15 minutes and 30 per day; per address 100 per 15 minutes.
- **Minor 2:** a new code for a contact cancels that contact's earlier live challenges.
- **Minor 3, verify errors:** 401 `invalid_code {attemptsLeft}`, 410 `challenge_expired` (also cancelled), 403
  `account_banned`, 429; refresh 401; logout 204; signup 409 `username_taken` / `contact_taken` (a parallel sign-up won;
  the app restarts sign-in, which finds the account), 422 `too_young` / `invalid_birth_year` / `invalid_username`.
- **Minor 4:** `too_young` consumes the signup token; the year is today's in Asia/Riyadh; a birth year in the future or
  before 1900 is 422.
- **Minor 5, the username rule lives in `packages/shared`:** NFKC first; Arabic letters U+0621–U+064A (no tashkeel,
  no tatweel, no bidi or zero-width marks) or ASCII letters, not both in one name; Western digits; `_`; 3–30
  characters; unique ignoring case (0001's index). T-109 extends it.
- **Minor 6, retention:** challenge rows deleted when consumed and swept an hour after expiry; refresh and session rows
  swept 7 days after expiry or revocation; at most 10 live families per player (the oldest revoked first).
- **Minor 7, audit:** `player.signup` written inside `create_player`; `player.refresh_reuse` when a family is revoked
  for reuse.
- **Minor 8:** before the staging SMS check, confirm Msegat's static-IP check (M0037) against CranL's outbound address
  or switch it off in the Msegat account; RUNBOOK lines for M0037 and the 1060 balance error.
- **Minor 9, `previous`:** it only cancels the earlier challenge; an invalid, expired or used `previous` is ignored and
  never fails the request; the email challenge is its own sign-in (an unlinked email signs up a second account,
  ADR-030; the "needs a linked email" copy is the app's and T-108's); the server never binds the email to the phone
  (that would reveal whether the phone has an account).
- **NITs taken:** the phone normaliser also accepts `9665…`, `+966 05…`, Persian digits, parentheses, dots, NBSP and
  direction marks, with a property test that it is idempotent and always matches 0005's CHECK; the SMS language comes
  from a `lang` body field (default `ar`), both texts tested to fit one segment with room for the Retriever hash line;
  only the Msegat `SmsSender`; TASKS notes T-107 delivers the server half of FR-123/124 and T-108 narrows to identifier
  changes and the sign-out copy; the contact lookup and phone throttling get their own derived keys; `X-Device-Id`
  through `deviceOf`, with the per-contact and per-address limits as the backstop when it is missing.
- **Notes for later tasks:** T-109 adds a required avatar to `/auth/signup`; T-110 adds the acceptance fields to it.

## Phase 1 code review (2026-10-20): 87, then 95 GO

- Fixed: definers pinned to `search_path = public, pg_temp` and TEMPORARY revoked from PUBLIC (migration 0014, with a
  test that fails on any unpinned definer); a revoked refresh token while its family lives is reuse; used refresh rows
  swept after 7 days; the challenge contact CHECK; a NULL signup hash raises; `invalid_birth_year`.
- **Logout changes shape:** `POST /v1/auth/logout {refreshToken}` is a public route whose proof is the refresh token (it
  ends that token's family), so a device whose access token expired can still sign out. Always 204.
- **For the app task:** only one refresh in flight at a time in the token store; two parallel refreshes where the second
  answer is kept sign the device out by design (reuse detection).
- **For T-217:** revoke the player's refresh families on deletion and let the sweep remove them
  (`player_refresh.player_id` has no ON DELETE action).
