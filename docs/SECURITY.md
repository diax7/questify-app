# Security — Questify

## T-411 archiving boundary (implemented; code review 87 folded)

Migration 0075 adds no table and one grant. `archive_ended_events` (definer, pinned search path, `questify_app` only)
takes no argument and moves an event only by the rule (`archive_due`, internal, no grant): any seat that calls it can
archive nothing that is not due, and no seat can write `status` (never granted). The trigger functions
`redemption_event_open`, `ticket_event_open` and `event_archived_final` hold no grant; the first two refuse a
reservation or ticket in an archived event and lock the event row against the step, the last refuses leaving
`archived` for every role, the owner connection included. Proven by the outsider suite (no execute, no grant to PUBLIC,
the step the only grant), the cross-tenant suite (every seat's call leaves both tenants' events as they were; no seat
updates a status) and `test/db/event-archive.int`.

## T-410 after-the-event boundary (implemented; core code review pending)

Migration 0074 adds no table and one grant. `event_recap` (definer, pinned search path, `questify_app` only) is bound to
the caller through `profile_player()` and takes no player id: it answers one row for the caller's own membership that
counts as played, nothing for another player, another organizer's event, a team seat, a rehearsal account, a banned
player or a pending, declined, banned or removed member, and only what the player already sees (no username, score,
balance, player count, join code or other id; `GET /v1/events/{id}/recap` is `private, no-store`). The trigger
function `event_shop_window_guard` holds no grant; it refuses the API's role (organizers and admins alike) any change
to a closed window and any shorter one after the end, on `clock_timestamp()`; no other role can update `event` but the
owner connection. The close itself is a rule over `shop_state` (no stored flag to tamper with). Proven by the outsider
suite (no PUBLIC rights; the grant list), the cross-tenant suite (the recap across players and organizers, another
organizer's window), the routes inventory, `test/db/shop-window.int` and `test/db/event-recap.int`.

## T-406 daily games boundary (implemented; core code review pending)

The ten tables of migration 0069 force RLS with no API or PUBLIC rights; the four play tables are append-only for every
role and started content is frozen for every role (ALWAYS triggers). `questify_app` holds three caller-bound player
doors (`own_daily`, `daily_answer_submit`, `daily_guess_submit`; no door takes a player id) and eleven console doors that
re-read the admin from the account (`questify_admin`, QY403 otherwise); every helper holds no grant (outsider suite).
Hidden content: no granted door answers a question's right option before the caller answered it, or a word before the
caller's game is over, in a result, a refusal's message, detail or hint, an audit row or a replay
(`test/security/daily-players.int`); the period and content checks refuse future, past and stale ids before any answer
is judged or marks computed. Audits name ids and changed field names only. A sponsor gets a disclosed name and nothing
else: no link, no tracking, no data (finish counts are Questify's own, ADR-067, ADR-311).

## T-405 streaks boundary (implemented; core code review pending)

`event_streak`, `event_streak_day`, `questify_streak_day`, `questify_streak_milestone` and `questify_streak_reward` force
RLS with no API or PUBLIC rights; the four record tables are append-only for every role (ALWAYS triggers). `questify_app`
holds five doors: `set_event_streak` (the event organizer's owner within their events, else AN404 as a missing event),
`event_streak_settings` (owners and editors in scope), and the caller-bound `own_event_streak`, `own_streak_bonus` and
`own_daily_streak`; every writer and helper (`streak_record`, `prev_open_day`, `daily_streak_on`, `daily_streak_length`,
`streak_due`, `questify_day`) holds no grant (outsider suite). No door takes a player id. The daily streak is shown to
its owner only: no public profile, ranking or organizer read carries it (cross-tenant suite: the only granted doors that
read it are `own_daily_streak` and `questify_sync`). Day rows and bonuses come only from the quest ledger entry's trigger
(never rehearsal); a forged bonus row fails `ledger_entry_streak_shape`; a milestone's XP row is bound by a composite key
to the same player's reward row, and no points source exists for a streak (FR-421). Crossed-lock tests cover two
completions of one enrollment, a meet crossing a scan, one player in two events, an erasure and the settings door.

## T-403b Questify quests boundary (implemented; core code review pending)

`questify_campaign`, `questify_quest` and `questify_award` force RLS with no API or PUBLIC rights. `questify_app` holds
seven doors: the player's `own_questify_quests` (caller-bound through `profile_player()`, no player parameter) and six
console doors (`questify_admin_list`, `questify_campaign_save|publish|retire`, `questify_quest_save|retire`); every
evaluator and console helper holds no grant (outsider suite). Each console door re-reads the admin from the account
(`app_admin_id()`, an active platform admin with the request's admin flag), so a player, an organizer's staff, a device
context, the anonymous role, a disabled admin or an admin account without the flag is refused (`42501`, answered 404 like
the console hook); every write route takes an Idempotency-Key and every write is audited (`questify.campaign_*`,
`questify.quest_*`) with ids and changed field names only, never titles. Awards come only from server facts through
`questify_sync` (one per player and quest, unique key); a Questify XP entry has no ledger entry, so no removal can
reverse it, and the CHECK pins each source's shape. A quest's condition is fixed once it can pay, so a later edit cannot
re-pay or re-label what players earned. Lock order is unchanged (player KEY SHARE, then `player_xp`); the award's key
check takes KEY SHARE on the quest, which an admin save (NO KEY UPDATE) never blocks; crossed-lock tests cover erasure
and completions while a quest pays. Migration 0066 takes `xp_entry` then `player_xp` up front, in scan order, under a
10 s lock timeout.

## T-403 achievements, passport and history boundary (implemented; core code review pending)

`city`, `achievement`, `achievement_earned` and `final_rank` force RLS with no API or PUBLIC rights; only four doors
are granted to `questify_app` (`questify_sync`, `own_achievements`, `own_events`, `city_list`) and every helper holds no
grant (outsider suite). Each player door binds to `app_player_id()` of an active player (`profile_player()`); no door
takes a player id, so one player cannot read or write another's tiers, stamps or history, and a staff session never
enters them (player bearer only). Earned tiers come only from server facts (standing quest XP credits, revealed final
ranks, reached community goals) through one `played_enrollment` rule; nothing the client sends is counted.
`achievement_earned` and `final_rank` are append-only for every role and kept on erasure tombstones (no personal data).
T-407 adds `player_preference`, `marketing_consent` and `marketing_state`: personal data, so no API grant and no policy, written and read only by caller-bound definers, never in a public, organizer or console read except an admin's audited read of consent (channels, dates, no contact); `marketing_consent` is append-only and erased with the account; a promotion chooses recipients only through `marketing_audience` (ids of active players opted in on the channel now); the opt-out link is HMAC-signed, turns a channel off only and answers the same for every player.
Lock order: sync takes player KEY SHARE then `player_xp`; erasure player → enrollments → `player_xp`; completions
enrollment → `player_xp` with no later player lock: no cycle (crossed-lock tests). The unlocked pre-check keeps a sync
with nothing due lock-free; 20 syncs a minute per player.

Public profile (ADR-276, plan review MAJOR-1/MINOR-5): another player sees tiers only (never progress) and at most 50
stamps of played events that are public, not workplace and ended or archived **at read time**: a live event never
appears, so polling a username cannot tell where someone is now, and an event made private later disappears. Stamps
carry name, local date, city and the revealed rank only: no event id, score, member status, join answer, history or
count of hidden stamps. The API also parses the DTO through the shared stripping allowlist (FR-702). The event city is
fixed once the event is live, ended or archived for every role (`CY409`), so a played event's city never moves.

## T-402b souvenir boundary (implemented; final code review pending)

Rules/targets/receipts/work/scans/command receipts force RLS with no direct API/PUBLIC rights. Narrow SQL doors
recheck active staff membership/event limits and reject forged admin/device/player contexts. System grant doors
require empty context including app_device_id. Recipient eligibility is relational, never a client/queue assertion.
Player FOR SHARE serializes platform ban UPDATE through grant commit; enrollment/rule/XP order and separate queue
claim/ack prevent player-erasure and completion-queue inversions. Receipt composite references avoid an event FK lock
after enrollment, preserving confirmation's opposite order. Rehearsal data cannot produce lifetime ownership/work.
Repair passes are finite (ADR-272): no automatic sweep re-reads non-recipients, and the evaluator's unlocked pre-check
returns before any player/enrollment/XP lock for a member owed nothing, so a backlog cannot contend with quest scans.
The locked path rechecks every condition in the order above. Public cosmetic names refuse control, line-separator and
bidi embedding/override/isolate characters in the shared schema and in souvenir_save (400), as terms and submissions do.

Own locker exposes private source event ID/name only to the active owner, even after leaving/archive; public
profile/ranking/equipment retain source-free allowlists and opaque cosmetic IDs. Cosmetic names/art are explicitly
public-facing content, never automatically copied from private event names. Errors, health and audit metadata contain
no submitted names, attendee list or contacts. Erasure deletes equipment/items/receipts/member work under0063's barriers;
retained result places remain anonymous. T-708's future download must cover earned provenance and explicitly decide
transient-work disclosure/retention; no data-download assembly is claimed here.

> One page: what we protect, from whom, and how. Stage 6, 2026-10-17. Not a compliance document
> (that is `STORE_COMPLIANCE.md`). Mitigations here also appear in the SRS or `ARCHITECTURE.md`.

## Assets worth protecting

1. **The points record and prize handover.** Cheating, forged points and stolen prizes are the
   product's main fraud target.
2. **Players' personal data** (phone, email, birth year, photos). A leak harms people and breaks
   PDPL and store rules.
3. **Staff and admin accounts.** An admin can read players, change texts for everyone and switch
   features off (ADR-093).
4. **Organizer data and isolation.** One organizer must never see another's data (NFR-016).
5. **Signing keys:** Apple Pass Type ID certificate, push keys, SMS and cloud credentials.
6. **Uploaded prize codes.**
7. **Availability during a live event.** An outage at a festival is the worst day.

## Trust boundaries

Untrusted input enters at: the sign-in code request; the scanned QR/NFC payloads; the quest
completion call; photo and text uploads; mini-game inputs; join-form answers; all organizer-written
text (shown to players); CSV and code uploads; wallet web-service calls; provider callbacks; the
public event page and join code; and the big-screen/station links.

## Who can do what

| Capability | Anonymous | Player | Operator | Editor | Owner | Admin |
|---|---|---|---|---|---|---|
| View public event page | yes | yes | yes | yes | yes | yes |
| Join, play, reserve | no | yes | only if the owner allows (ADR-057) | no | no | no |
| Scan players, award within caps | no | no | yes (own event, abilities, booth) | no | no | no |
| Hand over prizes | no | no | prize-desk operators | no | no | no |
| Create and edit quests, rewards, announcements | no | no | no | yes (own events, per scope) | yes | via logged support edit |
| Invite editors, set event limits | no | no | no | no | yes | yes |
| Export event data | no | no | no | yes | yes | yes (logged) |
| Activate events, set limits and add-ons | no | no | no | no | no | yes |
| View any player record | no | own only | no | no | no | yes, read-only, logged |
| Change texts, switches, templates platform-wide | no | no | no | no | no | yes |
| Add or remove admins; force sign-outs | no | no | no | no | no | yes |
| Edit the username word lists and the full-name allow-list (FR-1779, ADR-817) | no | no | no | no | no | yes (audited) |

## Authentication

- Players: phone (+966) or email, one-time code; 5-minute expiry; attempt limits; resend limits per
  number, email and IP; tokens rotate.
- **Player sessions end 365 days after the sign-in (T-810b, Q-660, ADR-706; ASVS V7.1.1, V7.3.2).** Access tokens last
  1 hour and refresh tokens 180 days, renewed on every refresh, but a refresh family never outlives its sign-in by more
  than 365 days (`family_started_at`, migration 0154), its last access token included. The web session (pathway row 10w) ends the same way: its cookie lives 180 days from the last rotation, and a refresh after the 365-day end answers 401 and clears it. Why a year and not NIST SP
  800-63B's 30 days at AAL1: the accounts hold event points, never money; a lost phone is ended by sign-out, the
  10-family limit or a ban; and a fresh code once a year is the friction a game can carry. Recorded as a deviation.
- **Player sign-in: one factor, accepted for v1 (Q-662; ASVS V6.3.3, V6.6.1, written exception).** A code by SMS or
  email is the only factor. Compensating controls: per-contact, per-address and per-install limits; single-use codes
  that end after 5 minutes and 3 tries; refresh-token theft detection (a reused token ends its family); a prize handover
  the player accepts in their own app; a notice on every phone or email change; the 365-day end above. Email is always
  offered next to SMS. Passkeys are revisited after the first events. Every code screen (sign-in, sign-up and invite on
  the web, the app's sign-in and phone or email change, the owner email change page) says under the field "Never share
  this code. Questify will never ask you for it." (`signIn.codeNeverShare`, T-810e).
- **Refused access is logged (T-810b, ADR-703; ASVS V16.3.2).** Every 403, and every 404 that a central check uses to
  hide a door (no membership of the organizer in the URL, a route off support's list, the console to a non-admin, an
  event the database says the caller cannot reach), writes one `authz.denied` line: method, route pattern, status,
  code, actor kind and id. Never the filled path, the query, a body, a contact or a header. A 404 for an object that
  row-level security hides inside the database is not logged (Q-671): it cannot be told from absence.
- **API answers carry their own security headers (T-810b, ADR-700; ASVS V3.4).** HSTS (a year, subdomains),
  `nosniff` and `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` on every `/v1` answer, set by the
  API and again by the web forwarder, so neither depends on the other.
- **Outside calls never follow a redirect (T-810b, ADR-701; ASVS V15.3.2).** Every `fetch` to a provider (Msegat,
  Have I Been Pwned, Resend, Gmail, Google's token endpoint) and the web's server-side calls to the API pass
  `redirect: "error"`; `apps/api/src/outbound-redirect.test.ts` parses the sources so a new call cannot forget it. The
  APNs and FCM sends use the HTTP/2 client, which never follows one.
- Staff (editors, owners, admins): email + password + email code, sessions expire after inactivity,
  sessions listed and revocable (ADR-078, F-293). The user considers this "very safe" (2026-10-17). It
  means a mailbox takeover can open an admin account, which ADR-078 and ADR-094 accepted.
- Passwords: argon2id (19 MiB, 2 passes, 1 lane); 12 to 128 characters counted as code points after NFKC;
  every set (reset, change, and the first password from `staff.cjs create` through reset) refuses the product names and the email's name part (ASVS V6.2.11) and
  any password in Have I Been Pwned's Pwned Passwords list (k-anonymity: 5 hex characters of the SHA-1 leave the
  server, padding on; T-020); never logged.
- Rotating My QR: a signed token with the player id and a 30-second window, verified server-side;
  the wallet-pass fixed code is accepted too (ADR-091) and is therefore a shareable secret by design.

### Sign-in pathways and their strength (T-810; ASVS V6.1.3)

Every way into the product that gives a session, a device cookie or an authority, read from the code on 2026-11-06.
The numbers are from `apps/api/src/auth/limits.ts` (`AUTH_LIMITS`, `PLAYER_SIGN_IN_LIMITS`) and
`apps/api/src/devices/limits.ts`. "Strength" says what an attacker must hold or guess. A 6-digit code is about 20 bits,
so what stops guessing is the attempt limit around it, and each row names that limit.

**How the pathways are enforced alike.** Every route names its access kind (`public`, `staff`, `member`, `owner`,
`player`, `admin`, `device`) and the server does not start with a route that has none; each kind has its own hook, and a
device cookie opens no staff or player route nor the reverse (`apps/api/src/route-access.ts`,
`apps/api/src/route-access.test.ts`, `apps/api/test/security/routes.int.test.ts`). The limits of every pathway sit in the
two limits files named above. The staff password step, the password reset request and the player code request answer
alike for a known and an unknown contact. Before a person is identified, a narrow database setting opens exactly one
row ("Thinner wall on the sign-in paths", below).

**People who sign in**

| # | Pathway (routes) | Who | What proves it | What bounds guessing | What it opens | Proof |
|---|---|---|---|---|---|---|
| 1 | Staff sign-in (`/v1/staff/auth/password`, `/code`, `/resend`) | Editor, owner, platform admin | Step 1: email and password (argon2id). Step 2: a 6-digit code emailed to the same address. The mailbox is the second factor (ADR-078); a mailbox takeover plus the password opens the account, accepted in ADR-078 and ADR-094 | Step 1 takes the same time and gives the same answer for an unknown, a wrong and a disabled account; 8 failures per email and 30 per address in 15 minutes, counted across challenges; the code lives 10 minutes with 5 tries per challenge (kept across resends), 3 resends 60 seconds apart and 5 challenges an hour per account; at most 4 password checks run at once | A session: 256-bit random token held as its SHA-256, `__Host-` cookie (HttpOnly, Secure, SameSite=Strict); idle end 30 minutes, maximum age 12 hours (admins 15 minutes and 8 hours); at most 10 live sessions; the role is read again on every request. A new admin sign-in emails the admin and `SECURITY_ALERT_EMAIL` | `apps/api/test/auth/sign-in.int.test.ts`, `apps/api/test/auth/sessions.int.test.ts` |
| 2 | Staff sign-up (`/v1/staff/auth/sign-up`, `/code`, `/resend`) | A new organizer owner | Email; a password that passes the policy and the breached-password check; the organizer's name and the three acceptances; then a 6-digit code emailed to that address (kept as an HMAC, compared in the database) | 3 starts an hour per email and 10 per address; the code lives 10 minutes with 5 tries and the resend limits of row 1; 5,000 sign-up and invite emails a day for the whole platform (ADR-823), taken by a resend only once its sign-up passes its checks, and 30 resends an hour per client address; 5 organizers a day per person | The session of row 1, opened as soon as the code is right: the code proves the mailbox and there is no further step | `apps/api/test/auth/sign-up.int.test.ts` |
| 3 | Team invite, existing account (`/v1/staff/invites/inspect`, `/accept`) | A person invited to an organizer by email | The invite link (a 256-bit token in the URL fragment, held as its SHA-256, valid 7 days) and a row 1 session for the invited address: the database refuses any other account (`QI403`) | 20 looks and acceptances an hour per client address; at most 20 pending invites per organizer; 10 invites a day before the first event is activated, 30 after | Membership of the organizer as editor or owner; no session of its own | `apps/api/test/organizers/team.int.test.ts`, `apps/api/test/db/organizer-team.int.test.ts` |
| 4 | Team invite, new account (`/v1/staff/invites/accept-new`) | An invited person without an account | The link and a new password (policy and breached-password check). The account takes the invite's email and a row 1 code is emailed at once: no session comes from the link alone (ADR-078) | As rows 1 and 3 | The session of row 1 after the code | `apps/api/test/organizers/team.int.test.ts` |
| 5 | Password reset (`/v1/staff/auth/reset/request`, `/confirm`) | Any staff account | An emailed link: a 256-bit token in the fragment, held as its SHA-256, valid 30 minutes (the first link from `staff.cjs create`, row 9, 24 hours), one use; then a new password under the policy and the breached-password check | 3 requests an hour per email and 10 per address; the request answers 202 for every email | No session. It ends every session and clears the sign-in lockout; the person then signs in by row 1; a notice email goes out (for admins also to the security mailbox) | `apps/api/test/auth/password-reset.int.test.ts`, `apps/api/test/auth/password-reset-paths.int.test.ts` |
| 6 | Password change (`/v1/staff/password`, signed in) | Any staff account | The current password, counted in the sign-in lockout | The failure windows of row 1 | Ends every other session | `apps/api/test/auth/password-reset.int.test.ts` |
| 7 | Staff step-up code (`/v1/staff/reauth/code`, `/verify`) | A signed-in staff member who ends other sessions | A 6-digit code emailed to their own address; it counts as fresh for 10 minutes (ADR-711), checked in the database | A wrong code counts in the failure windows of row 1; the code lives 10 minutes | The right to end other sessions; nothing new | `apps/api/test/auth/sessions.int.test.ts` |
| 8 | Owner email change (`/v1/admin/organizers/:organizerId/owner-email`, then `/v1/staff/auth/email-change/view`, `/confirm`, `/stop`) | A platform admin starts it for an organizer's owner; the owner and the old address finish or stop it | A code to the new address only, plus the owner's current password. Without the password the change waits 24 hours and the old address can stop it; the hold applies only with a recorded notice to the old address, and a failed send closes it (503, ADR-815). Link tokens are 256-bit, HMAC-derived, held as SHA-256 | 5 tries counted together for the code and the password; 3 starts a day per account and 10 an hour per admin; 20 link calls per 15 minutes per client address | The owner's sign-in email changes; every session, challenge and reset link ends | `apps/api/test/console/owner-email.int.test.ts` |
| 9 | Account made by the operator (`staff.cjs create`, `grant-admin`) | The operator, with the database owner connection | `create` takes no password, no flags and no standard input: the account gets the hash of 32 random bytes that are dropped, and one set-password link by row 5's table, valid 24 hours, one use, mailed after the commit (ADR-814). The person sets a password under row 5's policy and breached-password check, then signs in by row 1. `create` gives no role; `grant-admin` needs a reason, writes an audit entry and follows a confirmed sign-in | The owner connection itself (row 21). A wrong address means a stranger gets the link, so `create` can never make an admin | An account with no role (`staff.create`, `staff.invite` audit entries) | `apps/api/test/auth/staff-admin.int.test.ts` |
| 10 | Player code by SMS (`/v1/auth/code`, `/resend`, `/verify`) | Players | A 6-digit code to a Saudi mobile number (+966). One factor: the number (written exception, Q-662, above) | The code lives 5 minutes with 3 tries and at most 3 resends 60 seconds apart; 5 codes an hour and 10 a day per number; 10 an hour per install (no control on the web: a browser's install id lives in localStorage and can be rotated, and a scripted client can omit `X-Device-Id`; the per-number, per-address and wrong-code limits hold, T-803 P2); an address ceiling of 200 an hour plus 2 for each contact that typed a right code from it, up to 2,000; 10 wrong codes per number in 15 minutes and 30 a day; 5,000 login SMS an hour for the platform | Access token (1 hour) and refresh token (180 days, rotated on every use, reuse outside a 60-second grace ends the family); a family ends 365 days after its sign-in; at most 10 devices (ADR-706, ADR-710) | `apps/api/test/players/sign-in.int.test.ts`, `apps/api/test/db/player-sign-in.int.test.ts` |
| 11 | Player code by email (the same routes) | Players | A 6-digit code to the player's email address. One factor: the mailbox | As row 10; 1,000 player email codes a day for the platform | As row 10 | `apps/api/test/players/sign-in.int.test.ts` |
| 10w | Player web session (the web app's forwarder, `apps/web/src/lib/player-session.ts`, T-803 P2, ADR-818 to ADR-821) | Players in a browser at `/play` | Rows 10 and 11's code, with the device forced to `web` (no model, no user agent); the forwarder keeps the tokens in `__Host-qs_player` (HttpOnly, Secure, SameSite=Strict, host-only, 180 days, set again on each rotation) and no token reaches the page; every write with the cookie and every `/v1/auth/*` write must send `Origin` equal to `DASHBOARD_ORIGIN` (403 `csrf_rejected`); operator paths answer 404 to a cookie request (Q-755) | As rows 10 and 11, but per install is no control (row 10) | As row 10: the same family, 365-day end and 10-device cap, the web family counts in the 10. **Ship gate:** behind `PLAYER_WEB_SESSION`, off by default, turned on only with P3's `/play` CSP | `apps/web/src/lib/player-session.test.ts`, `apps/api/test/players/web-device.int.test.ts`, `apps/web/e2e/player-session.spec.ts`, `apps/web/e2e/player-session-race.spec.ts` |
| 12 | New player step (`/v1/auth/signup`) | A contact with no account, after a right code | A signup token held in the challenge, valid 15 minutes (migration 0013), then username, birth year and the acceptances | The code limits of row 10 apply before the token exists; the token adds no guess to bound | A player account and the session of row 10 | `apps/api/test/players/flow.int.test.ts` |
| 13 | Contact change or add (`/v1/me/contact/code`, `/verify`) | A signed-in player | A code to the new phone or email only; the old one is not proved again (accepted deviation, ADR-120, ADR-715; ASVS V7.5.1) | 5 codes an hour and 10 a day per player, refused requests included; 10 wrong codes in 15 minutes and 30 a day; notices go to the old value | The new contact; this device counts as fresh for 10 minutes; the other devices stay unless the player chooses to sign them out | `apps/api/test/players/contact.int.test.ts` |
| 14 | Player step-up code (`/v1/me/reauth/code`, `/verify`) | A signed-in player who ends other devices | A code to the contact the player already has, typed on this device within the last 10 minutes (ADR-711) | The send limits of row 10 | The right to end other devices; nothing new | `apps/api/test/players/devices.int.test.ts`, `apps/api/test/db/signed-in-devices.int.test.ts` |
| 15 | Account deletion (`/v1/me/deletion/code` from the app; `/v1/deletion/code`, `/verify`, `/confirm` from the web page) | The holder of an account's phone or email, signed in or not | A one-time code to that contact in its own challenge, which can never sign in (the answer is the same whether or not an account uses the contact), then a 10-minute single-use deletion token (T-217, ADR-177) | The send and failure limits of row 10 (`apps/api/src/deletion/deletion.ts` uses the same windows) | Erasure of the account; no session | `apps/api/test/deletion/deletion.int.test.ts` |
| 16 | App Review code (the same sign-in routes) | Apple's and Google's reviewers, one Questify SIM number | A fixed 6-digit code, stored only as its keyed hash (purpose `reviewer-code`), valid only while a Questify admin has opened the window (14 days by default, 30 at most) and only for a challenge flagged as the reviewer's. No SMS is sent while it is open: the flag is read after the `review_demo` row is locked for the reviewer number (0184), so a code asked while Prepare, Close or a number change commits follows the committed row | The sign-in limits apply unchanged (10 wrong codes per number in 15 minutes, 30 a day, 3 tries a challenge): at most 420 guesses of 1,000,000 in a 14-day window; `review_demo.code_guessing` is logged past 10 wrong in a day | The one reviewer account: an operator allowed to play, inside the demo organizer's demo event only (`RD404` anywhere else). Deliberately a weak single factor, contained by what it opens | `apps/api/test/db/review-demo.int.test.ts` ("the flag waits for the row (0184)"), `apps/api/test/console/review-demo.int.test.ts` |

**Devices and codes shown at a station**

| # | Pathway (routes) | Who | What proves it | What bounds guessing | What it opens | Proof |
|---|---|---|---|---|---|---|
| 17 | Device pairing (`/v1/device/...`, claimed under `/v1/organizers/:organizerId/events/:eventId/devices` or `/v1/operator/events/:eventId/devices`) | A station, kiosk or big screen, claimed by a signed-in team member or operator | The screen shows an 8-character code (31 letters and digits, about 40 bits, valid 10 minutes) and holds a 256-bit secret in the `__Host-qs_device` cookie (HttpOnly, Secure, SameSite=Strict), stored as its SHA-256. A signed-in person claims the code; the secret is replaced at activation | 60 pairing requests per 10 minutes per address bucket; 10 claims a minute per person; 30 unknown codes an hour per event and per organizer, with an alert above 200 an hour on the platform | A device of one kind (`station`, `kiosk`, `screen`) on one event, on `/v1/device` routes only. It ends on revoke, 24 hours after the event ends, 30 idle days, or when its operator or team member is removed | `apps/api/test/devices/routes.int.test.ts`, `apps/api/test/db/devices.int.test.ts` |
| 18 | Station screen code | A player whose app scans a station's screen | A code signed under `QR_SECRET` (HMAC-SHA-256, 128-bit tag) naming the quest and a 30-second window of the database clock; accepted up to 15 seconds after the window changes | One payment per player per quest in 45 seconds; 6 code fetches a minute per device and per operator and quest | One quest payment, within the quest's caps | `apps/api/test/db/devices.int.test.ts`, `apps/api/test/devices/routes.int.test.ts` |
| 19 | Kiosk live code (`GET /v1/me/live-code`, `/v1/device/kiosk-scans`) | A player shown to a kiosk | The player's live code: their id and a 30-second window of the database clock, signed as row 18. The fixed My QR is refused at a kiosk (`needs_live_code`) | 6 live codes a minute per player; 30 scans a minute per kiosk; 10 unreadable or forged codes in a minute pause the kiosk until the minute passes | One payment per player per quest in 45 seconds | `apps/api/test/db/kiosks.int.test.ts`, `apps/api/test/devices/kiosk-routes.int.test.ts` |
| 20 | Operator invite and My QR | A player claims an invite; a player is identified at a station or the prize desk | An operator invite is a signed code (purpose `operator`) claimed by a signed-in player; it is single use and ends at its row's `expires_at`. My QR is a signed fixed code of the player (purpose `my`) and only identifies: a prize handover needs the player's accept in their own app (abuse case 7) | A claim needs a signed-in player and an Idempotency-Key; an invite is single use; a leaked My QR is replaced by the player at once | An operator's abilities in one event (invite); the player's identity at a scan (My QR) | `apps/api/test/operators/operators.int.test.ts`, `apps/api/test/db/operators.int.test.ts` |

**Outside the product (the people who run it)**

| # | Pathway | Strength | Where it is recorded |
|---|---|---|---|
| 21 | Database owner connection (`DATABASE_ADMIN_URL`), used inside the API container for `migrate.cjs`, `staff.cjs` and `reward-codes.cjs` | A static database password given for the command and removed from the app environment afterwards (RUNBOOK "Database and deploy"; it is not in `ops/cranl/*.json`); the commands that change accounts or codes write an audit entry (`staff.create`, `staff.invite`, `staff.platform_role`, `reward.codes.reseal`). Rotation schedule and TLS to the database are unconfirmed (Q-664) | RUNBOOK "Staff sign-in", "Database and deploy" |
| 22 | The monitoring app (`/` Prometheus, `/grafana/`) | Prometheus: basic auth, user `questify-metrics`, a password of 24 or more characters (bcrypt hash set separately). Grafana: its own login as `admin`, a password of 24 or more characters, no anonymous view. Both settings are checked at start | RUNBOOK "Monitoring stack on CranL" |
| 23 | The CranL account, its API key (`CRANL_API_KEY` or `~/.cranl/config.json`) and the provider consoles (Google Workspace, Apple, Firebase, Msegat) | **Not recorded in the repository**: who holds them and whether each has a second factor. Q-701 | Q-701 |

**Links that open one thing and are not a sign-in**

| Link | What it holds | What it opens | Bound |
|---|---|---|---|
| Promotional opt-out link | The player id, the channel, the signing key's id and a 128-bit HMAC tag over all three (`marketing-opt-out`), stateless, 34 bytes | Switching off marketing for that player and channel, nothing else | Cannot be made for another player without `AUTH_SECRET`; read under the key its id names, the current or (during a rotation) the previous one, so links sent before a rotation still withdraw consent (ADR-826; `apps/api/src/marketing/opt-out.ts`) |
| Questify invitation link (SMS) | A 128-bit random token in the URL fragment | The public event card, nothing about a player | 120 opens an hour per address before the token is read (T-409b) |
| Survey results link | A 256-bit random token held as its SHA-256; the team makes it, replaces it or removes it | One survey quest's results, with text answers that look like contact details left out | 120 opens an hour per address, never cached (`apps/api/src/ratings/routes.ts`) |

### Staff sign-in controls (T-006) and where they are proven

| ASVS area | Control | Proof |
|---|---|---|
| V6 authentication | argon2id; same answer and same time for unknown, wrong and disabled; one sliding-window throttle per email and per address (8 and 30 failures in 15 minutes) counted across challenges; 5 code attempts per challenge, kept across resends; 5 challenges an hour; second factor is the emailed code (ADR-078) | `test/auth/sign-in.int.test.ts` |
| V7 session management | 256-bit random token stored as SHA-256; `__Host-` cookie, `HttpOnly`, `Secure`, `SameSite=Strict`; idle 30 minutes / maximum 12 hours (admins 15 minutes / 8 hours), checked against the user's current role on every request; revoke, list, cap of 10 live sessions; disabled users and revoked sessions stop at the next request | `test/auth/sessions.int.test.ts` |
| V6 recovery and change (T-020) | reset by emailed link: 256-bit token stored as SHA-256, in the URL fragment (never in a log, a proxy or a `Referer`), valid 30 minutes, one use (used up by deleting it), one per person; the request answers the same 202 for every email and works after the answer; 3 an hour per email, 10 per address; a reset ends every session and clears the sign-in lockout; a change needs the current password (counted in the sign-in lockout) and ends every other session (ASVS 5.0 V7.4.3); breached-password check fails closed (3 s, one retry); every change emails a notice (admins: the security mailbox too) | `test/auth/password-reset.int.test.ts`, `test/auth/password-reset-paths.int.test.ts`, `test/db/password-reset.int.test.ts` |
| V4 tenant boundary (T-101) | the organizer context counts only for a member staff user (`app_organizer_id()` reads the membership); editor event limits on events, enrollments, players and event audit entries; members join only through invites (definer functions; no INSERT for the API role); a sign-up completes only with the HMAC of the emailed code, checked in the database; the outbound mail budget (5,000 a day for sign-up and invite mail; the provider sets no daily limit, Dhia 2026-11-11) keeps sign-in codes deliverable, and is taken only after a request passes its own checks: a sign-up resend after its pending sign-up is checked (and 30 resends an hour per client address), email operator invites after the organizer's daily count (500), so neither anonymous traffic nor one organizer can drain it (ADR-823; a reserved share per tenant is in FOLLOWUPS); organizer names that read as addresses are refused | `test/db/organizer-team.int.test.ts`, `test/db/isolation.int.test.ts`, `test/organizers/team.int.test.ts`, `test/auth/sign-up.int.test.ts`, `test/operators/operators.int.test.ts`, cross-tenant and route suites |
| V4 editor event limits on the builder guards and Ask Questify (0189) | `submitters_of` (all four branches) and `stamped_steps` read the caller's organizer and event scope once and answer only in-scope events, so a scoped editor learns nothing of another event by its quest id; `feature_request_read` adds the event scope beside the organizer, as `event_read` | `test/db/games.int.test.ts`, `test/db/passport.int.test.ts`, `test/events/feature-layers.int.test.ts` |
| V4 admin powers re-checked (0189) | `add_reward_codes`, `end_event_early`, `operator_event_of` and the four operator definers (`create_operator_invites`, `revoke_operator_invite`, `set_operator`, `remove_operator`) open their admin branch only for `app_admin_id()` (an active platform admin behind the flag), and audit `admin` only then; `add_reward_codes` reads a NULL gate (a staff id with no organizer) as a refusal. Every policy and the remaining gates followed in 0191 (next row) | `test/db/operators.int.test.ts` ("the admin flag alone") |
| V4 every policy and gate re-checks the admin (0191) | the request's admin flag alone, with no active admin account behind it, opens no row-level policy (42 that read `app_is_admin()`, 11 that asked `app_admin_id()` once per row; all 53 now ask `(SELECT app_admin_id()) IS NOT NULL`, once per query), no guard (`enrollment_status_guard`, `event_spend_rank_guard`, `player_status_guard`, `rank_prize_guard`) and no `results_frozen`; only the refusals `ranking_system`, `souvenir_event` and `invitation_team_event` read the bare flag. A catalog test fails on a new bare flag in a policy, function, view, trigger condition, check or default; the forged flag is probed on every owned table | `test/db/admin-recheck-catalog.int.test.ts`, `test/security/cross-tenant.int.test.ts` ("with a forged admin flag") |
| V4 operator reads need the acting ability (0189, ADR-824) | `operator_scan_subject` names the scanned player only for an operator with `scan_quests` and the quest inside their limit, so an `ability_off` or `outside_station` refusal carries `player: null`; `preview_device` needs `scan_quests` or `show_rotating_qr` (OA403) | `test/db/name-display.int.test.ts`, `test/operators/refusals.int.test.ts`, `test/db/devices.int.test.ts` |
| V11 cryptography | `crypto.randomInt` for codes, `randomBytes` for tokens, HMAC with per-purpose keys derived from `AUTH_SECRET`, constant-time comparison; the opt-out link carries its key id and is read under the current or, during a rotation, the previous `AUTH_SECRET`, which derives that purpose only (ADR-826); quest QR codes signed with HMAC-SHA256 (128-bit tag) under a key derived from its own `QR_SECRET`, decoded strictly (one canonical spelling), bound to their quest and version (ADR-116); digital reward codes encrypted with AES-256-GCM under a key derived from `REWARD_CODE_SECRET` by HKDF-SHA-256 (one label per purpose), a fresh IV each, bound to the reward and the key id header as associated data, repeats found by a keyed HMAC under a per-organizer key (HKDF from the mark key with the organizer id, so one voucher at two organizers gives unrelated marks; ADR-827), so the database holds no readable code (ADR-136); the associated data binds a cipher to its reward and key id, not to its row: accepted (w2-crypto 2), since `FOREIGN KEY (reward_id, event_id)` pins the reward to one event, only the database owner can move ciphers, and swapping two codes of one reward exchanges equal vouchers, while binding the row id would need a v3 format and a re-seal of every row; each sealed code names its key id, the API holds the current key and during a rotation the previous one, and `reward-codes.cjs reseal` then `check` move every code to the new key (ADR-705, ADR-725 to ADR-729) | `src/auth/keys.test.ts`, `src/quests/qr.test.ts`, `src/rewards/codes.test.ts`, `src/marketing/opt-out.test.ts`, `src/rewards/reward-codes-command.test.ts`, `test/rewards/codes-routes.int.test.ts` (no code in logs, audit or the stored cipher), `test/rewards/reseal.int.test.ts` (rotation, re-seal, check) |
| V8 authorization (joining, T-111) | players join only through `join_event`, bound to the session; the enrollment insert policy is admin-only (until 0018 a player could enroll in any event by id, private ones included, and an organizer could enroll any player in their own event and so read that player's row); wrong join codes are counted per address (60 in 10 minutes) and per player (20), right ones cost nothing; a miss is reserved before the lookup, so a burst cannot pass the budget | `test/db/join.int.test.ts`, `test/join/join.int.test.ts` |
| V16 logging | events carry the request id, the event name, the user id (when known) and a 12-character keyed tag of the client address; never the email, the address itself, the password, the code or a token; the request serializer writes the method and the route pattern only (`/v1/rehearsals/:code`, `/v1/players/:username`; the filled path and query, which can hold a code, a username or a search, are never written; never a body: the code request's contact and accepted versions stay out; a request refused for its versions logs no `player.*` event, T-110); `Set-Cookie` and `Cookie` are redacted; a path no route answers is written as `unmatched` (a caller can type anything there, T-018). Metrics and traces (T-018, ADR-603) take only attributes from a closed list with a value shape (route pattern, status, fixed names), never a URL, header, body, SQL or error text | "what the logs hold" test; `src/telemetry/pii.test.ts` (sentinel values in paths, queries, headers and bodies never reach a log line, span or metric) |
| V3 / V4 | default-deny staff scope with an explicit public list; `Origin` check on state-changing requests; `no-store` on every staff answer | route-walk tests |

**Thinner wall on the sign-in paths.** Before a person is identified, sign-in code opens exactly one row through
a narrow setting (`app.auth_email`, `app.session_token_hash`, `app.challenge_token_hash`). Trusted code, not
the caller's identity, opens that row, so row-level security protects less here than on identified requests.
Tests assert that one lookup exposes one row and nothing else, and the request can never supply these values.

**Admin power narrowed (T-701, ADR-405).** `staff_user_own` is SELECT only (own row or admin) and
`staff_user_update` allows the own row only, so no context, an admin's included, can overwrite another person's
`password_hash`. `platform_role` and `status` are written only by the owner connection (`staff-cli grant-admin` and
`revoke-admin`, each with a required reason and the operator in the audit entry; a revoke ends sessions and support
grants); a test asserts the API role's exact privileges.

### Audit log (T-004)

| ASVS area | Control | Proof |
|---|---|---|
| V16 logging (security events, log protection) | every state-changing call writes one entry in the same transaction as the change: actor, action, target, organizer and event, before and after, request id, time set by the database. Append-only for every role, owner included; the API cannot backdate or renumber. Entries never hold a secret, an email, a phone number, an address or a user agent (refused in code at any depth, by key name only: the guard cannot read a value, so text an organizer wrote, such as a Home text card in the `event.layout.update` entry, may hold contact details they chose to publish, Q-362). Sign-in success and session end are entries; failed sign-ins stay in the server log | `test/audit/audit.int.test.ts`, `src/audit/entry.test.ts` |
| V8 authorization | an entry can only be written in the caller's own name and organizer; `system` entries only from the owner connection (CLI, jobs); an organizer reads only its own | same suite, plus `test/db/isolation.int.test.ts` |

Changing the table itself (a migration) is guarded by review only. The only sanctioned future change to past
entries is the anonymisation path for a deleted player (Q-084).

Operators are players, and `audit_log` has no player actor: their actions are recorded where they happen instead. A
quest an operator completes or awards carries `operator_id` on its ledger entry; a submission an operator reviews
carries `reviewed_by_operator`, `reviewed_at` and `review_key`, and its approval's ledger entry carries the
operator too (`actor = 'operator'`, T-301). The team's reviews are audited (`event.submission_approved` / `event.submission_rejected`).
A help-desk ticket an operator answers carries `answered_by_operator`, `closed_at` and `answer_key` (T-310); the team's
answers are audited (`event.ticket_answered` / `event.ticket_solved`, ids and the outcome only, never the text).

**Help-desk tickets (T-310, ADR-247).** Who can do what: the sender reads their own tickets in any enrollment status
(`own_tickets`, never who answered); another player reads nothing on any route; owners and editors in their event
limit read and answer every ticket of the event (`award_event_of`); an operator with `help_desk` reads and answers
open tickets that are event-wide or for a quest inside their limit, never their own, and reads a closed one only if
they answered it; an operator without it, `anon` and `PUBLIC` nothing. **T-312 (ADR-257):** operators never see a `report_player` ticket (HT404 on every door); owners and editors escalate with a note and read their escalated tickets read-only; an active platform admin reads exactly the rows with `queue = 'questify'` through the console (`app_admin_id()` re-read in every function, the request flag alone opens nothing), every read audited per event shown (`console.tickets_read`, `console.ticket_read`, ids only), 120 calls a minute; an event ticket never escalated, or sent back, is the same 404 as a missing one; an admin who is also an organizer member keeps each door to its own rule. Outsider suite: every new function refused to `anon` and `PUBLIC`; test/db/tickets-center crosses organizers A and B and the admin who is also a member. `ticket` has RLS
forced and no grant; every function is closed to PUBLIC (outsider suite, `purge_ended_tickets` included), the table is
classified in the cross-tenant suite, and `test/db/tickets.int.test.ts` crosses organizers, events and players. The text
and the reply never reach a log, an audit row or an error (`test/tickets/routes.int.test.ts` reads the logs).

### Points ledger and completions (T-105)

| ASVS area | Control | Proof |
|---|---|---|
| V8 authorization / business logic | one definer function, `complete_quest`, is the only writer of completions and points; the player is the request's own, never an argument; it checks enrollment, event, quest, proof and cap under a lock on the player's enrollment; points come from the quest row, never the request. The rules hold whatever the API sends; the QR signature and the player's identity are the API's (signed code, bearer session) | `test/db/completion-engine.int.test.ts` (a recorded mutation pass over the function's rules), `test/completions/complete.int.test.ts` |
| V8 usernames (T-109) | the API role cannot write a username or a birth year (revoked; only the definers `create_player` and `rename_player` write them, checking the word lists, folding, the change limit under a lock on the player's row); a CHECK on the characters keeps marks, tatweel and zero-width tricks out of every name; the lists cannot hold an entry that matches every name; the refusal never names the matched word; the history is append-only. Only the username and avatar of a player are shown to others (FR-120) | `test/db/usernames.int.test.ts`, `test/db/core-columns.int.test.ts`, `test/players/profile.int.test.ts`, `test/ranking/ranking.int.test.ts` |
| V8 admin powers (T-210) | console routes live only under `/v1/admin/` (the route inventory refuses anything else there), answer 404 to anyone but an active platform admin, and every activation definer re-reads the account (`app_admin_id()`), so the request's admin flag alone is not enough; the hard player limit is a trigger on `enrollment`, serialized per event, so two joins cannot both take the last seat | `test/security/routes.int.test.ts` (console routes), `test/db/activation.int.test.ts`, `test/activation/activation.int.test.ts` |
| V8 rankings (T-106) | readers are the event's active players only; the reader comes from the session (`app_player_id()`), never an argument; `ranking_rows` refuses any other caller with QR403 and names only ranked rows, for ids the API read from Redis (low-ranked players stay visible only to themselves, ADR-052); rebuild, claim and live-event functions run only in the system context (no identity of any kind, and since 0191 no device seat: `ranking_system()` refuses a kiosk, station or screen context and a forged device id, `test/db/ranking-repair-seats.int.test.ts`); `mark_ranking_repair` takes the system or a player of the event. Exclusions (bans, removals, the organizer's own team) are re-checked as rows are read, and every eligibility change marks a repair, so a stale copy never shows an excluded player for long. Redis holds no names or contacts (ADR-118) | `test/db/ranking.int.test.ts`, `test/ranking/ranking.int.test.ts`, `test/ranking/store.int.test.ts` |
| V11 / V16 integrity | the ledger is append-only for every role through any DML, the owner included (ALWAYS triggers on UPDATE, DELETE, TRUNCATE); a DDL change (dropping a trigger) goes through reviewed migrations only. One exception (ADR-157, T-211): the rehearsal wipe may delete rows marked `rehearsal` (set at insert from the enrollment) of its own event, under a transaction-local setting; the API role has no DELETE right, UPDATE and TRUNCATE stay refused, and the erase is audited with counts (`test/db/rehearsal.int.test.ts`). Score and balance are trigger-kept sums of it | same suite |
| V2 / V11 anti-automation | wrong typed codes are reserved before they are checked, under a lock on the player, so a burst cannot slip past the count: 5 per quest, 20 per player, 30 per install in 10 minutes. `X-Device-Id` is a claim from an honest client (an attacker rotates it); the per-player limits are the real wall | `test/completions/complete.int.test.ts` |
| V3 sessions (players) | bearer tokens of 256 bits stored as SHA-256; a session counts only while the player is active, the session unexpired and not revoked. Issued only by database functions that consume proof in the same transaction (a challenge token and its code, a signup token, a refresh token), never from a bare player id; access 1 hour, refresh 180 days rotated on every use, one family per device (at most 10); a reused refresh token outside the 60-second retry grace ends the family and is audited; sign-out by the refresh token (T-107) | `test/db/player-sign-in.int.test.ts`, `test/players/sign-in.int.test.ts`, `test/db/completion-engine.int.test.ts`, `test/completions/complete.int.test.ts` |
| V15 definer functions (T-107) | every `SECURITY DEFINER` function runs with `search_path = public, pg_temp` (pg_temp last), and no role but the owner may create temporary tables (`TEMPORARY` revoked from `PUBLIC`, migration 0014): a caller cannot shadow a table the function reads with a temporary one of the same name. A new definer function takes the same setting; a test fails the build if one does not | `test/db/player-sign-in.int.test.ts` |

**Residual risk accepted (T-107, plan review minor 1).** Someone who knows a player's phone number can ask for codes
and guess wrong: 30 wrong codes a day lock that number out of SMS sign-in until the window moves on, and 5 codes an
hour (10 a day) stop its codes. Email sign-in still works, and support frees the number (RUNBOOK, "Player sign-in and
SMS"). The windows stay per contact because a per-address limit cannot stop a spread-out attack and would lock out
whole venues.

**Deviation (T-018, 2026-11-03): written; evaluated from T-018b.** The alerts for these signals are rules in `ops/alerts/questify.rules.yml`:
`QuestifyEmailFailing` and `QuestifyEmailBackupInUse` (email senders down), `QuestifySignInThrottleSpike` (throttle spikes),
each with a RUNBOOK entry. They are evaluated once the telemetry store exists (T-018b, Q-560). One address key carrying most of the
traffic is still a log query (RUNBOOK, `QuestifySignInThrottleSpike`): the metrics hold no address tag.

### Paired devices and the screen code (T-309, ADR-239, ADR-240)

| ASVS area | Control | Proof |
|---|---|---|
| V3 sessions (devices) | a device's credential is 256 random bits in the `__Host-qs_device` cookie (HttpOnly, Secure, SameSite=Strict, Path=/), stored as its SHA-256, never in a URL, a log line, an audit row or a body; replaced once at activation (the old one lives until the new one is first used or 60 s, CTO 2); a device ends when revoked, its quest or event is deleted, its operator or team member is removed, 24 h after its event ends, or after 30 idle days | `test/db/devices`, `test/devices/routes` (cookie flags, activation, the log and audit scan) |
| V8 authorization | access kind `device` only under `/v1/device`, enforced by its own hook on the route's access kind; device definers read their own row by `app_device_id()` and take no event or quest argument, so a station can never ask for another quest's code; a device cookie opens no player, staff, member, owner or admin route and those credentials open no device route (CTO 11) | `route-access.test.ts`, `test/devices/routes`, `test/security/*` |
| V2 / V11 anti-automation | pairing requests: 60 per 10 minutes per address bucket (a venue's NAT), a reload with a live cookie makes none; claims and previews: 10 a minute per person; unknown codes: 30 an hour per event and per organizer, and above 200 an hour on the platform ops are alerted (`device.claim_misses_high`); codes are 8 of 31 characters (about 40 bits) and live 10 minutes; screen codes: 6 a minute per device and per operator and quest | `test/devices/routes`, `devices.test.ts` |
| V11 business logic (screen code) | the 30-second window is issued and judged on the database clock only; the previous window counts for its first 15 s; the door judges it after the enrollment lock, and pays one player once per 45 s on the quest (CTO 6) | `test/db/devices` (the screen door table, the clock's property test) |

| Threat | Answer |
|---|---|
| A station link shared on WhatsApp (FR-1713) | The address holds nothing: it opens a fresh pairing page that shows no event, no quest and no code |
| A photographed pairing code | Useless without the cookie only the showing browser holds; claiming it pairs that screen, not the photographer's |
| Staff tricked into pairing a stranger's remote browser (social engineering through the type-in) | Its codes still expire within 45 s; its label, client and last seen sit on the Devices page with Revoke |
| A device cookie copied before pairing | Dead after activation (the secret is replaced) |
| Racing the activation with a copied pending secret (CTO plan re-review 3) | The attacker's activation wins the fresh secret and the real screen's old secret dies, so the real screen goes blank (`device_unpaired`) and starts over; the answer is that blank screen plus Revoke on the Devices page, where the device shows as paired and active while the screen in front of staff shows a new code |
| A stolen device cookie | Works until Revoke, the event's end + 24 h, or 30 idle days |
| Guessing a pairing code | Needs a staff account of an event; held at 10 claims a minute per person and 30 unknown codes an hour per event and organizer, with a platform alarm above 200 an hour, against 40 bits that live 10 minutes |
| A screen code photographed and sent on | Refused once more than 15 s past its change (`code_expired`); relayed live within its 45 s it still pays its scanner (ADR-240, risk accepted: bounded by the quest's caps, one pay per window and the burst flags) |
| A flood of pairing requests (CTO 9) | At 5,000 open requests new pairings answer 503 `busy` (logged `device.request_flood`, which the error tracker alerts on) for up to 10 minutes; paired devices are never touched |
| An operator who lost the ability or the quest keeps a station running (CTO 3) | The station shows "Paused by the event team" and no code until the ability or the quest comes back |

### Practice scans (T-311, ADR-249, ADR-250)

A practice scan must never write points. Three walls, each tested alone:

| Wall | Control | Proof |
|---|---|---|
| Database | `operator_practice_scan` runs the real door in a block that always raises (`PX000`), so the subtransaction undoes every row and lock; it is `SECURITY INVOKER` and gains no privilege; a fresh `practice:` key never meets a real one | `test/db/practice-scan` (a whole-database fingerprint before and after, with the transaction around it committing; no advisory or row lock left; keys; crossed scans) |
| API | `withRolledBackContext` always sends `ROLLBACK`, never `COMMIT`; a failed rollback destroys the connection | `src/db/context.test.ts` |
| Route | `POST /v1/operator/scan/practice` is its own route with no ranking and no idempotency store; the real route has no practice flag | `test/operators/practice` (a ranking spy untouched, score unchanged), `practice.test.ts` |

In the app, practice mode lives in memory only; the writing tools (desk, inbox, tickets, manual award, review, NFC
write, rotating QR, pairing) are locked while it is on, and the "Practice · not saved" line comes from the server's
`practice: true`, never from the switch. Outsider: none of the three functions runs for `questify_outsider` or PUBLIC.

### The first-N bonus (T-313, ADR-260 to ADR-263)

No more than N bonuses are ever paid, and nobody outside the event reads or sets one:

| Risk | Control | Proof |
|---|---|---|
| Two players take the Nth bonus | One slot row per place, claimed `FOR UPDATE SKIP LOCKED` as the payer's last write; UNIQUE completion, entry and (quest, enrollment) on the slots, and partial UNIQUE indexes on the ledger | `test/db/first-bonus` (the race at the 50th place, 20 rounds at the last place, 40 claimers on 8 connections, a rolled-back claim) |
| A forged bonus row | `ledger_entry_first_bonus_shape` (a completion and a quest, positive, no boost, actor system), never boosted, no XP | the forged inserts and the never-boosted test |
| A bonus set or read across tenants | `set_quest_first_bonus` through `award_event_of` (AN404); `first_bonus_left` answers no row unless the caller is an active member or the team in scope; `own_first_bonus` the caller's own completion only | `test/db/first-bonus` (another organizer, an editor out of scope, a stranger, a banned member) |
| A client skipping or replaying through the practice path | `practice:` keys are reserved at the API (400 `idempotency_key_invalid`); the practice scan's door claims nothing | `src/conventions.test.ts`, `test/quests/first-bonus` |

Both tables keep row-level security forced with no grant to the API role; `pay_first_bonus` and `first_bonus_place` are
granted to nobody. Outsider suite: every new function refused to `questify_outsider` and PUBLIC.

### Kiosks and the live code (T-309b, ADR-242, ADR-244, ADR-245)

| ASVS area | Control | Proof |
|---|---|---|
| V8 authorization | `kiosk_complete_quest` takes no quest or event: it pays only the device's own quest, only a player enrolled in the device's event, only from an activated, live kiosk (a station's or pending cookie is 401); `kiosk_scan_subject` names only a player of that event; `GET /v1/me/live-code` signs only the bearer's own id | `test/db/kiosks`, `test/devices/kiosk-routes`, `test/security/*` |
| V11 business logic | the live code's window is issued and judged on the database clock; one pay per player per method per 45 s on a quest under the enrollment lock; the `kiosk:` key namespace is the kiosk door's alone (QK422 elsewhere, null-safe); the pairing operator is never paid by their kiosk | `test/db/kiosks` (the kiosk door table, the crossed locks) |
| V2 / V11 anti-automation | 30 scans a minute per kiosk; 10 unreadable or forged codes in a minute pause it until the minute passes; 6 live codes a minute per player | `test/devices/kiosk-routes` |
| V14 configuration | only `/ar/kiosk` and `/en/kiosk` get `camera=(self)` and `'wasm-unsafe-eval'`; every link there is a full page load; the decoder's wasm is self-hosted and hash-checked | `security-headers.test.ts`, `kiosk-decoder.test.ts`, `e2e/kiosks.spec.ts` |

| Threat | Answer |
|---|---|
| A screenshot of a live code | Dead 15 s after its window changed (45 s at most): `expired` |
| The fixed My QR (or a screenshot of it) at a kiosk | `needs_live_code`, nothing paid |
| A live code relayed live by video | Pays its owner once per quest per 45 s, within the caps; burst flags; risk accepted (ADR-242) |
| One code held up twice, or two phones showing one code | One pay (the 45-s rule under the enrollment lock; the page drops a string it just sent for 5 s) |
| The operator who paired the kiosk scanning themselves | `self_scan` |
| Forged or junk codes probing the signature | Not Questify-shaped: dropped in the page; shaped but forged: counted, 10 a minute pause the kiosk |
| A prankster pausing the kiosk with forged codes | At most a minute per 10 codes, from in front of the camera; accepted |
| The tablet taken, or its cookie read through an unlocked browser | Works elsewhere until Revoke, the event's end + 24 h or 30 idle days, and pays only players whose live codes it is shown; the Devices page shows last seen and scans in the last 24 hours; pairing a kiosk shows the lock-the-tablet tip (Guided Access, screen pinning) |
| A device cookie of another kind (a station) | `kiosk-scans` refuses it (401) |
| A kiosk of event A scanning a player of event B | `not_in_event`; the door takes no quest or event argument |
| A removed or de-abilitied operator's kiosk | `paused` at the next scan and poll; a removal revokes it |
| A camera feed | Decoded on the tablet; no frame leaves the page; nothing stored |
| The kiosk's answer kept for retries | The idempotency store keeps each kiosk scan's answer (green or orange, with the @username and avatar; red with the reason only) under the principal `device:{id}` and the scan's key, in the API server's own memory (CranL, `riyadh-1`; never a third party), for 24 hours, then it is gone; no code, player id or score is in it |
| Personal data on a public screen | The @username and the Questify avatar on green and orange only (public on the boards already, FR-120); never a score, balance, rank, status, ban or name; a red card names no one |

### The big screen's scenes (T-504, ADR-365)

| ASVS area | Control | Proof |
|---|---|---|
| V8 authorization | `screen_ranking`, `screen_community` and `screen_poll` take no argument and read only `current_device()`'s event; a station, kiosk, pending, unactivated or revoked device is `DV401` / `device_unpaired`; every call re-checks the cookie, so a Revoke blanks the page at its next poll | `test/db/big-screen`, `test/screen/routes`, `security/outsider` |
| V8 tenant isolation | `big_screen` is closed to every role; `event_big_screen` and `set_big_screen` run through `award_event_of`, so another organizer's event is `AN404` | `test/db/big-screen`, `security/cross-tenant`, `security/routes` |
| V8 authorization (finale) | `screen_finale` takes no argument and reads only `current_device()`'s event; no place is read before `event_result.revealed_at` is set and a place carries no score; `set_finale` and `clear_finale` are the owner's alone (`LF403`) and run through `award_event_of` (`AN404`); `finale` is closed to every role | `test/db/finale`, `test/screen/routes`, `security/outsider`, `security/cross-tenant`, `security/routes` |
| V11 business logic | the ranking is the rank push's `rank_top_ten_ids` (active, unbanned, not on the organizer's team, with points); the add-on (`bigScreen`, FR-1729) is Questify's to unlock and a save is refused without it | `test/db/big-screen` |
| V2 anti-automation | 40 scene reads a minute per device; one shared 2-second answer per event and scene bounds the database however many screens poll | `test/screen/routes`, `scenes.test.ts` |

| Threat | Answer |
|---|---|
| A stranger opens `/{lang}/screen` | A pairing code and nothing of any event (T-309); the scenes come only after a team member pairs it |
| A stolen screen cookie | Reads the same public scenes until Revoke, the event's end + 24 h or 30 idle days; it can read nothing else (no argument names another event) |
| A private poll or a hidden category shown to the room | The poll scene shows only a sent poll in a category with no audience that is not hidden and not held by a community goal |
| A poll's results leaked early | By the poll's own policy: `at_close` until it closes and `never` show the number of voters only; counts only, never who voted. `after_vote` counts are also on the big screen for everyone in the room, voted or not (FR-634, public by design); the poll builder says so beside "When players see the results" |
| Personal data on a public screen | The @username and Questify avatar and points of the top 10 (public on the boards already, FR-120); a community goal's title and numbers; a poll's options; no name, email, rank history or reward |
| A banned or excluded player on the board | `ranking_eligible` (account, enrollment and team checks) is the board's rule and the screen's |

### Questify invitations (T-409, ADR-329 to ADR-334)

Core: consent, player privacy, tenant isolation and admin powers. A promotional SMS goes only to an opted-in adult, only
with the exact text a Questify admin approved, and an organizer never learns who was invited.

| Risk | Control | Proof |
|---|---|---|
| A message to someone who did not opt in (FR-1111) | One consent rule, `promo_pool` (active, of full capacity, opted in on SMS now, a phone), read by the fill and again by the claim for every message; `marketing_audience` is restated over it and is system-only | `test/db/invitation-campaigns` (the fill's exclusions), `test/db/invitation-sending` (opted out, phone removed, banned since the fill), `test/db/marketing` |
| A phishing line under Questify's sender | No organizer text; the admin approves the rendered message, `event_renamed` when the names changed since the preview, the names copied and frozen; the name rule refuses addresses, phone numbers and hidden characters (NFKC; control, format and default-ignorable characters; combining marks around a dot; also on the cut text); the promotional sender is never the service one (startup check) | `name-rule.test.ts`, `message.test.ts`, `config.test.ts`, "preview, rename, approve → 409", "rename after approval sends the approved text" |
| An organizer learning who was invited (FR-739) | Organizer answers carry only published counts rounded in SQL (`fewerThan 10` / multiples of 10), parsed with a strict schema; at least 50 recipients a send; audit rows without counts; a joins-after-send hint stays possible and is stated (ADR-332, T-807 line) | the property test over random counters, the audit-row test, `invitations/routes` |
| Another tenant's campaign, or a limited editor outside the event | `invitation_team_event` (tenant, scope, active owner or editor; IV404), the owner checked again (IV403) | `test/security/cross-tenant`, `test/db/invitation-campaigns`, `invitations/routes` |
| A duplicate SMS | A 60-second lease with a fresh token; expiry makes the row `unknown` and clears the token; an acknowledgement needs the same token; `unknown` is never sent again; the sender retries only a request that never left | the Finding 2 tests |
| SMS at night (FR-1738) | TypeScript's two bands plus SQL's fixed band on the claim's own clock, with the lease's 60 s margin | `quiet-hours.test.ts`, the claim's time table in `test/db/invitation-sending` |
| The invitation page leaking its token (T-409b) | `/[lang]/i` is never indexed and sends no referrer; it reads the token from the fragment once, removes it from the address (`history.replaceState`), keeps it in memory and sends it once; the page is the same for everyone and shows only the public event card; no language switch (it would drop the token) | `e2e/invitations.spec.ts` (no `#` left, one open call), `invitation-landing.test` |
| A guessed or forwarded invitation link | 122-bit random link token in the URL fragment (never in a server log or `Referer`); the open door answers the public event card only; 120 tries an hour per address before the token is read | `invitations/routes`, `test/db/invitation-sending` |
| Personal data kept too long | Recipient rows deleted 90 days after the campaign finished whatever their state, at once by erasure, and a row a fill inserted while its player's erasure committed at the next settle; no contact or text stored | the purge and erasure tests |

The three tables keep row-level security forced with no grant; the API role holds only the 13 doors; `promo_pool` and
every helper are granted to nobody (outsider suite, by name).

### Push notifications and the center (T-501 and T-501b, ADR-343 to ADR-351)

Core: personal data out of push text, consent, tenant isolation and outside calls. What reaches Apple or Google is a
token and a fixed text; everything else stays in the center, read only by its player.

| Risk | Control | Proof |
|---|---|---|
| Personal data in a push (rule 3) | Fixed templates per kind; placeholders only from an allowlist (`event`, `quest`, `category`, `reward` frozen as public names, `date`, `time`, the event's words); names cut to 40 and run through the T-409 name rule, else the nameless variant; the title is the event's name or "Questify"; the payload holds ids only (`n`, `k`, `e`, `r`), never a URL | `packages/shared/src/push/templates.test.ts` (allowlist, nameless variant, random-name property test), `apps/api/src/push/message.test.ts` (ids only, under 4 KB in both scripts) |
| A push to someone who left, was banned, erased, or is pending (FR-1703) | The fan-out writes a center row only for an active player passing the kind's membership rule and the event's status rule; the claim checks the player, membership, device, mute, consent and archive again and skips with the reason | `test/db/push-store` (§ Review 1), `test/db/push-sending` (every skip reason) |
| A hidden or targeted quest, category or reward named to someone who cannot see it | `notice_visible`: `sees_category`, `member_sees_quest` (member_event_quests' listing rule and the window, compared over the same fixtures), the reward's audience; at fan-out and at the claim | `test/db/push-store` (§ Review 7) |
| A promotion without consent (FR-1111) | A promotional kind gets a center row and a send only through `promo_pool('push')`, at fan-out, and is checked again at the claim; the OS permission is never consent, and nothing promotional reaches the center without the opt-in | "a token alone is not consent, so no center row and no send", "consent withdrawn after planning" |
| Taking over someone's pushes | A device is bound to the request's own live sign-in (the bearer token's hash and the caller); a token moves only to whoever registers it with their own session; sign-out, the 10-family limit and a reused refresh token stop pushes at once; 20 registrations an hour | `test/db/push-store` (devices), `test/push/routes` |
| Another player's center | Every center door binds the caller and checks an active player; a team or admin seat has no center; the six tables have no grant | `test/security/cross-tenant` (T-501), `test/security/outsider` (exact grant list) |
| A duplicate or lost push in an outage | One collapse id per message on every attempt; no attempt starts that could outlive its lease (the worker's own monotonic clock); a definite 5xx requeues, only a timeout after writing is `unknown`; the breaker holds a failing target; account refusals hold, never fail; ambiguous invalid-token waves hold the target instead of deleting tokens | `apps/api/src/push/send.test.ts`, `round.test.ts`, `targets.test.ts`, `test/db/push-sending` |
| A provider key or token leaking (T-501b) | The `.p8` and the service account's key are read once at start and kept as key objects (no log or inspect prints them); a malformed or partial setting stops the start with a message naming the setting, never its value; the clients log only an event, the target, a status and the provider's code (a plain word), never a device token, a bearer, the text or Google's message; APNs and FCM are called directly over TLS, with no relay | `apps/api/src/config.test.ts` (push providers), `apps/api/src/push/apns.test.ts` and `fcm.test.ts` ("puts no token, key or push text in a result or a log line") |
| A producer leaking what it was triggered by, or undoing its door (T-501d) | Each trigger and the due-scan door call only `notice_create` with ids in `refs` and public names and moments in `params`: never a ticket's text or reply, a review reason, the answer, points or an amount; a missing kind writes nothing and raises nothing, no `EXCEPTION` block, trigger functions are definers closed to PUBLIC; `push_due()` is system-only | `test/db/push-producers` (each kind once and to the right player only, "a broken kind cannot roll back the door", the text and ids-only payload), `test/security/outsider` (T-501d), `test/security/cross-tenant` |
| An event push naming what a member cannot see, or reaching who should not get it (T-501e) | The flash quest and the poll are checked with `member_sees_quest`, a boost and a category's opening with `sees_category`, at fan-out and again at the claim; a flash quest, a boost and an opening wait for their category to open (no notice and no marker before; a boost also waits for its community lock), and a category that unlocks after another is never announced; every kind skips a member who may not play (an operator kept from playing), a rehearsal account outside draft and scheduled, a left, pending, banned or erased member; a poll skips who voted; the community push names no quest; producers write ids only in `refs` and public names and moments in `params`; a missing kind writes nothing and raises nothing; the trigger functions are definers granted to nobody | `test/db/push-events` (each kind once and to the right members only, a hidden category, another organizer's member, "a broken kind cannot roll back the door", the re-checks at sending, the text and ids-only payload), `test/db/push-store` (live and ended: no rehearsal account), `test/security/outsider` (T-501e) |
| Data kept too long | Center rows 180 days; outbox rows 7 days after their end; devices removed after sign-out, 60 days unseen or 7 days after an invalid mark; erasure deletes notices, center rows, sends, devices and mutes, and settle removes what a racing fan-out wrote | `test/db/push-store` (erasure, retention) |

The six tables keep row-level security forced with no grant; the API role holds only the 12 doors (`push_due` added by
T-501d); every helper and trigger function is granted to nobody (outsider suite, by name).

### Signed-in devices and sessions (T-810c, ADR-710 to ADR-718)

- A player device is a refresh family with its own row, labelled from the app at sign-in with the platform and the
  `expo-device` model only: never an IP, a location, a user agent, the phone's own name or the `X-Device-Id`. A
  browser sign-in is labelled `web` by the web forwarder, never with a model (migration 0188 checks it, ADR-820); it
  counts in the 10 like a phone, and the devices list shows it as "Web browser". The model
  and platform are personal data: kept in Saudi Arabia, exported, erased with the account, never in an audit entry
  (`model` is on the audit key guard) or a log line (a label failure logs the error's class only).
- Ending another device or session needs a fresh factor (ADR-711), checked in the database; ending this one never asks.
  Every family end locks the device row first and a rotation of an ended family answers `invalid` (ADR-712, ADR-717),
  proven by the parallel tests in `apps/api/test/db/signed-in-devices.int.test.ts`. End-others locks its own device row
  with the others and re-reads it, so an ended device cannot end the others (0184). The sweep takes device rows first and
  skips any another call holds (`SKIP LOCKED`), in bounded batches; a skipped family's old rows go at a later sweep
  (`docs/rules.md`, "The player sign-in's lock order").
- Threat: someone holding the owner's unlocked phone can now change the number and sign the owner out everywhere else
  (ADR-120 amended). Compensations: the notice to the old contact, the audit entries (`player.contact_change`,
  `player.devices.end_others`) and support's sign-in reset.
- Ending sessions does not stop someone who knows a staff password: the console note and the RUNBOOK say to reset it.

### Audit hardening: public list, guest probe, logged data errors (tier B, 2026-11-11)

- `GET /v1/public/events` takes one attempt per address bucket (`public_list`, 240 a minute; a venue's phones share one
  address) after the query is parsed, so a bad request costs nothing; past it the answer is 429 `too_many_attempts` with
  `Retry-After`. A busy address lock does not refuse (`holdBack`'s `letBusyThrough`): phones opening Explore at the same
  moment still get the list, and only a real count over the budget does not. The join-code lookups keep their own
  wrong-code budget.
- `GET …/events/{eventId}/join/guests?contact=` confirms a full phone or email against the masked list, so each probe is
  counted per team member (`guest_contact_probe`, 30 an hour across events); the plain list is not counted. Past it 429
  `too_many_attempts`. A masked four-digit ending cannot be swept (10^4 probes) inside the limit. Known limits: the probe takes a
  non-waiting lock, so a double submit can get a busy 429; and the budget is per member, so several accounts on one team
  multiply it.
- `loggableError` keeps the text of a Postgres data exception (class 22, such as `22001 value too long for type
  character varying(10)`) but masks every quoted span (`"…"`) in the message and in the stack, because
  `22P02 invalid input syntax for type uuid: "<value>"` and its kind echo the offending value in quotes
  (`apps/api/src/conventions.test.ts`). Rule 3 therefore holds for a route that ever passes an unchecked value to a typed
  parameter.
- A real player's stamp of a review-demo step is refused (`QC404`, no enrollment) and the guard
  `review_demo_member_guard` keeps them out of the demo event (`RD404`): the demo's static codes are signed with the
  production keys, so this confinement is what makes them useless to anyone else
  (`apps/api/test/db/review-demo-codes.int.test.ts`).

## Top abuse cases

| # | Abuse case | Type | Mitigation |
|---|---|---|---|
| 1 | A player on organizer A reads organizer B's data by changing an id | Information disclosure | Authorization check on every object, an `organizer_id` on every tenant row, row-level security in PostgreSQL, and outsider tests using only the public credential (NFR-016, NFR-018) |
| 2 | Scripts spam the completion call, replay requests or forge QR contents | Tampering | Signed QR payloads with a version (regenerate kills old ones); idempotency keys; unique (enrollment, quest); rate limits; flags for bursts and impossible speed (ADR-041) |
| 3 | A fake score from a modified mini-game | Tampering | Built (T-305, ADR-212): the database issues a seeded round with its own clock and frozen level; the API replays the inputs with the round's engine version and never trusts a reported score; impossible inputs, a claimed result the replay does not give, or more play time than the server saw refuse the round (it counts as played, a `minigame` flag is raised, the reason never reaches the player); unlikely play is paid and flagged. Accepted: the seed reaches the phone, so a modified app can see the layout; targets sit below perfect play and the reward is one quest's points once (Q-176) |
| 4 | SMS pumping: someone requests thousands of codes to run up Questify's SMS bill | Denial of service / cost | Saudi mobiles only; every SMS sent (first and resent) counts per number (5 an hour, 10 a day), per install (10 an hour) and per address (a ceiling only: 200 an hour, plus 2 for each contact that typed a right SMS code from that address in the hour, up to 2,000, so a venue earns room and a pumper does not; an email code earns email room only; each contact earns once an hour; T-804b, ADR-691: a pumper gains about one SMS per Saudi SIM it holds and types a code from); a platform ceiling (5,000 an hour, Q-093, data in `platform_send_budget`, 16 stripes taken without a held lock, ADR-690) refuses with the email offer (T-107). **Weak spot:** an IPv6 client is bucketed by its /64, and one subscriber often holds a whole /56 or /48, so it can spread requests over 256 or more address buckets; the per-number, per-install and platform windows are the walls that still hold (T-804b plan review). Still to come: the cost alert in the usage view and a challenge after repeated requests (ADR-099 risk) |
| 5 | Phishing or takeover of an admin or owner mailbox | Spoofing / elevation | Password + email code; short sessions; admin session list and forced sign-out; every admin change logged (console reads from T-701, Q-116); alert on new admin sign-in |
| 6 | An operator or kiosk misuses scanning to award points | Elevation of privilege | Per-operator abilities and quest limits (owner only, ADR-139); removal refuses the next scan at once; every station scan needs a signed My QR, pays at most the quest's cap, once per operator, player and quest in 10 seconds, and names the operator in the append-only record (F-110); no station rate limit: T-209 flags bursts |
| 7 | Stolen or shared pass/QR used at the prize desk | Spoofing | My QR is fixed and only identifies the player (ADR-137): a handover needs the player's accept in their own app (T-206); the player can replace a leaked code at once; the desk also checks the reservation and open flags |
| 8 | Uploaded files carry malware or inappropriate content | Tampering | Built for photos (T-301b, ADR-828): a private bucket per environment; JPEG, PNG or WebP by magic bytes only (HEIC, SVG and anything else 415), 8 MB, 32 MP; re-encoded by sharp to an upright JPEG with no metadata (EXIF, GPS and profiles go); stored under a key the database builds; read only through 5-minute signed URLs on the bucket's host (never our origin; `img-src` names that one host, the `<img>` sends no referrer); only the event team sees a photo (FR-205). Report and unpublish of photos come with T-504b (no player sees one before) |
| 9 | Organizer-written text injects script into the dashboard or app | Tampering | Output encoding everywhere, no raw HTML in texts, content-security policy on web pages |
| 10 | Leaked signing keys (wallet certificate, push keys, `QR_SECRET`, `REWARD_CODE_SECRET`) | Information disclosure | Keys only in the secret store, access limited and logged; expiry alerts; rotation procedure written before launch (`QR_SECRET`: RUNBOOK; `REWARD_CODE_SECRET`: RUNBOOK "Rotating `REWARD_CODE_SECRET`", a re-seal that keeps every code readable, T-810f). A reward code reaches only the player who redeemed it: never a log, an audit row, an error body or the dashboard; the in-memory idempotency cache holds the reserve answer for its replay, so a shared or persistent cache must exclude it |
| 11 | A script injected into the web origin (XSS) acts as the signed-in player (T-803 P2) | Elevation of privilege | The origin also serves the dashboard, the kiosk pages and organizer content. The player cookie is HttpOnly, so a script cannot read or carry away the tokens, but it can act as the player through the cookie for as long as the page is open, including a contact change (pathway row 13 sends the code only to the new contact), which is a lasting account takeover. **Ship gate:** no production `/play` and no cookie issuance until P3's `/play` content-security policy is in; the forwarder's cookie steps stay behind `PLAYER_WEB_SESSION`, off by default. **P3 (2026-11-10):** the `/play` CSP is in (ADR-822: `script-src 'self' 'wasm-unsafe-eval'`, no inline script, `connect-src 'self'`, `frame-ancestors 'none'`; camera and location for `/play` only); the switch is on in `ops/cranl/staging.json` and not in production, where Dhia turns it on. A step-up code for a contact change from a `web` family is Q-758 |

### Photo storage (T-301b, ADR-828)

| Wall | Where it holds |
|---|---|
| No table right: `media_object` and `media_delete` are RLS forced with no grant; eight definers are the only doors, the worker's five refuse every seat but the system's | `test/security/outsider` (photo storage), `test/db/media` |
| A key names its own tenant: the CHECK `media_object_key_prefix` ties it to the row's organizer, event, purpose and id; no request field reaches a key | `test/db/media` "forces the key" |
| A photo is attached only by its uploader, in its event, for its purpose, stored and younger than 30 minutes, locked while attached | `test/db/media`, `test/security/cross-tenant` "keeps photos" (B's photo id from A's seat is SM404) |
| A URL is signed only for a key one of the seat-checked readers returned (`award_event_of`, `review_operator`, `help_operator`, `inbox_abilities`, `ticket_admin`); an editor scoped to one event gets no key of another | `test/security/cross-tenant` "keeps photos", `test/submissions/photo` |
| Deletion cannot be skipped: a rejection, removal, erasure, rehearsal wipe, ticket purge, event deletion, sweep or 365-day purge each queues the key; the worker deletes after its claim commits | `test/db/media` "deleting by construction", `test/storage/worker` |
| Organizer images (ADR-829): the team uploads only inside its organizer and event scope (`award_event_of`); a holder names only a stored image of its own event and kind (`media_images_use` MI422; the map and sponsor columns' composite keys); the two read doors give a key only to an active member of the event (not suspended) or the team in scope, every refusal one 404, never a player's photo | `test/db/organizer-images`, `test/security/cross-tenant` "keeps organizer images", `test/storage/image-routes` |
| No open redirect: the web forwarder passes `location` only from the two image read paths and only when it is on the photo bucket's own https origin (`MEDIA_HOST`); anything else there answers 404. The app asks for JSON and loads the URL itself, so its token never follows a redirect to the bucket | `apps/web/src/lib/forward-headers.test.ts`, `test/storage/image-routes` |
| Bucket credentials: `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` live in the CranL secret store (operator-set), never logged; storage logs carry the operation, the key's purpose and the status only. **Before production:** a key that opens only that environment's bucket (CranL keys are probably account-wide), proved by the contract test's unsigned list returning 403 | `src/storage/client.test.ts` |

## Secrets policy

Secrets live in environment variables injected from the cloud's secret store. Never in code, git,
logs, chat or docs. Separate values per environment. Rotated when a person with access leaves, on
suspicion, and before certificate expiry. A pre-commit and CI secret scan runs on every change.
The inventory of every key, what it may and may not be used for, who holds it and what a rotation breaks is the
next section.

## Cryptographic inventory and key policy (T-810; ASVS V11.1.1, V11.1.2)

Read from the code and `ops/` on 2026-11-06; each row names its file. A task that adds, removes or changes a key,
secret or algorithm updates this section in the same commit (CLAUDE.md, "How the docs are kept"). No secret value is
written here, only names, algorithms and rules.

**Key policy.**

1. **One secret per job, kept in the secret store only.** `AUTH_SECRET`, `QR_SECRET` and `REWARD_CODE_SECRET` are three
   separate values of 32 characters or more. The API refuses to start without any of them and has no default
   (`longSecret`, `apps/api/src/config.ts`). `ops/cranl/*.json` declares each as `{"secret": "generate"}` (32 random
   bytes, base64url, made once by `pnpm infra apply`, `scripts/cranl/apply.mjs`) or `{"secret": "operator"}` (supplied
   from the operator's shell). The settings are read once at start (`apps/api/src/server.ts`), so a new value takes
   effect on the next deploy. No deployed value is in the repository, a log, an audit entry or an error (tests use throwaway values), and CI
   holds none: `.github/workflows` contains no `secrets.` reference.
2. **Not shared between services.** Only the API process holds the three secrets and the provider keys. The web app's
   settings are `API_ORIGIN`, `DASHBOARD_ORIGIN`, `PLAYER_WEB_SESSION` and two store links, none secret (`apps/web/src/lib/config.ts`); the phone app holds only its own
   session tokens, in the keychain or keystore; the database holds hashes, sealed values and tags, never a secret; the
   monitoring app holds its own passwords (`ops/cranl/*.json`).
3. **One key per purpose.** Where one secret serves several purposes, each purpose has its own derived key (HMAC-SHA-256
   with a label, or HKDF-SHA-256), so a value made for one purpose is not accepted for another
   (`apps/api/src/auth/keys.test.ts`, `apps/api/src/quests/qr.test.ts`, `apps/api/src/rewards/codes.test.ts`).
4. **Random values come from the operating system's generator** (`crypto.randomBytes` and `randomInt`; `gen_random_uuid()`
   for row ids). Four uses are not cryptographic and protect nothing: the install id and Idempotency-Keys in the phone
   app (`apps/app/src/api/uuid.ts`, `Math.random`), the throwaway password of `dummyVerify` (`apps/api/src/auth/password.ts`),
   the demo organizer's slug and the demo event's join code, which is given to the store reviewers anyway (migration
   0144, `md5(random()::text)`), and the jitter of the background loops.
5. **Rotation is event-driven**: when a person with access leaves, on suspicion of a leak, and before a certificate or
   key expires ("Secrets policy", above). There is no routine schedule and no owner other than the operator (Q-700).
   Steps are in the RUNBOOK where they exist; the last column says what each rotation breaks, so the choice is made
   knowing the cost.
6. **Retirement.** A rotation replaces the value in the secret store. `REWARD_CODE_SECRET` is the one that keeps its
   previous value for a while: until `reward-codes.cjs check` exits 0, and database backups taken before the re-seal
   need it until they expire (RUNBOOK, "Rotating `REWARD_CODE_SECRET`", step 4).

| Key (setting) | Algorithm and form | Used for | Never used for | Holder and store | Rotation, and what it breaks | Code and proof |
|---|---|---|---|---|---|---|
| `AUTH_SECRET` (root), 32+ characters, with `AUTH_KEY_ID` (1 to 255, default 1) and, only during a rotation, `AUTH_PREVIOUS_SECRET` and `AUTH_PREVIOUS_KEY_ID` (ADR-826) | Each purpose key is `HMAC-SHA-256(AUTH_SECRET, "questify/auth/v1/<purpose>")`, 32 bytes. A value is then `HMAC-SHA-256(purpose key, value)`, 32 bytes. Compared in constant time (`timingSafeEqual`) | The 20 purposes in the next eight rows, and only those; the previous secret derives `marketing-opt-out` only | Signing a session (sessions are random tokens), signing a QR (that is `QR_SECRET`), encrypting anything, leaving the API process | The API process; CranL secret store (`generate`). `staff.cjs clear-throttle` also reads it | RUNBOOK "Rotating `AUTH_SECRET`": open sign-in codes stop and every throttle window restarts; sessions stay valid. What else breaks is in the next eight rows (the RUNBOOK sentence "nothing stored depends on it" was wrong and is corrected, Q-700) | `apps/api/src/auth/keys.ts`, `keys.test.ts` |
| derived: throttle keys `throttle-email`, `-address`, `-user`, `-organizer`, `-player`, `-player-quest`, `-device`, `-contact`, `-paired-device`, `-event` (10) | HMAC-SHA-256 of the identifier | Naming a counter row in `auth_throttle` without storing an email, an address or an id | Authenticating anyone | The API; the table holds only the 32-byte result | Every counter restarts; nothing is lost | `apps/api/src/auth/keys.ts`, `apps/api/src/auth/throttle.ts` |
| derived: one-time code hashes `player-code` (player sign-in, contact change, step-up), `code` (staff sign-in, sign-up, step-up), `deletion-code`, `email-change-code` (4) | HMAC-SHA-256 of `challenge id`, a newline, then the code | The stored form of a code that lives 5 to 10 minutes: the database holds only the hash | One kind of code verifying as another; keeping a code | Challenge rows in PostgreSQL | Open codes stop working; people ask for a new one | `apps/api/src/auth/keys.ts`, `apps/api/src/players/sign-in.ts`, `apps/api/src/auth/sign-in.ts` |
| derived: `contact-lookup` | HMAC-SHA-256 of the normalised phone or email | Finding a contact's earlier challenges without storing the contact twice | Authentication | The API; challenge rows | Challenges open at that moment are not found | `apps/api/src/players/sign-in.ts` |
| derived: `device-pairing-code` | HMAC-SHA-256 of the normalised 8-character pairing code | The stored form of a pairing code (valid 10 minutes) | A device secret (that is a random token) | `device_request` rows in PostgreSQL | Pairing codes shown at that moment stop working; the screen asks again | `apps/api/src/devices/devices.ts` |
| derived: `deletion-fingerprint` | HMAC-SHA-256 of the normalised phone or email | The mark an erased account leaves for ban and welcome checks, so the contact cannot be found by hashing every Saudi number | Authentication | The API; the marks in PostgreSQL | **Loses every mark** and there is no previous-key slot to keep them (Q-141): a rotation of `AUTH_SECRET` forgets bans and welcome marks | `apps/api/src/players/sign-in.ts`, `docs/SECURITY.md` "Data protection" |
| derived: `marketing-opt-out` (the opt-out HMAC) | First 16 bytes of `HMAC-SHA-256(key, key id, newline, player id, newline, channel)`, in a 34-byte token `id16 ‖ channel1 ‖ keyId1 ‖ tag16` (46 base64url characters); read under the key its id names, exact length and canonical spelling only | The link in every promotional message that switches that player's marketing off for that channel | Anything but switching marketing off | The API; stateless, nothing stored | Links already sent keep working while the old secret is held as `AUTH_PREVIOUS_SECRET` (90 days, Q-763; at once removed after a leak), then stop; the player can still switch consent off in the app (ADR-826) | `apps/api/src/marketing/opt-out.ts` |
| derived: `email-change-link` | `HMAC-SHA-256(key, purpose, newline, change id)`, 256 bits, base64url; stored as SHA-256 | The confirm and Stop links of an owner email change | Any other link | The API; only the hashes are stored | Links of open changes stop working; the admin cancels and starts the change again | `apps/api/src/auth/email-change.ts`, `apps/api/src/console/owner-email.ts` |
| derived: `reviewer-code` | HMAC-SHA-256 of the typed code | The stored form of the App Review fixed code | Any other code | `review_demo` row | "A rotated `AUTH_SECRET` invalidates the code and the number's stored key: Prepare again" (RUNBOOK) | `apps/api/src/console/review-demo.ts` |
| `QR_SECRET`, 32+ characters, its own value | Each purpose key is `HMAC-SHA-256(QR_SECRET, "questify/qr/v1/<purpose>")`. A code is a format byte, a 16-byte id, a 4-byte version or window, and the first 16 bytes (128 bits) of `HMAC-SHA-256(purpose key, those 21 bytes)`: 37 bytes, 50 base64url characters, decoded strictly | Eight purposes, by format byte: quest `0x01` (printed quest QR), my `0x02` (a player's My QR), operator `0x03` (operator invite), step `0x04` (passport step), reveal `0x05` (hidden category), tag `0x06` (NFC tag), screen `0x07` (a station's 30-second code), live `0x08` (a player's 30-second kiosk code); and `questify/nfc/v1/ticket` (the NFC write ticket: four ids and an expiry, 300 seconds, 16-byte tag) | Encrypting or hiding anything: a code holds ids only and signs, it does not protect data; a code of one purpose opening as another | The API process; CranL secret store (`generate`) | RUNBOOK "Rotating `QR_SECRET`" (written for the quest QR). All eight purposes die at once: printed quest, step and reveal sheets must be reprinted (Print codes shows new ones), written NFC tags rewritten, operator invite links already sent are dead; My QR, live and screen codes and tickets are drawn again on the next request. Not needed on a clock: the key signs, it does not encrypt | `apps/api/src/quests/qr.ts`, `apps/api/src/nfc/ticket.ts`, `qr.test.ts` |
| `REWARD_CODE_SECRET`, 32+ characters, its own value, with `REWARD_CODE_KEY_ID` (1 to 255, default 1) and, only during a rotation, `REWARD_CODE_PREVIOUS_SECRET` and `REWARD_CODE_PREVIOUS_KEY_ID` | HKDF-SHA-256 (salt `questify/reward-code`, info `questify/reward-code/v1/seal` or `/mark`, 32 bytes; each organizer's mark key is HKDF-SHA-256 from the mark key, empty salt, info `questify/reward-code/v2/mark/<organizer id>`, ADR-827). Seal key: AES-256-GCM, a fresh 12-byte IV, a 16-byte tag, associated data = the header `0x51 0x02 keyId` and the reward id. Mark: HMAC-SHA-256 of the normalised code under the organizer's mark key, compared only inside one event | Sealing the digital reward codes organizers upload (the cipher), and a keyed mark that finds a code uploaded twice without opening it | Anything but reward codes; a log, audit entry, error, cache or the dashboard (SECURITY abuse case 10) | The API process; CranL secret store (`generate`). Sealed values and marks in `reward_code` | RUNBOOK "Rotating `REWARD_CODE_SECRET`": a ring of the current key and one previous key; `reseal` moves every code (and re-marks a row whose mark is not its organizer's), `check` proves both. **Losing the secret makes every code sealed under it unreadable.** Backups taken before the re-seal need the old secret | `apps/api/src/rewards/codes.ts`, `apps/api/src/rewards/reseal.ts`, `codes.test.ts`, `apps/api/test/rewards/reseal.int.test.ts` |
| Staff passwords (no key) | argon2id (`@node-rs/argon2`): memory 19,456 KiB (19 MiB), 2 passes, 1 lane, the library's random salt kept inside the hash string; the password is NFKC-normalised first, 12 to 128 code points. A hash with other parameters is made again at the next right sign-in (`needsRehash`) | `staff_user.password_hash` | Players (they have no password); any other secret | PostgreSQL | Changing the parameters re-hashes on sign-in. Reset and change end every session | `apps/api/src/auth/password.ts`, `password.test.ts` |
| Random tokens and codes (no key) | 256-bit `randomBytes` tokens held as their SHA-256 (an unkeyed hash is enough for a random 256-bit value): staff session, player access and refresh token, device cookie secret, password reset link, team invite link, sign-up, challenge and deletion tokens, survey results link. 128-bit tokens: meet codes (the review demo's included) and the Questify invitation link (migration 0153, the first 16 bytes of SHA-256 over two `gen_random_uuid()` values). 6-digit codes by `randomInt` (about 20 bits, bounded by attempt limits, see "Sign-in pathways"). Pairing code: 8 of 31 characters, `randomInt`, about 40 bits | The secrets people and devices hold | Use as a key | The holder; PostgreSQL stores only the SHA-256 of the 256-bit tokens. The Questify invitation link is stored in clear (`invitation_recipient`, 0073; it opens only the public event card and one `opened` count, and the rows are purged 90 days after the campaign; hashing it is in FOLLOWUPS) | A bearer token ends by revoke, expiry or rotation of its family; nothing to rotate centrally | `apps/api/src/auth/keys.ts`, `apps/api/src/devices/pairing-code.ts`, `apps/api/src/plays/meet.ts` |
| APNs auth key, the `.p8`: `APNS_PRIVATE_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | ES256: ECDSA P-256 with SHA-256, signature as the raw r and s (`ieee-p1363`), in a JWT with `kid` and `iss` (team id) and `iat`. The JWT is re-signed every 40 minutes and once after `ExpiredProviderToken`. The key must be an EC P-256 private key or the API will not start | Authenticating to `api.push.apple.com` and `api.sandbox.push.apple.com`, one key for both | Anything else | The API process, which reads it once at start and holds it as a key object that prints nothing. **Not yet provisioned:** the four settings are not in `ops/cranl/*.json`; the push go-live checklist waits for Dhia's keys | Replace the four settings and deploy. No RUNBOOK steps, and no expiry alert (`docs/SLO.md` §2, T-018b) (Q-700) | `apps/api/src/config.ts`, `apps/api/src/push/apns.ts`, `apps/api/src/push/apns.test.ts` |
| FCM service account: `FCM_SERVICE_ACCOUNT` | RS256: RSA private key signs a JWT (1 hour) exchanged at the account's `token_uri`, which must be exactly `https://oauth2.googleapis.com/token`, for an access token with scope `firebase.messaging`; cached until 5 minutes before it ends | Sending push through FCM HTTP v1 | Anything else | The API process. **Not yet provisioned** (not in `ops/cranl/*.json`) | Replace the setting and deploy; no RUNBOOK steps (Q-700) | `apps/api/src/auth/google-token.ts`, `apps/api/src/push/fcm.ts` |
| Gmail service account: `GMAIL_SERVICE_ACCOUNT_KEY`, `GMAIL_ACT_AS` | RS256 as above, scope `gmail.send` only, subject `GMAIL_ACT_AS` (domain-wide delegation) | The email Questify sends: sign-in, sign-up, reset and step-up codes, invites, notices, alerts (Resend is the backup) | Reading mail; any other scope | The API process; operator-supplied into the secret store | Replace the setting and deploy; creating the Google key is in RUNBOOK "Email sending" and nothing says how to retire the old one (Q-700) | `apps/api/src/auth/google-token.ts`, `apps/api/src/auth/email/gmail.ts` |
| Provider and infrastructure credentials (not cryptographic keys, listed so the secret store is complete) | `MSEGAT_USERNAME`, `MSEGAT_API_KEY`; `RESEND_API_KEY` (not set in `ops/cranl/*.json`); `DATABASE_URL` (the API's own role, not the owner, set by CranL's connect); `REDIS_URL`; `APP_ROLE_PASSWORD` and `DATABASE_ADMIN_URL` (the owner, given for a command; RUNBOOK "Database and deploy" removes it from the app environment afterwards); `CRANL_API_KEY`; monitoring: `METRICS_PASSWORD` (24+ characters) with `METRICS_PASSWORD_HASH` (bcrypt), `GF_SECURITY_ADMIN_PASSWORD` (24+), `GF_SECURITY_SECRET_KEY` (32+, signs Grafana's stored data source password), `OTEL_EXPORTER_OTLP_HEADERS`, optional `ALERT_SMTP_PASSWORD` | Authenticating to those services | Anything else | The API, the monitoring app or the operator; CranL secret store | Monitoring password: every six months and on leaving (RUNBOOK "Rotating the password"). All others: no steps and no schedule; the database and Redis passwords are static (Q-664, Q-700) | `apps/api/src/config.ts`, `ops/cranl/production.json`, `apps/api/src/migrate-cli.ts`, `ops/monitoring/stack/render-config.sh` |
| Unkeyed digests | SHA-256 for response validators (`apps/api/src/etag.ts`), migration checksums, budget bucket names and request fingerprints (`apps/api/src/conventions.ts`); SHA-1 only for the first 5 hex characters sent to Pwned Passwords (`apps/api/src/auth/breached.ts`); MD5 only for non-secret fingerprints and ids in SQL and the rehearsal's `TEST-` code (`apps/api/src/rehearsal/rehearsal.ts`) | Equality and change detection | Protecting a secret anyone could guess | n/a | n/a | the files named |
| TLS and certificates | Questify holds no certificate and no TLS private key. TLS 1.2 or 1.3 ends at CranL's edge; its versions, ciphers and certificate are CranL's and unconfirmed (Q-664). The web app reaches the API over CranL's private network by plain `http` on purpose (`apps/web/src/lib/config.ts`). `DATABASE_URL` carries no `sslmode` and `REDIS_URL` may be `redis://` (Q-664). Every outside call is `https` to a constant host, with Node's default certificate checks: nothing in the repository sets `rejectUnauthorized`. APNs and FCM use HTTP/2 over TLS. A release build of the phone app with plain `http` stops at start | n/a | n/a | CranL | Not Questify's to rotate; confirm with CranL in T-811 (Q-664) | `apps/api/src/outbound-redirect.test.ts`, Q-664 |
| Not built | Wallet signing (the Apple Pass Type ID certificate and the Google Wallet service account, T-801) and device attestation keys (INTEGRATIONS: "flags only") are not in the code. App store signing credentials are held by Expo EAS, Apple and Google and are not in the repository | n/a | n/a | n/a | T-801 adds its rows (ASVS sheet, "Scope") | `docs/INTEGRATIONS.md` |

## Data protection

- In transit: TLS everywhere, HSTS on web pages.
- At rest: encrypted storage by the cloud; extra column encryption for prize codes.
- Residency: all personal data in Saudi Arabia (ADR-070); the exceptions are push tokens/text (the device token and
  a fixed template with public names only, sent straight to APNs and FCM with no relay, T-501),
  wallet pass content, device-integrity attestations (Apple App Attest, Google Play Integrity), the Play Install Referrer, any foreign email provider (staff mail, and player sign-in codes by email until Q-034 is
  answered: only the address and the code pass through, ADR-117) and the Pwned Passwords range API (5 hex characters of a password's SHA-1, no personal data), each listed in the data map (NFR-020) and on the
  counsel list.
- Meet codes (T-303c, ADR-209): a 128-bit random token per code, alive one minute, used once; it travels only in a
  request body and in the QR, and only its SHA-256 hash reaches the database (compared by equality on a unique
  index: a guess is a lookup miss). Refusals and logs never echo it. `meet_pass` and `meeting` have no grant and no
  policy; only `issue_meet_pass`, `meet_pass_state` and `meet_player` are executable, by the API role only (outsider
  suite). The scanner learns the other player's username and avatar only; a refusal for the other player's reasons
  is one generic `not_for_them`.
- Location (T-303b, ADR-206): read only while the app is open and only with a request that uses it; it travels in the request body (never a header or query); no coordinate is stored, only rounded distances, accuracy and the mocked mark in `completion_position`, which no API role can read; refusals never echo the numbers; the database must not log bound parameters (a test checks the settings; CranL checked per RUNBOOK before the switch goes on). A check-in proves only what the phone claims.
- Minimisation: no ad networks or tracking SDKs; location only while the app is open; photos only
  through the system picker or camera (NFR-021).
- Deletion (T-217, migration 0038, ADR-175 to ADR-178 Proposed): one transaction (`erase_player`) turns the account into a
  tombstone (id and status only); contacts, sessions, refresh tokens, username history, acceptances, join answers,
  flags, device ids, ledger-note reasons and operator assignments go; the ledger, enrollments, frozen results and
  handed-over prizes stay, naming no one; audit rows hold ids only already. It takes a fresh one-time code (its own
  challenge, which can never sign in; ASVS re-authentication) and a 10-minute single-use deletion token. The public
  code request always writes a challenge and sends after the answer, so a known and an unknown contact look the same.
  The fingerprint is an HMAC under a key derived from `AUTH_SECRET` (`deletionFingerprint`): rotating that secret
  loses the ban and welcome marks (Q-141); a plain hash would not do, every Saudi number can be hashed in minutes.
  The deleted player's remembered idempotency answers are dropped (`forget`), so none of their responses replays. No
  restore after deletion (ADR-094).
- What an organizer reads about a player (closed in T-208, migration 0019): the join card (FR-121, version 0.1)
  discloses the username and avatar, points and quests in the event, and prizes collected (PD-17). Organizers no
  longer read `player` at all; `event_players` returns those columns only (tested: no birth year, no contact, a
  cross-tenant probe). `enrollment_read` still lets the organizer seat read `enrollment.player_id`; the API never
  returns it, and the dashboard reads enrollments through definers as it grows.
- Accepted risk (T-208): the exclusion list can work as a lookup. An owner who adds a phone number and watches the
  board can learn which username has it, though organizers never see contacts. FR-319 needs the behaviour; it is
  kept small: no "excluded" flag in any answer, at most 500 entries an event, every add and remove audited (the kind,
  never the value), phones masked in every answer.
- Changing a phone or email (T-108, ADR-120 Proposed): the code goes to the new contact only; the old one is not
  re-proved (ASVS 5.0 V7.5.1 asks for re-authentication; a player who lost their number cannot give it). Compensating
  controls: a fresh code to the new contact, notices to the old value and the other channel on every change and add,
  the audit entry, sessions kept so the real owner can change it back, support for the rest. No new account-existence
  oracle: whether another account has a contact is said only after its code is entered, so only someone holding it
  learns it; every request counts in the player's window, refused ones too.
- The app's session (MASVS-STORAGE, T-111 app half): the access and refresh tokens are one item in the phone's
  keychain or keystore (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: never in a backup to another device),
  never in AsyncStorage. The first launch of an install clears that item, because the iOS keychain outlives an
  uninstall. A store that cannot be read (a lost Android key) counts as no session. One refresh is in flight at a
  time; only the API's 401 to a refresh ends the session. A release build without its API address, or with plain
  http, stops at start (MASVS-NETWORK).
- Backups (target, NFR-026): point-in-time, copied to a second place in Saudi Arabia that we control, restore rehearsed.
  **Today:** CranL offers neither point-in-time restore nor a second-region copy (ADR-107 addenda); staging holds only
  test data, and the nightly copy with a proven restore is T-019, required before the first real player.

## Tests that prove it

- An **outsider suite** holding only the public credential must be able to do nothing it should not
  (global standard; NFR-017, NFR-018).
- Cross-tenant tests: an editor of organizer A against every route of organizer B returns 403/404.
  Built in T-012 (`apps/api/test/security/`): every table is classified as owned or shared, and for each owned
  table organizer A (or another staff member, or another player) can read none of the other side's rows beyond what
  is public by design (organizer names, public events and their add-ons), change or delete none through any column
  it may update, and forge none. Every route is listed with how it keeps callers apart.
- Load test at 20,000 completions per minute before the first event (NFR-003).
- A restore rehearsal and an SMS-pumping simulation before launch.

### T-402 cosmetics and public-profile evidence (core GO95; final integration gate pending)
Ownership grants originate only from reached-level inserts in the XP transaction; no direct catalog/inventory/
equipment rights exist for the API. Composite ownership FKs and setter kind checks prevent forged equips; direct
avatar writes are revoked. Rename/equipment failure rolls back every field. Active caller checks live inside each
definer, not only HTTP guards. Own locker/acknowledgments never accept a recipient ID. Public profile is a separate
five-field DTO, excludes deleted/platform-banned targets and never returns owner contacts, XP, source events or
history. Read rate limits and no-store apply; URL logger redacts public usernames/query values.
Evidence: `test/db/profile-items.int.test.ts` (forged/read/write denial, kind, replay, pagination, erasure races),
`test/db/profile-upgrade.int.test.ts` (both old/new erasure orders and in-flight XP barrier),
`test/players/items.int.test.ts` (exact HTTP allowlist, active targets, refusal/atomicity, cache and limit),
`src/app.test.ts` (log redaction), all outsider/cross-tenant/route guards, ranking DB/Redis suites. Lifetime grants
survive rehearsal wipes because rehearsals never produce XP/reached; no inventory FK targets wiped event rows.
Per-player blocks remain FR-1415/T-705 and must filter this new public-profile read; event bans are not platform bans.
The app's owner-profile loader generation is invalidated at sign-out, forced end, a superseding reload and provider
cleanup; both awaited reads check it before publishing. Sign-out removes private state immediately and blocks new
profile reads until logout settles. `apps/app/src/auth/player-state.test.ts` exercises deferred real-session
responses: late private data after sign-out, A→B replacement, stale failures, forced end and cleanup never restore
the old account. This closes the MAJOR in the first independent code review88; fresh re-review GO95 confirms the
fix with zero BLOCKER/MAJOR. The coordinator's combined full-suite integration gate remains pending.

Souvenir replay boundary (T-402b): current resource authorization must precede cached idempotent replay, including
a same-organizer event-scope revocation while staff membership stays active. These routes use preValidation
before the global cache preHandler and retain SQL authorization in each mutation. Real middleware tests first
prove a successful cached replay, revoke only event scope, then require404/no replay header/no private cached
body for all six mutation doors, including processing. This finding and repair are scoped to souvenirs; other
routes are not asserted vulnerable without evidence.

### Home blocks written by the organizer (T-610, Proposed ADR-395)

Authenticated owners and editors write short bilingual texts, quick links and banner slides that every player of their event reads on Home.
Text is plain: the server removes invisible and control characters, bounds every field and refuses a field no block has; the app and the
dashboard draw it as text, with no HTML or Markdown and nothing tappable inside it. A tap goes to a screen of the app, one quest of the
event, or an https link with a full host name, no user info and no control characters; the player is shown the host and agrees before the
browser opens; `javascript:`, `http:`, `intent:`, `tel:` and every other scheme are refused on save and left out on read. A quest or reward id
is looked up only in the reading player's own lists, so an id of another event draws nothing. The composed configuration, which a public
event serves to anyone, carries the content of shown blocks only. A damaged stored value reads as less content, never as an error, and the
reader holds no pattern release Hermes cannot compile. This is a filtered staff copy boundary, not a classifier: a phone number or address
written in plain words is allowed (Q-362, decided): organizer-written text (text cards, slides, links) may contain contact details the organizer chose to show their own players. The audit guard checks key names only, never values, so that text also sits in the `event.layout.update` entry (the author and the layout), readable by the organizer's own team and Questify admins; it is not sent in a push or written to a log. The layout is control-character clean on save (`cleanBlockText`), so a NUL cannot reach the JSON write.

### Organizer announcements (T-502, Proposed ADR-358)

Authenticated, event-scoped owners/editors may publish bounded bilingual copy to their own active members. Shared
name-rule filtering rejects addresses/phone numbers/remaining controls; invisible characters are removed first and
all four fields checked. The push renderer rechecks frozen text before any vendor payload. This is a filtered staff
copy boundary, not a general profanity/PII classifier: spelled-out addresses may pass; audit identifies the author
without recording text. A compromised editor is bounded to 3 sends/hour and 10/day per event by the serialized DB
door (future reservations included); a replay is checked before the cap. No email/SMS path or channel field exists.
Forced-RLS announcement rows have no direct rights; only five caller-checked definers are granted. Mutations check
current event scope before cached idempotent replay. Member reads bind active caller enrollment and rehearsal.
Scheduled release rechecks lifecycle/lateness and locks the same row as cancellation; text is frozen. The table-diff
channel test and full live-catalog outsider/cross-tenant inventory cover the new surface. No deployment performed.

### Places only on the ranking (T-611, ADR-396)

An event may set its ranking to places only (FR-1832). The score is then taken out of the answer on the server, not hidden by the client:
`GET /v1/events/{id}/ranking` (whole event and today) and `GET /v1/events/{id}/results` carry no `score` for any row, `me` or place, built field
by field, and say `scores: false`; the app draws a score only when the answer holds one. A configuration that cannot be read, or a stored `scores`
value that is present but not understood, counts as places only. Tests: `test/events/layout.int.test.ts` (a member, a stranger and a signed-out
caller; the ranking switch off still answers 404). The big-screen ranking scene follows it (migration 0106): `screen_ranking` sends only a place, a username and an
avatar unless `layout.looks.ranking.scores` is "shown" (no stored value is shown; a value or a `ranking` entry that is there and not understood is places only);
tests in `test/db/big-screen.int.test.ts`, and `screen_ranking` keeps its closed-to-PUBLIC grant (outsider suite). Not covered: the player's own points on Home
(their own record and balance, Q-363 (b)).

### Prize reservation and the desk sale (T-612, ADR-397)

With an event's reservation Off the desk sells items and experiences after a My QR scan. The operator's tap only makes an offer (no points,
no stock); the price leaves the balance only on the player's own Pay in their signed-in app (ADR-137), which runs every shop gate again
under the enrollment and reward locks and checks the price is the one the player was shown (DS409 `price_changed`). The desk sees whether the
player can buy each reward, never their balance (Q-364 g). A sale needs the API-verified My QR pair (the name search does not sell). The
`desk_sale` table has RLS forced and no grant; its doors are definers revoked from PUBLIC and granted to the API's role only, with the
operator checked through the hand-over assignment and the player through their own enrollment. A Pay's caught refusals are a fixed list of
business codes; anything else rolls the whole call back. The sale's redemption key prefix `desk:` is reserved (RK422 for a client key).
Tests: `test/desk/desk-sale.int.test.ts` (every refusal writes nothing, races, another organizer, rehearsal and erasure),
`test/desk/sale-routes.int.test.ts`, the outsider suite (anon and PUBLIC hold nothing on `desk_sale` or the new and restated functions; the
API's role holds no table privilege on it) and the cross-tenant suite.

### Event labels (T-614, Proposed ADR-399)

An event's renamed labels (`event.config.texts`) are organizer-written text that reaches every player's phone, so the closed list is the
control: only the six bar names are accepted (`EVENT_TEXT_KEYS`), and any other key, including every legal, consent and error text, is
refused by the server whatever the dashboard sends (422 `invalid_texts`, a test walks every shipped legal and consent key). A text is
cleaned with the same function as Home's words (invisible, control and bidi override characters removed, so a NUL cannot reach the JSON
write and a label cannot be reordered), held to 24 characters, and checked for its placeholders. The app draws it as plain text and reads
the composed value again tolerantly (a damaged or unsafe stored text shows the platform's text). The route is the existing member door
(an owner or an editor within their events; the database applies the limit; another organizer's event answers 404), audited as
`event.texts.update`, with no table, function or grant added. Tests: `test/events/texts.int.test.ts` (an owner, an editor, another
organizer's owner, an editor outside the event, a stranger, a signed-out caller and a player, plus the legal-key refusals and a damaged
stored value), the routes list in `test/security/routes.int.test.ts`.

### Name display (T-615, ADR-400)

A player's full name (the answer to the event's Full name join field) is personal data that can now reach other players. Two gates hold in
the database, so no client, route or later query can skip them: the event's setting (`event.name_display`, `event.name_audience`,
default usernames for the staff) and the player's own notice (`enrollment.name_notice`, written by `join_name_notice` in the join's own
transaction from the audience the card showed; a notice that is not the event's now rolls the join back, NN409). `public_full_name` is the
one rule other players' reads go through: setting `everyone`, enrollment active, notice `everyone`, name given, cleaned by
`display_name_text` (control, zero-width and direction characters removed, 60 characters kept; the clients draw it in a direction isolate). It feeds `ranking_names`
(the ranking, asked only when the event shows names), `event_results`, `screen_ranking` and `screen_finale`; a player who joined before
the setting, while only the staff were to see it, or left the field empty shows by username. The staff reads (`operator_scan_subject`,
`desk_full_name`) check the seat (an operator of the event, the hand-over ability for the desk) and the setting, and show an active or pending
player only. Widening to `everyone` is refused by a trigger (ND409)
while an active or pending player who was not told is in (`event_names_locked`, which the Joining page also reads under the caller's
row-level rules); the trigger trusts only the connection that owns it and holds every other login; a full name needs the Full name field (ND422). New columns and the helpers
(`event_name_notice`, `event_player_names`, `display_name_text`, `public_full_name`, `full_name_part`, `names_part`, `staff_full_name`,
`event_name_display_guard`) are closed to PUBLIC and to the API role; the API role holds EXECUTE only on `join_name_notice`, `event_names_locked`,
`player_name_display`, `ranking_names`, `desk_full_name` and the restated readers. The full name goes to no push, log line, error,
analytics row or export beyond the join answer the team already receives; `apps/api/src/full-name-guard.test.ts` lists the API files
that may name it. Tests: `test/db/name-display.int` (every rule and refusal as rows), `test/join/names.int` (the card, the join, the
dashboard), the ranking, results, big screen, finale, station and desk suites, the outsider suite (anon and PUBLIC hold nothing on the
columns or the functions) and the cross-tenant suite (B's setting, notices and names out of A's reach). Counsel on Q-080 can still narrow it.

**The full-name allow-list from the console (FOLLOWUPS batch 23, migration 0185, ADR-817).** A new admin power: an active platform
admin adds or removes a word of `full_name_allow`, which lets full names holding it through the word lists. Three definers
(`console_name_allow`, `admin_name_allow_add`, `admin_name_allow_remove`) re-read the admin (`console_admin()`, QE403 to every other
seat, so a member, an organizer, a player or a disabled admin gets 404 from the routes), take the lists' advisory key, and audit each
change with the word (`full_name_allow.add|remove`, a list entry, not a player's); no reason and no re-authentication, as the word lists.
The add door is the wall against widening the lists by mistake: it refuses a word that is itself a `username_word` entry (WA409; a real
name such as Butt stays a reviewed migration's decision), a word of an entry's shape (WA409 too: with one of the check's own affixes
removed or a run of 3 or more letters collapsed, it equals a `word` entry or holds a `part` entry, so cunty, kikes or «كسي» cannot be
allowed; Butts and Skeeter stay a migration's call), and a word with which an abusive name of the corpus that is refused now would
pass (WA422; `full_name_probe`, the corpus' 327 abusive names, no grant, kept equal to `test/db/full-name-corpus.ts` by a test). The
limit: an abusive form outside the corpus and outside the affix rule is not caught; the audit entry is the backstop. Every
abusive corpus word tried through the door leaves every abusive name refused (`test/db/name-allow-console.int`). The list trigger marks
the name-flag sweep, so stored names follow within minutes. Outsider and cross-tenant suites hold the three doors and the probe table.

### Review demo boundary (T-710, ADR-560 to ADR-567; STORE_COMPLIANCE §1.3)

The reviewer's fixed code is a contained hole: one Questify number, one account, one tenant, a window the admin opens.

| Claim | Where it is held | Evidence |
|---|---|---|
| The fixed code signs in nothing but the reviewer account | `sign_in_player` reads it only for a challenge flagged `reviewer` (set by `start_player_challenge` when the contact key is the reviewer's and the window is open); every other challenge compares only its own random code | `test/db/review-demo` (other numbers `wrong`), `test/console/review-demo` (HTTP, other number 401) |
| A real account never holds the reviewer number, and the fixed code never opens one that does | Create, set-contact and Prepare refuse a held number (`contact_held`); `create_player` answers `expired` and `confirm_contact_change` `taken` for it; an owner that is not `review_demo.player_id` answers `expired`, is audited (`review_demo.owner_mismatch`) and is never provisioned | `test/db/review-demo`, the outsider's-seat case in `test/console/review-demo` |
| Close and the window's end stop the code at once | the reviewer verify locks the `review_demo` row before the challenge; Close, Prepare, set-contact and the tick take it FOR UPDATE and revoke the reviewer's sessions | the two races in `test/db/review-demo` |
| A guessed code gives only the demo | triggers keep demo accounts in the demo event and everyone else out (`RD404`); no `xp_board` row; never in `promo_pool`; the demo event takes no invitation; the contact cannot change | `test/db/review-demo`, `test/security/cross-tenant` |
| Nothing is sent for a reviewer challenge | the API reads the flag and skips the SMS; a resend sends nothing | `test/console/review-demo` (SMS spy) |
| The code is never stored or logged in clear | only `keys.reviewerCodeHash` (purpose `reviewer-code`) is stored; Prepare is not idempotent (the store would keep the answer) and answers `no-store`; audits carry the version and window | `test/console/review-demo`, `src/auth/keys.test.ts` |
| Closed to the public | both tables have no grant; the doors are granted to the API role alone and re-read the admin (QE403) | `test/security/outsider` |
| The QR picker serves the reviewer alone (T-710b) | `review_demo_here` reads `app_player_id()` against the row: the reviewer, the demo event, the window open, an active member; `review_demo_codes` and `review_demo_meet_code` raise RD404 otherwise and the route answers the unknown event's 404; a pick goes through the ordinary completion doors, so no rule is skipped | `test/db/review-demo-codes`, `test/review-demo/codes` (outsider's seat), `test/security/outsider` |

Limits: the sign-in windows apply unchanged (10 wrong a contact per 15 minutes, 30 a day, 3 a challenge), so a 14-day
window allows at most 420 guesses of 1,000,000; `review_demo.code_guessing` logs past 10 wrong in a day (RUNBOOK).

### Platform pages (T-709, ADR-415 to ADR-418)

- **Five definer doors, granted to the API role alone** (`console_health`, `console_numbers`, `console_admin_accounts`,
  `console_admin_sessions`, `admin_end_session`); each re-reads the admin (`app_admin_id`, QE403 otherwise) and pins
  `search_path`. Outsider, cross-tenant and route suites assert the exact grants and that every tenant seat is refused.
- **No secret in the health answer:** the server's set-up is yes or no per transport; counts and flags only.
- **Forced sign-out:** only an open session of a platform admin can be ended (a member's session is a 404), with a reason of
  10 to 300 characters in the audit entry (`staff.session.force_end`); the caller's own session is refused. The reads of
  staff emails and sessions are audited with ids only. `revoke-admin` refuses the last active admin (FR-1785).

### Console foundation (T-701, ADR-405 to ADR-409)

- **Organizer rows are definer-only:** the API role lost INSERT and UPDATE on `organizer`, so no member can lift a
  suspension (catalog test in `test/db/console-suspension`).
- **Suspension walls:** ledger by kind (only refunds and removals), joining, public reads, big screen in the database;
  player routes (404 `event_unavailable`) and the team's writes (423) in the API. Statements that start after the
  suspension commits are refused (tested with a transaction opened before it).
- **Suspension by object (migration 0190, ADR-825):** a player route that names a quest, step, category, reward,
  session, desk sale, game round, meet pass or redemption of a suspended event answers 404 `event_unavailable`, as an
  `:eventId` route does; only the give-back doors stay open (`OPEN_WHILE_SUSPENDED` in `src/players/guard.ts`).
  `test/security/suspension-doors.int.test.ts` walks every player route: a param that is neither derived nor on its open
  list fails, and every derived route is called while its event is suspended. Souvenirs, which write no ledger row,
  wait while their event is suspended (scan, claim and evaluate refuse; ES423 keeps the work). A device seat no longer
  passes the system branch of `mark_ranking_repair`, nor (migration 0191) any other `ranking_system()` gate. Known and accepted (low): while some event is suspended, a player
  who asks for a serial id (`/v1/game-rounds/N/result`, `/v1/meet-passes/N`) gets `event_unavailable` where a route's own
  404 would answer for an object that does not exist, so the difference tells the player that object N exists and
  belongs to a suspended event.
- **Support grants:** 15 minutes, one event, reason required, never for a member, 20 an hour, closed by any admin and by
  `revoke-admin`; the grant is re-checked on every statement (`app_organizer_id`, `app_event_scope`, active admin) and
  `app.is_admin` is never set, so support holds an editor's rights in that event only. The API seats support on a
  deny-by-default route list (no device pairing, no exports, no event-less routes). Silent to the organizer by Dhia's
  decision (Q-373); every support write is stamped in the audit log by the database.
- **Support view (T-712, ADR-520 to ADR-524):** a grant has a kind, `view` (the console's default) or `edit`. Under a
  view the organizer hook answers 403 `support_view_only` to every write before a handler runs, refuses the quest codes
  and the rehearsal card as well (404), and marks the request's organizer context `readOnly`, so its transactions open
  `BEGIN READ ONLY`. The database honours a view grant in `app_organizer_id()` and `app_event_scope()` only while
  `transaction_read_only` is on: a path that loses the mark runs as nobody. Every allowed read is throttled (240 a
  minute per admin) and logged by `support_view_log` as `support.viewed` with the route pattern and path UUIDs only,
  coalesced per minute (no URL, query string or page content). Proven by `test/organizers/view-mode.int.test.ts`,
  generated from the route inventory (every write refused and nothing changed, every read without a server error,
  writing nothing and matching an edit grant's answer).
- **Console reads audited (Q-116 closed):** organizer list, organizer page and event page each write one audit row with
  ids only.

### Push to a group (T-706b, ADR-530 to ADR-534)

- **Who:** only an active platform admin (`console_admin()` in every door, QE403; the route hook answers 404 to anyone
  else). The fan door is for the push worker's system seat only (PN403). `group_push` is closed to every role; the
  outsider suite proves it and the grants.
- **Who receives:** an event push reaches the event's real, active members through the store's event fan-out (a rehearsal
  account, a left or banned member and a non-member never); a promotional push reaches only players `marketing_audience`
  returns (active, adult, opted in to push now, in the city and holding an interest asked for), and the store reads the
  consent again at the fan-out and at the claim, so an opt-out between the page and the phone wins. A player is told by
  at most one promotional push a week across group pushes and invitations.
- **Text:** the promotional push's rules and the name rule (no address, phone number, control or direction character),
  checked by the form, the API and the door; the notice carries the admin's frozen text and, for an event push, the event's
  public name, nothing about a player. The audit entry holds the audience and the reach, never the text or a player.
- **Abuse:** a stolen admin session could send one promotion to everyone: the send needs the reviewed reach confirmed, an
  Idempotency-Key, and is held to 10 an hour per admin and 20 overall; every send is audited with who. A running send
  cannot be stopped (Q-490).
- **Proof:** `test/db/group-push.int.test.ts` (seats, refusals, reach by status and consent, paging, cap, freeze),
  `test/console/group-push.int.test.ts` (HTTP), the outsider, cross-tenant and route suites.

## Legal data requests (T-708, ADR-480 to ADR-485)

- **Delivery:** a data export is built in the database at the moment it is asked for and goes straight back on the same
  HTTPS response (`no-store`, `attachment`, `nosniff`). It is never written to storage, the idempotency store, Redis, a
  log or an email; the routes are POST and not idempotent, and only the file's size is logged. The app writes it to its
  cache, opens the share sheet and deletes the cache file after; the console saves it in the admin's browser and the
  admin hands it over only through the channel counsel names (Q-441).
- **Abuse:** a stolen session could download the owner's contacts: the download is audited, the player gets a notice,
  and the database allows 3 a day (5 an hour at HTTP). A fresh code before the download is Q-440.
- **Admin powers:** export and erase need an active platform admin, a reason code and an opaque case reference that
  cannot carry a name, contact, phone or id number; the erase needs the username typed and a forfeit for pending
  handovers. Both are audited with the admin; the audit log outlives the account.
- **No restore:** a tombstone can never change (trigger enabled ALWAYS). After any database restore, before the API takes
  traffic, the runbook's "Re-apply erasures" erases again every account erased since the backup (`staff-cli
  reapply-erasures`). Erased data lives on in backups only until they age out (proposed 35 days, T-019; the privacy
  policy must say so, Q-443).

### Owner email change and the team alert (T-701b, ADR-490 to ADR-494)

- **Who:** an active admin, for an organizer's owner only; never a platform admin's account, never the admin's own; the
  new address belongs to no staff account (checked at start and at completion, the unique index settles a race and the
  close commits). One open change per account, 3 starts a day per account, 10 an hour per admin.
- **Proof:** the code goes to the new address only; the owner also types the current password (checked through the verify
  gate; a wrong code and a wrong password count in the same 5 tries and answer alike). Without the password the change
  waits 24 hours and the old address can stop it. The admin never sees the code.
- **Old address:** told at start (masked new address, Stop link), at a hold and at completion; a hold applies only with
  its notice recorded (`hold_notice_at`, ADR-815), and otherwise closes `send_failed`; after completion Stop
  queues a team alert (7 days). Completion ends every session, challenge and reset link and the old address's pending
  invites.
- **Public routes** (`/v1/staff/auth/email-change/view|confirm|stop`): tokens in bodies, 256-bit HMAC-derived, stored as
  SHA-256; 20 calls per client address in 15 minutes; unknown, expired and closed links answer alike.
- **No addresses in audit rows or logs** (ids, states, the identity check and the reason only); addresses live in the
  change row and are erased 180 days after it closes.
- **Team alert mail** holds ids, event and organizer names, kinds, counts, reason codes and due times, never a reporter,
  note, reported text or username; one digest per 10 minutes and 100 a day (a disputed email change still goes past that) on its own budget (`team_alert_mail`), so it
  can never take the sign-in mail budget (`outboundMailPerDay`).
