# Runbook

> How to run, check and repair Questify. Each entry says what to do, not why (the why is in the ADRs).

## Local checks

- `pnpm ci:changed`: lint, the function-limit ratchet, format check, types and all tests (the checks of the push and
  pull-request gate, ADR-372). The gate adds the browser specs of the changed area: `node scripts/ci-scope.mjs origin/main`
  prints them as `specs=e2e/a.spec.ts e2e/b.spec.ts` (or `specs=all`, with the reason on stderr); after a web build run
  `pnpm --filter @questify/web e2e <those paths>`.
- `pnpm lint:limits`: the ratchet for the 100-line and complexity-8 limits of `docs/rules.md` (T-023). It fails on a
  function over a limit that is not in `scripts/function-limits-baseline.json`, or on a baselined one that grew
  (the message names the file, line and values). Fix it by splitting the function. It lists shrunk or removed
  offenders without failing; `node scripts/function-limits.mjs --update` then rewrites the baseline, only downward
  (it refuses while anything grew). Commit the baseline with the change. A renamed offender counts as new.
- `pnpm ci:full`: `ci:changed` plus the dependency audit, and, for the browser side, the whole suite after a web build
  (`pnpm --filter @questify/web e2e`, about 21 minutes on a CI runner, below). `full.yml` runs the same on GitHub, daily and by hand. The
  mutation check is not run here (ADR-174): it runs only on GitHub, see below.
- Integration tests need a throw-away PostgreSQL: `docker compose up -d`, then set
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`. Without it they are skipped, and
  a skipped database test proves nothing: check the count of passed tests.
- A full local run at the default parallelism (16 threads) can crash the test PostgreSQL (2026-11-03, T-018): its shared memory is
  Docker's default 64 MB, so a heavy query fails with "could not resize shared memory segment", the container goes into crash
  recovery ("the database system is in recovery mode", several minutes) and every file after it fails with "Hook timed out" or
  "Connection terminated". The crash also leaves hundreds of `questify_test_*` databases (8 GB once). Run the API tests with
  `npx vitest run apps/api --maxWorkers=4` (about 30 minutes, clean) and the rest with `npx vitest run apps/web apps/app
  packages scripts` (under a minute, no database). After a crash, drop the idle leftovers with a `\gexec` of `DROP DATABASE … WITH
  (FORCE)` over `pg_database` where `datname LIKE 'questify_test_%'` and no row in `pg_stat_activity`.
- "too many clients" or "remaining connection slots" in a local full run: every integration file opens its own pool.
  `compose.yaml` starts PostgreSQL with 300 connections; a container made before that keeps 100 until
  `docker exec questifyapp-postgres-1 psql -U postgres -c "ALTER SYSTEM SET max_connections = 300"` and a restart.
- CI (`.github/workflows/ci.yml`, on a push to `main` and on a ready pull request; drafts are skipped). Three jobs, the
  last two chained and both next to the first:
  - `checks` (12 to 15 minutes, cap 25): PostgreSQL 17 and Redis services, secret scan, install, `ci:changed`, the API
    build, `pnpm audit` (the security floor, always).
  - `scope` (about 0.5 minutes): `scripts/ci-scope.mjs` reads the changed files and says whether the change needs the
    browser tests and which specs (web app, shared package, lockfile, workflow, API source or migrations; a unit-test file
    alone starts nothing, and then `browser` is skipped).
  - `browser` (a matrix of 2 shards, cap 30, each on its own runner with its own PostgreSQL and Redis): install, web build,
    then `playwright test --shard=N/2` over the specs `scope` chose. The shards run in parallel and next to `checks`, so
    a run that needs the whole suite takes about 14 minutes (scope 0.5, setup 1, one shard 11 to 12, step cap 22; one job
    took 32), and `checks` is then the longer job; a scoped run takes as long as `checks`. Playwright cuts the (project, file) groups into halves by test
    count, so shard 1 is the desktop project and shard 2 the phone project (177 tests each). A shard with nothing to run
    passes. A failed shard keeps its traces as the artifact `e2e-results-1` or `e2e-results-2`; `fail-fast` is off, so
    both shards report. These times are estimates from the old single-job runs: read the first sharded runs
    (`gh run view`) and tighten the caps.
  The browser run is the layout check plus the specs of the changed area (the `AREAS` table in the script, 2 to 5 minutes a
  shard), and the whole suite when shared code changed: the interface kit, layouts, global CSS, Next, Playwright or package
  files, e2e helpers that many specs import, the API's root files and its auth, database, audit, settings, completion and
  translation code, an edited line in `app.ts`, `http-errors.ts` or the shared `index.ts`, a file or text no area names,
  more than 20 specs' worth of areas, or an unknown base. The `scope` log says which and why. A new browser spec must be
  named in `AREAS` (`scripts/ci-scope.test.ts` fails otherwise). `full.yml` runs everything, including every browser spec
  (one job, no shards), daily at 01:17 UTC on `main` (about 900 minutes a month, free while the repository is public) and by
  hand.
- Browser tests locally (web app): `pnpm --filter @questify/web build`, then
  `pnpm --filter @questify/web e2e` with `TEST_DATABASE_URL` set (first time: `pnpm --filter @questify/web exec
  playwright install chromium`). Run the specs of your area before merging a web, shared or API change, and the whole suite when `ci-scope` says
  `all`; the whole suite is part of `ci:full` and takes about 21 minutes on a CI runner, more on the PC (354 tests, one worker; CI splits it into two shards of 11 to 12). `E2E_API_LOG=1` prints the API's
  unexpected errors during a browser run; `--reporter=list` shows each spec's time.
- Heavy checks run on GitHub, started by hand (ADR-149; free while the repository is public): push the branch, then
  `gh workflow run full.yml --ref <branch>` (every test, both builds, the audit and all browser tests, about 30
  minutes) or `gh workflow run mutation.yml --ref <branch> -f mutate="<globs>"` (Stryker with incremental results
  kept between runs; empty `mutate` runs every core module). Read the result with `gh run watch` and the
  `mutation-report` artifact. The PC keeps the quick loop: single test files while coding. **Never run mutation
  on the PC** (ADR-174: about 18 GB, it can crash it). One `mutation.yml` run per batch of 2 or 3 core tasks, with
  `mutate` set to the core files those tasks changed; kill survivors only while a file is under 90%.
- If incremental results reuse stale static/schema survivors after new tests, request a fresh scoped proof with
  `gh workflow run mutation.yml --ref <branch> -f mutate="apps/api/src/tickets/console-routes.ts,!**/*.test.ts" -f force=true`.
  The optional boolean `force` defaults to false; true adds Stryker 10's `--force` alongside `--incremental`,
  re-testing all selected mutants and saving fresh incremental results for later runs. Ordinary dispatches keep
  incremental reuse. Only the coordinator dispatches, one run at a time (a new run on the same ref cancels
  the active run).
  Run 40172088017 reused nine static schema survivors with empty coverage and the prior `testsCompleted: 1393`
  despite 31 new passing boundary tests; its 85.07% score is not fresh proof for those survivors.

## Staff sign-in

Settings: `DATABASE_URL`, `AUTH_SECRET` (32+ characters), `QR_SECRET` (32+ characters, its own value), `REWARD_CODE_SECRET` (32+ characters, its own value; T-203), `DASHBOARD_ORIGIN`, `GMAIL_SERVICE_ACCOUNT_KEY`, `MAIL_FROM`,
optional `GMAIL_ACT_AS` (the mailbox to act for when `MAIL_FROM` is an alias), optional `RESEND_API_KEY` + `RESEND_FROM`, `SECURITY_ALERT_EMAIL`, `TRUST_PROXY_HOPS`. All come from the host's
secret store, never from chat or the repository. The app refuses to start without the required ones.

**Create an account** (inside the app container, with the owner connection; the password is piped in, never
typed on the command line or kept in an environment variable):

    printf '%s' "$PASSWORD" | node staff.cjs create someone@example.com [--admin]

**A person is locked out ("too many attempts")**: wait 15 minutes, or free them now:

    node staff.cjs clear-throttle someone@example.com    # needs AUTH_SECRET in the environment

If an attacker keeps a known admin email throttled, this is also the way back in; the address limit may need the
same attention if the attacker rotates addresses (look for the `staff.throttled` log lines).

**"Too many sign-in codes" (5 an hour)** can be caused by someone who knows the password. `clear-throttle` frees it
too; then change the password (dashboard, My account) or reset it.

**A locked-out admin (or anyone), in order:**
1. Forgot the password: "Forgot your password?" on the sign-in page emails a link (30 minutes, one use). Using it
   ends every session and clears the sign-in lockout, so the next sign-in works.
2. Throttled, or the reset requests are used up (3 an hour per email): `node staff.cjs clear-throttle <email>` clears
   the failures, the code count and the reset-request count.
3. Lost the mailbox: there is no web way back (the mailbox is the second factor, ADR-078). With the owner connection,
   disable the account and create a new one; record it.

**`staff.outbound_cap` in the log** (sign-up answers 503, invites answer `mail_cap`): the day's budget of 400 sign-up and
invite emails is spent. Sign-in and reset codes are not counted and still go out. Look for an abuse pattern (many
sign-ups from one address range); the budget refills over 24 hours, or raise `outboundMailPerDay` in
`apps/api/src/auth/limits.ts` if the traffic is real.

**Invite links answer 429 for many people at one site** (launch day behind one office network): looking at and
accepting invite links share 20 an hour per client address (`inviteChecksPerAddress` in
`apps/api/src/auth/limits.ts`). Raise it for the day, or ask people to open their link from a phone's own network.

**`event.lifecycle_failed` in the log** (with `reason` and the SQLSTATE `code`): the 30-second tick could not move events
through their lifecycle. Once is harmless: the next tick catches up, and every status shown is read at the moment, so
no one waits on the tick. Repeated for more than five minutes: check the database (`55P03` is a lock timeout, `08…` a
lost connection); to move due events by hand, run `SELECT advance_event_lifecycle();` with the API's role.

**`event.archive_failed` in the log** (T-411): the tick's last step could not archive ended events. Nothing waits on
it: every player read works in both states, and an event left Ended only stays editable by its team a while longer.
Repeated: check the database as above; by hand, `SELECT archive_ended_events();` with the API's role (it
archives only what the rule allows, 100 a call). An event that stays Ended long after its close is waiting for one of
ADR-341's conditions: `SELECT archive_due(e) FROM event e WHERE id = '<event>'` as the owner, then look for an end
less than 30 days ago (the help desk's sending window: never archived sooner), a `reserved` redemption, an open
ticket (an escalated one waits for Questify's answer; a ticket is purged 90 days after the latest of the end, the
sending, the escalation and the return), or results not revealed within 60 days of the end. One failing row would
roll back the whole run's batch every time (no per-event exception block, ADR-341): find it with `archive_due` on
the oldest ended events and fix that row. `event.archived` (info) counts the events archived in a run.

**`quest.refused` spikes in the log** (T-105): the `reason` says which. Many `forged` or `not_questify` from one player
means someone is trying made-up QR contents; many `old` after a "New code" means a printed sheet was not replaced.
A player stopped by the wrong-code limit (`too_many_attempts`) waits out the 10-minute window; there is no command to
free a player sooner yet. Nothing here holds or removes points: flags come with T-209.

**`quest.code_release_failed`**: the database was unreachable for the moment after a correct code; that player has one
extra counted attempt for 10 minutes. No action unless it repeats (then check the database).

**`staff.breach_check_unavailable` in the log** (password set answers 503): the API cannot reach
`api.pwnedpasswords.com`. Check outbound HTTPS from the API container; nothing is changed while it is down.
`staff.password_notice_failed` means a "password changed" email did not go out (see the email senders below).

**Both email senders are down** (`staff.email_unavailable` in the log, sign-in answers 503): nobody can sign in.
The log line names the step and Google's reason (`unauthorized_client`: the domain-wide delegation or its scope is missing; `invalid_grant`: the mailbox in `GMAIL_ACT_AS` or `MAIL_FROM` is not a real user, or the clock is off). Check Google's daily sending limit, then Resend's key and domain. A sender that is
configured but wrong shows as `staff.email_failover` first.

**Force a person out**: end their sessions from the database owner connection
(`UPDATE staff_session SET revoked_at = now() WHERE staff_user_id = '...' AND revoked_at IS NULL`), then record it
in the same transaction:
`INSERT INTO audit_log (actor_type, action, target_type, target_id) VALUES ('system', 'staff.session.end_all', 'staff_user', '...')`.
A platform admin's sessions can be ended from the console's Admins page (T-709), with a reason in the audit log; this SQL is for a person who is not an admin or when the console is down.

**Audit log**: read it from the owner connection (`SELECT * FROM audit_log ORDER BY id DESC LIMIT 50`). No one can
change or remove an entry, the owner included; do not try to work around the triggers.

**Rotating `AUTH_SECRET`**: kills open sign-in codes and resets the throttle windows; nothing stored depends on
it. Sessions stay valid. Do it when someone with access leaves or the secret may have leaked.

**Rotating `QR_SECRET`** (ADR-116): every quest QR ever printed, in every organizer's events, stops working at once;
there is no grace period. Do it only when the secret may have leaked (anyone holding it can make a code for any
quest). Steps: set a new value in the secret store and redeploy the API; tell every organizer with a scheduled or live
event to open Print codes and reprint (the page shows the new codes); note it in the incident log. Players who scan
an old code get "this code no longer works" (T-105). A routine rotation is not needed: the key signs codes, it does
not encrypt data.

**`REWARD_CODE_SECRET`** (ADR-136) encrypts digital reward codes. Unlike `QR_SECRET` it protects data: losing or
changing it makes every code not yet given unreadable (players who already redeemed see "We couldn't show this code";
the log says `reward.code_unreadable` with ids). Back it up with the database's backups, in a separate place. To rotate
after a leak: set the new value and redeploy; ask each organizer with digital rewards to upload their unused codes again
on a new reward (the old ones cannot be read), and remove the old reward. Keep the code out of any idempotency cache
that is shared or written to disk (today's is in memory, per process).

## Player sign-in and SMS (T-107)

- **Settings:** `MSEGAT_USERNAME`, `MSEGAT_API_KEY`, `MSEGAT_SENDER` (the activated services sender, never the `…AD`
  one), all three or none; production refuses to start without them. Without them elsewhere every SMS is refused and
  the app offers email.
- **Before the first real SMS from a server:** Msegat may reject calls from an unregistered address (`M0037`). Register
  the API's outbound address in the Msegat account or switch the static-IP check off there.
- **Log events** (never a phone, email, code or token): `player.code_sent {channel, outcome}` (`unknown_timeout` and
  the like mean the text may still arrive), `player.sms_refused {gateway, reason}` with Msegat's code, `player.budget_half`
  / `player.budget_spent {channel}`, `player.throttled`, `player.code_failed`, `player.signed_in`, `player.signed_up`,
  `player.refresh_reuse`.
- **`sms_refused` reasons:** `1060` the balance is spent (top up the Msegat account; players meanwhile use email);
  `M0037` the static-IP check; `1110` the sender name is wrong or not activated; `1120` the number or international
  sending; `unreachable` Msegat could not be reached twice; `not_configured` no Msegat settings.
- **Budgets:** at most 5,000 login SMS an hour on the whole platform (`smsPerHour`, a warning at half; Q-093) and 1,000
  player email codes a day (`playerEmailsPerDay`, below the mailbox quota so staff codes always have room, ADR-117).
  A spent budget answers 503 until the window moves on. Tuning numbers live in `apps/api/src/auth/limits.ts`.
- **Freeing a contact or an address** (a player locked out by someone else's wrong guesses, SECURITY.md): the counts
  are rows in `auth_throttle` (buckets `player_code_contact`, `player_code_device`, `player_code_address`,
  `player_fail_contact`, `player_fail_address`), keyed by `contactThrottleKey` of the stored phone (`+9665…`) or
  lower-case email under `AUTH_SECRET`. Compute the key in a one-off script and call `clearKey(db, bucket, key)` (owner
  connection), as for staff.

## The App Review demo (T-710, ADR-560 to ADR-568)

- **Once per environment:** console, **App Review demo**, type Questify's reviewer SIM number (Q-520; never a real
  person's) and **Create the demo**. It makes the "Questify Review Demo" organizer (you are its owner, every overridable
  feature On), the live "App Review Demo" event (its end rolls 60 to 90 days ahead by itself), 12 fictional players with
  points and the reviewer account (an operator allowed to play). A number a player's account holds is refused.
- **Build the content once** as the demo organizer's owner in the ordinary dashboard (ADR-568): every quest type, shop
  rewards with `DEMO-` codes for digital ones, and the review-day items: a live poll with 1,440 minutes, a running
  community goal with an unlock step, a scheduled flash quest and a boost, an NFC quest, a station paired for the
  screen-QR quest. The page's **Readiness** list shows what is still missing.
- **Before each store submission:** **Prepare for review** with the build's version and a window (14 days by default,
  30 at most). The reviewer account is erased and made again (held prizes forfeited) and a new six-digit code is shown
  **once**: paste it into App Store Connect and Play Console at once with the reviewer number and the event's join
  code. Then sign in as the reviewer with that code and play to level 3 (at least 40 gems, T-806). No SMS is ever sent
  while the window is open.
- **After review:** **Close window**. The fixed code stops and the reviewer is signed out; the window also closes by
  itself at its end (the lifecycle tick, within 30 seconds). With the window closed the reviewer number is an ordinary
  one: a real SMS goes to the SIM.
- **A rotated `AUTH_SECRET`** invalidates the code and the number's stored key: Prepare again.
- **Anyone who knows the reviewer number can use up its sign-in limits** (10 wrong codes in 15 minutes, 30 a day). A
  log line `review_demo.code_guessing` fires when its wrong codes pass 10 in a day. Prepare gives a new code; **Change
  reviewer number** (a second Questify SIM) is the fallback, and closes the window and signs the reviewer out.

## Questify invitations (T-409, T-409b, ADR-329 to ADR-335; server and web pages built)

Confirmed by the T-409 build (migration 0073, `apps/api/src/invitation-campaigns/`) and the T-409b build (the pages).

- **Where people work:** an organizer's owner asks on the event's Invitations page (the event page links to it only
  while the switch is on); a Questify admin opens the console's Invitations (the home links to it with the number of
  requests waiting), reads the names and the exact text, sets the cap and the send time (Riyadh time; a time in quiet
  hours moves, and the page says so) and approves, or refuses or cancels with a note the owner reads. The invitation
  links in the SMS open `/{lang}/i#{token}`.

