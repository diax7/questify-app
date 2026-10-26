# Runbook

> How to run, check and repair Questify. Each entry says what to do, not why (the why is in the ADRs).

## Local checks

- `pnpm ci:changed`: lint, format check, types and all tests (what the pull-request gate runs).
- `pnpm ci:full`: `ci:changed` plus the dependency audit. The mutation check is not run here (ADR-174): it runs only
  on GitHub, see below.
- Integration tests need a throw-away PostgreSQL: `docker compose up -d`, then set
  `TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres`. Without it they are skipped, and
  a skipped database test proves nothing: check the count of passed tests.
- "too many clients" or "remaining connection slots" in a local full run: every integration file opens its own pool.
  `compose.yaml` starts PostgreSQL with 300 connections; a container made before that keeps 100 until
  `docker exec questifyapp-postgres-1 psql -U postgres -c "ALTER SYSTEM SET max_connections = 300"` and a restart.
- CI (`.github/workflows/ci.yml`): one job, a PostgreSQL 17 service, secret scan, `ci:changed`, the API build,
  `pnpm audit`; then, only when `scripts/ci-scope.mjs` says the change needs them, the web build and the browser
  tests (web app, shared package, lockfile, workflow, API source or migrations).
- Browser tests locally (web app): `pnpm --filter @questify/web build`, then
  `pnpm --filter @questify/web e2e` with `TEST_DATABASE_URL` set (first time: `pnpm --filter @questify/web exec
  playwright install chromium`). Run them before merging any web, shared or API change; they are part of `ci:full`
  in spirit and take about a minute.
- Heavy checks run on GitHub, started by hand (ADR-149; free while the repository is public): push the branch, then
  `gh workflow run full.yml --ref <branch>` (every test, both builds, the audit and all browser tests, about 10 to 15
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
The admin screen for this arrives with T-701.

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
- **Community tick alerts (T-306b, ADR-222 to ADR-224; log lines until T-018 makes them alerts):**
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
- Migrations: `node migrate.cjs` (owner connection `DATABASE_ADMIN_URL`; `--roles` the first time; `--verify` as the
  app role proves its limits). Remove the owner connection string from the app environment afterwards.
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
