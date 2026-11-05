# T-810c - Signed-in devices (plan, tier A: sign-in, admin powers)

Source: `docs/TASKS.md` T-810c; Q-661 (answered by Dhia, 2026-11-05, "Build it (Recommended)"); `docs/security/ASVS_L2.md`
gap row 10 and rows V7.4.3, V7.4.5, V7.5.2; ADR-120 (a contact change keeps sessions); the player refresh families of
migrations 0013 and 0154 (ADR-706). Decisions: ADR-710 to ADR-716 (Proposed). Questions: Q-680 (for Dhia), Q-681.
Migration: **0155** (new). Delivers no FR in TASKS.md; this plan adds FR-140 (section 9).

**Done when** (TASKS.md): the three actions (a player's device list with Sign out, the console's "end every session",
a staff member's fresh code before ending their other sessions) work in Arabic and English with tests, outsider tests
show no one lists or ends another person's sessions, and the sheet's three rows move to Met.

**Order.** One build, one commit per step: (1) 0155 and its DB tests, (2) player API, (3) staff API, (4) console API,
(5) app screens, (6) web dashboard and console, (7) docs and the ASVS sheet. The security suites
(`apps/api/test/security/*`) and `test/db/rehearsal.int.test.ts` run after step 1.

---

## 1. What a "device" is

A **player device** is one refresh family (0013): the chain of refresh tokens that one sign-in on one phone starts and
every rotation continues. It ends when the player signs out there, when its 365 days run out (ADR-706), when an 11th
sign-in pushes it out of the 10-family cap, on refresh-token theft detection, on a ban, on the console's sign-in reset,
or (new) when the player ends it from another device.

Today a family has no row of its own: its refresh rows are swept 7 days after use, and nothing says what phone it is.
0155 adds `player_sign_in_device`, one row per family (section 3).

**What the player sees per device** (nothing else is stored or shown):

| Field | Source | Shown as |
|---|---|---|
| Platform | `ios` or `android`, sent by the app at sign-in | the platform icon and the fallback name "iPhone" / "Android phone" |
| Model | `expo-device` `Device.modelName` (already a dependency, ADR-259: no permission, no identifier), sent by the app at sign-in; optional, at most 40 characters of `[A-Za-z0-9 ._()+-]`, else dropped | "iPhone 15 Pro", "Pixel 8", "SM-S918B" |
| Signed in | `signed_in_at` (the family's `family_started_at`) | a date, "Signed in 3 Nov 2026" |
| Last used | the `created_at` of the family's live refresh token (its latest rotation) | a day, never a time: "Active today", "Yesterday", "4 days ago", then a date |
| This device | the family of the request's own access token | a gold "This device" tag; its button is the normal Sign out |

**Not stored and not shown** (SECURITY.md rule 3 and the personal-data rows): no IP address, no location of any
precision, no user agent string, no `X-Device-Id` (an install id is an identifier, and it is a claim, SECURITY.md
V2/V11), not the phone's own name (`Device.deviceName` is banned by `apps/app/src/help/center.test.ts`). The model and
platform are personal data once tied to an account, so they live in Saudi Arabia with the rest, are erased with the
account, and appear in the data export (section 3). The audit log never holds the model (the entry guard's key list
gets `model` and `label`).

The `x-device-id` header stays what it is today (a throttle key); it is not tied to the family (ADR-710).

**Staff** sessions are unchanged in shape: `staff_session` already keeps user agent, IP, created and last seen, shown
only to the staff member themself and to platform admins (0002, T-709). Staff are not players; the "no IP shown"
rule is a player rule.

## 2. Re-authentication: a fresh code (V7.5.2)

ASVS V7.5.2 asks that ending any or all other sessions comes after authenticating again with at least one factor.

**Staff** (Q-661, Dhia): a fresh **email code** to the account's own address (the second factor of the staff sign-in).
**Players** (Q-680, product choice for Dhia, recommended below): a fresh **sign-in code** to the account's own phone or
email, the same six-digit code by SMS or email as sign-in.

**Fresh** means one of these happened on **this** session (staff) or **this** family (player) in the last 10 minutes
(ADR-711):
- the sign-in itself (staff `staff_session.created_at`, which needs password and code; player `signed_in_at`, which
  needs a code);
- a re-authentication code typed here (`reauth_at`, new column);
- for a player, a contact-change code typed here (the new contact's code proves the person holds the account's new
  factor; `confirm_contact_change` sets `reauth_at`, section 3).

So the common cases need no extra code: a player who lost a phone signs in on a new one and ends the old one at once;
a player who just changed their number gets the "sign out other devices" offer with no second code. A fresh proof
belongs to one session or family: a code typed on the laptop does not make the phone fresh.

Ending **this** device (sign out) never asks for a code. The database checks freshness, not only the API.

**Recommendation for Q-680** (players re-authenticate with a fresh code, except within 10 minutes of a sign-in or
contact change): it is the only option that meets V7.5.2 for players, and the exceptions cover the lost-phone and
contact-change paths, so most players never see the extra code. Cost: one SMS per use outside those windows, rare.
Option B (no code for players; the row stays Partly for players) is cheaper but keeps the gap open; option C (code
every time) adds an SMS to the lost-phone path for no gain.

## 3. Migration 0155 (`0155_signed_in_devices.sql`)

Starts with `SET LOCAL lock_timeout = '10s'`. Every function it creates or replaces has `REVOKE ALL ... FROM PUBLIC`
next to it; only the doors the API calls get `GRANT EXECUTE ... TO questify_app`. Every new table is `ENABLE` and
`FORCE ROW LEVEL SECURITY` with **no policy and no grant** (definers only), and `REVOKE ALL ... FROM PUBLIC`.

**Tables and columns.**
- `player_sign_in_device`: `id uuid PK` (what the app sees; never the family, which push devices and refresh rows
  key on), `player_id uuid NOT NULL REFERENCES player`, `family uuid NOT NULL UNIQUE`, `platform text CHECK (platform
  IN ('ios','android'))` null until labelled, `model text CHECK (model ~ '^[A-Za-z0-9 ._()+-]{1,40}$')`,
  `signed_in_at timestamptz NOT NULL`, `reauth_at timestamptz`, `ended_at timestamptz`. Index on `(player_id) WHERE
  ended_at IS NULL`.
- `player_reauth_challenge`: `id`, `player_id`, `family` (the family it was asked from; a code proves only that one),
  `token_hash` (32 bytes, unique), `channel` (`phone`|`email`), `code_hash`, `attempts` (0..3), `expires_at` (5 min),
  `created_at`. No contact column: the definer reads the contact from `player_contact` when the API asks to send.
  One live row per family (a new request replaces it).
- `staff_session.reauth_at timestamptz` (new column), **not** added to the API's column `UPDATE` grant (0002 grants
  only `last_seen_at`, `revoked_at`): only the definer writes it. `staff_session_guard` (0002) is replaced to also
  refuse moving `reauth_at` backwards.
- `staff_reauth_challenge`: `id`, `session_id uuid NOT NULL UNIQUE REFERENCES staff_session ON DELETE CASCADE`,
  `token_hash`, `code_hash` (the HMAC with `AUTH_SECRET`, as the sign-in code), `attempts` (0..5), `resends` (0..3),
  `last_sent_at`, `expires_at` (10 min, as the sign-in code), `created_at`. Bound to the session, so it cannot be
  confirmed from another session.

**Backfill.** One `player_sign_in_device` row per family that still has a live refresh row: `signed_in_at` = its
`family_started_at`, `platform` from `push_device.platform` of the same family when there is one, else null (shown as
"Phone"), `model` null. Nobody is signed out.

**Functions replaced (same signatures unless said).**
- `issue_player_tokens` (0154): inserts the device row for a new family (`ON CONFLICT (family) DO NOTHING`, with
  `signed_in_at` = the family's start), and the 10-family cap sets `ended_at` on the families it ends. Every issuing
  definer (0013 to 0144) is covered without being touched.
- `revoke_family` (0013): also sets `ended_at` on the device row and deletes the family's `push_device` and its queued
  `push_send` rows, as the sign-in reset does (0118), so an ended phone gets no further pushes. Its callers (sign-out,
  theft detection, inactive player) all gain this.
- `rotate_player_refresh` (0013): **lock order** device row, then refresh row. It reads the presented token's family
  without a lock, takes the device row `FOR UPDATE`, answers `invalid` when `ended_at` is set, then continues as now.
  The end functions take the same device row `FOR UPDATE` first, so a rotation in flight either finishes before the end
  (and its new tokens are revoked by it) or sees `ended_at` and stops. Without this a rotation committing during an
  end could leave a fresh refresh token alive (READ COMMITTED does not see rows inserted after the UPDATE's snapshot).
- `admin_reset_player_sign_in` (0118): also sets `ended_at` on every device row of the player.
- `sweep_player_sign_in` (0013): deletes device rows ended more than 7 days ago, and rows whose family has no refresh
  row left; deletes expired reauth challenges.
- `confirm_contact_change` (0144): gains `session bytea` and, on `changed`, sets `reauth_at = now()` on the caller's
  family found by that access token hash. The 3-argument version is **dropped** (replace, not deprecate); RUNBOOK
  deploy note as for 0052: between the migration and the new API instance, a contact change on the old instance fails
  with 500 and the app's retry with the same key recovers it.
- The erasure path (the latest `erase_rows` or the function that deletes `player_refresh` on erasure, 0076 and later):
  deletes the player's device and reauth rows.
- The data export (`privacy/data-export.ts` and its definer): adds `signedInDevices: [{platform, model, signedInAt,
  lastUsedAt}]` for live devices.

**New definers** (all `SECURITY DEFINER SET search_path = public, pg_temp`, caller-bound: the player is
`app_player_id()`, the session is the request's own access-token hash passed in as `session`, matched against
`player_session` with `player_id = app_player_id()`, live, as the push-device door does in 0076; staff use
`app_staff_user_id()` and `app_session_token_hash()`):

| Function | Granted | What it does |
|---|---|---|
| `label_player_device(refresh_hash bytea, platform text, model text)` | yes | Sets platform and model once (only while both are null) on the family of a refresh token that is live: the proof is the token just issued, so no one labels another's family |
| `player_devices(session bytea)` | yes | The caller's live devices (at most 10) with `current` for the session's family and `fresh_until` for it |
| `start_player_reauth(session bytea, method text, token bytea, code bytea)` | yes | `no_contact` if the player has no contact on that channel; else replaces the family's challenge and returns the contact to send to (the API sends it; the code is never stored plain) |
| `confirm_player_reauth(session bytea, token bytea, code bytea, request uuid)` | yes | `expired` / `wrong` (attempts left) / `confirmed`: sets `reauth_at`, deletes the challenge, audits `player.reauth` |
| `end_player_device(session bytea, target uuid, request uuid)` | yes | `ended` / `already_ended` (still the caller's) / `not_found` (unknown or someone else's: one answer) / `current` (use sign-out) / `reauth_required`; locks the device row, sets `ended_at`, `revoke_family`, audits `player.device.end` |
| `end_other_player_devices(session bytea, request uuid)` | yes | `reauth_required` or `ended n` (n may be 0); same locks in id order, audits `player.devices.end_others` with the count |
| `start_staff_reauth(token bytea, code bytea)` | yes | Replaces the current session's challenge (at most 3 resends, 60 s apart) |
| `confirm_staff_reauth(token bytea, code bytea, request uuid)` | yes | As the player's, on `staff_session.reauth_at`; audits `staff.reauth` |
| `end_own_staff_session(target uuid, request uuid)` | yes | Another of the caller's own sessions: `reauth_required`, `ended`, `not_found` (not live or not theirs); audits `staff.session.end` |
| `end_other_staff_sessions(request uuid)` | yes | Every other live session of the caller after the fresh check; audits `staff.sessions.end_others` with the count |
| `admin_end_staff_sessions(target uuid, reason text, request uuid)` | yes | Console: `console_admin()` first; every live session of one staff account (an organizer member or an admin), not the caller's own (`QA422`); the reason through `suspension_reason_clean` (10 to 300 characters); audits `staff.session.end_all` with `reason` and `ended`; `QA404` for an unknown account |
| `player_device_is_fresh`, `staff_session_is_fresh` | no | Internal helpers (10 minutes) |

Ending a player's other devices does not touch the push device of this phone, nor its `tokens_valid_after`.

The direct `revokeSessionById` in `apps/api/src/auth/staff-store.ts` is deleted: ending another own session goes
only through `end_own_staff_session`. The RLS `UPDATE` policy on `staff_session` stays (sign-out of the current
session, the session cap at sign-in and the password change use it).

## 4. API routes (`docs/API.md`)

All `cache-control: no-store`. Every write is idempotent: it takes an **Idempotency-Key** (the convention layer
replays the first answer for 24 hours) and is also idempotent by state (ending what is already ended answers the same
success, a second "end others" ends 0).

**Player** (`access: "player"`, bearer):

| Route | Answer | Refusals |
|---|---|---|
| `GET /v1/me/devices` | `{devices: [{id, platform: ios\|android\|null, model: string\|null, signedInAt, lastUsedAt, current}], freshUntil: ISO\|null}` | 401 |
| `POST /v1/me/devices/{id}/end` (Idempotency-Key) | 204 (also when that device of the caller was already ended) | 401, 403 `reauth_required`, 404 (unknown or someone else's), 422 `current_device` (use `/v1/auth/logout`) |
| `POST /v1/me/devices/end-others` (Idempotency-Key) | `{ended}` | 401, 403 `reauth_required` |
| `POST /v1/me/reauth/code` | `{channel: phone\|email, lang}` → 202 `{challengeToken, expiresInSeconds: 300, sentTo}` (`sentTo` masked: `+966 5•• ••• •12`, `d•••@gmail.com`) | 401, 422 `no_contact`, 429 (the sign-in windows per contact, install and address, and the platform SMS budget, `sign-in-limits.ts`), 503 `sms_unavailable` (`emailOffered` when the player has an email) / `email_unavailable` |
| `POST /v1/me/reauth/verify` (Idempotency-Key) | `{challengeToken, code}` → `{freshUntil}` | 401, 422 `invalid_code {attemptsLeft}`, 410 `challenge_expired`, 429 |

`POST /v1/auth/verify` and `/v1/auth/signup` accept an optional `device: {platform, model?}` in the body; after the
tokens are issued the API calls `label_player_device` (a failure is logged and never fails the sign-in; the device
shows "Phone"). An older app sends nothing and works as now. `POST /v1/me/contact/verify` passes the session hash
(section 3).

While a new terms version waits (ADR-446) every player write is held, but ending devices is a safety action: `POST
/v1/me/devices/{id}/end`, `/end-others` and the two reauth routes join `OPEN_WHILE_UNACCEPTED` in
`apps/api/src/players/guard.ts` (ADR-714). The list is a GET and is never held.

**Staff** (`/v1/auth`, staff cookie):
- `GET /v1/auth/sessions` gains `freshUntil`.
- `POST /v1/auth/reauth/code` → 202 `{challengeToken, expiresInSeconds: 600}`; the email goes to the account's own
  address with the sign-in code template's wording "to confirm it is you"; the staff send windows apply.
- `POST /v1/auth/reauth/verify` `{challengeToken, code}` → `{freshUntil}`; 422 `invalid_code`, 410
  `challenge_expired`.
- `DELETE /v1/auth/sessions/{id}`: for the current session, as now (sign-out); for another, 403 `reauth_required`
  unless fresh; 404 unchanged.
- `POST /v1/auth/sessions/end-others` (Idempotency-Key) → `{ended}`; 403 `reauth_required`.

**Console** (inside the console scope: 404 to anyone but an active platform admin):
- `POST /v1/console/staff/{staffUserId}/end-sessions` `{reason}` (Idempotency-Key, `CONSOLE_SESSION_END_LIMIT`) →
  `{ended}`; 422 `end_own_session` for the caller's own account; 404 unknown account.
- **A player:** the existing `POST /v1/console/players/{playerId}/reset-sign-in` (T-704, FR-1775, ADR-421) already ends
  every session of one player with a reason code and note in the audit log, and clears their codes and push devices.
  It is the "end every session of one player" action; no second door (ADR-713). The ASVS evidence names its test.
- `GET /v1/console/organizers/{id}` team rows gain `staffUserId`, so the organizer page can offer the action.

## 5. The app screen (Arabic and English, RTL, brand deck)

Copy is drafted here and finalised with the `ux-araby` skill in the build; every string goes into
`packages/shared/src/i18n/messages.ts` in both languages. Western digits; dates through the app's existing date
formatter.

**Where.** Account screen (`apps/app/app/account.tsx`) gets a row "Signed-in devices" / "أجهزتك المسجَّلة" under the
contact rows. New screen `apps/app/app/devices.tsx`; logic in `apps/app/src/account/devices-api.ts` and a pure
`devices-flow.ts` state machine (list → confirm → code → done), tested like `contact-flow.ts`.

**Look** (brand deck, ADR-013): the parchment card list of the account screen, one card per device; the platform's
3D phone icon from the existing icon set (no new art; if the set has none, the existing account icon is reused and a
FOLLOWUPS line asks for one); the gold tag for "This device" / "هذا الجهاز"; wood button for the main action, the
outlined danger button for "Sign out". In RTL the icon sits at the start (right), the tag and the button at the end;
`start`/`end` styles only, never `left`/`right`. The current device is always first, then by last used.

**Strings (draft).**

| Key | English | Arabic |
|---|---|---|
| title | Signed-in devices | أجهزتك المسجَّلة |
| intro | Devices where your account is signed in. | الأجهزة التي سجّلت الدخول منها إلى حسابك. |
| thisDevice | This device | هذا الجهاز |
| fallbackIos / fallbackAndroid / fallbackPhone | iPhone / Android phone / Phone | آيفون / جوال أندرويد / جوال |
| signedIn | Signed in {date} | سجّلت الدخول في {date} |
| activeToday / activeYesterday / activeDays / activeOn | Active today / Active yesterday / Active {n} days ago / Active {date} | نشِط اليوم / نشِط أمس / نشِط قبل {n} أيام / نشِط في {date} |
| signOut | Sign out | تسجيل الخروج |
| signOutOthers | Sign out of all other devices | تسجيل الخروج من الأجهزة الأخرى |
| confirmOne | Sign out of {device}? Anyone using it will need a new code to sign in. | تسجيل الخروج من {device}؟ سيحتاج من يستخدمه إلى رمز جديد لتسجيل الدخول. |
| confirmOthers | Sign out of {n} other devices? | تسجيل الخروج من {n} أجهزة أخرى؟ |
| reauthTitle | Confirm it's you | تأكيد هويتك |
| reauthBody | We'll send a code to {sentTo}. | سنرسل رمزًا إلى {sentTo}. |
| doneOne / doneOthers | Signed out of {device}. / Signed out of your other devices. | تم تسجيل الخروج من {device}. / تم تسجيل الخروج من أجهزتك الأخرى. |
| alreadyEnded | That device was already signed out. | تم تسجيل الخروج من هذا الجهاز مسبقًا. |
| onlyThis | Only this device is signed in. | لا يوجد جهاز آخر مسجَّل الدخول. |
| afterPhone / afterEmail | Your number is changed. Sign out of your other devices? / Your email is changed. Sign out of your other devices? | تم تغيير رقم جوالك. هل تريد تسجيل الخروج من أجهزتك الأخرى؟ / تم تغيير بريدك الإلكتروني. هل تريد تسجيل الخروج من أجهزتك الأخرى؟ |
| afterYes / afterNo | Sign them out / Keep them | تسجيل الخروج منها / إبقاؤها |

Arabic plurals for {n} use the existing plural helper (1, 2, 3 to 10, 11+ forms).

**The code step** reuses the sign-in code field (with T-810e's "never share this code" line), resend and the email
offer when SMS is unavailable; channel picker only when the player has both contacts.

**After a phone or email change** (V7.4.3): the contact flow's `done` step fetches `GET /v1/me/devices`; when other
devices exist it shows the offer card above with the two buttons. "Sign them out" calls `end-others` with no code
(the contact code made this family fresh). With no other device, the done step is as today. ADR-120 is amended: a
contact change keeps the other sessions **unless the player chooses to end them**.

**Errors**: 403 `reauth_required` opens the code step; 404 and `already_ended` refresh the list with the
`alreadyEnded` note; offline shows the app's standard offline card; no spinner without a timeout.

## 6. Web: staff dashboard and console

- **`apps/web/src/components/SessionsPanel.tsx`** (staff's own sessions): "End" on another session and a new "End all
  other sessions" button. When not fresh, a dialog asks for the emailed code ("Confirm it's you"), then retries the
  action once. The current session keeps "Sign out". Arabic and English, RTL.
- **Console Admins page** (`ConsoleAdmins.tsx`): beside the per-session "End", "End all sessions" for an account, with
  the reason field (10 to 300 characters) as today.
- **Console organizer page**: each team row gets "End all sessions" with the reason. A staff account in no organizer
  and not an admin keeps the RUNBOOK SQL (rare: a sign-up that never made an organizer); RUNBOOK updated.
- **Console player page** (`ConsolePlayer.tsx`): the existing "Reset sign-in" is relabelled in its help text to say it
  ends every signed-in device; no new control.

Browser specs: the area's specs plus `layout.spec.ts`, one worker, as WORKER_BRIEF says.

## 7. Tests

**DB** (`apps/api/test/db/signed-in-devices.int.test.ts`, new):
- a sign-in, a sign-up and a rotation keep one device row per family; the cap's 11th sign-in ends the oldest row;
- `label_player_device` labels once; a second call, a dead token or someone else's token changes nothing;
- end one, end others, idempotent repeats; `reauth_required` at 10 minutes and 1 second, fresh at sign-in, after
  reauth and after a contact change; a reauth on family A does not make family B fresh;
- **race**: an end and a rotation of the same family in parallel (two clients, both orders): afterwards no live
  refresh or access token of that family exists; an end-others and a new sign-in in parallel never ends the new one;
- the push device of an ended family and its queued sends are gone; the sweep removes ended rows after 7 days;
- erasure deletes device and reauth rows; the export lists live devices with no family id;
- staff: `reauth_at` cannot be set by the API role (column grant) or moved back (guard); confirm from another session
  fails; `admin_end_staff_sessions` refuses non-admins, own account, short reasons, and audits the count.

**Route** tests for every refusal in section 4, both languages' messages present, the masked `sentTo`.

**Outsider** (`apps/api/test/security/outsider*.test.ts`, public credential only): no bearer → 401 on every new
player route; no staff cookie → 401 on staff routes; console routes → 404; the anon and PUBLIC roles cannot select the
new tables or execute any new function (the function-grant inventory gains the new names with their grant state).

**Cross-tenant and cross-person** (`apps/api/test/security/*` and the route inventory):
- player A lists only A's devices; A ending B's device id answers 404 and B's device stays live; A's reauth token
  confirmed with A's code from B's session fails;
- staff A cannot end staff B's session (404), cannot see it in the list; an organizer owner has no door to end an
  editor's sessions; a non-admin staff member gets 404 from the console door; an admin cannot end their own account
  from the console;
- a reauth code is single-use, 3 (player) or 5 (staff) tries.

**App**: `devices-flow.test.ts`, `devices-api.test.ts`, the account screen row, the contact flow's offer (shown only
with other devices), the label sender (no `deviceName`, model trimmed, `expo-device` load failure sends no model),
`hermes-runtime.test.ts` stays green. `npx expo export`.

**Mutation targets** (coordinator, on GitHub): `apps/api/src/players/devices*.ts`, `apps/api/src/players/reauth*.ts`,
`apps/api/src/auth/reauth*.ts`, the changed parts of `apps/api/src/auth/routes.ts` and `staff-store.ts`,
`apps/api/src/console/staff-sessions*.ts`.

## 8. ASVS sheet

- V7.4.3 to Met: staff (password change, email change end others) plus the player's offer after a contact change.
- V7.4.5 to Met: the console ends one staff account's sessions or one player's (reset sign-in); "all users at once"
  stays the RUNBOOK SQL (one `UPDATE` of every live staff and player session plus an audit entry), written as the
  documented incident procedure.
- V7.5.2 to Met: list and end for both, after a fresh factor (if Q-680 is answered as recommended; with option B the
  player half stays Partly).
- Gap row 10 closed, pointing at this plan.

## 9. FR and SRS

- **New FR-140** (account, F-76, Should): "The app shall list the devices where the player is signed in, with the
  phone's model, when it was signed in and last used, and let the player sign out of one or all other devices after
  confirming with a fresh code; after a phone or email change it shall offer to sign out of the other devices."
  Acceptance: "Given two signed-in phones, when the player signs out of the other one from this one, then the other
  phone shows the sign-in screen on its next request. Given a player who changed their number, when they choose to sign
  out other devices, then no other phone stays signed in." Trace row `FR-140 | F-76 | Should | built (T-810c)`.
- **FR-1785** amended: an admin can end every session of any staff account, not only an admin's.
- **FR-125**: note that after the change the app offers to sign out the other devices (ADR-120 amended).
- SECURITY.md: the session rows (V7) and the personal-data map gain the device label (model, platform), its retention
  (7 days after the device ends) and the export.
- DATA_MODEL.md, API.md, RUNBOOK (the 0155 deploy note, the console action, the SQL only for unattached staff).

## 10. Decisions and questions

- **ADR-710** a player device is a refresh family with its own row; label from the app (platform, model), never IP,
  location, user agent or install id.
- **ADR-711** a fresh factor is a code typed on this session or family in the last 10 minutes, the sign-in included,
  checked in the database.
- **ADR-712** lock order device row then refresh row for every rotation and end.
- **ADR-713** the console's player action is the existing sign-in reset; a new door ends any staff account's sessions.
- **ADR-714** ending devices and re-authenticating stay open while new terms wait.
- **ADR-715** `confirm_contact_change` takes the session hash and marks the family fresh; the 3-argument version is
  dropped with a deploy note.
- **ADR-716** the device label appears in the data export and is erased with the account.
- **Q-680 (for Dhia, product)** do players type a fresh code before ending other devices? Recommended: yes, except
  within 10 minutes of a sign-in or contact change.
- **Q-681 (developer)** the 10-minute freshness window; recommended 10 minutes (the staff sign-in code's life).

## 11. Risks

- **Takeover with an unlocked phone (ADR-120's cost) gets sharper.** Someone holding the owner's unlocked phone can
  change the number and now also sign the owner out everywhere else, where before the kept sessions let the owner
  change it back. Q-661's approval accepts the offer; compensations stay: the notice to the old contact, the audit
  entries, support's sign-in reset. Recorded in ADR-120's amendment and SECURITY.md's threat table.
- **The rotation race** (section 3) is the one way to leave a token alive; the lock order and the parallel DB test are
  the guard.
- **SMS cost** of player reauth: counted in the same windows and platform budget as sign-in codes.
- **Old app builds** send no device label: those devices show "iPhone" / "Android phone" when a push device exists,
  else "Phone"; nothing breaks.
- **The dropped `confirm_contact_change` signature** fails contact changes on the old API instance for the deploy's
  minute (RUNBOOK note).

---

## 12. Plan review (84) amendments (2026-11-05)

Q-680 answered by Dhia ("Yes, ask a code (Recommended)"); Q-681 answered by the developer (10 minutes). These replace
the sections above where they differ.

1. **One way to end a family (MAJOR).** A new ungranted `end_family(target uuid) RETURNS boolean` locks the family's
   `player_sign_in_device` row `FOR UPDATE`, sets `ended_at`, then revokes the family's refresh rows and access rows and
   deletes its reauth challenge, its `push_device` and the device's queued `push_send` rows. `revoke_family` (0013) is
   **dropped**; every path that ends a family calls `end_family`: `sign_out_player`, the three ends inside
   `rotate_player_refresh` (theft twice, an inactive or reset player), the 10-family cap in `issue_player_tokens`,
   `admin_reset_player_sign_in`, `admin_ban_player`, `review_demo_revoke`, and the new end doors. A door that ends
   several families calls it once per family in device-id order (rows without a device row last), so two ends never
   lock in opposite orders. The player-wide paths (reset, ban, review demo) keep their blanket `UPDATE` after the loop
   and their `tokens_valid_after` cutoff, so nothing a family-less row holds survives.
   The DB test adds **the cap race**: an 11th sign-in while the oldest family rotates, in both orders: no deadlock, and
   afterwards the oldest family holds no live refresh or access token.
2. **A family with no device row cannot rotate.** `rotate_player_refresh` answers `invalid` when the presented token's
   family has no `player_sign_in_device` row, as for an ended one. The backfill gives a row to every family with a
   live, unexpired refresh token, so nobody is signed out by the deploy.
3. **The list shows live families only.** `player_devices` returns a device only while its family holds a refresh
   token that is not revoked and not expired.
4. **The parallel end-others test**: end-others ends exactly the families it locked (its count), and a sign-in that
   commits after its lock stays live.
5. **Staff freshness in the database.** The `session_update` policy on `staff_session` is narrowed to the row of the
   looked-up token (`token_hash = app_session_token_hash()`, the session check's touch and lapse), and the API role
   loses its `INSERT` on `staff_session`. Every other write moves into definers: `open_staff_session(token, agent,
   address)` (insert plus the 10-session cap, used by sign-in and sign-up), `set_staff_password(new_hash, keep)`
   (password change and reset: sets the hash and ends the other sessions in one step, so ending them takes a password
   change), and `end_own_staff_session(session, target, request)` (the current session is a sign-out; another needs a
   fresh session). Staff definers take the request's own session-token hash (`session bytea`), as the player doors do.
   Staff routes live under `/v1/staff`, not `/v1/auth` as section 4 wrote.
6. **Erasure** changes `erase_rows(uuid, uuid[], bytea)` (last replaced in 0121): it deletes the player's
   `player_reauth_challenge` and `player_sign_in_device` rows. The label failure after a sign-in logs only the error's
   class name (`player.device_label_failed`, `reason`), never the platform or model.
7. **New FR-141** (console, Must): an admin can end every session of any staff account with a reason. FR-140 stays the
   player's device list. FR-1785 is not amended.
8. **RUNBOOK**: ending sessions does not stop someone who knows the password; for a staff account that may be taken,
   end its sessions and send a password reset. No email to the person is added.
