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
- **Rate limiting:** `429` with `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` headers.
  Limits are tuning numbers editable in the console (F-279): login-code requests per phone/email/IP,
  scans per minute per player, uploads, exports.
- **Live updates:** `GET /v1/events/{id}/stream` (server-sent events) carries ranking changes,
  announcements, "flash quest started", maintenance. If the stream drops, the app falls back to
  polling every 5 seconds (NFR-005).
- **Webhooks:** none sent to organizers in v1. Inbound: SMS delivery receipts, email bounces, wallet
  device registrations; all verified by signature.
- **Config:** `GET /v1/config[?event=<id>]` returns the composed configuration with an `ETag` (see
  `CONFIGURABILITY.md`); anyone may read it. The document is `{schemaVersion: 1, features: {<name>: {enabled,
  minAppVersion, message}}, tuning: {<name>: number}}`, keys sorted. An unchanged document costs one request:
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
| `POST /v1/auth/code` | anonymous | `{channel: phone\|email, value}` → `202`; sends a code (SMS, or email after 30 s, FR-1812) | 422 bad number (not +966), 429 |
| `POST /v1/auth/verify` | anonymous | `{value, code}` → `{accessToken, refreshToken, player, isNew}` | 401 wrong/expired code, 429 |
| `POST /v1/auth/refresh`, `POST /v1/auth/logout` | player | rotate / revoke | 401 |
| `GET /v1/me`, `PATCH /v1/me` | player | profile; username, character, frame, title, city, interests | 409 name taken, 422 filtered word |
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
| `GET /v1/public/events/{joinCode}` | anonymous | name, art, dates, language, join fields (event page) | 404 |
| `POST /v1/events/{id}/join` | player | `{answers}` → enrollment | 403 full (hard limit), 409 already joined, 422 missing field |
| `POST /v1/events/{id}/leave` | player | → 204 | |
| `GET /v1/events/{id}/home` | player | layout blocks, up next, happening now, my rank card | 403 not enrolled |
| `GET /v1/events/{id}/ranking?scope=` | player | top 10 plus the player's own row, `{rows[11]}` (ADR-052) | |

### Quests and verification

| Operation | Auth | Request → Response | Errors |
|---|---|---|---|
| `GET /v1/events/{id}/quests` | player | categories with quests, my progress | |
| `POST /v1/quests/{id}/complete` | player | `{proof: {type, code\|nfc\|…}, location?}`, **Idempotency-Key** → `{points, balance, rank, xp?}` | 409 done, 403 paused/closed/not yet, 422 bad or old code, 429 busy |
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
| `GET/POST/PATCH /v1/organizers/{id}/events` | owner, editor (scoped) | create, duplicate, edit event | 403 outside scope |
| `…/events/{id}/categories`, `…/quests` (CRUD, reorder) | owner, editor | validated by the quest-type schema; live edits take `{apply: future\|past}` and `{confirm: true}` | 422 schema, 409 conflict (last save wins) |
| `…/events/{id}/rewards`, `…/codes` (upload) | owner, editor | rewards, stock, prize codes | 422 duplicate codes |
| `…/events/{id}/announcements` | owner, editor | send now or schedule, with push option | 422 outside CST send window |
| `…/events/{id}/config` | owner, editor | words, layout, bar items, branding, features | 422 protected item hidden (FR-1750) |
| `…/events/{id}/reports`, `…/export` | owner, editor | participation, survey, one-page report, exports (logged) | |
| `GET …/members` | owner, editor | `{members: [{staffUserId, email, role, eventScope, joinedAt}], invites: [{id, email, role, eventScope, expiresAt}]}` (T-101) | 404 |
| `POST …/invites` | owner | `{email, eventScope?: uuid[≥1]}` → `201 {id}`; emails a link `DASHBOARD_ORIGIN/en/invite#token=…` valid 7 days; re-inviting an email replaces its invite (no Idempotency-Key needed) | 400, 409 `already_member`, 422 `invite_self` / `invalid_scope`, 429 `too_many_attempts` (20 pending; 10 a day before an event is activated, 30 after) / `mail_cap`, 503 `email_unavailable` |
| `POST …/ownership` | owner | `{email}` → `201 {id}`; an owner invite (one at a time); on acceptance the invitee becomes owner and the owner an editor (FR-1723) | as for invites |
| `DELETE …/invites/{inviteId}` | owner | → 204 | 404 |
| `PATCH …/members/{staffUserId}` | owner | `{eventScope: uuid[≥1] \| null}` → 204; an editor's event limit (FR-1724) | 404, 422 `invalid_scope` |
| `DELETE …/members/{staffUserId}` | owner | removes an editor → 204 | 404, 409 `owner_required` (the owner themselves) |
| `DELETE …/members/me` | owner, editor | an editor leaves → 204 | 409 `owner_required` (the owner) |

**Organizer routes (T-101):** every `/v1/organizers/{id}/…` route runs the staff session and Origin checks, then reads
the caller's membership from the database: **a non-member gets 404** (the same as an unknown organizer), **an editor on
an owner route gets 403 `owner_only`**; a limited editor working on an event outside their limit gets 403 from the event
routes (T-102). The database checks the membership again on every query (DATA_MODEL "The organizer context").
| `POST …/events/{id}/qr/regenerate`, `…/operators/batch` | owner, editor | new quest QR; batch operator QRs | |
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
