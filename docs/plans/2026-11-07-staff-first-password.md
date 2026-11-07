# Staff first password and the held email change's notice (plan, tier A: sign-in, admin powers)

Source: `docs/FOLLOWUPS.md` "2026-11-05 T-810", the first clause of "2026-11-03 T-701b", and "2026-11-05 - T-810c".
Governing: ADR-078 (the mailbox is the second factor), ADR-490 to ADR-492 (owner email change), ADR-718 (staff sessions),
`docs/SECURITY.md` "Sign-in pathways" rows 1, 5, 8, 9, 21, ASVS gap 18. Decisions: ADR-814, ADR-815 (Proposed). Questions:
Q-751, Q-752. Migration: **0169** (new; 0168 is on staging, 0156 stays reserved for T-810d). Delivers no FR.

**Done when:** `staff.cjs create` takes no password and no operator ever holds a working one; a held email change applies
only with a recorded notice to the old address; ASVS V6.4.1 can move to Met (section 8).

**Order.** (1) 0169 and its DB tests, (2) `email-change.ts`, worker, route, console, (3) mail sender extraction, `create`,
template, (4) docs. Security suites and `test/db/rehearsal.int.test.ts` run after step 1.

---

## 1. Today

- `createStaffAccount` hashes whatever stdin gave. The RUNBOOK pipes a random value and sends the person to "Forgot your
  password?", but nothing makes an operator do that, and the password works from the first sign-in.
- `confirm` commits `held`, then `mailHeld` sends the only notice. A failed send is logged and the worker applies the
  change 24 hours later (`owner_email_apply_due`). A crash between the commit and the send has the same result.

## 2. T-810: `create` sends a set-password link (ADR-814)

**Chosen:** `create` takes no password. The account gets the argon2id hash of 32 random bytes that are dropped at once, plus
one set-password link in the existing `staff_password_reset` table, mailed to the address.

| Option | Verdict |
|---|---|
| **Link, no initial password** | **Recommended.** No initial secret reaches a person, so there is nothing to force. No route, session or guard changes |
| Flag plus forced change at first sign-in | Rejected. An operator still holds a working secret until then (V6.4.1 stays arguable), and every staff route needs a "may only change the password" session state, a large new race surface |
| NULL `password_hash` | Rejected. Touches every reader, and sign-in would need a timing path of its own. A real hash pays the same argon2 price |
| Own invite table, 7 days | Rejected. New table, policies and sweep for a case "Forgot your password?" already covers |

**FOLLOWUPS expected a migration here; none is needed.** The link, its one use (`consumeResetLink`), the policy checks, the
session end and the notice are all row 5 as built. 0169 belongs to T-701b alone.

**Link life: 24 hours** (`staffInviteValiditySeconds: 86_400` in `limits.ts`). This is the longest the table allows:
`reset_delete` lets the retention sweep remove any row older than 1 day, so a longer link would vanish while valid.
After expiry the reset page's existing "request a new link" gives the normal 30-minute link (Q-751).

**CLI (`apps/api/src/staff-cli.ts`, `auth/staff-admin.ts`):**
1. `create <email>` never reads stdin, so an old piped command cannot hang; its input is ignored and the output says the
   person sets their own password. Usage text and the file comment change. `createBreachCheck` leaves the CLI. **`--admin` is
   gone, and any flag after the email refuses with the usage text**, so an old `create --admin` cannot quietly make a plain
   account. A typo would mail a stranger a link, and that mailbox also gets the sign-in code (ADR-078), which would hand over
   a platform admin; `create --admin` also skipped the reason `grant-admin` requires. The flow is plain `create`, confirm the
   person has signed in, then `grant-admin --reason`.
2. Mail settings are read first: `authConfig` is exported, and `createEmailSender` moves from `server.ts` to
   `apps/api/src/auth/email/from-config.ts` (the server passes its `instrumentEmail` wrapper). Missing settings refuse before
   anything is written.
3. Email checks, then the random hash outside any transaction.
4. One transaction: `staff_user`, `insertResetLink` (reused), audit `staff.create`.
5. After the commit, send (never holding a transaction across a network call). Then audit `staff.invite` with `{sent}`.
6. A failed send exits 1: `Created <email>, but the email did not go out. Send them to "Forgot your password?".` A second
   `create` answers "already exists" and sends nothing. A sent email whose `staff.invite` audit row failed also exits 1, but
   says the email went out and only the audit entry is missing. The outcome text lives in `staff-admin.ts` (`createOutcome`),
   so tests reach it without running the CLI.