- **Setting:** `MSEGAT_PROMO_SENDER`, the registered promotional "...-AD" sender name (Q-034), used with the same
  `MSEGAT_USERNAME`/`MSEGAT_API_KEY`. Unset: SMS is unavailable for invitations and the console cannot approve one. Never
  set it to the service sender (`MSEGAT_SENDER`) or the reverse (FR-1112).
- **Deploy order for migration 0073:** `set_marketing` gains a fourth argument with a default (`lang text DEFAULT
  NULL`, NULL read as Arabic), so the running API's 3-argument calls keep working: run the migration, then deploy the
  API. Consents saved in between simply have no language and get Arabic messages.
- **Turning `invitationCampaigns` on** (console switch, off when absent), only when all three hold: the T-409b pages (the dashboard,
  console and landing pages) are deployed; the privacy policy carries the T-807 line on invitation counts (ADR-332); the
  Q-034 promotional sender is registered with the operators and `MSEGAT_PROMO_SENDER` is set (and Msegat's static-IP
  check, `M0037`, passes for the API's address).
- **Kill switch:** turning `invitationCampaigns` off refuses new requests and stops the tick from starting or claiming
  anything at once; messages already handed to Msegat finish, and the settle step (joined counts, publishing, purging)
  keeps running. Turning it on again resumes `sending` campaigns where they stopped. To stop one campaign, cancel it in
  the console instead.
- **Alert:** `invitation.channel_hold {channel, code}` at error level means Msegat refused for the account (`1060`
  balance, `1110` sender, `M0030` a sender without the "AD" ending, `M0090` a template mismatch, `M0037` address,
  `unreachable`): SMS invitations pause for 15 minutes and then try again; the console shows the hold. Fix the account
  (top up, activate the sender, register the address); nothing is lost and no message fails because of it.
- **One campaign can hold every campaign:** a refusal that is really about one campaign's text (a template mismatch
  `M0090`, or `M0030`) still holds the whole SMS channel, every 15 minutes, so it blocks every campaign behind it. If the
  alert repeats with the same code while other campaigns wait, cancel that campaign in the console (its queued messages
  are cancelled, nothing else is lost) and check the Msegat template or sender.
