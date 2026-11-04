# T-804b - Sign-in rush: the platform code lock and the shared-address window (plan, tier A, sign-in)

Follows T-804's rush measurement (Q-621) and the outline in `2026-11-04-t-804a-completion-hot-path.md` section 8.
Decisions: ADR-690 to ADR-692 (Proposed); questions Q-650 to Q-652. Q-621 part (3), the size of the platform SMS
budget, stays Dhia's choice (Q-093): this plan only makes the number data, it does not change it.

**Done when** (TASKS.md): the rush reaches 250 codes a second at p95 under 1 s on this PC, the SMS and email budgets are
never exceeded, and 2,000 players behind one address can ask for a code within an hour.

## 1. What is slow today, and why

`POST /v1/auth/code` runs `openChallenge` (`apps/api/src/players/sign-in.ts`) in one transaction: the contact's
try-lock, the windows (`firstFull`, three or four `count(*)` reads), then `takePlatformBudget`
(`apps/api/src/players/sign-in-limits.ts`): `pg_advisory_xact_lock` on ONE platform key, a `count(*)` over up to 5,000
`auth_throttle` rows of the hour, an insert, and then the rest of the transaction (`recordAll`'s inserts,
`start_player_challenge`, the commit and its WAL flush) still holding that lock. Every code on the platform passes
through it one at a time: about 10 ms each, so about 100 codes a second (Q-621: 100/s p95 297 ms, 120/s p95 2.3 s).
Resends (`prepareResend`), contact changes (`players/contact.ts`, both the code and the notice) and account deletion
codes (`deletion/deletion.ts`) take the same lock.

Second limit: `codesPerAddressHour` is 200, so one venue Wi-Fi or carrier address stops after 200 codes an hour; and
`failuresPerAddress` (100 wrong codes in 15 minutes) would stop a crowd of 2,000 typing codes at about 5% typos.

**Step 0, profile first (no code change):** rerun the T-804 rush on today's code
(`node ops/load/run.mjs --skip-completions --rush 50:10,100:10,150:10`) while sampling `pg_stat_activity`
(`wait_event = 'advisory'`) every 100 ms and `pg_stat_statements` for the sign-in statements. Record: share of request
time spent waiting on the advisory lock vs work, mean database time a code. This is the baseline table of section 7 and
confirms the lock is the limit before it is removed.

## 2. The budget without one held lock (ADR-690)

**Shape: striped sliding windows, taken in their own short transaction, given back on any refusal.**