`createStaffAccount(owner, {email}, {email: sender, dashboardOrigin})` returns `{id, sent, audited}`. `REASONS`,
`refuseBreached` and `checkPasswordPolicy` leave this file. Every account starts with `platform_role = 'none'`.

**API and web:** no route or page changes. The link opens `/{lang}/reset-password#token=…`; the page's existing title and
strings fit a first password. The password policy and breach check run there, so V6.2.12 still holds.

## 3. T-701b: no notice, no apply (ADR-815)

Only the first clause of the FOLLOWUPS line. The digest cap, `takeOutboundMail`, at-most-once notices, the plan's lines 259/281
and `admin_unpublish`'s lock stay listed there.

**Chosen:** both closes the line offered: a recorded notice is required (this also covers a crash), and a failed send closes
the change at once.

| Option | Verdict |
|---|---|
| **Record the notice; refuse to apply without it; close on a failed send** | **Recommended.** Fails closed on a failed send, a crash and a lost write |
| Close on a failed send only | Rejected. A crash after the commit still applies unnoticed |
| Worker resends until it goes | Rejected for now. New retry state, for a close the admin can undo by starting again (Q-752). This does not rest on failover: `RESEND_API_KEY` is not set in `ops/cranl/*.json`, so there is no second provider and one Gmail failure closes the owner's change |

Flow in `email-change.ts`: `mailHeld` returns whether the send worked, and `notify` then calls the door with the link's token
hash. `noticed` answers `held`; `closed` answers the new `notice_failed` kind; `gone` (stopped or cancelled meanwhile) answers
`invalid`. Fields missing from the answer count as a failed send. If the door call itself fails the owner sees a 500 and the
row closes at its due time.

Route: `notice_failed` throws `emailChangeNoticeFailed` (503, `email_change_notice_failed`, `apps/api/src/auth/http-errors.ts`,
`docs/API.md`). `describeProblem` shows `message[language]`, so the form needs no change.

Worker: `applyDue` logs `team_alert.hold_unsent {change}` at error level for an outcome of `send_failed`. Log fields stay ids
only. Only `confirmed` mails, as now.

Console (`ConsoleOwnerEmail.tsx`): a `send_failed` change with `appliesAt` set failed at the notice, since only a held row has
it. It shows the new string; `console_owner_email_change` already returns `appliesAt` and is not restated. The admin starts
again (3 starts a day).

## 4. Migration 0169 (`0169_held_email_notice.sql`)

`SET LOCAL lock_timeout = '10s';` Header comment as 0168. No `COMMIT`.

- **Column:** `ALTER TABLE staff_email_change ADD COLUMN hold_notice_at timestamptz;` Nullable with no default, so no rewrite.
  The table's forced row-level security and absent grants stay. **No backfill:** nobody can say those notices went out.
- **Restated, one only: `owner_email_apply(uuid, text, uuid)`,** as 0130 (its one definition), same arguments and owner, no
  grant. Added straight after the lock, before the guards:

  ```sql
  IF how = 'waited' AND c.hold_notice_at IS NULL THEN
    c := owner_email_close(change, 'send_failed');
    PERFORM owner_email_audit(c, NULL, 'send_failed', jsonb_build_object('step', 'hold_notice', 'why', 'unrecorded'), request);
    RETURN jsonb_build_object('outcome', 'send_failed', 'changeId', c.id);
  END IF;
  ```

  `owner_email_confirm` and `owner_email_apply_due` call it and are not restated. Guarding here covers every waited apply.
- **New door: `owner_email_hold_notice(token bytea, sent boolean, request uuid) RETURNS text`**, `SECURITY DEFINER`,
  `search_path = public, pg_temp`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO questify_app`. It is bound to the link's token
  hash like `owner_email_confirm`, so the API role cannot mark a change by id alone. It locks the row by `token_hash` and never
  raises:
  - no row, or state not `held`: `gone`;
  - `hold_notice_at` already set: `noticed` (no second audit row, whatever `sent` says);
  - `sent IS TRUE`: sets `now()`, audits `hold_notice`, answers `noticed`;
  - otherwise: closes `send_failed`, audits `send_failed` with `{step: 'hold_notice', why: 'send'}`, answers `closed`.

Lock order is unchanged: the door takes the one change row, as Stop and cancel do. `owner_email_purge` and the checks need no
change, since `send_failed` is already a closed state.

## 5. T-810c stays out

It shares no table or function with this work, so the shared migration would only join unrelated risk.
- **Sweep lock order:** locking device rows first means locking live families too, because the sweep deletes used refresh rows
  older than 7 days from families still in use. A sweep would then queue player rotations, on the hot path, to remove a
  deadlock that needs a token over 7 days old and costs one aborted request. `SKIP LOCKED` batches would avoid that but are a
  design change with their own race tests.
- **End-others fresh check:** a safe one-line lock in `end_other_player_devices`, but the review found its race changes nothing,
  and it would add a player sign-in function to this review.

Both stay in FOLLOWUPS for the next task that rewrites those functions.

## 6. After the deploy: nobody is locked out

- **Existing staff accounts, staging included:** nothing changes. No column, flag or backfill touches `staff_user`. Passwords,
  live sessions, pending reset links and sign-in codes all keep working. Nothing forces a change on anyone.
- **Staging operators:** event operators are player accounts with code sign-in and do not touch this path. People who run
  staging with staff accounts are covered above. No script, CI job or e2e helper calls `staff.cjs create` (searched:
  `scripts`, `ops`, `.github`, `apps/web/e2e`; e2e uses `#e2e/mail.ts`).
