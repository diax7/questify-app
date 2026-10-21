# API — Questify

> The contract between the clients and the server (not the implementation). Stage 6, 2026-10-17.
> **Surface: internal-only in v1** (the player app, the web app and the wallet providers are the only
> callers), but built as if it could be opened later, because the AI setup wizard (ADR-060) and
> agencies would call an organizer API. Nothing here is a public promise yet. Proposed, ADR-102.

## Conventions

- **Base path and versioning:** `/v1`. A breaking change gets `/v2`; the app keeps working against
  `/v1` until its minimum-supported version is raised in the console. The app sends its version in
  `X-App-Version`, and the server answers `426` with a store link if the build is too old.
- **Format:** JSON, UTF-8, camelCase; times in ISO-8601 UTC; ids are UUIDs; numbers are Western
  digits (ADR-018). User-facing text comes as `{ "ar": "...", "en": "..." }`.
- **Auth schemes:**
  - *Player bearer token:* short-lived access token plus a rotating refresh token, issued after a
    phone or email code (ADR-030). Operators use the same token plus an event role.
  - *Staff session:* cookie `__Host-qs_session` (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no
    `Domain`) after email + password + email code (ADR-078), with inactivity expiry (NFR-030). **The
    dashboard's server reverse-proxies `/v1` to the API**, so the browser sees one origin: no CORS, and the
    cookie works. State-changing requests must carry `Origin` equal to the dashboard origin (else
    `403 csrf_rejected`). The web app's `/v1` forwarder passes `X-Forwarded-For` through
    unchanged and reaches the API over the private network, so the API trusts exactly one hop (CranL's edge) on
    both paths (`TRUST_PROXY_HOPS=1`, ADR-113). Every `/v1/staff/*` answer is `Cache-Control: no-store`.
  - *Screen token:* a signed read-only token in the big-screen and station page links.
  - *Provider callback:* signed requests from SMS, email and wallet services.
  - Roles: `anonymous`, `player`, `operator` (a player with an event assignment), `editor`, `owner`,
    `admin`. Every route lists who may call it; the server re-checks the organizer and event on
    every request (NFR-016).
- **Errors:** one envelope everywhere: `{ "code": "<machine_code>", "message": { "ar", "en" },
  "details": {} }`. Status codes: 400 bad input, 401 not signed in, 403 not allowed or paused, 404,
  409 conflict (e.g. already completed), 422 rule failure, 426 update the app, 429 too many
  requests / busy, 503 maintenance (with the maintenance message).
- **Pagination:** cursor-based (`?cursor=&limit=`); lists return `nextCursor`.
- **Idempotency:** every unsafe action (complete a quest, award points, reserve a prize, send a
  message, redeem) requires an `Idempotency-Key` header. The server keeps the first result for 24
  hours and returns it for a retry.
- **Rate limiting:** `429` with a `Retry-After` header and `details.retryAfterSeconds` (what the app needs to say when to try again).
  Limits are tuning numbers, editable in the console (F-279) once its tuning lands; today they are code constants (`apps/api/src/auth/limits.ts`): login-code requests per phone/email/IP,
  scans per minute per player, uploads, exports.
- **Live updates:** `GET /v1/events/{id}/stream` (server-sent events) carries ranking changes,
  announcements, "flash quest started", maintenance. If the stream drops, the app falls back to
  polling every 5 seconds (NFR-005).
- **Webhooks:** none sent to organizers in v1. Inbound: SMS delivery receipts, email bounces, wallet
  device registrations; all verified by signature.
- **Config:** `GET /v1/config[?event=<id>]` returns the composed configuration with an `ETag` (see
  `CONFIGURABILITY.md`); anyone may read it. The document is `{schemaVersion: 1, features: {<name>: {enabled,
  minAppVersion, message}}, tuning: {<name>: number}, legal: {documents: [{id, version}]}}`, keys sorted.
  `legal` names the player documents in force (`terms_of_use`, `privacy_policy`, `community_guidelines`,
  T-110): the app opens them as the web pages `/{lang}/legal/{id}` and sends these versions back when the
  person accepts. An unchanged document costs one request:
  `If-None-Match` with the tag answers `304`. `Cache-Control: no-cache`, so apps always revalidate. A change
  reaches every app within 15 seconds (the server's cache) plus the time until the app next asks. An event the
  caller cannot see (private, or not there) answers `404` exactly alike. The app keeps the last document that
  passed `parseComposedConfig` (F-282), drops blocks it does not know, and treats a feature as absent when its
  own version is below `minAppVersion`.
- **Texts:** `GET /v1/translations` returns `{ar: {key: text}, en: {key: text}}`: only the texts a Questify
  admin changed. Anyone may read it; it carries an `ETag` (304 when unchanged) and the server keeps it for 15 seconds.
  The app lays it over the texts shipped inside it (`createTranslator`), so a key that is missing, blank, damaged (a
  placeholder gone) or unreachable shows the shipped text (FR-1768). Numbers in any text are shown in Western digits.
- **Deprecation:** since the API is internal, old routes are removed after the minimum app version
  passes them; each change is recorded in `docs/` changelog notes. If the API is ever opened,
  `Deprecation` and `Sunset` headers and a minimum 6 months' notice apply (proposed).
- **OpenAPI:** generated from the shared schemas during the build; until then this file is the
  source of truth.

## Operations (v1 baseline)

Auth shows who may call. "Rate" notes any special limit.

> **Baseline only.** The operations below cover the core loop, rewards, notifications, wallet, the dashboard and the console at group level. Still to be listed when each phase is built: agenda and session registration and check-in; polls, community quests, surveys and ratings; the Questify layer (profile, items, achievements, gems, daily challenge and word, streaks, Questify home, Explore, public events list); guest lists, join fields and rank prizes; reports, blocks and help-desk tickets; consent, data export and deletion requests; operator invites, station and kiosk pairing, inbox; maps and sponsors; big-screen and station feeds. They follow the same conventions.

### Sign-in and account

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `POST /v1/auth/code` | anonymous | `{channel: phone\|email, value, previous?, lang?: ar\|en, accept: {terms, privacy}}` → `202 {challengeToken, expiresInSeconds: 300, resendAfterSeconds: 60, emailFallbackAfterSeconds: 30 (phone only)}`; texts a six-digit code to a Saudi mobile (any common way of typing it, Arabic-Indic digits too) or emails it. The same answer whether or not the contact has an account. `previous` (the SMS challenge token) is ended once the email code went out (FR-1812). A new code for a contact ends its earlier one (T-107). `accept` holds the terms and privacy versions the person accepted on the screen (FR-1705); they are checked before anything is stored, counted or logged, recorded at sign-up (and at a returning player's sign-in when newer) | 400 (bad body or email, `accept` missing or malformed), 422 `acceptance_required` (`details.documents: [{id, version}]`, the terms and privacy in force: show them and retry) / `phone_not_supported` (`details.emailOffered`), 429 `too_many_attempts` (`Retry-After`; 5 codes an hour and 10 a day per contact, 10 an hour per install `X-Device-Id`, 200 an hour per address), 503 `sms_unavailable` (`details.emailOffered`: Msegat refused or the platform's hourly SMS ceiling is spent) / `email_unavailable` |
| `POST /v1/auth/resend` | anonymous | `{challengeToken, lang?}` → `202 {expiresInSeconds, resendAfterSeconds}`; a new code (the old one ends, 3 fresh tries); 3 resends, 60 s apart; counts in the same limits | 410 `challenge_expired`, 429 `resend_too_soon` (`Retry-After`) / `resend_limit` / `too_many_attempts`, 503 |
| `POST /v1/auth/verify` | anonymous | `{challengeToken, code}` → a returning player: `{accessToken, refreshToken, expiresInSeconds: 3600, player: {id, username, avatar}}`; a contact with no account: `{isNew: true, signupToken}` (valid 15 minutes) | 401 `invalid_code` (`details.attemptsLeft`; 3 tries per code), 403 `account_banned`, 410 `challenge_expired`, 429 (10 wrong codes per contact in 15 minutes, 30 a day; 100 per address in 15 minutes) |
| `POST /v1/auth/signup` | anonymous | `{signupToken, username, birthYear, avatar}` → `201` tokens and player, as verify. Username: 3–30 Arabic or Latin letters (not both), digits, `_`, at least one letter; unique after folding (case, and أ/إ/آ, ة/ه, ى/ي read alike); checked against the Arabic and English word lists (ADR-119). Avatar: one of `falcon`, `fox`, `camel`, `owl`, `lantern`, `explorer-hat` | 400 (no or unknown avatar), 409 `username_taken` / `contact_taken` (a parallel sign-up won: sign in again), 410 `signup_expired`, 422 `invalid_username` (`details.reason`: `length` / `characters` / `mixed_scripts`) / `username_blocked` (never names the word) / `invalid_birth_year` / `too_young` (under 13 by year, Riyadh time) |
| `POST /v1/auth/refresh` | anonymous (the refresh token is the proof) | `{refreshToken}` → new tokens, as verify; the old pair ends. A retry within 60 s whose answer was lost gets a fresh pair; any other reuse ends the device's sign-in (theft). One refresh in flight per device | 401 `unauthenticated` |
| `POST /v1/auth/logout` | anonymous (the refresh token is the proof) | `{refreshToken}` → `204`; ends this device's access and refresh tokens, even when the access token already expired. Unknown tokens also answer 204 | 400 |
| `GET /v1/me` | player | `{id, username, avatar, usernameChange: {allowed, nextChangeAt}, legal: {toAccept, guidelinesAccepted}, identifiers: {phone, email}}` (T-109, T-110, T-108); `identifiers` are masked (`•••• 1234`, `s•••@najd.sa`) or null, so the app knows which one is missing (FR-139, FR-1817); `legal.toAccept` lists the sign-up documents (`terms_of_use`, `privacy_policy`) whose version in force the player has not accepted (the app asks on launch), `guidelinesAccepted` whether the guidelines in force are accepted (asked before a first submission, FR-1706); no contact and no birth year. `allowed: false` with `nextChangeAt` set means "wait until then"; `allowed: false` with `nextChangeAt: null` means Questify has changes off; the app formats the date in the player's language with Western digits (FR-705's message). Character, frame, title, city and interests arrive with their tasks | 401 |
| `PATCH /v1/me` | player | `{username?, avatar?}` (at least one) → the profile, as `GET`. The avatar changes freely among the six; the username only while Questify allows changes (platform feature `usernameChanges`) and once per `usernameChangeDays` (default 30; sign-up does not count). Every name stays in the history (FR-1702) | 400, 403 `username_changes_off`, 409 `username_taken`, 422 `invalid_username` / `username_blocked`, 429 `username_too_soon` (`details.nextChangeAt`, `Retry-After`) |
| `POST /v1/me/contact/code` | player | `{channel: phone\|email, value, lang?}` → `202 {challengeToken, expiresInSeconds: 300}`: a code to the new phone or email, to change that channel or add it (FR-125, FR-139; T-108). The text says what the code is for. Whether another account has the contact is never said here. A resend is a new request: it ends the earlier challenge and counts in the player's window (5 an hour, 10 a day, every request, refused ones too), besides the sign-in windows for the contact, the install and the address | 400, 409 `contact_unchanged` (already the player's), 422 `phone_not_supported`, 429 (`Retry-After`), 503 `sms_unavailable` / `email_unavailable` |
| `POST /v1/me/contact/verify` | player | **Idempotency-Key** (a new key per tap; a wrong code's answer replays for that key); `{challengeToken, code, lang?}` → the profile, as `GET /v1/me`. The account takes the new value only now; the old value of that channel and the other channel get a notice (SMS or email, both languages, never the new value; ADR-120). Codes in Arabic-Indic digits work | 400 (also `idempotency_key_required`), 409 `contact_in_use` (another account has it) / `request_in_progress`, 410 `challenge_expired`, 422 `invalid_code` (`details.attemptsLeft`) / `idempotency_key_reused`, 429 |
| `POST /v1/me/acceptances` | player | `{terms?, privacy?, guidelines?}` (at least one) → the profile, as `GET`. Records the versions accepted now, all or nothing: re-acceptance of a new version (FR-1705), or the guidelines before a first submission (FR-1706). Repeating one is fine (T-110) | 400, 422 `acceptance_required` (`details.documents: [{id, version}]`: all three player documents in force) |
| `DELETE /v1/me` | player | start account deletion → `202` | 409 if handover pending (explained) |
| `POST /v1/staff/auth/password` | anonymous | `{email, password}` → `{challengeToken, expiresInSeconds}`; emails a six-digit code (valid 10 minutes) | 400, 401 `invalid_credentials` (same for unknown, wrong and disabled), 429 `too_many_attempts` / `too_many_challenges` (`Retry-After`), 503 `busy` / `email_unavailable` |
| `POST /v1/staff/auth/code` | anonymous | `{challengeToken, code}` → `{account}` and the session cookie | 400, 401 `invalid_code` (`details.attemptsLeft`), 410 `challenge_expired`, 429 |
| `POST /v1/staff/auth/resend` | anonymous | `{challengeToken}` → `{}`; new code, old one stops (3 resends, 60 s apart) | 410, 429 `resend_too_soon` / `resend_limit`, 503 |
| `POST /v1/staff/auth/reset/request` | anonymous | `{email, lang: ar\|en}` → `202 {}`, the same for every email; an active account gets a link `DASHBOARD_ORIGIN/{lang}/reset-password#token=…` (valid 30 minutes, one use, replaces older links), sent after the answer (T-020) | 400, 403 `csrf_rejected`, 429 `too_many_attempts` (3 an hour per email, 10 per address; `Retry-After`) |
| `POST /v1/staff/auth/reset/confirm` | anonymous | `{token, newPassword}` → `204`; sets the password, ends every session, clears the sign-in lockout; the person then signs in with password and code | 400, 410 `reset_link_invalid` (unknown, expired or used), 422 `weak_password` (`details.reason`: `too_short`, `too_long`, `same_as_email`, `context_word`, `breached`), 429, 503 `breach_check_unavailable` (`Retry-After: 30`) / `busy` |
| `POST /v1/staff/password` | staff | `{currentPassword, newPassword}` → `204`; ends every other session, keeps this one | 401, 403 `current_password_wrong` (counts toward the sign-in lockout) / `csrf_rejected`, 422 `weak_password`, 429, 503 |
| `POST /v1/staff/auth/sign-up` | anonymous | `{email, password, organizerName, accept: {terms, dpa, contentRules}}` → `{challengeToken, expiresInSeconds}`, the same for a new and an existing email; a new email gets a code, an existing one a note with no code (T-101) | 400, 422 `acceptance_required` (`details.documents`) / `invalid_organizer_name` (`details.reason`) / `weak_password`, 429, 503 `email_unavailable` (also when the day's mail budget is spent) / `breach_check_unavailable` |
| `POST /v1/staff/auth/sign-up/code` | anonymous | `{challengeToken, code}` → `{account, organizerId}` and the session cookie; creates the account and its organizer (FR-1401) | 401 `invalid_code`, 410 `challenge_expired`, 429 |
| `POST /v1/staff/auth/sign-up/resend` | anonymous | `{challengeToken}` → `{}` (as the sign-in resend) | 410, 429, 503 |
| `POST /v1/staff/organizers` | staff | `{name, accept}` → `201 {organizerId}`; **Idempotency-Key required**; 5 a day | 422, 429 |
| `POST /v1/staff/invites/inspect` | anonymous | `{token}` → `{organizerName, role, email, accountExists}` | 400, 410 `invite_invalid`, 429 (20 an hour per address) |
| `POST /v1/staff/invites/accept` | staff | `{token}` → `{organizerId}`; only the account the invite was sent to | 403 `invite_other_account`, 409 `already_member`, 410 |
| `POST /v1/staff/invites/accept-new` | anonymous | `{token, password}` → `{challengeToken, expiresInSeconds}`: creates the invited email's account, then emails a sign-in code (no session from the link alone, ADR-078) | 409 `sign_in_to_accept`, 410, 422 `weak_password`, 429, 503 |
| `POST /v1/staff/auth/sign-out` | staff | ends this session, clears the cookie → `204` | 401, 403 |
| `GET /v1/staff/me` | staff | `{id, email, platformRole, memberships: [{organizerId, organizerName, role, eventScope}]}` (only the caller's own memberships; organizer names are public) | 401 |
| `GET /v1/staff/sessions`, `DELETE /v1/staff/sessions/{id}` | staff | the user's live sessions (current marked); end one of their own → `204` | 401, 404 |

### Joining and events

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `GET /v1/public/events` | anonymous | `?cursor&limit` (default 25, at most 100) → `{events: [{id, joinCode, name: {ar, en}, venue: {ar, en}, kind, timezone, startsAt, endsAt, statusNow}], nextCursor}`: public events that list themselves, scheduled or live, soonest first (FR-104; T-111). The cursor is opaque; one naming an event that no longer exists starts again from the first page | 400 (bad cursor or limit) |
| `GET /v1/public/events/{joinCode}` | anonymous | `{event: {…as above, access, joinMethods}, card: {version, title: {ar, en}, receives: [{ar, en}]}}`: the join card, for any access type (the code is the secret, FR-105), scheduled, live or ended (`statusNow: "ended"`: no Join). Codes in any case. Wrong codes count against the address: 60 misses in 10 minutes, then every lookup from it is refused, right codes too; right codes cost nothing | 404 (unknown, draft, archived or malformed code), 429 `too_many_attempts` (`Retry-After`) |
| `GET /v1/public/events/{joinCode}/quests` | anonymous | `{categories: [{id, name, quests: [{id, title, description, type, points, opensAt, closesAt}]}]}`: a public or unlisted event's visible quests (FR-111); never a quest's answer or settings. Counts wrong codes as above | 403 `members_only` (private event), 404, 429 |
| `POST /v1/join` | player | `{joinCode, via: code\|qr\|link\|public_list, cardVersion}` → `{enrollmentId, eventId, status: active\|pending, alreadyMember}` (FR-101 to 105, 112, 121; T-111). A public or unlisted event makes an active member, a private one a pending member until the owner approves (ADR-105, T-218). Joining again answers the same enrollment (idempotent by event and player, no key needed); a player who left joins again. The card's version is kept with the enrollment. Wrong codes count against the address (60) and the player (20 in 10 minutes) | 400, 403 `join_method_off` (the event turned that way off) / `join_not_allowed` (removed or banned), 404, 409 `event_ended`, 422 `card_version_stale` (`details.card`: the card in force), 429 |
| `GET /v1/me/events` | player | `{events: [{…as in the list, status: active\|pending, score, balance}]}`: the player's events for the switcher, newest join first (FR-122) | 401 |
| `POST /v1/events/{id}/leave` | player | → 204: an active or pending member leaves (FR-1703; T-208); leaving again is 204; joining again restores the same record. The event's pushes go to active members only | 404 (not a member), 409 `cannot_leave` (banned or removed: leaving would let them join again) |
| `GET /v1/events/{id}/home` | player (active or pending member) | `{event: {id, name, venue, startsAt, endsAt, timezone, statusNow}, standing: {status: "active", score, balance, questsDone, questsTotal} \| {status: "pending"}, upNext: {questId, title, type, points} \| null, rankingOn}` (FR-801, FR-804; T-113). `questsTotal` counts the visible quests; a quest is done once completed to its repeat cap. Up next: the pinned quest while it is open for this player (event live, inside its window, not done to its cap), else the open quest with the most points, the first in order on a tie (FR-1748; points per estimated minute is Q-101); null outside a live event. A pending member gets the event and `pending` only. The app skips the ranking call when `rankingOn` is false | 400, 401, 403 `not_enrolled` (strangers, left, removed and banned members; the same answer whether or not the event exists) |
| `GET /v1/events/{id}/activity` | player (active member) | `?cursor&limit` (default 25, at most 100) → `{entries: [{id, at, kind, scoreDelta, balanceDelta, reason: {type: "quest", questId, title} \| {type}}], nextCursor}`: the player's own points record in this event, newest first, from the ledger (FR-410; T-115). `nextCursor` is the last entry's id, or null; hidden quests' entries still show. `kind` is `quest` today; later kinds (spends, awards, removals: T-207) may arrive, so the app shows an unknown one without breaking | 400 (bad cursor or limit), 401, 403 `membership_pending` / `not_enrolled` |
| `GET /v1/events/{id}/ranking` | player with an active enrollment | `{rows: [{rank, username, avatar, score, isMe}] (top 10), me: {rank, username, avatar, score} \| null, total}` (ADR-052; T-106). Order: points, then who reached them first (FR-606). Banned, removed and excluded players and the organizer's own team are never in it (FR-609, FR-318, FR-1014). `me` is null for a player with no points (or excluded). Served from Redis, or from PostgreSQL with the same order when Redis cannot answer. `?scope=today` (today's ranking) arrives with T-216 | 400, 401, 403 `not_enrolled`, 404 (no such event) / `ranking_off` (FR-607) |

### Quests and verification

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `GET /v1/events/{id}/quests` | player (active member) | `{event: {statusNow, timezone}, categories: [{id, name, quests: [{id, title, description, type, points, repeatCap, opensAt, closesAt, done, earned, state}]}]}`: the visible quests in order (T-113, T-114). `done`: how many times this player completed it; `earned`: the points this player earned from it, from the ledger (a later points change does not move it, so it can pass `points × repeatCap`; category sums leave out hidden quests, so they need not add up to the score); `state`: `done` (completed to its cap) \| `not_live` (the event is not live) \| `not_yet` \| `closed` (its window) \| `open`, on the server's clock, the rule Home's Up next uses. `type` may be one this app version does not know: show it without an action. Never a quest's answer or settings | 400, 401, 403 `membership_pending` (a pending member of a private event) / `not_enrolled` (strangers, left, removed and banned members; the same whether or not the event exists) |
| `POST /v1/quests/{id}/complete` | player (`Authorization: Bearer`) | `{proof: {type: "qr", code: token} \| {type: "code", code}}`, **Idempotency-Key**, optional `X-Device-Id` (a UUID per install) → `{completionId, points, occurrence, score, balance, replayed, rank}` (T-105; `rank` T-106: the player's place after this completion, `null` when not ranked or when the live ranking could not be read or written, which never fails the completion; XP with T-401). A retry with the same key answers the first completion with the current score and balance; the same key for another quest is 422 `idempotency_key_reused`. The convention layer replays any 4xx for 24 hours too, so the app makes a new key per tap and reuses one only to retry a dropped connection | 401, 404 (no such quest or not in its event), 403 `quest_not_open {reason: event_not_live\|hidden\|not_started\|ended}` / `enrollment_inactive {reason}`, 409 `already_completed {cap}`, 422 `invalid_code` (one answer for a forged, old, other-quest or wrong code), 429 `too_many_attempts` with `retry-after` (wrong typed codes: 5 per quest, 20 per player, 30 per device in 10 minutes) |
| `POST /v1/operator/scan` | operator | scanned My QR + quest/award → `{player, result}` | 403 outside abilities or booth limit, 422 expired My QR |
| `POST /v1/operator/award` | operator | manual award within caps | 403 over cap |
| `POST /v1/quests/{id}/submissions` | player | signed upload then `{mediaKey, text}` → pending | 413, 422 type |
| `POST /v1/minigames/rounds`, `POST /v1/minigames/rounds/{id}/result` | player | issue seeded round; send inputs for replay | 422 impossible inputs → flag, 409 attempts used |
| `POST /v1/quests/{id}/vote` | player | poll or organizer-written options | 409 voted |

### Rewards and handover

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `GET /v1/events/{id}/shop` | player | rewards, balance, window | |
| `POST /v1/rewards/{id}/reserve` | player | **Idempotency-Key** → reservation with pickup code | 409 out of stock, 422 not enough balance, 403 window closed |
| `POST /v1/desk/handover` | operator (prize desk) | scan reservation → handed | 403 open flag holds items (ADR-100), 409 already handed |

### Notifications and wallet

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `GET /v1/notifications`, `PATCH /v1/notifications/settings` | player | list; channel opt-ins with dates | |
| `POST /v1/devices` | player | register push token + integrity attestation | |
| `GET /v1/wallet/apple/{eventId}`, `/wallet/google/{eventId}` | player | signed `.pkpass` / Save-to-Wallet link | 503 if certificate unavailable |
| `POST /v1/wallet/apple/v1/...` (Apple web service) | provider | register/unregister device, list updated passes, fetch pass | per Apple spec |

### Organizer dashboard

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `GET …/events` | owner, editor | `{events: [event]}` newest first; a limited editor sees only their events (T-102) | 404 |
| `POST …/events` | owner, editor (unlimited) | **Idempotency-Key**; `{name: {ar?, en?}, kind?, venue?: {ar?, en?}, access?, joinMethods?, timezone?, dayStartHour?, startsAt, endsAt}` → `201 {event}`, always a draft. Times are the event's wall clock `YYYY-MM-DDTHH:mm` (no offset), read in `timezone` (default `Asia/Riyadh`); unknown fields (`status`, `joinCode`) are refused | 400, 403 `scope_limited`, 422 `invalid_event` `{field}` |
| `GET …/events/{eventId}` | owner, editor | `{event}`: `{id, joinCode, name, kind, venue, access, joinMethods, timezone, dayStartHour, startsAt, endsAt (UTC ISO), status, statusNow, createdAt}`; `statusNow` is the status at this moment, before the lifecycle tick | 404 (also outside an editor's limit) |
| `PATCH …/events/{eventId}` | owner, editor | the same fields, all optional → `{event}`; times sent are read in the zone sent, else the stored one; a zone sent alone keeps the instants. Scheduled: the start stays in the future; live: only a later end; ended: times fixed | 404, 409 `event_times_locked`, 422 `invalid_event` `{field}` |
| `DELETE …/events/{eventId}` | owner, editor | drafts only → 204 (FR-1003) | 404, 409 `event_not_draft` |
| `PUT …/events/{eventId}/ranking` | owner | `{enabled: boolean}` → `{ranking}`; shows or hides the event's ranking to players (FR-607), keeping the event's other switches; audited (`event.features.update`). The event view (`GET …/events/{eventId}`) carries `ranking` | 400, 403 `owner_only`, 404 |
| `POST …/events/{eventId}/end` | owner | `{confirm: true}` → 204; ends a live event now (FR-1608) | 400, 403 `owner_only`, 404, 409 `event_not_live` |
| `PUT …/events/{eventId}/focus` | owner, editor | `{questId: uuid \| null}` → `{focusQuestId}`: pins a quest of this event as every player's Up next, or clears the pin (FR-1748; T-113). No confirmation while live; a hidden quest may be pinned and is skipped until it shows. Audited (`event.focus_set`, before and after) when it changes | 400, 404 (another event's or an unknown quest), 409 `event_closed` |
| `GET …/events/{eventId}/quests` | owner, editor | `{focusQuestId, categories: [{id, name, position, quests: [{id, categoryId, type, title, description, points, repeatCap, opensAt, closesAt, visible, position, config}]}]}` in order; works for any status (T-103) | 404 |
| `POST …/events/{eventId}/categories` | owner, editor | **Idempotency-Key**; `{name: {ar?, en?}}` → `201 {category}` at the end; at most 30 per event | 409 `limit_reached {limit}` / `event_closed`, 422 `invalid_category {field}` |
| `PATCH …/categories/{categoryId}` | owner, editor | `{name, confirm?}` → `{category}` | 404, 409 `confirm_required` (live) / `event_closed` |
| `DELETE …/categories/{categoryId}` | owner, editor | `{quests?: "move" \| "delete", to?, confirm?}` → 204; one holding quests needs the choice (FR-1004); the last category stays | 404, 409 `category_not_empty {quests}` / `last_category` / `confirm_required`, 422 `invalid_category {field: "to"}` |
| `PUT …/categories/order`, `PUT …/categories/{categoryId}/quests/order` | owner, editor | `{ids, confirm?}` (the full current set) → 204 (FR-229) | 404, 409 `order_stale` / `confirm_required` |
| `POST …/events/{eventId}/quests` | owner, editor | **Idempotency-Key**; `{categoryId, type, title, description?, points, repeatCap?, opensAt?, closesAt?, visible?, config?}` → `201 {quest}` at the end of its category; times as the event's wall clock; `config` checked by the type's schema (`packages/shared/src/quests`); at most 300 per event; adding needs no confirmation, even live | 409 `limit_reached` / `event_closed`, 422 `invalid_quest {field}` |
| `PATCH …/quests/{questId}` | owner, editor | the same fields but `type` (fixed), plus `confirm?` → `{quest}`; a new category puts it at the end; `null` clears a time; in a live event `{confirm: true}`; `{apply: future\|past}` arrives with T-604 | 404, 409 `confirm_required` / `event_closed`, 422 `invalid_quest {field}` |
| `DELETE …/quests/{questId}` | owner, editor | `{confirm?}` → 204 | 404, 409 `confirm_required` / `event_closed` |
| `…/events/{id}/rewards`, `…/codes` (upload) | owner, editor | rewards, stock, prize codes | 422 duplicate codes |
| `…/events/{id}/announcements` | owner, editor | send now or schedule, with push option | 422 outside CST send window |
| `…/events/{id}/config` | owner, editor | words, layout, bar items, branding, features | 422 protected item hidden (FR-1750) |
| `…/events/{id}/reports`, `…/export` | owner, editor | participation, survey, one-page report, exports (logged) | |
| `GET …/events/{eventId}/players` | owner, editor | `?cursor&limit&q` → `{players: [{enrollmentId, username, avatar, status, score, joinedAt}], nextCursor}` in join order; `q` is a username prefix (case and Arabic look-alikes ignored, at most 30 characters). Only what the join card discloses: no birth year, contact or player id (T-208) | 400, 404 (another organizer's event or outside an editor's events) |
| `PUT …/events/{eventId}/players/{enrollmentId}/ban` | owner | `{banned: boolean}` → `{banned}` (FR-321, FR-1605). A banned player leaves every board, cannot earn or join again; their record stays. Lifting makes them active. A player who left can be banned. Audited (statuses only) | 400, 403 `owner_only`, 404, 409 `ban_not_allowed` (a removed player) |
| `GET …/events/{eventId}/exclusions` | owner, editor | `{exclusions: [{id, kind: phone\|email_domain, value}]}`, newest first; a phone shows as `•••• 1234` for every seat (FR-319) | 404 |
| `POST …/events/{eventId}/exclusions` | owner | `{kind, value}` → `201 {exclusion}` (or `200` with the entry already there). A phone in any common Saudi form, Arabic-Indic digits too; a domain matches exactly (`company.com` does not cover `mail.company.com`; internationalized TLDs accepted). Listed people never appear on the boards and still play. At most 500 an event. Audited (the kind, never the value) | 400, 403, 404, 409 `exclusion_list_full`, 422 `invalid_exclusion` (`details.kind`) |
| `DELETE …/events/{eventId}/exclusions/{exclusionId}` | owner | → 204 | 403, 404 (one answer for an unknown entry and another organizer's) |
| `GET …/members` | owner, editor | `{members: [{staffUserId, email, role, eventScope, joinedAt}], invites: [{id, email, role, eventScope, expiresAt}]}` (T-101) | 404 |
| `POST …/invites` | owner | `{email, eventScope?: uuid[≥1]}` → `201 {id}`; emails a link `DASHBOARD_ORIGIN/en/invite#token=…` valid 7 days; re-inviting an email replaces its invite (no Idempotency-Key needed) | 400, 409 `already_member`, 422 `invite_self` / `invalid_scope`, 429 `too_many_attempts` (20 pending; 10 a day before an event is activated, 30 after) / `mail_cap`, 503 `email_unavailable` |
| `POST …/ownership` | owner | `{email}` → `201 {id}`; an owner invite (one at a time); on acceptance the invitee becomes owner and the owner an editor (FR-1723) | as for invites |
| `DELETE …/invites/{inviteId}` | owner | → 204 | 404 |
| `PATCH …/members/{staffUserId}` | owner | `{eventScope: uuid[≥1] \| null}` → 204; an editor's event limit (FR-1724) | 404, 422 `invalid_scope` |
| `DELETE …/members/{staffUserId}` | owner | removes an editor → 204 | 404, 409 `owner_required` (the owner themselves) |
| `DELETE …/members/me` | owner, editor | an editor leaves → 204 | 409 `owner_required` (the owner) |

**Organizer routes (T-101):** every `/v1/organizers/{id}/…` route runs the staff session and Origin checks, then reads
the caller's membership from the database: **a non-member gets 404** (the same as an unknown organizer), **an editor on
an owner route gets 403 `owner_only`**; an event outside a limited editor's limit answers 404, as a missing one, and a
limited editor cannot create events (403 `scope_limited`, T-102). The database checks the membership again on every query (DATA_MODEL "The organizer context").
| `GET …/events/{eventId}/codes` | owner, editor | `{codes: [{questId, categoryId, category, title, version, url}]}` for the quests whose type carries a printed QR, in builder order; `url` is `DASHBOARD_ORIGIN/q/{token}` (T-104); any status | 404 |
| `POST …/events/{eventId}/quests/{questId}/qr/regenerate` | owner, editor | → `{version, url}`; the version goes up, so every code printed before stops working at once (FR-1711); no live confirmation (the dashboard asks first) | 404 (another event, or a type without a code), 409 `event_closed` |
| `…/operators/batch` | owner, editor | batch operator QRs | |
| `GET …/events/{id}/stream` | owner, editor | live control room | |

### Questify console

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `…/admin/organizers`, `…/events/{id}/activate` | admin | approve organizers; set limit mode, limit, add-ons | |
| `…/admin/settings`, `…/admin/translations` | admin | feature switches, tuning numbers, text matrix, banner, maintenance | 422 placeholder removed |
| `…/admin/players` (search, view, fix, data request) | admin | read-only view logged; fix and merge; export/delete | |
| `…/admin/templates`, `…/legal`, `…/words`, `…/help` | admin | templates (CST rules enforced), legal versions, word lists, FAQ | 422 |
| `…/admin/health`, `…/admin/admins`, `…/admin/seasons` | admin | health view; admin accounts and sessions; ranking seasons | |

Console and dashboard routes live under `/v1/staff/...`; the exact paths are finished when the build
starts. Every state-changing call writes to the audit log (NFR-019).