- The budget of a channel is split into `n` stripes (default 16). Stripe `i` is its own sliding window in
  `auth_throttle` (same bucket `sms_platform` / `player_email_platform`, key
  `sha256('questify.sms_platform.' || i)`, 32 bytes as the table requires) with its own cap
  `cap_i = floor(cap / n) + (i < cap mod n ? 1 : 0)`, so `sum(cap_i) = cap` exactly. `n` is clamped to `cap` (a cap of 3
  has 3 stripes; a cap of 0 has none and is always spent). In any sliding window each stripe holds at most `cap_i`
  rows, so the channel holds at most `cap`: **the budget stays exact and sliding**, as today. (A per-hour counter row,
  the outline's first idea, would be a fixed clock hour: up to twice the cap across an hour boundary, and the email
  budget would stop matching the provider's rolling day. Rejected.)
- **One statement, own transaction.** A new PL/pgSQL function `take_send_budget(p_channel text)` (migration 0150) is
  called as one autocommit statement on the request's connection, before the request's main transaction opens. It
  reads the channel's row of `platform_send_budget`, picks a random first stripe and walks the stripes in rotation:
  `pg_try_advisory_xact_lock(stripe)`; if taken, counts the stripe's rows in the window; if under `cap_i`, inserts one
  row (`clock_timestamp()`) and returns `('taken', stripe, at, used_after, cap_i)`. A stripe it locks and finds full
  is passed over. It **never waits**: if no stripe had room and at least one stripe was busy (locked by another
  request), it returns `busy`; only when every stripe was locked and found full does it return `spent`. Locks live
  for the function plus its commit (well under a millisecond plus the WAL flush), never across the sign-in.
- **Busy is a retry, never a false "spent" (ADR-692).** The service calls the function again up to 3 times with
  5 to 20 ms jitter (each call is its own transaction, so no locks are held between them), then answers `throttled`
  with `retryAfterSeconds: 1`, as the contact try-lock already does. No deadlock is possible: the function holds only
  try-locks and never blocks.
- **Reserve first, give back on refusal.** A new service helper `reserveSend(deps, channel)` (in
  `players/sign-in-limits.ts`, replacing `takePlatformBudget`) returns a reservation `{stripe, at}` or `spent`/`busy`.
  The main transaction then runs as today without the platform lock: contact try-lock, windows, `recordAll`,
  `start_player_challenge` (or `resend_player_challenge`). Precedence of answers is kept: a throttled request answers
  `throttled` even when the budget was spent; `spent` answers `sms_unavailable` / `email_unavailable`. On any outcome
  other than "the send goes" (throttled, contact busy, a refused challenge, an exception and rollback), the unit is
  given back after the main transaction ends with one `DELETE` of the reservation row (`forget` with the stripe key and
  `at`), best effort: a failed give-back is logged (`player.budget_give_back_failed`, no contact) and the unit stays
  used. **Errors can only under-spend, never overspend.** A sent message whose delivery is unknown or refused stays
  counted, as today.
- **Same helper everywhere the lock was taken:** `openChallenge`, `prepareResend`, `players/contact.ts` (the code and
  the best-effort notice), `deletion/deletion.ts`. `takePlatformBudget` and its `PLATFORM` table are removed (replace,
  don't deprecate); `smsPerHour` and `playerEmailsPerDay` leave `PLAYER_SIGN_IN_LIMITS`.
- **Out of scope:** `takeOutboundMail` (`auth/outbound.ts`, the staff sign-up and invite mail budget) keeps its global
  lock: it is not on the player rush path and its traffic is small (Q-651).

**The half warning.** The function returns the taken stripe's `used_after` and `cap_i`; the service says
`player.budget_half` when the stripe reaches `floor(cap_i / 2)`. That is up to `n` lines an hour instead of one. The
alert `QuestifySendBudgetSpent` counts `player.budget_spent` and is unchanged; nothing alerts on `half` today (Q-652).

**Configurable budget (Q-621 part 3, Q-093).** New table `platform_send_budget (channel text PRIMARY KEY CHECK
(channel IN ('phone','email')), cap int NOT NULL CHECK (cap >= 0), window_seconds int NOT NULL CHECK (window_seconds >
0), stripes smallint NOT NULL CHECK (stripes BETWEEN 1 AND 64))`, seeded with today's numbers (phone 5,000 a 3,600 s,
email 1,000 a 86,400 s, 16 stripes each). Changing Dhia's number is one `UPDATE` (RUNBOOK step), no deploy and no store
release; a console screen for it is not built (no one asked; Q-650 notes it). A lower cap mid-window simply refuses
until each stripe drains below its new share; a higher one takes effect on the next call.

**Deploy note.** The migration moves the current window's rows of the old single key into the stripe keys (round
robin), so the new code sees the hour's history. While an old API instance is still running during the deploy it
counts only the old key: the budget can be overspent by what old instances send in those seconds. RUNBOOK: deploy
0150 outside an event's opening, as for any sign-in change.

## 3. Shared venue addresses without opening abuse (ADR-691)

