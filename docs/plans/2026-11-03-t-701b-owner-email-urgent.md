# T-701b - Owner email change and urgent reports (plan, tier A)

Delivers FR-1784 (owner email change; pause and restore shipped in T-701, merge dropped by Q-375) and FR-1732 (reports
from a live event marked urgent, put first with a due time, and an alert email to the Questify team at the address stored
as configuration data, Q-376). Depends on T-701 (done) and T-705b (the reports queue, done). Migration **0130**.
ADR-490 to ADR-496 Proposed; Q-450 to Q-453 Proposed. Tier A because the email change rewrites a staff account's sign-in
identity: plan review, build, one code review, mutation on GitHub for the email-change code only. The urgent half is
tier B logic carried in the same task (ADR-410: each half delivers value alone; built together because they share the
console's organizer and reports pages and one migration).

## 1. What exists and is reused

- **Staff identity:** `staff_user.email` (lower case, unique index `staff_user_email_key`, 0001) is the only sign-in
  identifier; sign-in is email + password + emailed code (T-006). The API role holds only `SELECT` and
  `UPDATE (password_hash)` on `staff_user` (0002, narrowed by 0114/ADR-405), so an email can only change through an
  owner-run definer. One account can be a member of several organizers; an organizer has exactly one owner
  (`organizer_one_owner`).
- **Sessions and secrets:** `staff_session`, `staff_login_challenge`, `staff_password_reset` (`staff-store.ts`);
  `revokeUserSessions` ends every live session; the ADR-405 revoke path is the model for "end everything".
- **Code and link patterns:** sign-up and contact-change codes are HMACs computed by the API (`auth/keys.ts`) and
  compared in the database; 5 attempts, 3 resends 60 s apart (`auth/limits.ts`). Reset links carry the token in the URL
  fragment (`/{lang}/reset-password#token=…`), so it never reaches a server log. The outbound mail budget
  (`outboundMailPerDay`, 400) and the sender with failover (`auth/email/sender.ts`, `failover.ts`) are the sign-in
  transport, which runs in production.
- **Console:** organizer page (`GET /v1/admin/organizers/{id}`: owner and team with emails, audited
  `console.organizer_read`), per-admin limits in `console/routes.ts`, confirmation screens with a required reason
  (ADR-063), Idempotency-Key on writes.
- **Reports (T-705b, 0121):** `content_report` (one row per report, `event_id` NULL only for a username reported outside
  an event), `console_reports` (one row per open target, oldest first, `overdue` past 24 h), `console_report`,
  `admin_report_resolve`. ADR-079: reports handled within 24 h, within 1 h while the event is live.
- **Configuration data:** `platform_setting` key `moderation` already holds `appealEmail` (ADR-423/429, no seed, the API
  falls back to `MAIL_FROM`); its write policy (0122) admits only `features` and `tuning`, so `moderation` has no writer.
- **Organizer alert worker (T-503):** lease, claim, ack and the "uncertain" outcome for a send that timed out; its
  transport is OFF in production (ADR-360) because it mails organizers' personal addresses. Copied, not reused.

## 2. Owner email change: the flow (ADR-490)

1. **Admin starts.** Console organizer page, owner card, **Change sign-in email**. The dialog asks for the new address,
   how identity was checked (a fixed list: `known_phone` (called back on the number on file), `id_document`,
   `contract_contact` (the signatory on the organizer's agreement), `other`) and a reason (10-300 characters, cleaned).
   The confirmation screen names the organizer, the current and the new address, and **every other organizer this
   account belongs to** (the change applies to the account, not one organizer), and says the owner will be signed out
   everywhere once they confirm.
2. **Code to the new address.** `POST /v1/admin/organizers/{id}/owner-email` opens a change row and emails the **new**
   address a 6-digit code and a link `/{lang}/email-change#token=…` (token 32 random bytes; only hashes are stored).
   The change is pending for **60 minutes**. If the code email cannot be sent, the row is closed (`send_failed`) and the
   admin sees "We could not send the code. Check the address." (as `killChallenge`).
3. **Old address told at once.** The **old** address gets "Questify support started changing your sign-in email to
   j•••@e•••.com" with a **Stop this change** link (`/{lang}/email-change/stop#token=…`, its own token) and the support
   contacts. Its failure never blocks the change (logged with ids only).
4. **The owner confirms, not the admin.** The owner opens the link from the new mailbox; the page shows the organizer
   name and the masked new address and asks for the code (5 attempts; the admin may **Resend** up to 3 times, 60 s
   apart, which issues a new code and keeps the link). The admin never sees or types the code, so owners are never taught
   to read a code to someone on the phone (the usual phishing script).
5. **Completion, one transaction** (`owner_email_confirm`): lock the account row, re-check every guard of section 3,
   set `staff_user.email`, end every live session, delete the account's sign-in challenges and reset links, close the
   change (`confirmed`), audit. After commit the API emails the new address ("Your sign-in email is now …") and the old
   one ("Your sign-in email was changed to j•••@e•••.com. You were signed out everywhere. If this was not you, contact
   Questify support"). The password is unchanged; the owner signs in with the new address (or uses Forgot password).
6. **Admin side afterwards:** the owner card shows the pending change (new address, expiry, Resend, **Cancel**) or the
   last finished one (confirmed / cancelled / stopped by the old address / expired, with the time).

**What the owner sees:** the code email at the new address; the confirm page (Arabic and English, RTL, Western digits);
"Done. Sign in with {email}." with a Sign in button; the notices at both addresses; every open dashboard tab returns to
sign-in at its next request. Nothing new inside the dashboard: the email shown on the account menu is simply the new one.

## 3. Takeover guards (ADR-491)

The code proves only that the person who confirms controls the new mailbox; the identity check before step 1 is the
real protection (FR-1784's "after verification"). The design narrows what a fooled or rogue admin can do:

- **Who can be changed:** only the organizer's current **owner** (the route names the organizer; the door checks the
  owner row), only an **active** account, never a **platform admin** (admins change only through the owner connection,
  ADR-405), never the requesting admin's own account. EC403 / EC404, no detail beyond the code.
- **Which address:** normalized like sign-up (`auth/normalize.ts`), at most 254 characters, different from the current
  one, and **not the email of any staff account** (checked at start and again at completion; the unique index settles a
  race: a violation closes the change as `email_taken`). An address that only has a pending sign-up or invite is
  allowed (that sign-up then fails on the unique index; an invite addressed to it reaches its rightful mailbox).
- **One pending change per account** (partial unique index); a second start answers `409 email_change_pending` with the
  pending one's expiry (cancel it first). Two admins at once: one wins, the other gets 409.
- **Rate limits:** per admin 10 starts an hour and 30 resends or cancels an hour (console buckets, 429 + Retry-After);
  per account 3 starts a day (counted in the door, EC429); per change 5 code attempts and 3 resends; per IP 20
  confirm, view or stop calls in 15 minutes on the public routes (`throttle.ts`); every mail counts against
  `outboundMailPerDay`.
- **Stop link:** while pending, the old address can stop the change (no sign-in needed; the token is the authority);
  the console shows "Stopped from the old address" and the audit log records it, so support knows to call back.
- **Audit with ids and reason only:** `owner_email.start` (organizer, account, change id, identity check, reason),
  `owner_email.resend`, `owner_email.cancel`, `owner_email.stop`, `owner_email.confirm`, `owner_email.expire`; actor
  `admin` for console actions, `system` for the owner's confirm and the old address's stop (the change id links them).
  Addresses never go into `audit_log`, logs or errors (hard rule 3). The organizer's own audit rows carry
  `organizer_id`, so a future organizer history screen shows the change.
- **Where the addresses live:** only in the change row (old and new), so a disputed change can be traced; the row's
  addresses are erased 180 days after it closes (the lifecycle tick), the ids and states kept.
- **Waiting period:** none; the change applies at confirmation (lost-mailbox cases are often urgent during a live event).
  Q-450 asks Dhia whether a 24-hour hold is wanted.

## 4. Urgent reports (ADR-493)

- **Urgency is the database's, fixed at arrival.** New `content_report.urgent boolean NOT NULL` and `due_at timestamptz
  NOT NULL`, set by a BEFORE INSERT trigger that ignores any value passed: urgent when the report has an event whose
  `status = 'live'` at that moment (Q-452); `due_at = created_at + 1 hour` when urgent, else `+ 24 hours`. An ended,
  draft, scheduled or archived event, and a username reported outside an event, are normal. Existing rows: `urgent =
  false`, `due_at = created_at + 24 h`. Neither changes later (an event ending does not relax a due time).
- **Queue order** (`console_reports`, restated): per open target `urgent = bool_or(urgent)`, `dueAt = min(due_at)` over
  its open reports, `overdue = dueAt < now()`; order **urgent first, then earliest due, then target id**; still at most
  100 rows, plus `urgentTotal` (open urgent targets) for the console menu badge. `console_report` adds each report's
  `urgent` and `dueAt`.
- **Console:** an **Urgent** badge; "Due in 35 min" / "Overdue by 2 h" (relative, Western digits) replacing "Over 24
  hours"; the Reports menu item shows the urgent count; the target page shows the due time.
- **Scope:** content and username reports (Questify's queue). Escalated help-desk tickets keep their own order (ADR-496,
  Q-451).

## 5. The team alert (ADR-494, ADR-495)

- **Producer:** an AFTER INSERT trigger on `content_report` for an urgent row takes a transaction advisory lock on the
  target (after the reporter's lock `report_content` already holds, always in that order) and, when the target has no
  other **open urgent** report, inserts one `team_alert` row (`kind 'urgent_report'`, target kind and id, event id,
  report id; `dedupe = 'urgent:' || report id`, unique). So one alert per target per open episode: more reports on the
  same target while it is open add none; once its reports are resolved, a new urgent report alerts again.
- **Outbox `team_alert`:** ids only (no address, no text), states `queued | sending | sent | failed | uncertain`,
  lease columns as `organizer_alert`; RLS forced, no grant; definers `team_alert_claim(lease, size)` and
  `team_alert_ack(id, lease, outcome)` for the worker; rows deleted 30 days after they finish.
- **Worker** (`apps/api/src/team-alerts/worker.ts`, in-process tick every 60 s with jitter, lease 60 s): claims every
  queued row (at most 50) and sends **one digest email** per run listing up to 20 targets ("and 7 more"): event and
  organizer name, what kind of item, the report count, the reason codes, the due time (Riyadh time and relative), a
  link to `/{lang}/console/reports/{kind}/{id}`. **No personal data:** no reporter, note, snapshot text or username, so
  it may use the sign-in transport (ADR-494, Q-453). 8-second deadline; timeout = `uncertain` (never resent), a refused
  send = `failed`, retried on the next two runs, then left `failed` and logged. The console badge does not depend on
  the mail.
- **Recipient (Q-376):** `platform_setting.moderation.alertEmail`, read each run; when absent the API's `MAIL_FROM`
  (as `appealEmail` today). No seed: a migration cannot know the address.
- **Editing the addresses:** the console Reports page gets a small **Moderation addresses** card: the alert address and
  the appeal address, each showing "Using the sending address (…)" when unset, with Save and Use the sending address.
  `PUT /v1/admin/moderation-addresses` calls `admin_set_moderation_addresses(alert, appeal, request)`: active admin,
  each value an address (normalized, 254 max) or null, merged into the `moderation` key under its row lock, audited
  `platform_settings.update` with before and after (Questify's own role addresses, not personal data). The generic
  settings policy stays `features` and `tuning` only.

## 6. API

| Route | Access | Notes |
|---|---|---|
| `POST /v1/admin/organizers/{id}/owner-email` | admin | body `{newEmail, identityCheck, reason}`, Idempotency-Key; 201 `{changeId, expiresAt}`; 409 `email_taken`, `same_email`, `email_change_pending`; 403 `owner_is_admin`, `own_account`; 404 `not_owner`; 422 inactive account or bad reason; 429; 502 `code_not_sent` |
| `POST /v1/admin/owner-email-changes/{id}/resend` | admin | 409 when not pending or too soon; 429 after 3 |
| `POST /v1/admin/owner-email-changes/{id}/cancel` | admin | idempotent; 409 when already closed |
| `GET /v1/admin/organizers/{id}` | admin | gains `ownerEmailChange` (pending or last, with addresses: the admin already sees the owner's email there) |
| `POST /v1/staff/auth/email-change/view` | public | `{token}` → `{organizerName, newEmailMasked, expiresAt}` or 404 (expired, closed or unknown, all one answer) |
| `POST /v1/staff/auth/email-change/confirm` | public | `{token, code}` → 200 `{email}`; 422 `wrong_code` with attempts left; 404 as view; 409 `email_taken` |
| `POST /v1/staff/auth/email-change/stop` | public | `{token}` → 200 (also when already closed: no oracle) |
| `PUT /v1/admin/moderation-addresses` | admin | `{alertEmail, appealEmail}` (string or null) |
| `GET /v1/admin/reports` | admin | gains `urgent`, `dueAt`, `urgentTotal` |

Tokens travel in POST bodies, never in a URL. The three public routes join the explicit staff public list, keep the
`Origin` check and `no-store`. Errors are bilingual codes in `http-errors.ts`.

## 7. Migration 0130 (deny by default)

New: `staff_email_change` (id, staff_user_id, organizer_id, requested_by, identity_check CHECK list, reason 10-300,
old_email, new_email (lower, `@`, ≤254, NULLable after the purge), token_hash, stop_hash (32 bytes, unique), code_hash
(32 bytes), attempts 0-5, resends 0-3, last_sent_at, expires_at (= created_at + 60 min, CHECK), state
`pending|confirmed|cancelled|stopped|expired|send_failed|email_taken`, closed_at, created_at; CHECKs tying state to
closed_at; partial unique `(staff_user_id) WHERE state = 'pending'`); `content_report.urgent`, `content_report.due_at`
(added, backfilled, then NOT NULL) and an index on open reports by `(urgent DESC, due_at)`; `team_alert`.
Functions: `admin_owner_email_start`, `admin_owner_email_resend`, `admin_owner_email_cancel`,
`admin_owner_email_send_failed`, `owner_email_view`, `owner_email_confirm`, `owner_email_stop`,
`console_owner_email_change(org)` (called by `console/organizers.ts` `readOrganizer`, which reads in the admin seat), `report_urgency` (trigger), `report_team_alert`
(trigger), `team_alert_claim`, `team_alert_ack`, `admin_set_moderation_addresses`, `moderation_alert_email()`; restated:
`console_reports`, `console_report` (0121), the
lifecycle purge (expire pending changes past their time as `expired`, erase addresses after 180 days, delete finished
`team_alert` rows after 30 days). Every new table: RLS enabled and forced, `REVOKE ALL … FROM PUBLIC, questify_app`.
Every new function `REVOKE ALL … FROM PUBLIC` in the same group; EXECUTE to `questify_app` only for the doors, the
three public doors, the worker's claim and ack and `moderation_alert_email`; trigger functions and helpers none. Every
definer pins `search_path = public, pg_temp`; doors that write audit rows are VOLATILE. 0130 restates nothing deployed
in place (0121 and 0114 functions are `CREATE OR REPLACE`d with a "restates" note).

**Code checks in the database:** the API computes `hmac(code)` with the auth key and passes the hash; the door compares
under the change's row lock (`FOR UPDATE`), counts the attempt first and refuses after 5, as `sign_in_player`.

## 8. Tests (test first)

- **DB** `test/db/owner-email-change.int.test.ts`: every refusal of start (non-admin, flag without the role, disabled
  admin, member, player, anon; not the owner, an editor of the organizer, a disabled account, a platform admin, the
  admin's own account, the same address, an address of another staff account in any case, a bad reason, a bad identity
  check, a second pending change, the fourth start in a day); view, confirm and stop by token (wrong, expired, closed
  answer alike); 5 wrong codes then the right one refused; resend spacing and cap; completion ends every session, the
  challenges and the reset links and leaves other accounts' rows alone; sign-in by the new address finds the account and
  by the old one finds none; the unique-index race (another account takes the address between start and confirm →
  `email_taken`, state closed, nothing changed); two concurrent confirms (one wins); two concurrent starts (one 409);
  stop vs confirm race; the audit rows hold ids and never an address; the purge erases addresses after 180 days and
  expires pending rows; the catalog still shows only `SELECT, UPDATE(password_hash)` on `staff_user` for the API role.
- **HTTP** `test/console/owner-email.int.test.ts`, `test/auth/email-change.int.test.ts`: the routes and codes above;
  emails sent to the right addresses with masked addresses in the notices (a fake sender); a failed code send closes
  the change and answers 502; a failed old-address notice still completes; the per-admin and per-IP limits (429 +
  Retry-After); a revoked session answers 401 after completion; the tokens never appear in the access log (route-level
  log redaction test as T-704's).
- **DB** `test/db/report-urgency.int.test.ts`: live event → urgent, due +1 h; scheduled, ended, archived, outside an
  event → normal, +24 h; values passed by a door ignored; queue order (urgent first, then due, then id); `urgentTotal`;
  overdue; the alert row: one per open episode, none for a normal report, a second urgent report on the same target
  adds none, a new one after resolution adds one, two concurrent urgent reports on one target make one row.
- **Worker** `test/team-alerts/worker.int.test.ts`: digest of several rows in one email, "and N more" past 20, the
  configured address and the `MAIL_FROM` fallback, timeout → `uncertain` not resent, refusal → `failed` retried twice,
  two workers never send one row twice (leases), the mail body holds no username, note or snapshot text.
- **Moderation addresses:** door refusals, validation, merge keeps the other field, audit before/after;
  `ban_notice` keeps reading `appealEmail`.
- **Security suites:** outsider (new tables and functions refused to `anon` and `PUBLIC`, the exact grant list),
  route-access (public list gains three routes; admin routes 404 to others), cross-tenant (an owner or editor cannot
  reach any door), rehearsal and other list guards updated.
- **Web:** console owner card, change dialog and confirmation, pending panel; Reports urgent badge, due times, menu
  count, addresses card; public confirm and stop pages; `e2e/console-owner-email.spec.ts`, the reports spec extended,
  layout pages for the two public pages; every string in `messages.ts` in Arabic and English (`ux-araby`), RTL.

**Mutation globs** (GitHub only, the email-change code): `apps/api/src/console/owner-email*.ts`,
`apps/api/src/auth/email-change*.ts`. The urgent half is not ledger, sign-in, tenant or redemption code.

## 9. Docs touched at build

API.md (routes above), DATA_MODEL.md (`staff_email_change`, `team_alert`, the report columns, `moderation` keys),
SECURITY.md (staff sign-in controls: email change row; the public routes; the alert mail holds no personal data),
RUNBOOK (how support verifies identity before an email change; how to reverse one: run it again to the old address;
the alert address), SRS trace (FR-1784 built except merge; FR-1732 built), TASKS, STATE.

## 10. Risks

1. **A convincing impostor plus a careless admin takes over an organizer.** The code cannot stop this; the identity
   check list, the reason, the old-address notice with Stop, the audit and the per-account cap narrow it. A hold period
   would add more (Q-450).
2. **The change affects every organizer the account belongs to.** Shown on the confirmation screen; accepted.
3. **Lost alert mail.** `uncertain` is never resent (no duplicates); the console badge and due times are the primary
   signal, the email is a nudge.
4. **Report floods at a large live event.** One alert per target episode and one digest per minute keep the mailbox
   readable; the reporters' caps (10 an hour, 30 a day) stay.
5. **Restating `console_reports` and `console_report`** (0121 is undeployed: CranL runs through 0086, staging 0117;
   restated in 0130 rather than edited, since later branches build on 0121): the T-705b suites rerun.

## 11. Decisions and questions (recorded with this plan)

- **ADR-490** (Proposed): the owner email change flow: admin starts with identity check and reason; code and link to the
  new address; the owner confirms on a public page; 60 minutes; the admin never handles the code.
- **ADR-491** (Proposed): takeover guards: owner only, active, never an admin or the admin's own account; the address of
  no staff account; one pending change; caps; the old address told with a Stop link; audit ids only; addresses in the
  change row only, erased after 180 days.
- **ADR-492** (Proposed): completion ends every session, challenge and reset link of the account; no session issued;
  the password unchanged; the change applies to the account across organizers.
- **ADR-493** (Proposed): urgency and due time set by the database at arrival (live event: urgent, 1 hour; else 24
  hours); the queue puts urgent first, then the earliest due.
- **ADR-494** (Proposed): the team alert is an ids-only outbox, one alert per target episode, one digest email a minute
  at most, sent through the sign-in transport because it carries no personal data, to `moderation.alertEmail` or
  `MAIL_FROM`.
- **ADR-495** (Proposed): the console edits the moderation addresses (alert and appeal) through one door; the generic
  settings policy is not widened.
- **ADR-496** (Proposed): escalated help-desk tickets are not part of FR-1732's urgency in v1.
- **Q-450:** a 24-hour hold before an owner email change applies? Recommended: no.
- **Q-451:** should tickets escalated from a live event also be urgent? Recommended: not in v1.
- **Q-452:** "live" means `event.status = 'live'` (not rehearsal, not within dates before the tick). Recommended: yes.
- **Q-453:** the alert email uses the sign-in transport (Gmail with failover) since it holds no personal data.
  Recommended: yes.