- **New accounts need the mailbox:** no new dependency, since sign-in already emails a code there. A wrong address means
  no access, as now.
- **Mail down at `create`:** the account exists and "Forgot your password?" works once mail is back.
- **Replacing an admin (RUNBOOK "Lost mailbox"):** plain `create`, confirm the new person has set a password and signed in,
  then `grant-admin --reason`, and only then `revoke-admin` on the old one. The RUNBOOK step says so. `revoke-admin` counts
  active admins, not admins who can sign in, so it would pass early.
- **Open email changes:** see section 10. A change waiting for its code is unaffected.

## 7. Audit rows

No address, token or hash in any of them.

| Action | When | Actor | `after` |
|---|---|---|---|
| `staff.create` | account made | system | `{platformRole}` as now |
| `staff.invite` (new) | after the send | system | `{sent: boolean}` |
| `staff.password.reset` | first password set | staff | `{sessionsEnded}` as now |
| `owner_email.hold_notice` (new) | notice recorded | system | `{changeId}` |
| `owner_email.send_failed` | failed send, or unrecorded at apply | system | `{changeId, step, why}` |

## 8. ASVS and docs

- **V6.4.1 Partly to Met, gap 18 closed; counts become Met 56 / 105 / 161, Partly 2 / 19 / 21.** Accounts made before this
  deploy may hold a password an operator once knew. So the row moves in the commit that records this read-only query run on
  each environment, with anyone listed asked to reset:
  ```sql
  SELECT u.email FROM staff_user u
  JOIN audit_log a ON a.action = 'staff.create' AND a.target_id = u.id::text
  WHERE u.status = 'active' AND NOT EXISTS (SELECT 1 FROM audit_log b WHERE b.target_id = u.id::text
        AND b.action IN ('staff.password.reset', 'staff.password.change'));
  ```
- **Evidence only:** V6.2.12 moves to `password-reset.int.test.ts` "refuses a breached new password and keeps the old one"
  (its `staff-admin` test goes); V6.3.2 takes the renamed `create` test; V7.5.1 stays Partly with the notice added; V16.5.2 gains
  the failed-notice test.
- **Docs:** SECURITY rows 5, 8 and 9 (row 5 gains the 24-hour `create` link); RUNBOOK "Create an account", "Lost mailbox", the
  `staff.email_change_notice_failed` line, a `team_alert.hold_unsent` line (check the console and restart) and a 0169 deploy note; API.md, DATA_MODEL.md (`hold_notice_at`); FOLLOWUPS, removing what shipped.

## 9. Tests (test first)

**`apps/api/test/auth/staff-admin.int.test.ts`, `test/audit/audit.int.test.ts`:**
- Refusals: bad email and an existing account send nothing and leave no second link; missing mail settings write nothing;
  no password is accepted: the input type has none, and a spawned CLI never touches stdin; a flag after the email refuses;
  sign-in before the link is used answers the ordinary 401; a used, expired (past 24 hours) or disabled account's link is
  refused; a failed send keeps the account and link, records `sent: false`, and the CLI exits 1 (spawned, mail stubbed).
- `create` grants no role.
- `sent: true` with a failed `staff.invite` audit does not print "the email did not go out".
- Works: link sets a password, then row 1 signs in with the code; the expired path through "Forgot your password?".
- Races: the same link used twice at once sets one password; two `create` calls at once make one account, one link, one mail;
  a Forgot request replaces the link, and the older one then fails.
- The sweep leaves a link under 1 day old.