The address windows are an abuse ceiling, not the wall (the contact and install windows are, `limits.ts` comment).
Flat 2,000 an hour (Q-634's recommendation) would let one address pump 2,000 SMS an hour to fresh numbers with no
cost. Instead **the address earns room from people who finish signing in:**

- New bucket `player_verified_address`: `judge` records one row for the asker's address bucket when `sign_in_player`
  answers `signed_in` or `new` (a right code), in the same transaction.
- The code window for an address becomes `min(ceiling, base + perVerified x verified_in_window)` with
  `codesPerAddressHour = { base: 200, perVerified: 2, ceiling: 2000, windowSeconds: 3600 }`. The failure window
  likewise: `failuresPerAddress = { base: 100, perVerified: 1, ceiling: 500, windowSeconds: 900 }`, counting verified
  sign-ins in its own 15 minutes.
- A venue: the first 200 codes go at once; while at least half of the codes sent are typed back correctly, each
  correct one opens two more, up to 2,000 an hour. A pumper never types codes back, so it stays at 200 an hour; to earn
  room it must receive and type half the codes on Saudi numbers it holds (only Saudi mobiles get SMS,
  `normalizeSaudiMobile`), which removes the gain. The per-number (5 an hour, 10 a day) and per-install (10 an hour)
  windows and the platform budget are unchanged and still apply.
- `firstFull` takes the address limit from one extra indexed `count(*)` of `player_verified_address` for that key.
  Staff windows are not touched. Per-event address windows (Q-634) stay out: the code request carries no event.
  The numbers are developer tuning (Q-650 records them for the first real event's review).

## 4. Migration 0150 and grants (deny by default)

- `platform_send_budget`: RLS enabled and forced; one policy `FOR SELECT TO questify_app USING (true)`;
  `REVOKE ALL ... FROM PUBLIC`; `GRANT SELECT ... TO questify_app` only. No insert, update or delete for the API: the
  number changes by an owner `UPDATE` (RUNBOOK).
- `take_send_budget(text)`: PL/pgSQL, `VOLATILE`, `SECURITY INVOKER` (the API already holds `SELECT, INSERT` on
  `auth_throttle`; no definer power is needed), `SET search_path = public, pg_temp` as docs/rules.md allows for
  PL/pgSQL, raises on an unknown channel. `REVOKE EXECUTE ... FROM PUBLIC` in the same migration;
  `GRANT EXECUTE ... TO questify_app`.
- The row move of section 2 (owner-run `UPDATE auth_throttle SET key = ...` for rows of the two buckets in their
  window).
- No new column on any table holding points or standing. No personal data: keys are hashes of fixed names.
- **Outsider suite** (`apps/api/test/security/outsider.int.test.ts`): `questify_outsider` cannot execute
  `take_send_budget` (the catalog check already covers new functions; one named assertion is added) and cannot select
  `platform_send_budget`. The API role cannot `UPDATE`, `INSERT` or `DELETE` `platform_send_budget` (a refusal test
  from its seat). The rehearsal list and the other list-style guards gain the table and function.

## 5. Tests (test first; DB tests on the real PostgreSQL)

`apps/api/test/players/send-budget.int.test.ts` (new), from the API role's seat:
1. **Never overspent under concurrency:** cap 50, 8 stripes; 200 calls from 40 connections at once (a barrier, then
   `Promise.all`); exactly 50 `taken`, 0 more rows than 50 in the window; repeated 20 rounds on a cleared bucket.
2. **Not under-spent either:** in (1) every unit is taken (`busy` answers retried as the service does).
3. Cap not divisible by stripes (37 over 8): 37. Cap below stripes (3 over 16): 3. Cap 0: `spent` at once.
4. **Sliding:** rows back-dated beyond the window do not count; rows inside it do, per stripe.
5. **Busy is not spent:** a second session holds every stripe's lock in an open transaction; the function returns
   `busy`, inserts nothing; after release it returns `taken`.
6. **Give back:** a returned reservation frees exactly one unit (the 51st call then succeeds); a give-back of an
   unknown `at` deletes nothing.
7. **Config is data:** an owner `UPDATE` of cap from 50 to 60 lets 10 more go without a restart; lowering it to 40
   refuses until the window drains.
8. **Migration move:** rows of the old single key inside the window are counted after 0150 (a migration test that
   seeds the old key at 0149 and migrates).

End to end, through the service (`apps/api/test/players/flow.int.test.ts` and a new rush case):
9. 200 parallel `requestCode` calls for new phones with the phone cap set to 40: the SMS stub sent exactly 40 messages,
   the stripe rows sum to 40, the rest answered `sms_unavailable` or `throttled`; email the same with its cap.
10. **Give back on refusal:** a request throttled by its contact window, one that loses the contact try-lock, and one
    whose main transaction throws (a pool wrapper failing `start_player_challenge`) each leave the budget where it was.
11. Throttled outranks spent: a throttled contact with the budget spent answers `throttled`.
12. Resend, contact change, contact notice and deletion code each take and give back through the helper (their
    existing suites updated; `players/contact.int.test.ts`, `deletion/deletion.int.test.ts`).
13. **Address earning:** 200 codes from one address then the 201st refused; after 50 right codes from that address,
    300 allowed; a wrong code earns nothing; a right code from another address earns nothing for this one; the ceiling
    2,000 holds with 5,000 verified; the failure window earns the same way up to 500. Per-number and per-install
    refusals unchanged (existing tests untouched and green).
14. Outsider and grant tests of section 4. Unit tests for the stripe caps and the earned-limit arithmetic.

Mutation (GitHub, ADR-174): `apps/api/src/players/sign-in-limits.ts`, the changed parts of
`apps/api/src/players/sign-in.ts`, `apps/api/src/players/contact.ts`, `apps/api/src/deletion/deletion.ts`; hand
mutants for the SQL function in the DB test (a `<=` for `<` on `cap_i`, the remainder stripe dropped, `busy` turned
into `spent`): each must fail a test.

## 6. Load measurement (confirms the gate)

Harness changes (`ops/load/`, `apps/api/test/load/`): `prepare.ts` sets `platform_send_budget` to a cap the run
chooses (`--sms-cap`, default high enough not to stop a throughput run). A `--rush-verify <share>` option: the load
server's SMS stub (`test/load/server.ts`, never in `src/`) keeps the last code per phone in memory and serves it on a
127.0.0.1-only port; the driver types back that share of codes (and a wrong one for 5%).

Runs on this PC (Ryzen 7 1700, Docker PostgreSQL 17.11, one API, pool 10; then three APIs), each the median of two:
- **A. Throughput:** `--skip-completions --rush 100:10,200:10,250:30,300:10 --rush-per-address 50`, new phones:
  250 a second at p95 under 1 s, every answer 202; advisory lock waits (sampled) near zero; PostgreSQL CPU and mean
  database time a code against step 0.
- **B. Budget at the cap:** `--sms-cap 5000 --rush 300:30` (9,000 asked): exactly 5,000 SMS sent by the stub and 5,000
  stripe rows, the rest `sms_unavailable`; with email fallback the email cap holds the same way.
- **C. One venue address:** 2,000 new phones from one address over 20 minutes with `--rush-verify 0.8`: no 429, every
  phone gets a code; with `--rush-verify 0` the address stops at 200 (abuse unchanged).
Results go in section 8 of this file, TASKS.md and the RUNBOOK's "Load test" part.

## 7. Order of work

1. Step 0 profile (section 1). 2. Migration 0150 with tests 1 to 8 and the outsider tests. 3. `reserveSend` and the
four callers, tests 9 to 12. 4. The earned address windows, test 13. 5. Harness options, runs A to C. 6. Docs: API.md
(no change to answers; the `throttled` retry on a busy budget noted), DATA_MODEL.md (the table and stripes),
SECURITY.md (the earned window), RUNBOOK (changing the budget, deploy note), TASKS, STATE.

## 8. Open risks

- If removing the lock moves the limit to the commit flush or to the windows' `count(*)` reads, 250 a second may still
  miss; step 0 and run A show which. The address count for a busy venue reads up to 2,000 rows a request (indexed).
- Reservations held by requests that are then refused can, at the very edge of the cap, make a concurrent request see
  every stripe full for a few milliseconds: it answers `sms_unavailable` with at most a handful of units still free.
  Never an overspend.
- The deploy overlap (section 2) is the only window where the budget can be exceeded.
- The earned window assumes about half the codes at a venue are typed back; a venue with many failed SMS deliveries
  earns slowly (the email fallback still counts the address window). Q-650.