- **Quiet hours:** an invitation SMS never leaves 22:00 to 09:00 Riyadh time, and in Ramadan never 22:00 to 12:00 (the
  fixed band, also checked in SQL, plus CST's Ramadan band 01:00 to 12:00); a send that crosses 22:00 resumes by itself
  at 09:00 (12:00 in Ramadan).
- **Queued messages never wait forever:** if the event ends while messages are still queued (the switch was off,
  `MSEGAT_PROMO_SENDER` unset, a hold, quiet hours), the settle step, which runs even with the switch off, skips them and
  ends the campaign as sent with the reason "event over"; the console shows how many were skipped.
- **Startup check:** the API refuses to start when `MSEGAT_PROMO_SENDER` equals `MSEGAT_SENDER` (case and spaces
  ignored), or when it is set without the Msegat account.
- **Fill timing (by hand, `apps/api/test/perf/invitation-fill-timing.int.test.ts`, 2026-10-27, the development laptop:
  Docker Desktop on Windows, busy):** at 100,000 opted-in players the console's estimate takes 0.7 s and the fill 4.0 s
  (the plan's 2 s gate is missed on this machine; ADR-334). The start therefore runs in its own transaction with a 60 s
  statement limit and a 65 s client read limit (the API pool's are 5 s and 6 s), so a slow database never kills a fill
  half-way. While it runs, another server
  skips the fill, and an edit of that one event or a cancel of that campaign waits; no player or join waits. Measure
  again on CranL before turning the switch on, and before approving a cap above 20,000 if it took over 10 s.
- **Other log lines:** `invitation.start {outcome}` (started, too_small, event_changed, event_over), `invitation.ack_failed
  {code}` (the message's lease expires within a minute and it is counted as unknown, never resent),
  `invitation.settle_failed` / `invitation.send_failed {code}` (the next tick tries again). None carries a phone, a
  text or a player.

## Push notifications (T-501 store, center and worker; T-501b APNs and FCM clients)

Plan: `docs/plans/2026-10-28-t-501-push.md` (ADR-342 to ADR-349, Accepted; the build's details ADR-350). Migration 0076
(undeployed). The push worker runs inside the API container on its own pool of 3 connections: it fans out (personal
notices first), claims rounds of 200 under 60-second leases, sends in waves of 50 and settles every 10 minutes. The
clients (T-501b, ADR-351) call Apple and Google directly over HTTP/2, one reused connection per host (closed after 4
quiet minutes); without keys no client exists: the center fills and every push expires unsent.

- **Settings (all-or-none per provider):** `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (the `.p8` from the Apple
  Developer account, PEM or base64), `APNS_TOPIC` (`app.questify.mobile`); `FCM_SERVICE_ACCOUNT` (the Firebase
  project's service account JSON, or its base64). A partial or malformed set stops the server at start. None set: the
  server starts, logs `push.provider_missing` once, and sends nothing for that platform; the in-app center still holds
  every message. Keys live only in the CranL secret store. The checks at start (each names the setting, never a value):
  the `.p8` must be an EC P-256 private key and is signed with once (a key that cannot sign stops the start); the key
  and team ids are 10 capital letters or digits; `APNS_TOPIC` is a bundle id; the service account needs `project_id`,
  `client_email`, an RSA `private_key` and an https `token_uri`. Values come from the environment only (no file path).
- **Making the keys (Dhia, once):** in the Apple Developer account create an APNs auth key, choosing the environment
  **Sandbox & Production** and the key restriction **Team Scoped (All Topics)** (a key limited to one environment
  answers 403 `BadEnvironmentKeyIdInToken` on the other host, which holds that target and logs `push.provider_hold`;
  a topic-specific key must list `app.questify.mobile`); note its key id and the team id; set the four `APNS_*`. In Firebase,
  Project settings → Service accounts → Generate new private key; set `FCM_SERVICE_ACCOUNT` to the file's base64
  (`base64 -w0 key.json`). Then run the go-live checklist below.
- **Switch:** `pushNotifications` (on when absent). Off, nothing is sent; the center, mutes and registration keep
  working.
- **Alerts (error level):** `push.provider_hold {target, code}` (an account or quota refusal, or the breaker),
  `push.mass_invalid {target}` (most of a round came back as an ambiguous token error: check the APNs environment, the
  bundle id or the Firebase project), `push.fcm_auth_failed {status, code}` (Google refused the service account: FCM
  is held 15 minutes; `code: unreachable` at start means Google did not answer and the next send asks again),
  `push.apns_refused {target, status, code}` and `push.fcm_refused {status, code}` (a request we built wrong, such as
  `PayloadTooLarge` or `INVALID_ARGUMENT` on a field other than the token: a bug to fix). A failing step logs `push.fan_out_failed`,
  `push.round_failed`, `push.settle_failed`, `push.due_failed` (the due scans: reservations, T-501d; flash quests,
  boosts, category openings and the event starting soon, T-501e) or `push.ack_failed` with
  the SQLSTATE only (never a token, a text or a
  player); the loop goes on after a second. A failed acknowledgement leaves its rows to lease expiry (`unknown`, never
  sent twice).
- **Backed-off notice (error level):** each failed fan-out try of a notice logs `push.fan_out_batch_failed {notice,
  code}` and the notice waits 1, 4, 16 minutes, then an hour between tries (`notice.retry_after`), so the notices
  behind it go out and a passing error (`40P01` deadlock, `55P03` lock timeout, `57014` statement limit at peak) only
  delays it. The third failure in a row raises the alert `push.notice_parked {notice, code}`: find the cause from the
  SQLSTATE and fix it; it is retried by itself every hour. To retry at once (the manual override), as the owner:
  `UPDATE notice SET retry_after = NULL, fan_failures = 0 WHERE id = <notice>;` (it resumes from its cursor; members
  already fanned keep their rows).
- **Start-up (warn level, production):** `push.provider_missing {platform}` once per start for each platform with no
  provider (both until Dhia's keys are set).
- **Timing check (by hand, never in the default run or CI):**
  `PUSH_TIMING=/path/to/out.txt TEST_DATABASE_URL=… pnpm vitest run apps/api/test/perf/push-timing.int.test.ts` after a
  change to the fan-out, the claim or their indexes (skipped unless `PUSH_TIMING` is set, like the other timing files;
  it takes about 4 minutes). Gates: each fan-out call under 1 s and 50,000 members under 30 s; claim plus ack of 200
  under 200 ms with 60,000 event rows, 65,000 event rows or 10,000 personal notices queued (at most 200 heads visited);
  a 50,000-row notice then a 10-row one, the first claim takes 100 and 10. 2026-10-28 on the laptop: 18.4 s in 27 calls
  (slowest 794 ms); claims 92, 163 and 153 ms median; 200 heads; [100, 10] (ADR-350 (10)). Measure again on CranL
  before NFR-004's load test. The join-decision push (T-501d):
  `PUSH_TIMING=… pnpm vitest run apps/api/test/perf/push-producers-timing.int.test.ts` after a change to the
  `enrollment` triggers, accept-all or `notice_create`. Gate: under 5 s per call for an event without a hard limit
  (1,000 per call) and with one (250 per call); 2026-10-28 on the laptop with 5,000 waiting: 1.70 s with the trigger,
  1.22 s without, 0.85 s for a hard-limited event's 250, the personal fan-out of their notices 0.4 s (ADR-353 (5); an
  unbounded accept-all of 5,000 had taken 7.4 s). A hard-limited event's call grows with the event's seated players
  (its seat guard recounts them on every row, T-221). The dashboard repeats the call while requests wait, at most 10
  calls a press, then says to press again. The event pushes (T-501e):
  `PUSH_TIMING=… pnpm vitest run apps/api/test/perf/push-event-timing.int.test.ts` after a change to an event kind's
  audience or to `sees_category`, `flash_shown`, `member_sees_quest`, `notice_visible` or `notice_audience_ok`.
  It also times a category's opening whose category gains a 20-quest gate after the fan-out (the claim must not check
  the gate) and an opening notice of a gated category (the fan-out must not either). 2026-10-28 on the laptop, calls of
  1,000 (ADR-354 (9)): a live poll to 50,000 members 30.0 to 30.2 s in 52 calls, median 0.60 s, slowest 0.68 s (hard
  gates: 1 s a call and the 5 s statement limit; 30 s for the whole is a soft target, since the worker runs one
  fan-out call then one claim of 200 per pass and the claim rate sets when the last member is pushed); an
  opening 27.3 s, median 0.55 s; the claims about 0.1 s (73 ms with the gate set); the gated opening 0.15 s a call. The
  generic event notice (`push-timing.int`) with calls of 1,000: 18.9 s in 52 calls, slowest 0.43 s, claims 89 ms. The
  hidden-category hint (T-501g):
  `PUSH_TIMING=… pnpm vitest run apps/api/test/perf/push-hint-timing.int.test.ts` after a change to `push_hint_ok`,
  `category_hint_preview` or the hint's fan-out (about 2.5 minutes). Gates: the count and each fan-out call inside the
  API's 5 s limit, each call under 1 s. 2026-10-28 on the laptop (ADR-357 (6)): the count 305 to 366 ms at 50,000
  members, with or without one exclusion entry (an exclusion rule asked per row through `excluded_from_event` took
  2.4 s), 228 to 241 ms with a tag audience; the press 311 to 327 ms (it counts first); the fan-out 41.2 s in 102 calls
  of 500, median 0.41 s, slowest 0.47 s.
- **Personal pushes (T-501d):** decisions, help-desk answers and prizes are written by triggers in the same
  transaction as the door; reservations ready at the desk or ending come from `push_due()`, which the worker runs every
  minute with the switch on or off. A missing `notice_kind` row writes nothing and refuses nothing. Seen from SQL as the
  owner: `SELECT kind, count(*) FROM notice WHERE created_at > now() - interval '1 day' GROUP BY 1;`.
- **Event pushes (T-501e):** a flash quest's launch, a live poll's send and a boost saved to start now are written by
  triggers in the same transaction as the door; a community milestone by the community tick's settle (one push per goal
  per settle, for the highest step it reached); a scheduled flash quest's opening, a boost's later start, a category's
  opening and the event starting within the hour come from `push_due()` (up to a minute late). A category that unlocks
  after another is never announced; a start or an opening moved 15 minutes or more is pushed again, at most twice. A member who may not
  play, a rehearsal account on a live event and a member who cannot see the quest or category get none. A missing
  `notice_kind` row writes nothing and refuses nothing.
- **Outbox health (SQL as the owner):** `SELECT target, state, count(*) FROM push_send GROUP BY 1, 2;` many `queued`
  rows on one target with nothing `sent` means that target is held or has no provider; `SELECT count(*) FROM notice
  WHERE fanned_at IS NULL;` should stay near 0.

### Push go-live checklist (gates T-806; run once Dhia's keys exist)

Record the date, the build numbers and the phones used under each line. Every line must pass before the store
submission (T-806) is marked done. What T-501b's tests prove without keys: every answer in the plan's APNs and FCM tables
maps as written (local HTTP/2 servers speaking each wire format: statuses, reasons, resets, `GOAWAY`, slow and silent
hosts), the provider token and the OAuth token are built and refreshed as specified, and nothing secret reaches a log.
Probed 2026-10-28 with self-made keys (ADR-351 (10)): both Apple hosts answered 403 `InvalidProviderToken` over TLS and
HTTP/2, Google's token endpoint 400 `invalid_grant`, FCM 401 `UNAUTHENTICATED`. What only real keys and phones show is
below.

1. The APNs provider token is accepted on both hosts: a development build receives through
   `api.sandbox.push.apple.com`, an internal or TestFlight build through `api.push.apple.com`; FCM accepts the service
   account.
2. A TestFlight install registers as `production` (its environment reads `null`, ADR-344 (5)) and receives a push.
3. A real iPhone and a real Android phone each receive a personal push and an event push, in Arabic (right to left on
   the lock screen, Western digits) and in English.
4. After uninstalling the app on each phone, a later push comes back as APNs 410 `Unregistered` and FCM 404
   `UNREGISTERED`, in the shapes T-501b maps, and the device is marked invalid. Allow time: Apple may keep answering
   200 for a while after an uninstall (it learns of it from the phone), so send again after an hour, then a day, and
   record when the answer changed.
5. Sending the same notification twice replaces the first on both phones (APNs collapse id, Android tag).
6. A tap with the app killed opens the right screen: confirm where `expo-notifications` puts the direct-APNs custom key
   `q` (`trigger.payload` or `content.data`) and the FCM `data`, and that the app reads them there. The app (T-501c,
   `src/push/tap.ts`) reads `trigger.payload.q` (iOS; by the library's source `content.data` is only the `body` key
   of an Expo-service push, so empty here), `trigger.remoteMessage.data` and `content.data` (Android, flat `n k e r`),
   and ignores anything whose kind or ids do not check out. Send one of each kind from a killed app and from the
   foreground; a wrong placement is a one-line change in `tapOf`.
7. With the permission refused, the center still lists the message and Settings shows the off state.
8. A soak of more than 60 minutes of steady sending on both platforms: the APNs provider token is re-signed at 40
   minutes and the FCM access token renewed before its hour ends, with no `TooManyProviderTokenUpdates`, no
   `ExpiredProviderToken` hold and no `push.fcm_auth_failed` in the logs.
9. A phone offline (flight mode) while three pushes are sent gets only the latest when it comes back, on both platforms
   (APNs stores one notification per app; FCM notification messages always collapse, ADR-351 (5)); the center lists all
   three.

### The app's side of push (T-501c; phone checks owed to Dhia)

The app needs a new development or preview build (EAS, Dhia's step) because `expo-notifications` and `expo-application`
are native. An older build still runs: push is off there (Settings says so), everything else works.

- **The Firebase file is a hard gate on the Android store build (T-806).** Without it Android never gets a token, so no
  Android push can arrive; the app then skips the explainer and the system prompt, and Settings would still offer to turn
  notifications on. Do not submit the Android build until the file is in it and the Android lines of the checklist
  above have passed.
- **Getting the Firebase file.** Download `google-services.json` from the Firebase project (Project
  settings → Your apps → the Android app `app.questify.mobile`) and point `android.googleServicesFile` at it. It holds
  API keys, so how it reaches the build (an EAS file secret read by an `app.config.js`, or the file in the repository) is
  decided when Dhia has the file. Not set in T-501c; until then Android cannot get a token and registers nothing,
  quietly, and the center still works. The notification icon (a 96 px all-white PNG on transparent from the brand deck,
  `icon` in the `expo-notifications` plugin) is also not set, so Android shows its default.
- **iOS:** the Push Notifications capability and the APNs key come from the Apple Developer account (the key above);
  the entitlement `aps-environment` is written as `development` and Xcode makes it `production` in a release archive.
- **Checks on a real iPhone and Android phone, development build then TestFlight / preview:**
  1. A new install shows no permission prompt at launch or at sign-up; joining an event shows the explainer after
     "You're in"; "Turn on" shows the system prompt; "Not now" shows nothing for 30 days (change the phone's date to
     check) and never after the system has been answered either way.
  2. After "Turn on", the `push_device` row exists with the right `platform`, `environment` (`sandbox` for a development
     build, `production` for TestFlight and preview) and `language`; a restart the same day sends no second call;
     changing the app's language sends one.
  3. A push for each topic arrives on its own Android channel (system settings list six: Messages for you, Event
     announcements, Ranking, Community milestones, Reminders, Questify offers); on the locked screen, personal messages
     and offers show no text.
  4. Muting a topic in Settings stops its push and the row still appears in the center, unread; the bell shows a dot
     and the number clears after reading.
  5. Signing out removes the device (`push_device` row gone) and the phone gets no more of that account's pushes;
     signing in as another player moves the token to that player.
  6. With the permission refused (iOS Settings → Questify → Notifications off), Settings shows "Notifications are off on
     this phone" with "Open phone settings", every screen works, and the center holds the message.
  7. A simulator or emulator registers nothing (no `push_device` row) and shows no explainer.

## Usernames and the word lists (T-109, ADR-119)

- **Editing the lists until the console has a screen (FR-1779):** with the owner connection, add a word with
  `INSERT INTO username_word (word, match, language) VALUES (username_fold('<word>'), 'part', 'en');` (letters only;
  `word` matches a whole part of a name between `_` and digits, `part` matches anywhere). The table refuses anything
  else. Existing names are never re-checked: a new word applies to new names and renames.
- **What still slips through:** joined words against a `word` entry (`bigass`), repeated letters (`fuuuck`), spellings
  the digit map does not cover. Add a `part` entry when a pattern shows up.
- **Accepted false refusals:** a `part` entry also blocks innocent names that contain it, for example `swanky`
  (wank), `yamashita` and `matsushita` (shit), `pussycat` (pussy). Remove or narrow an entry if players run into one.
- **Username changes:** the platform feature `usernameChanges` (on by default) and the tuning number
  `usernameChangeDays` (default 30) in the platform settings. Every name a player had stays in `username_history`.
- **The migration refuses to run** when existing names break the new character rule or read alike after folding: it
  lists the player ids; rename them (owner connection) and run it again.

## The daily word guess lists (T-406d, ADR-327, ADR-328)

- **Import once per language before the first daily word goes live:** console → Content → Word bank → pick the language →
  Import → choose `data/word-lists/guess-list-en.txt` or `guess-list-ar.txt` → Add. The console sends 500 words a call
  (the database spends about 1.4 ms a word and the API allows a statement 5 s): English takes about 15 seconds, Arabic
  (119,023 words) about 3 minutes. The page shows the running total. If a call fails, the page keeps what the earlier calls did and says "Stopped after
  N of M words"; send the same file again to continue. That repeats the calls that went through (new Idempotency-Keys, so
  they run again): harmless, since adding changes nothing already there, but each call leaves an audit row (about 239 for a
  full Arabic import).
- **Pruning or growing a list:** paste or upload words and use Remove (or Add); the lines the database refuses are shown.
  A removal never touches a guess already made or a daily word.
- **Rebuilding the files** (a newer SCOWL or Wikidata dump): `scripts/build-word-lists.mjs` (usage in its header),
  with every download in its own folder; update the checksums and dates in `docs/legal/THIRD_PARTY.md`.
- **The hand-picked daily words need not be in these files:** scheduling a daily word also adds it to its language's
  guess list.

## Rankings and Redis (T-106, ADR-118)

- **Settings:** `REDIS_URL` (`redis://` or `rediss://`; required in production). Check at deploy whether CranL's
  managed Redis needs TLS (`rediss://`). Without Redis the API serves rankings from PostgreSQL (same order, more
  database work: about 50 ms per "my place" at 20,000 players).
- **The Redis must keep every key:** `maxmemory-policy noeviction`. The API reads it after connecting and logs
  `redis.eviction_policy` when it is something else or cannot be read (some managed services hide `CONFIG`; then check
  it in the provider's console at each deploy).
- **When Redis is down or slow** (250 ms per command): completions still succeed and answer `rank: null`; rankings are
  read from PostgreSQL; the event is marked in `ranking_repair` and the repair job (every 2 seconds) rebuilds it when
  Redis is back. A backstop rebuilds every live event whose copy is older than 5 minutes. Log events:
  `ranking.write_failed`, `ranking.read_failed`, `ranking.rebuild_failed`, `ranking.mark_failed`, `redis.error`,
  `redis.connect_failed`.
- **Rebuild one event by hand:** mark it, and the repair job rebuilds it within seconds. With the owner connection (no
  request context): `SELECT mark_ranking_repair('<event id>');`. Losing the whole Redis is harmless: every copy is
  rebuilt from PostgreSQL the first time it is read.
- **Several API instances:** the ranking switch (and every event setting) is cached for up to 15 seconds per instance;
  another instance can show the old switch for that long after the owner changes it.
- **Not yet signalled:** a change of a staff user's email (no route changes it yet) sends no repair; the backstop
  catches it within 5 minutes.
- **Local runs:** `docker compose up -d` starts Redis on 56379; set `TEST_REDIS_URL=redis://127.0.0.1:56379` for the
  ranking tests (they skip without it).
- **Questify-wide ranking size, monthly check (T-408, ADR-322):** the Questify-wide ranking reads PostgreSQL only
  (no Redis copy yet). With the owner connection: `SELECT count(*) FROM xp_board b JOIN player p ON p.id = b.player_id
  WHERE b.board = 'all' AND b.xp > 0 AND p.status = 'active';` and `SELECT count(*) FROM player WHERE status <>
  'active';`. When the first passes about 30,000 (measured p95 37 ms at 100,000 against a 50 ms gate), start T-408d,
  the Redis copy; a fast-growing second (deleted accounts) brings that forward. To re-time it:
  `QUESTIFY_RANKING_TIMING=/path/out.txt npx vitest run apps/api/test/perf/questify-ranking-timing.int.test.ts`, with
  nothing else running.

## Email sending (ADR-112)

Sender: `questify@nafes.com`, through the Gmail API. Done once by the admin of the `nafes.com` Google Workspace.
No password or key ever goes into chat, the repository or a doc.

Already in place on `nafes.com` (checked 2026-10-20): Google Workspace mail, SPF `include:_spf.google.com`, DKIM
(`google._domainkey`, 2048-bit) and DMARC `p=none` with reports to `dmarc@nafes.com`. DNS is on Cloudflare.

1. **Mailbox:** `questify@nafes.com` is an **alias** of an existing user (the user's choice, 2026-10-20). The service
   account acts for that user and sends with the alias as From; if Google refuses the alias as the sign-in subject,
   set `GMAIL_ACT_AS` to the real mailbox. Sent codes appear in that user's Sent folder, and replies reach them.
   Set up on 2026-10-20: the alias belongs to `system@nafes.com` (`GMAIL_ACT_AS=system@nafes.com`), and
   `questify@nafes.com` was added to that mailbox's Gmail settings under "Send mail as"; without that step Gmail
   rewrites the From line to `system@nafes.com`.
2. **Google Cloud:** in console.cloud.google.com (signed in as a nafes.com admin) create a project `questify-mail`,
   enable the **Gmail API**, create a **service account** `questify-mailer`, and create a **JSON key** for it. If key
   creation is blocked ("Disable service account key creation" organization policy), allow it for this project only.
3. **Permission:** Workspace Admin console, Security, Access and data control, API controls, **Manage domain-wide
   delegation**, Add new: the service account's **client ID** (a long number on the service account page) with exactly
   one scope: `https://www.googleapis.com/auth/gmail.send`.
4. **Secrets:** in CranL, app `questify-api-staging`, Environment: add `GMAIL_SERVICE_ACCOUNT_KEY` = the whole JSON
   key file's content, and `MAIL_FROM` = `questify@nafes.com`. Then delete the downloaded key file.
5. **Check:** sign in on staging with a Gmail address; in Gmail, "Show original" must say SPF, DKIM and DMARC PASS.
   Add `nafes.com` to Google Postmaster Tools to watch delivery.

Later, by the domain owner: after two to four weeks of clean DMARC reports, change `p=none` to `p=quarantine`, then
`p=reject` (this covers all of nafes.com's mail).

**Dashboard address:** `questify.nafes.com` gets a DNS record pointing at the CranL web app when it is deployed. In
Cloudflare it must be **DNS only (grey cloud)**: Cloudflare's proxy would add a hop in front of CranL's edge and break
the client-address count (ADR-113).

## Telemetry and alerts (T-018, ADR-600 to ADR-605)

Targets, the metric catalog and the alert table: `docs/SLO.md`. Rules: `ops/alerts/questify.rules.yml`. The API records metrics and
traces through OpenTelemetry and sends them nowhere until `TELEMETRY_EXPORTER` is set (SLO.md, section 5); the store that evaluates these
rules, the alert mail and the dashboard are prepared in `ops/monitoring/stack/` ("Monitoring stack on CranL", below) and run once the
monitoring app is created. Until then nothing evaluates the rules: watch the log lines the entries below name.

- **Check the rules:** `promtool check rules ops/alerts/questify.rules.yml` and `promtool test rules ops/alerts/questify.rules.test.yml`
  (no install needed: `docker run --rm --entrypoint promtool -v "$PWD/ops/alerts:/rules:ro" prom/prometheus:v3.15.1 check rules
  /rules/questify.rules.yml`, and `test rules /rules/questify.rules.test.yml`; the tag is pinned, raise it on purpose). Run both after
  any change to the rules, then copy the file over `ops/monitoring/stack/questify.rules.yml`, which the monitoring app loads (a test fails
  while the two differ). No CI job runs them yet (`docs/FOLLOWUPS.md`).
  `pnpm vitest run apps/api/src/telemetry/alerts.test.ts` checks that every alert has an entry here and names only metrics, labels
  and events the code has.
- **From a log line to its trace:** a line written inside a request or a background run carries `trace_id` and `span_id`; search the
  trace store for that id (only a share of requests keep a trace, `TELEMETRY_TRACE_RATIO`; the metrics count all).
- **Every alert starts the same way:** (1) is there a deploy or a migration in the last hour (the previous image is the rollback);
  (2) `GET /readyz` from outside (503 means the database does not answer); (3) which instance (`instance` label) and which route,
  loop or provider (the alert's labels); (4) the log lines named below.
- **Breakdown queries** (any Prometheus-style store): 5xx by route
  `sum by (http_route, http_response_status_code) (rate(http_server_request_duration_seconds_count{http_response_status_code=~"5.."}[5m]))`;
  slowest routes `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[10m])))`;
  outside calls `sum by (questify_operation, questify_provider, questify_outcome) (rate(questify_outbound_requests_total[15m]))`;
  an event's rate `sum by (questify_event) (rate(questify_log_events_total[5m]))`.

### QuestifyAvailabilityFastBurn

More than 1.44% of requests answer 5xx over 5 minutes and an hour (SLO-1). **Check:** the 5xx by route breakdown (one route or all),
`/readyz`, the `database.busy` rate (a 503 `busy` is a failure the player sees), `unexpected error` log lines (their `trace_id`
opens the request). **Do:** a deploy in the last hour: roll back to the previous image. All routes and `/readyz` 503: the database
(CranL console; the failover; `QuestifyDatabaseBusy`). One route: find its error in the log, fix or switch its feature off in the
console. Write a short post-mortem (QUALITY_BASELINE section 4).

### QuestifyAvailabilitySlowBurn

The same failures at a lower rate for six hours (6 times the monthly budget). **Check:** the 5xx by route breakdown over 6 hours; one
route or one status usually stands out. **Do:** a ticket for the next working day; fix the route. Once the month's budget is spent,
deploy fixes only (SLO.md, error budget).

### QuestifyCompletionSlow

More than 5% of scans take over a second to confirm (SLO-2). **Check:** `QuestifyDatabasePoolWaiting` and `QuestifyDatabaseBusy` (a
scan is one transaction, so a slow database is a slow scan), the slowest routes query, `QuestifyRankingStoreFailing` (rankings then read
PostgreSQL), and whether one event is very hot (the dashboard's live numbers). Long transactions: as the owner,
`SELECT pid, application_name, state, now() - xact_start AS age, wait_event FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER
BY age DESC LIMIT 10;`. **Do:** end a blocking session (CranL's own console sessions count); raise `DATABASE_POOL_SIZE` within the
database's connection limit; add an API instance; compare with the load test (NFR-003: 20,000 scans a minute in one event).

### QuestifyCompletionFastBurn

Scans fail with 5xx faster than the budget (SLO-3). **Check:** the breakdown restricted to `questify_route_class="completion"`: 503 is
`busy` (the database), 500 is a bug (`unexpected error` with its `code`, `constraint` and `routine`). **Do:** as for
`QuestifyAvailabilityFastBurn`; a scan that fails for players mid-event is the worst case, so roll back first and look after.

### QuestifyTelemetryMissing

No request has been reported for ten minutes: the API is down, or its exporter is broken. **Check:** `GET /healthz` and `/readyz` from
outside, the CranL app status and log. If the API answers, read its standard error for `telemetry.export_failed` (the monitoring app's
address, its certificate, the password in `OTEL_EXPORTER_OTLP_HEADERS`) and the monitoring app's own health. **Do:** restart or roll back the API;
fix the exporter setting.

### QuestifyDatabaseBusy

The API answers "busy, retry" more than once every two seconds. **Check:** the `database.busy {code}` lines: `55P03` a lock timeout, `57014`
the statement limit (5 s), `53300` too many connections, `40P01` a deadlock (rare; a repeating one is a bug in a lock order,
ARCHITECTURE "Consistency"), `CA503` a door's own lock budget. Long transactions as in `QuestifyCompletionSlow`. **Do:** end a blocking
session; for `53300` lower the pool or raise the database's limit; record a repeating deadlock in `docs/FOLLOWUPS.md` with its code.

### QuestifyDatabasePoolWaiting

A client has waited for a database connection for five minutes (`questify_pool` says which pool). **Check:** the `api` pool's size
(`DATABASE_POOL_SIZE`, 10 by default) against the connections in use (`questify_db_pool_connections` by state) and slow queries; the
`push` pool has 3 connections for the fan-out, so a waiting push pool means a slow database or an oversized fan-out. **Do:** find the
slow statement before raising the pool (a bigger pool on a slow database makes it slower); then raise `DATABASE_POOL_SIZE` within the
database's connection limit.

### QuestifyLoopStalled

A background loop (`questify_tick` names it) has not finished a run for five minutes on that instance. **Check:** the loop's failure
events in the API log: `lifecycle` `event.lifecycle_failed` and the other step names in `events/tick.ts`; `community` `community.*`;
`souvenir` `souvenir.tick_failed`; `invitation` `invitation.settle_failed`, `invitation.send_failed`; `rank_push`
`ranking.push_tick_failed`; `organizer_alerts` `organizer_alert.run_failed`; `team_alerts` `team_alert.run_failed`; `ranking_repair`
`ranking.repair_failed`; `push_worker` `push.*_failed`. A run that never ends is a database call with no answer. **Do:** restart that
instance: every loop is safe to restart (rows are leased or taken with SKIP LOCKED, and other instances keep running). Record the cause
in `docs/FOLLOWUPS.md`.

### QuestifyRankingRepairStalled

The loop that rebuilds marked rankings has not run for 30 seconds, so a ranking may be older than the 5-second target (SLO-4).
**Check:** `QuestifyLoopStalled` entry, then `Rankings and Redis` above. **Do:** restart the instance; rebuild one event by hand with
`SELECT mark_ranking_repair('<event id>');`.

### QuestifyRankingStoreFailing

Redis or the ranking repair has been failing for ten minutes. Scans still succeed (the rank shows blank) and rankings read from
PostgreSQL, slower. **Check:** `redis.error`, `redis.connect_failed`, `redis.eviction_policy` (the policy must be `noeviction`),
`ranking.write_failed`, `ranking.read_failed`, `ranking.rebuild_failed`, `ranking.repair_failed`, `ranking.mark_failed`; CranL's Redis
status; `REDIS_URL` (TLS or not). **Do:** restore Redis; the repair loop rebuilds every marked event when it is back, and losing the whole
Redis is harmless (`Rankings and Redis`). During a live event with a big ranking, the PostgreSQL fallback costs about 50 ms a read
at 20,000 players: watch `QuestifyCompletionSlow`.

### QuestifyCommunitySettleFailing

`community.settle_failed`, `community.tick_failed`, `community.pay_failed` or `community.health_failed` has been logged continuously for
ten minutes. A deploy that carries a migration which replaces a settle function (`Migration 0141` under "Database and deploy") logs
`community.settle_failed {code: 42883}` for the seconds before the new API takes over; that is expected and never alerts, because
only ten unbroken minutes do. **Check:** the `code`: `42883` a function that does not exist (the API and the migration are different
versions: deploy the API that matches the migration, or run the missing migration); `40P01`, `55P03`, `57014` a lock clash or
the statement limit (it retries on the next tick); `CV500` see below. **Do:** fix the version; the owner's "Settle and pay now" settles at
once after a repair.

### QuestifyCommunityPayoutsBehind

`community.settle_behind`, `community.payout_stuck` or `community.settle_blind` is logged: a goal's settle point is over 2 minutes behind,
due rewards are older than 2 minutes, or an API or owner session could not be read in `pg_stat_activity`. **Check and do:** "Community
tick alerts" under "Database and deploy" has each line's cause and fix (the named backend holding the oldest transaction; CranL's own
console sessions count; `community.pay_failed {code}`; the owner losing its privileges). Results wait meanwhile; nothing is lost.

### QuestifyErrorEventRepeating

An error-level event not covered by another alert has been logged more than ten times in fifteen minutes (`questify_event` names it).
**Check:** search this RUNBOOK for the event name (push, souvenir, lifecycle, ranking, invitation and alert events are all described
under their feature), then the log lines around it. **Do:** fix the cause. If the event is a normal part of some flow and only noisy,
change its level in the code or raise this rule's threshold (and run `promtool test rules`), and say why in the commit.

### QuestifyPushFailing

More than 20% of push sends fail, are lost, requeue or are held over 15 minutes. **Check:** the outside-calls query by `questify_provider` and
`questify_outcome`: `requeue` Apple or Google answered 5xx or the request never left (their status pages); `unknown` timeouts;
`failed` a request we built wrong (`push.apns_refused`, `push.fcm_refused`); `hold` an account or quota refusal
(`push.provider_hold`). A dead token (`invalid_token`) is normal and not counted. **Do:** see "Push notifications", Alerts (error level).

### QuestifyPushProviderRefusing

APNs or FCM refuses our requests, a round came back mostly as token errors, or a notice is parked (`push.provider_hold`,
`push.mass_invalid`, `push.fcm_auth_failed`, `push.apns_refused`, `push.fcm_refused`, `push.notice_parked`). **Check and do:** "Push
notifications", Alerts (error level) and "Backed-off notice": the key or environment (`BadEnvironmentKeyIdInToken`), the bundle id or
Firebase project, the service account; a parked notice shows its SQLSTATE and retries by itself every hour, or at once with the
`UPDATE notice SET retry_after = NULL, fan_failures = 0 WHERE id = <notice>;` override.

### QuestifySmsFailing

More than 20% of SMS are refused or lost over 15 minutes. Players can still sign in by email. **Check:** `player.sms_refused {gateway,
reason}` lines: `1060` the Msegat balance is spent (top up), `M0037` the static-IP check, `1110` the sender name, `1120` the number or
international sending, `unreachable` Msegat did not answer twice. **Do:** "Player sign-in and SMS" has each fix. The budget lines
(`player.budget_half`, `player.budget_spent`) say whether the platform's own hourly limit is the cause.

### QuestifySignInThrottleSpike

Sign-in, reset or code attempts are being throttled (`staff.throttled`, `player.throttled`) more than once every two seconds for ten
minutes: someone is guessing passwords or codes, or a venue sits behind one address. **Check:** the lines carry `step` and `addr`, a
12-character keyed tag of the client address and never the address. Count them by `addr` in the log store (for example, lines with
`event` `staff.throttled` grouped by `addr`): one tag carrying most of them is one source; many tags is a spread-out attack, which
per-address limits cannot stop (SECURITY.md "Residual risk"). Look at `staff.email_unavailable` and `player.code_failed` beside them.
**Do:** one source: find its address in CranL's edge log for that time (our logs hold only the tag) and ask CranL to block it. A venue: nothing to do, the limits are per contact. A targeted account: free
it with `clear-throttle` once the attack stops ("Staff sign-in", "Player sign-in and SMS"). Which address key carries most of the
traffic is a manual query until T-018b adds the aggregate.

### QuestifySendBudgetSpent

`player.budget_spent` (the hourly SMS budget `smsPerHour` or the daily player email budget) or `staff.outbound_cap` (the day's 400
sign-up and invitation emails) was reached, so the next request is answered 503 until the window moves. **Check:** whether it is an
event (many real sign-ups) or abuse (many sign-ups from one `addr`). **Do:** real demand: raise the number in
`apps/api/src/auth/limits.ts` and deploy (SMS costs money: check the Msegat balance first, `QuestifySmsFailing`); abuse: as for
`QuestifySignInThrottleSpike`.

### QuestifyEmailFailing

Email sends are failing on Gmail and on the backup (or there is no backup): staff sign-in codes and player email codes do not go out.
`staff.email_unavailable {reason}` is logged for each sign-in that could not send. **Check:** the log line names the step and Google's reason (`unauthorized_client`, `invalid_grant`, "Email sending" above), Google's daily
sending limit, the Resend key and verified domain. **Do:** fix the delegation or the key; players can use SMS and staff wait or use
`clear-throttle` once mail works ("Staff sign-in").

### QuestifyEmailBackupInUse

Gmail failed and Resend sent instead (`staff.email_failover`). Nothing is broken for users yet. **Check and do:** as for
`QuestifyEmailFailing`, on the Gmail side, and open a ticket before the backup fails too.

## Monitoring stack on CranL (T-018b, ADR-620 to ADR-626)

Telemetry goes to **one CranL app** in `riyadh-1`, built from `ops/monitoring/stack/` (Dhia, 2026-11-03: Questify on CranL is at most three
apps, the API, the web app and this one, plus the two databases; ADR-626 replaced the first design of three apps). Caddy, Prometheus with
its OTLP receiver and the alert rules, the Alertmanager and Grafana run in one container behind one public port. **Prepared 2026-11-03, not
created yet:** no CranL app exists until T-017's scripts, or a person following this section, create it; Q-580 lists what to check on the
first deploy. One app per environment (ADR-620): staging first, production's own copy of the same folder when production exists (Q-582).
Telemetry carries no personal data (ADR-603) and stays in Saudi Arabia with the rest.

```
API (TELEMETRY_EXPORTER=otlp) --https, password--> :8080 Caddy --> Prometheus (OTLP receiver, rules) --> Alertmanager --mail (optional, Q-581)--> owner
people --https--> :8080 Caddy, /grafana --> Grafana (its own login) --> Prometheus        (Prometheus, Alertmanager and Grafana listen on 127.0.0.1 only)
```

**Check the files before any deploy** (Docker, about five minutes, no CranL, no secret): `pnpm monitoring:validate` builds the image and
checks it with the programs' own checkers (`promtool check config`, `check rules` and `test rules`, `amtool check-config` and the routes,
`caddy validate` and `fmt`, `shellcheck`, `shfmt`), then starts it and proves: Prometheus refuses a missing, wrong or empty password and
takes the API's OTLP with the right one; the metric names and labels are the ones the rules use and no label off the API's closed list is
stored from an export shaped like the API's; traces, remote write and the admin and lifecycle APIs are closed; Prometheus loads all 20 rules and
finds its Alertmanager; only Caddy's port is open outside the machine; Grafana, under `/grafana`, needs a login, reaches Prometheus and
answers every query of the dashboard; a test alert comes out as an email with the runbook link; with `ALERT_SMTP_HOST` unset (or empty)
the app starts from the metrics and Grafana settings, says "alert email off", evaluates the rules and has no email integration, while one email
setting without the others is refused; Prometheus stores the off-list attributes it is sent (the premise of ADR-626, see "Auditing the stored
labels"); Grafana's login-free health page is closed at Caddy (404, written several ways); a stop signal ends the container cleanly, a
`/data` the container's user cannot write stops it at once with a message that names `/data`, and the death of any of the four programs,
by a stop signal or by `kill -KILL`, ends it with an error within seconds. `pnpm vitest run
apps/api/src/telemetry/monitoring.test.ts` (no Docker) keeps the files in step with the API's attribute list, the alert rules and this
section. Run both after any change under `ops/monitoring/` or `ops/alerts/`; no CI job runs the first yet (`docs/FOLLOWUPS.md`).

### The app

A Docker build from the folder: set the CranL Dockerfile path to `ops/monitoring/stack/Dockerfile` (the build context is the folder, so it holds
everything the image copies). A CranL app has a public `*.cranl.net` address and one port, so every link carries a credential (ADR-622, ADR-626).
The name is a suggestion (`questify-monitoring`); add `-staging` or `-production`.

| | |
|---|---|
| Folder | `ops/monitoring/stack` |
| Port | `8080` (Caddy; everything else listens on 127.0.0.1) |
| Volume | `monitoring-data` mounted on `/data`, 5 GB (Prometheus writes `/data/prometheus`, the Alertmanager `/data/alertmanager`); the container user is `grafana` (uid 472) |
| Image | Grafana 13.2.5 as the base, with Prometheus v3.15.1, Alertmanager v0.34.2 and Caddy 2.11.7 copied in, each pinned by version and digest |
| Addresses | `https://<app address>/` is Prometheus (query page and API, password); `https://<app address>/grafana/` is Grafana (its own login); `https://<app address>/api/v1/otlp/v1/metrics` is where the API sends |

Settings of the app (CranL environment, secrets in the secret store). A wrong or missing value stops the app at start with the setting's name,
never its value.

- `METRICS_PASSWORD`: 24 or more characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `~` and `-` only (Grafana's data source file reads it as YAML; the `base64url` command below makes exactly these); the one password of the user `questify-metrics`. The API sends it, Grafana's data source uses it, and it opens Prometheus's own pages.
- `METRICS_PASSWORD_HASH`: its bcrypt hash. Make it with `docker run --rm
  httpd:2.4.69-alpine@sha256:070da7661f0be8a05430b2c125c0cde9e53176b4048c813024021969a0e3893c htpasswd -nbBC 10 questify-metrics
  "<password>"` and keep what follows `questify-metrics:` (it starts with `$2y$10$`).
- `GF_SECURITY_ADMIN_PASSWORD`: 24 or more characters, no spaces; the Grafana user is `admin`. Applied at every start (Grafana keeps nothing between deploys).
- `GF_SECURITY_SECRET_KEY`: 32 or more random characters; signs the stored data source password. Never the Grafana default.
- `GF_SERVER_ROOT_URL`: `https://<app address>/grafana/` (the address in the CranL dashboard or the custom domain; the trailing `/grafana/` is required).
- **Alert email is optional (Q-581, decided 2026-11-03: none for now).** With `ALERT_SMTP_HOST` unset or empty the app starts in the
  *no-email mode*: it logs one line, `alert email off: no ALERT_SMTP_HOST`, and the Alertmanager gets a configuration whose only
  receiver sends nothing. The rules are still evaluated and the firing alerts show on the Grafana dashboard ("Alerts firing" and the
  table "Firing alerts"); nobody is told, so look at the dashboard. The five settings below then stay unset. With `ALERT_SMTP_HOST`
  set, all five are required and checked, and a missing or wrong one stops the app with its name; the other four set without the
  host stop it too (a half-finished setup is never read as "email off").
- `ALERT_SMTP_HOST`: `host:port` of the SMTP server, with STARTTLS (port 587) or TLS (465), like `smtp.gmail.com:587` or `smtp.resend.com:587`.
- `ALERT_SMTP_USER` and `ALERT_SMTP_PASSWORD`: its login (a Gmail app password, or a Resend key with the user `resend`).
- `ALERT_MAIL_FROM`: the address the mail says it is from; it must be one the SMTP account may send as.
- `ALERT_MAIL_TO`: where alerts go. For now the address of `MAIL_FROM` (Q-561), `questify@nafes.com`, whose mailbox the owner reads.
- `MONITORING_ENVIRONMENT`: `staging` or `production`; it is in the subject of every alert mail, so it is needed only with the five above.

**To turn alert email on later** (Q-581 reopens when a sender exists, a Gmail app password or a Resend key): set the five `ALERT_*`
settings and `MONITORING_ENVIRONMENT` and redeploy the app; nothing else changes. Then fire the test alert below.

Make each random value with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (`base64url`, never `base64`: its `+`, `/` and
`=` are refused in `METRICS_PASSWORD`). Nothing here is kept in the
repository, a log or a chat; Dhia or the T-017 script keeps them in the CranL secret store only.

**After the first deploy** (Q-580 lists the CranL facts this confirms):

1. `GET https://<app>/-/healthy` answers 401 without the password and 200 with it (`curl -u questify-metrics:<password>`); `POST https://<app>/api/v1/otlp/v1/metrics` with no password answers 401.
2. `https://<app>/grafana/` opens a login page (no anonymous view); signed in as `admin`, the folder "Questify" holds "Questify SLOs" and the tile "Last report from the API" fills once the API is pointed at the app.
3. The app's log shows `Starting Alertmanager`, `Server is ready to receive web requests.` and Grafana's `HTTP Server Listen`; the data directory is writable (a volume owned by root is the usual cause: the app then stops at once with `render-config: /data is not a directory this container's user ... can write`; set the volume's owner to uid 472, CranL's volume page says how).
4. **A fired test alert** (do it after every deploy and every change of `ALERT_*`; with alert email off, skip it: the app log has the line `alert email off: no ALERT_SMTP_HOST` and nothing is sent): in the app run `amtool --alertmanager.url=http://127.0.0.1:9093 alert add alertname=QuestifyTest severity=page --annotation='summary="Test alert"' --annotation='runbook="docs/RUNBOOK.md#monitoring-stack-on-cranl"'` (`cranl run -- ...`). The mail "[Questify staging PAGE] QuestifyTest" arrives within a minute. No mail: the dashboard tile "Alert mails not sent" and the app's log line `Notify attempt failed` say why (a wrong SMTP login, a sender the account may not use, a closed port).

### Pointing the API at it

On each API app (`questify-api-staging`, later production), set, then redeploy:

| Setting | Value |
|---|---|
| `TELEMETRY_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `https://<app address>/api/v1/otlp` (a path, but no user, password or query; the API adds `/v1/metrics`, which Prometheus's receiver serves) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `authorization=Basic%20<credential>` (the space is written `%20`); secret store. `<credential>` is `questify-metrics:<METRICS_PASSWORD>` in base64: `METRICS_PASSWORD='<password>' node -e "process.stdout.write(Buffer.from('questify-metrics:' + process.env.METRICS_PASSWORD).toString('base64'))"`. Paste it as it prints, with its `+`, `/` and `=` (only `%` escapes are decoded) |
| `TELEMETRY_TRACE_RATIO` | leave unset: with `TELEMETRY_EXPORTER=otlp` it defaults to `0`. Prometheus has no trace endpoint (it answers 404), so any ratio above 0 starts spans whose export fails with a `telemetry.export_failed` line every minute (Q-583) |
| `TELEMETRY_METRIC_INTERVAL_MS` | leave at the default 60000; it must stay under 120000 or the loop alerts never fire (SLO.md section 5) |

Within two minutes the dashboard tile "Last report from the API" drops under 2 minutes and the metrics `http_server_request_duration_seconds_*`
exist. The API logs one `telemetry.export_failed` line a minute while the app is unreachable or refuses the password, and nothing
else changes for users. A 401 there is a wrong or blank credential; a 413 is a body over 4 MB; a timeout is the address or the app being down.
`QuestifyTelemetryMissing` pages after 10 silent minutes, which is also what a wrong password looks like.

### Rotating the password

One password serves the API, Grafana's data source and people (Prometheus allows one user), so a rotation has a short gap, not none. Every six
months, when someone who had it leaves, and at any suspicion:

1. Make a new `METRICS_PASSWORD` and its `METRICS_PASSWORD_HASH`, set both on the app and redeploy it (Grafana and the self-scrape pick them up at start).
2. Straight after, set the API's `OTEL_EXPORTER_OTLP_HEADERS` to the new credential and redeploy the API; check that the dashboard keeps filling.

Between the two steps the API's exports fail with 401 and are dropped; do both within ten minutes and nothing pages. To rotate the Grafana
admin password: change `GF_SECURITY_ADMIN_PASSWORD` and redeploy.

### Auditing the stored labels

Prometheus cannot filter the attributes it is sent (ADR-626): the API's closed list (`ATTRIBUTE_RULES`, ADR-603) is the wall: `safeAttributes` at each call, and a metric view in the SDK
(`installTelemetry`, Q-585) that applies it again to every recording before export. Both are tested end to end in
`apps/api/src/telemetry/pii.test.ts` and `sdk.test.ts`. So the stored labels are checked by hand after any API release that touches
`apps/api/src/telemetry/` and once a month:

`curl -s -u questify-metrics:<password> -G 'https://<app address>/api/v1/labels' --data-urlencode 'match[]={job="questify-api"}'`

Each series of the API carries only these labels, and nothing else: `__name__`, `job`, `instance`, `le` and the attributes of the closed list
as `http_request_method`, `http_route`, `http_response_status_code`, `questify_route_class`, `questify_event`, `questify_log_level`,
`questify_operation`, `questify_provider`, `questify_outcome`, `questify_tick`, `questify_pool` and `questify_pool_state`. Its `target_info`
(`{__name__="target_info",job="questify-api"}`) carries `job`, `instance`, `service_version` and `deployment_environment_name`. Any other
name is a leak: fix the API first, then remove what was stored by stopping the app, clearing the volume and starting it (the history is
lost, nothing else: "Retention and backups"; the admin API that `delete_series` needs is off).

### Retention and backups

- **Retention:** 30 days of metrics (`--storage.tsdb.retention.time=30d`), so the 30-day error budget view has its window, and a cap of 4 GB
  (`retention.size`) on the 5 GB volume: Prometheus drops its oldest blocks before the disk fills. At the expected 8,000 to 10,000
  active series a month takes 0.5 to 1 GB (an estimate; the dashboard's "Disk used" tile shows the real figure). To keep more, raise the volume
  first, then both numbers in `ops/monitoring/stack/entrypoint.sh`. Series count: each deploy adds a set for the new instance id
  that fades after 5 minutes; the tile "Series in memory" climbing steadily means a label has started to vary.
- **Backups: none, on purpose.** Metrics are a view of what the API did; the source of truth is the database (T-019). Losing the
  volume loses the history and restarts the 30-day budget view, not any data. Rules, dashboards and every setting except the secrets are in the
  repository; the secrets are in the CranL secret store. Alertmanager silences live on the volume (`/data/alertmanager`); losing one costs at most an extra mail.
  The Prometheus admin API, which a snapshot needs, is off.
- Grafana keeps nothing: preferences and sessions are lost at every deploy; the dashboards are in the image and read-only.

### Operating it

- **Change a rule:** edit `ops/alerts/questify.rules.yml`, copy it over `ops/monitoring/stack/questify.rules.yml` (the test fails while they differ), run `pnpm monitoring:validate`, redeploy the app.
- **Change the dashboard:** edit `ops/monitoring/stack/grafana/dashboards/questify-slo.json`, run the validation (it runs every query), redeploy.
- **A new attribute or metric in the API:** add it to `ATTRIBUTE_RULES` and to `DATAPOINT_KEYS` in `ops/monitoring/lib/fixtures.mjs` (and the label to "Auditing the stored labels" above); the test names the list that is missing it. Nothing in the app needs to change: Prometheus stores what it is sent.
- **Raise a version:** change the `FROM` tag and digest in `ops/monitoring/stack/Dockerfile` (`docker pull <image>:<tag>` prints the digest), read the release notes, run the validation, redeploy. Dependabot (monthly, one grouped PR, `.github/dependabot.yml`) raises the new tag and digest of every image in this Dockerfile and the two root Dockerfiles; run the validation before merging that PR. The validation fails on purpose if a newer Prometheus starts dropping off-list attributes: that is the day to use it (ADR-626).
- **Silence an alert:** in the app, `amtool --alertmanager.url=http://127.0.0.1:9093 silence add alertname=<name> --duration=2h --comment="<why>"`.
- **Look at a query by hand:** the app's address, signed in as `questify-metrics` with `METRICS_PASSWORD`, serves the usual query page; the rule states are under Alerts. Grafana is at `/grafana/`.
- **A program died:** the container stops and CranL restarts it; the app log says which (`entrypoint: <program> stopped`). A restart loop is a setting or a full disk: read the first lines of the log.
- **The stack watches itself only through the dashboard row "Monitoring stack"** (parts up, mails not sent, rule failures, series, disk). If the app is down, nothing pages: an outside watcher is Q-584.

### Footprint (per environment)

| | Expected |
|---|---|
| Apps | 1 of the three CranL apps (API, web, this one) |
| Memory | 320 MB for the whole app measured idle on a laptop (50 seconds after start, no dashboard open); expect 500 to 900 MB in use (Grafana takes 300 to 400 MB when a dashboard is open, Prometheus 150 to 400 MB with the Alertmanager, Caddy under 50 MB) |
| CPU | well under one core in total; Grafana spends the most when a dashboard is open |
| Disk | one 5 GB volume, 0.5 to 1 GB used after 30 days; the image is about 2.5 GB (Grafana's own is 2 GB of that) |
| Network | the API sends about 100 KB a minute per instance to the app (estimate; compare with the app's outbound figure after a day) |

## Infrastructure as code on CranL (T-017, ADR-650)

What Questify has on CranL is declared in `ops/cranl/staging.json` and `ops/cranl/production.json`: the project, the region, the
repository, the two databases (and PostgreSQL's backup schedule), the buckets (none yet, Q-149) and the three apps with their port,
build folder, Dockerfile, volumes, cron jobs, domains and every environment variable. Change CranL by changing the file and running
`apply`, never in the dashboard (except the steps listed under "Dashboard only").

```
pnpm infra plan staging     # read-only: GET calls only; exit 0 = CranL matches the file, 2 = there is a change, 1 = an error
pnpm infra apply staging    # creates and updates until CranL matches the file; never deletes anything
```

- **The API key** comes from `CRANL_API_KEY`, or else the CranL CLI's sign-in (`~/.cranl/config.json`). It is never printed.
- **Variables.** A string is a plain value; `{"template": "http://{api.host}:3000"}` is filled from the apps' addresses (`url` is the
  public `https://` origin, `host` the internal name, as `API_ORIGIN` needs); `{"database": "postgres"}` is set by CranL's
  connect (the connection string never passes through the script); `{"secret": "generate"}` is 32 random bytes made at the first
  apply; `{"secret": "operator"}` is read from `SECRET_<APP>_<NAME>` in your shell (like `SECRET_API_MSEGAT_API_KEY`), and apply
  stops before any change when one is missing. A secret that exists on CranL is never read, compared or replaced: rotate it as its own
  section says (or `PATCH` it by hand), then nothing in the file changes.
- **What plan prints.** `api` lines are what apply will do (plain values with their old and new value; secrets by name only).
  `manual` lines are what the API cannot change: a public-repo app's build folder or branch, a region, a database's type, a
  protected app. `unmanaged` lines are settings CranL has that the file does not declare: add them to the file, or remove them in the
  dashboard. apply leaves both alone and lists them at the end (exit 2).
- **apply checks itself.** After its changes it reads CranL again; if any `api` change is left it fails, so a run that succeeds is
  also the proof that a second run changes nothing. A failed run is safe to repeat: it continues from what exists.
- **After apply**, a changed variable takes effect on the app's next deploy or restart; deploy as "Database and deploy" says
  (migrations first for the API). apply never deploys.
- **Tests:** `pnpm vitest run scripts/cranl` (an in-memory CranL; no network).

**Dashboard only** (Q-612; check these by hand after creating an app, since the API cannot read them):

| App | Dockerfile path | Health check | Build folder |
|---|---|---|---|
| API | `Dockerfile` | `/healthz` | `/` |
| web | `Dockerfile.web` | `/en/sign-in` | `/` |
| monitoring | `Dockerfile` | none (Caddy answers 401 without the password) | `/ops/monitoring/stack` |

The build folder is set at create; afterwards a public-repo app's build folder or branch changes only in the dashboard (plan shows it
as `manual`). Automatic rollback is off on every app (not readable by the API either).

**State on 2026-11-04** (`plan staging`, read-only): everything matches except one `manual` line, the monitoring app's build folder
(`/ops/monitoring/prometheus`, from before ADR-626, so the app is stopped; Q-610). The staging database's backups have not run yet (Q-611).

### A fresh environment (T-017b; needs five free CranL slots, Q-613)

1. In a shell, set the operator secrets plan names (`pnpm infra plan production` lists them under "apply needs these operator
   variables"): the Gmail service account key and the Msegat login as in their sections; `SECRET_MONITORING_METRICS_PASSWORD` and its
   hash (`METRICS_PASSWORD_HASH`) as "Monitoring stack on CranL" says; and `SECRET_API_OTEL_EXPORTER_OTLP_HEADERS`, the
   `authorization=Basic%20...` value made from that password ("Pointing the API at it").
2. `pnpm infra apply production`. It creates the two databases, the three apps (each starts a first build, which fails until its
   settings exist; that is expected), then sets every variable, connects the databases, adds the monitoring volume, and checks itself.
3. In the dashboard, check the "Dashboard only" table for each new app.
4. Migrate and deploy as "Database and deploy" says (`DATABASE_ADMIN_URL` for `node migrate.cjs --roles` once), then deploy the web app
   and the monitoring app, and run the monitoring app's "After the first deploy" checks.
5. `pnpm infra plan production` prints "No changes"; run `apply` once more and it makes no change.
6. Unset the operator secrets from the shell.

## Load test (T-804, ADR-660)

Measures NFR-002 (95% of completions confirmed within 1 s), NFR-003 (20,000 completions a minute in one event), NFR-005
(the ranking shows a change within 5 s) and NFR-025 (ten events at once), plus the sign-in rush through
`POST /v1/auth/code`. Results of each run are in STATE.md; the first ones (2026-11-04) are under T-804 in `docs/TASKS.md`.

**Run it on this PC** (Docker's PostgreSQL and Redis up, `pnpm install` done, at least 8 GB free on the disk):

```
node ops/load/run.mjs                                   # the target: 10 events x 20,000 a minute, 60 s, then the rush
node ops/load/run.mjs --rate-per-event 480 --rush ""    # one lower rate, completions only (480 a minute = 8 a second)
node ops/load/run.mjs --skip-completions --events 1 --players 10 --quests 1 --rush 50:10,100:10   # the rush only
```

What it does: bundles `apps/api/test/load/server.ts` and `prepare.ts` with esbuild; `prepare create` makes a database on
the local PostgreSQL named like the tests' ones (`questify_test_<time>_<hex>`), runs every migration and seeds with
set-based SQL (one organizer and live event per `--events`, `--quests` scan quests plus a 5,000-point probe quest per
event, `--players` players per event with a phone and an enrollment); sessions are issued by `issue_player_tokens`, the
function every API sign-in ends in, in one statement. It starts the API (production's pool of 10, Redis options, ticks
and request logs; SMS, email and push stubbed), runs `--drivers` driver processes (`ops/load/driver.mjs`), prints the
report and writes it to `ops/load/out/<time>/report.json` (git ignores `ops/load/out/`), then drops the database and
the run's Redis keys, also on Ctrl+C. A run killed harder leaves its database to the test sweeper (gone after 2 hours).
It stops before starting, and after seeding, when less than 8 GB is free.

How it measures: each event's completions follow an open schedule (request i is due at start + i / rate, sent then
whether or not earlier ones answered) and latency is counted from that due time, so a slow server shows as latency,
never as a lower rate. The first `--warmup` seconds are not counted. A refused, timed out (15 s, as the app) or shed
completion counts as not confirmed. The ranking probe completes its quest every `--probe-every` ms and reads the board
as another player every 100 ms until the probe leads it with the new score. `database` in the report compares the
completions and ledger rows written with the answers, and lists the PostgreSQL functions by time spent
(`track_functions` is on for the run's database). `schedulerLag` is the client's own delay: when its p95 passes about
50 ms, the client is the limit and the numbers say nothing about the server.

Main options: `--events` (10), `--players` per event (2,500), `--quests` per event (20), `--rate-per-event` a minute
(20,000), `--duration` (60 s), `--warmup` (10 s), `--drivers` (5), `--sockets` per driver and API (64; the server sees
at most drivers x sockets requests at once), `--max-in-flight` per driver (4,000), `--api-instances` (1, ports 4810
on; drivers spread over them), `--pool-size` (10), `--rush` (steps `rate:seconds`, default `25:10,50:10,100:10,200:10`,
below the 5,000 SMS an hour budget), `--rush-per-address` (50 codes from each client address, `X-Forwarded-For`
10.x.y.z), `--rush-first` (the first phone, +96659 and 7 digits), `--admin-url`, `--redis-url`, `--pg-container`
(for the CPU samples, `questifyapp-postgres-1`).

**A production-like environment** (the rerun T-804 waits on): never production, and never CranL staging while people
use it. The driver side is ready: `node ops/load/run.mjs --target https://<api host> --plan plan.json --remote` from a
load machine near it (without `--remote`, a target other than this PC is refused); API and PostgreSQL CPU are then not
sampled, so read the environment's own metrics (Grafana: route latency, pool waiting, database CPU) for the same
minutes. The seeding side is not: `prepare create` refuses any database server but this PC's, because it runs the
tests' `roles.sql` and sets the API role's password to the tests' one. Seeding an environment's own database (the same
SQL, as its owner, without touching roles, with `LOAD_QR_SECRET` set to its `QR_SECRET`) and removing it afterwards is
the first step of that rerun.

## Web app (dashboard)

- Image: `Dockerfile.web` at the repository root (CranL builds from the folder holding the Dockerfile), with CranL Dockerfile path `Dockerfile.web`; port 3000; health check on `/en/sign-in`.
- Staging (2026-10-20): app `questify-web-staging`, https://questify-web-staging-4ecphq.cranl.net; the API's
  `DASHBOARD_ORIGIN` is that address until `questify.nafes.com` (CNAME already in Cloudflare, DNS only) is switched on.
- Setting: `API_ORIGIN` = the API's **internal** address, for staging `http://questify-api-staging-3ez01s:3000`
  (never the public https URL: the app refuses to start with one). No secrets in the web app.
- The API's `DASHBOARD_ORIGIN` must equal the web app's public https origin, and `TRUST_PROXY_HOPS=1` (ADR-113).
- Optional settings `APP_STORE_URL` (https on `apps.apple.com`) and `PLAY_STORE_URL` (https on `play.google.com`): the
  store pages for the event web page `/{lang}/e/{CODE}` (T-112). Unset, the page shows no store buttons and says the
  app is coming soon; any other value stops the app at start. The Play link gets the install referrer `join=CODE`.
- The event page's link preview names `https://questify.sa` (the join link's host) for its canonical and share image,
  on staging too: a preview of a staging link points at production until the domain serves the web app.

## The first loop on two phones (T-118)

- **Scripted run:** `apps/api/test/loop/first-loop.int.test.ts`. Through the real routes: an organizer signs up, builds
  an event with one QR quest and reads its code; two players sign up by SMS code and join by the event's code; one
  scans; the scanner's balance and both rankings update. Run it with `TEST_DATABASE_URL` (and `TEST_REDIS_URL` for the
  Redis ranking copy, as in production). The one database write stands in for Questify activating the event (T-210).
- **On real phones (staging):**
  1. Staging is ready: migrations through 0023, Redis with `REDIS_URL`, `QR_SECRET`, `DASHBOARD_ORIGIN`, and a working
     sign-in channel (Msegat with M0037 handled, or email codes through Resend: the app offers both).
  2. Build the development client once: `eas build --profile development --platform android` gives an APK to install
     by link, with only an Expo account (iPhone needs the Apple Developer account, T-010). It holds no JavaScript: run
     `npx expo start --dev-client` in `apps/app` (phones on the same network, or `--tunnel`). Unset, the app uses the
     staging API and web origins in `src/api/client.ts` and `src/event/scan.ts`; if staging moved, set
     `EXPO_PUBLIC_API_URL` (the API's https origin) and `EXPO_PUBLIC_QUEST_CODE_ORIGIN` (equal to the API's
     `DASHBOARD_ORIGIN`, which the printed `/q/` links use) for that command.
  3. On the dashboard: sign up, create the event with its end in the future, add a "Scan a QR code" quest, open its
     printable code.
  4. Activate the event until the console does it (T-210), as the database owner:
     `UPDATE event SET status = 'live', starts_at = now() - interval '1 minute' WHERE lower(join_code) = lower('<CODE>');`
  5. Phone 1 and phone 2: sign up, join with the code. Phone 1 scans the printed code. Phone 2's ranking shows
     phone 1 first with the quest's points within its 15-second refresh; phone 1's Home shows the new balance.

## Database and deploy

- **Location switch (T-303b, ADR-208): before turning `locationQuests` on** in the console, run on the CranL database
  `SHOW log_parameter_max_length; SHOW log_parameter_max_length_on_error; SHOW log_statement;
  SHOW log_min_duration_statement;` and record the values here. The switch stays off unless
  `log_parameter_max_length_on_error = 0` and either `log_parameter_max_length = 0` or (`log_statement = none` and
  `log_min_duration_statement = -1`): otherwise a check-in's position could reach the database log. Also update the App
  Store privacy label (location, app functionality, not linked to tracking) and Play's Data safety form first.
  Values on CranL (read 2026-10-23): `log_parameter_max_length` -1, `log_parameter_max_length_on_error` 0,
  `log_statement` none, `log_min_duration_statement` -1: the rule holds (statements are never logged, and an
  error logs no parameters). Read them again if CranL changes its Postgres settings.

- **"Set your interests" (T-407c, ADR-320): never deploy migration 0071 without the new app build.** App builds
  installed before T-407c parse the Questify quest list with the closed metric list (`events`, `cities`, `quests`), so
  once 0071 seeds the `interests_set` quest their whole quest list fails to load. Release order: the new app build
  (its card schema takes any metric name) is approved and live in both stores, and the test phones carry it; then the
  server with 0071. If the server must go first, retire the seeded quest in the console right after the migration and
  re-add it once the app is out (a re-added quest pays everyone with interests again, Q-290).
- **Mini-game engines (T-305, ADR-212):** a server deploy carrying a new engine version (`packages/shared/src/games`,
  a `v<n>.ts` beside the old one) goes out **before** the app release that draws with it: the server answers an app
  whose engine is older with 426 `update_required`, and replays each round with the version frozen on it, so the old
  version stays until no open round can use it (the longest window after the deploy: the time limit plus 10 minutes).
- **Live polls (T-306): migration 0052 drops `vote_quest(uuid, text, text)`** for the several-choice signature.
  Between the migration and the new API instance taking traffic, the old instance's votes fail (500). Deploy in a quiet
  minute, or migrate and switch over together; the app's retry with the same key recovers a failed vote once the new
  instance answers. On the day a build goes to store review, send a live poll with 1,440 minutes in the demo event
  (STORE_COMPLIANCE, review notes).
- **Community quests (T-306b): migration 0053 checks its owner can read the API's sessions** (a superuser, or one
  holding `questify_app`'s privileges; CranL's `admin` is a superuser) and stops with "the migration owner … can not
  read questify_app's sessions" otherwise; `node migrate.cjs --verify` then reports `ownerSeesSessions: true`. Nothing
  is granted. It also drops `event_has_open_poll` for `event_has_live`: deploy the new API with it. On the day a build
  goes to store review, give the demo event a running community goal with an unlock milestone (STORE_COMPLIANCE, review notes).
- **Migration 0065 (T-403, achievements, passport, event city, final ranks):** adds a column to `event`
  (ACCESS EXCLUSIVE for a moment), creates `final_rank` with keys to `event_result` and `enrollment` (scans wait on the
  enrollment key lock for the rest of the migration), then holds `event_result` in SHARE ROW EXCLUSIVE while
  `backfill_final_ranks()` snapshots every already confirmed event. `lock_timeout` is 10 s: if it stops on a lock, run
  it again in a quiet minute; it changes nothing until it commits. Deploy the new API with it (`confirm_results` and
  `public_player_profile` are restated; the new routes need the new functions).
- **Migration 0056 (T-308, NFC tags):** two new closed tables and widened checks; `record_completion` restated. The app
  needs a new EAS development build (react-native-nfc-manager, a native module) before NFC runs on a phone. On the day a
  build goes to store review, give the demo event a scan quest with NFC on (its QR works for the reviewer).
- **Migration 0055 (T-307, flash quests and boosts):** a new column on `quest`, the `boost` table and `ledger_entry.boost_id`
  (nullable, no default: no rewrite of the ledger). `pay_completion` is dropped and created with no defaults: deploy the
  new API with it. On the day a build goes to store review, give the demo event a scheduled flash quest and a boost
  (STORE_COMPLIANCE, review notes).
- **Community tick alerts (T-306b, ADR-222 to ADR-224; the alerts `QuestifyCommunityPayoutsBehind` and `QuestifyCommunitySettleFailing`, T-018):**
  - `community.settle_behind {goals, blockerPid, blockerApp}`: a goal's settle point is more than 2 minutes behind.
    The named backend holds the oldest open transaction of `questify_app` or the owner. CranL's own sessions as
    `admin` (its web console, its managed `pg_dump`) count as the owner's and hold the settle point back for as long as
    they stay in a transaction: close the console's transaction, or let the dump finish. An API backend idle in a
    transaction is ended after 10 s (`idle_in_transaction_session_timeout` on the pool). Results wait meanwhile
    (`community_paying`); the owner's Settle and pay now answers `community_settling` until it clears.
  - `community.payout_stuck {steps, rows}`: due rewards older than 2 minutes. Look for `community.pay_failed {code}`
    (a deadlock or lock timeout retries on the next tick); the owner's Settle and pay now pays the event's at once.
  - `community.settle_blind {goal}` (`CV500`): an API or owner session could not be read in `pg_stat_activity`;
    settling stops until it can. The owner lost its superuser or its `questify_app` privileges: restore them.
- Community timing, by hand (not in CI): `COMMUNITY_TIMING=out.txt pnpm vitest run
  apps/api/test/perf/community-payer-timing.int.test.ts`. 2026-10-24 on the dev machine: a first settle over 20,000
  completions with 10,000 new contributors and 10,000 payees frozen 2.25 s (under the pool's 5 s statement limit),
  a steady 5 s tick 73 ms, 10,001 players paid in 21 batches in 5.5 s (the slowest batch 296 ms). One settle reads at
  most 10 minutes of ledger, so a backlog after an outage catches up over several ticks; the owner's Settle and pay now
  settles repeatedly until final. **On CranL, before the first real event with a community quest:** time a batch of 500
  (the same file against a CranL copy, or the `community.paid` log lines' spacing); if a batch takes over 250 ms, lower
  `BATCH_SIZE` in `apps/api/src/community/payer.ts` to 250 (CTO code review nit 5).
- **Migration 0141 (T-711b, feature layers part 2):** drops `settle_goal(uuid, boolean)` and `settle_community(uuid, boolean,
  uuid)` for one-argument and two-argument versions. Between the migration and the new API, the old API's community tick logs
  `community.settle_failed {code: 42883}` and the owner's Settle and pay now answers 500, for the seconds of the deploy; the
  next tick of the new API settles and the settle point catches up. These lines are expected (`QuestifyCommunitySettleFailing` alerts only
  when they go on for ten minutes, never on one line). Deploy the API right after the migration.
- Migrations: `node migrate.cjs` (owner connection `DATABASE_ADMIN_URL`; `--roles` the first time; `--verify` as the
  app role proves its limits). Remove the owner connection string from the app environment afterwards.
- **Migration retry (T-022, ADR-291, ADR-580).** Each file runs as one transaction. If it fails with `40P01` (deadlock) or
  `55P03` (lock timeout), the runner rolls the whole transaction back and runs the file again: three retries after the first
  try, so four attempts, waiting about 1 s, 2 s and 4 s (each spread between half and one and a half times). Every retry
  writes one line to standard error with the file, the SQLSTATE and the attempt (`Migration 0067_x.sql hit a lock clash
  (SQLSTATE 40P01) on attempt 1 of 4 and was rolled back whole; retrying in 1043 ms.`); no error text, no connection string.
  Any other error fails at once and is never retried. A file never runs twice or half-way: the advisory lock is held across
  the retries, a failed attempt is rolled back before the next starts, and a test fails if a migration file ends the
  runner's transaction itself (`COMMIT;`, `BEGIN;`, `ROLLBACK;`); write new files without them. A file that waits on a lock
  forever never reaches `55P03`: start such a file with `SET LOCAL lock_timeout = '10s';` (as 0063 to 0065 do).
  **Exit codes of `node migrate.cjs`, which the deploy loop relies on:** `0` every file is applied (stdout is the JSON
  `{applied, alreadyApplied}`); `75` a file lost the clash on all four attempts, rolled back whole and recorded nothing, and
  the files before it stay applied: wait a minute and run the same command again; `1` anything else (a failing statement, an
  edited applied file, a bad file name, no connection, a rollback that also failed): stop and read standard error, do not
  loop. The deploy loop is therefore `n=0; until node /srv/migrate.cjs; do s=$?; [ "$s" -eq 75 ] || exit "$s"; n=$((n+1)); [ "$n" -lt 5 ] || exit 75; sleep 60; done` (a real failure ends it with its own code, and a lock held past five tries ends it with 75); a run that
  exits `0` is done, and one more run shows the newest file under `alreadyApplied`. A rollback that fails (a lost connection
  in the middle of a clash) is exit `1`: look at `schema_migration` and the schema before running again.
- A deploy on CranL is manual (no webhook): build from the Dockerfile, then check `/healthz` and `/readyz`.

### Souvenir grant recovery (T-402b; deployment still deferred)

The server's separate souvenir tick runs every5s with jitter and a2s processing budget, at most500 recipients per
invocation. Each recipient's claim, grant and generation/token acknowledgment commit separately. A crash after
grant commit replays ownership safely; a claimed but unfinished lease expires after60s. Claims the time budget left
unevaluated are released at once (souvenir_release), not held for the lease. Failures remain durable,
retry with bounded backoff up to300s and expose pending/failed counts in the authorized organizer Souvenirs page.
Health logs contain counts/error classes only. The internal empty-context `souvenir_health()` also excludes device
identity; never expose this system context through HTTP or grant a direct table right for recovery.

Use 'Process pending grants' with a fresh request key for another pass; retry a dropped request using its same key.
The response is pending until both due work and the current pass are done. Scans are finite (ADR-272): activating a
non-rank rule, and each 'Process pending grants' request, starts one pass of500-member batches over members without
that souvenir; the pass waits until the event is live and deletes itself at the end. After it, nothing re-scans on a
timer: triggers on the facts (joins, completions, quiz/game results, confirmed places, operator play/removal, account
reinstatement) queue each member. If a member is missing an item after an owner-connection data repair, run one
'Process pending grants'. Rank rules start no activation pass; confirmation queues the placed members. For rank waiting state,
the owner must confirm the existing final-results preview; do not rebuild frozen places or activate a new rank rule
after confirmation. An archived event is read-only, but its previously authorized durable work can finish normally.
Do not delete receipts or reset player_item source fields to repair a queue. Preserve source privacy and erasure.

Synthetic load evidence can be reproduced on a throwaway local test database by bundling/running
`apps/api/test/support/souvenir-benchmark.ts` with TEST_DATABASE_URL and optional SOUVENIR_BENCH_REPORT. It seeds
20,001 recipients, measures source enqueue cost and actual bounded worker passes, and requires convergence with
no pass over500 recipients. It creates/drops its own test database; never point it at production. This is ordinary
database performance verification, not Stryker; mutation remains GitHub-only. Record measured values separately.

The measurement below predates the finite-pass and lease-release repair (ADR-272) and was not re-run. Its joined rule
grants every member, so it could not show the repeating sweep's cost for rules most members miss; that behavior is
now covered by `apps/api/test/db/souvenir-repair.int.test.ts` (no re-enqueue after a drained pass).

2026-10-26 local synthetic measurement (one joined rule, local Docker PostgreSQL, no overlapping heavy checks):
20,001 owned/0 due/0 failed after443,198ms. Source enqueue of a20,001-row enrollment update took23,401ms total;
this is a bulk storm measurement, not individual completion latency.7,399 back-to-back invocations included213
nonempty passes; the largest processed160 recipients (cap500), and the slowest pass took2,764ms. The2s budget is
checked between transactions, not a hard cancellation deadline. Empty invocations while unfinished leases expire
are included. This harness omits the normal5s tick interval and does not establish production capacity or all-audience/
100-rule performance. Report `Temp/questify-t402b-20k.json`, log with the same prefix. No invented latency target.

### T-502 announcements (2026-10-29; migration 0081, not deployed)

A scheduled row is released by the existing push_due minute tick (up to 100 due announcements/call; more asks the
worker to loop). If delivery stalls, inspect ids/status only: scheduled/not-yet-due, sent with fan-out pending, or
skipped event_closed/not_live/late. A missing notice kind leaves a due row waiting and logs the send-now failure by
event id; restore the shipped announcement kind, never retry text manually through an outside sender. More than
30 minutes late is intentionally skipped. Cancel only before release; sent announcements cannot be recalled.
Before real use, complete the existing APNs/Firebase go-live checklist. On iOS and Android verify Arabic RTL and
Western digits, Home flash/boost expiry after more than 15 minutes, newest-three ordering/See all, full-text list,
Back, failed-read retry and a muted-announcements member (center/Home present, no push). Push tap opens event Home.
Native Expo export passes for iOS+Android; default web export is unsupported by this native app's existing missing
react-native-web dependency, which T-502 does not add. No EAS build or real vendor send is part of this task.

### T-221 seat limit once a statement (migration 0146; deploy steps)

- **When:** never during a live event's peak. 0146 takes `enrollment` in ACCESS EXCLUSIVE mode with
  `lock_timeout = '1s'` (below the app pool's 2 s, so a queued player request never times out behind it); a long join or
  scan transaction makes it give up with `55P03`, and the runner retries three times before the deploy stops. Re-run
  the deploy in a quieter minute; nothing was applied.
- **Required after the deploy (timing probe):** on staging, build an event like the T-221 fixture (a hard limit, about
  20,000 seated, 5,000 pending, welcome points, one active souvenir rule) and time one `accept_all_join_requests` call
  (`apps/api/test/perf/seat-limit-timing.int.test.ts` shows the fixture). Record the number in ADR-631. **Above 3.5 s
  the planned response is lowering the cap**: a new migration restating `accept_all_join_requests` with a smaller
  `LIMIT least(free, n)` (one line); the dashboard already repeats calls.
- **Hot path check:** the update trigger fires on every `UPDATE enrollment` (each scan's score update) and exits early.
  If `QuestifyCompletionSlow` fires after the deploy, compare a quest scan's time with the T-221 numbers in TASKS.

## Platform admins and support access (T-701, ADR-405, ADR-407)

- **Make or unmake a Questify admin** (owner connection, inside the API container):
  `node staff.cjs grant-admin someone@questify.sa --reason "Joins the support rota"` and
  `node staff.cjs revoke-admin someone@questify.sa --reason "Left the support rota"`. `--reason` is required (10 to
  300 characters); `--by <name>` names the operator, else the operating-system user is recorded. Each is one
  transaction with an audit entry (`staff.platform_role`, holding the reason and the operator); a revoke ends the
  account's sessions and closes its live support grants.
- **Console health, numbers and admin sessions (T-709):** Health reads queues and leases from the database and the
  server's set-up; a tile that is not OK names why. A stopped ticker shows as an event past its start or end, a push or
  alert waiting too long, or a lease that ran out. `revoke-admin` refuses the last active admin: grant the role to another
  account first. Ending an admin's session: Admins, Show sessions, End session (reason, confirm).
- **Close a support grant by hand** (owner connection), when the console is not at hand:
  `UPDATE support_grant SET closed_at = now(), close_kind = 'admin' WHERE id = '...' AND closed_at IS NULL;`
  then record it in the audit log as a system entry (`support.closed`).
- **Suspensions** are made and lifted from the console (Organizers, or an event's page); the API walls of other
  instances follow within 10 seconds, the database walls at once.

## Re-apply erasures after a restore (T-708, ADR-484)

A restore brings back accounts erased after the backup was taken. After **any** database restore, before the API takes
traffic:

1. Gather the ids erased since the backup's time: the API's `player.deleted` log lines (JSON, `player` field) for that
   period, and, when the pre-restore database is still readable, `SELECT target_id FROM audit_log WHERE action =
   'player.delete' AND at > '<backup time>'`. Put them in one file (log lines and plain ids may be mixed).
2. Run `node staff-cli.cjs reapply-erasures <file>` with `DATABASE_ADMIN_URL` (the owner). It calls the owner-only
   `reapply_erasure` for each id: an active account is erased again (pending prizes forfeited, audited `player.delete`
   with `source: reapply`), a tombstone or an unknown id is skipped. It prints the counts.
3. Only then let the API take traffic.

The log store must keep `player.deleted` lines at least as long as the oldest backup (Q-443). The restore rehearsal
(T-019) erases a test account after the backup, restores, re-applies and checks the account is a tombstone again.
- **Changing an owner's sign-in email (T-701b):** verify identity first: call back the number on file, or check an
  identity document, or the signatory on the organizer's agreement; record which and why in the dialog. The owner must
  confirm from the new mailbox with the code and the current password; without the password the change waits 24 hours.
  To reverse a change, run it again to the old address. "Stopped from the old address" or a dispute alert means call
  the organizer before anything else.
- **Moderation addresses:** console, Reports, Moderation addresses: the urgent-report alert address and the ban appeal
  address; empty means `MAIL_FROM`. The digest goes at most every 10 minutes and 100 times a day; past that only the
  console's urgent count shows new urgent reports.