**`apps/api/test/db/owner-email-hold.int.test.ts` (new), `test/console/owner-email.int.test.ts`, `email-change.test.ts`:**
- Refusals: a waited apply with no notice closes `send_failed`: email, sessions, challenges and reset links untouched, no
  applied mail; `gone` for unknown token, `pending` and closed rows; `sent` false closes; a repeat changes nothing; the password
  path never needs the notice.
- Route: failed send answers 503 and the row is closed; door failure after a send never applies.
- Races (two connections, `applies_at` moved back): door against Stop, against admin cancel, and against `apply_due` holding the
  row, each ending in one final state with no error; two `apply_due` runs apply once.
- Old API: a held row with no door call closes at apply, and the worker sends nothing.

**Outsiders (`apps/api/test/security/*`):** `questify_app` still cannot read or write `staff_email_change`, and cannot execute
`owner_email_apply`; PUBLIC cannot execute the door; a wrong token changes nothing; the public route list is unchanged; function
lists and the rehearsal guard gain the door; `staff_user` stays closed to the API role beyond `password_hash`.

## 10. Deploy and the seconds on the old API

Order as RUNBOOK: migrate 0169, then the API, then web. No down migration; the column and door are harmless if unused.

**Before migrating:** `SELECT count(*) FROM staff_email_change WHERE state = 'held';` Any such row closes `send_failed` at its
due time (no backfill). If there are rows, wait for them to apply or restart them afterwards.

| Old code on 0169 | What happens |
|---|---|
| Sign-in, reset, password change, `create` | Unchanged, nothing they use moved |
| Password-confirmed email change | Unchanged: `how = 'password'` skips the new branch |
| Hold confirmed in those seconds | Notice goes out, nothing records it, so it closes `send_failed` 24 hours later. Safe side; the admin restarts it |
| Old worker | Gets `{outcome: 'send_failed'}`, mails nothing, logs nothing; the audit row and console show it |
| Rollback | Same as the row above for every hold made meanwhile, until the API rolls forward |

The reverse (new API on 0168) does not arise with this order. If it did, a hold would fail at the door with a 500 after the
notice, and the row would stay held and close once 0169 ran. New web on the old API, and old web on the new, both work: the error
carries its own text, and the console string only needs `appliesAt`.

## 11. New strings

Written with `ux-araby`: no `تم`, one term ("إشعار"), system actions as a light passive as elsewhere on these pages. CLI output
is operator-only and English, as the rest of the CLI.

| Where | Arabic | English |
|---|---|---|
| Error `email_change_notice_failed` | تعذّر إرسال الإشعار إلى بريدك القديم، فأُغلق التغيير. اطلب من دعم كويستفاي البدء من جديد. | We could not notify your old address, so the change was closed. Ask Questify support to start again. |
| `console.ownerEmail.last.noticeFailed` | أُغلق في {time}: تعذّر إشعار البريد القديم. | Closed at {time}: the old address could not be notified. |
| Email subject `staffInviteEmail` | اختر كلمة مرور حسابك في كويستفاي | Choose your Questify password |
| Email line 1 | أنشأنا لك حسابًا في كويستفاي. اختر كلمة المرور من هذا الرابط: | A Questify account was created for you. Choose your password here: |
| Email line 2 | الرابط صالح لمدة {hours} ساعة ولمرة واحدة. إذا انتهت مهلته، اختر «نسيت كلمة المرور؟» في صفحة تسجيل الدخول. | The link works once and lasts {hours} hours. If it runs out, use "Forgot your password?" on the sign-in page. |
| Email line 3 | إذا لم تتوقع هذه الرسالة، تجاهلها. | If you did not expect this email, ignore it. |

The email is one bilingual message with `/ar/` and `/en/` links, like `passwordChangedEmail`, subject `ar | en`. `{hours}` is
always 24, so the Arabic singular "ساعة" is correct; a new value must recheck it.

## 12. Mutation globs

`apps/api/src/auth/staff-admin.ts`, `apps/api/src/auth/email-change.ts`, `apps/api/src/auth/email/from-config.ts`.
`team-alerts/worker.ts` is outside `stryker.config.json`'s list, so its test is the DB and route tests above.

## 13. Risks

- A mailbox holder can set a first password within 24 hours: the same reach as Forgot today (ADR-078), plus the sign-in code.
- A hold can close for a false failure when the mail did go out: the old address saw a notice for a closed change, and Stop
  answers `none`. Safe, and the admin restarts.
- A crash after commit tells the owner nothing until they ask support at the 24-hour mark. Accepted: rare and fails closed.
- A third party's Forgot requests can replace the pending link: each mails the same person a working link, 3 an hour.
