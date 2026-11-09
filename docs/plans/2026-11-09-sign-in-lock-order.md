# Sign-in lock order: the reviewer flag and the sign-in sweep (plan, tier A: sign-in)

Source: `docs/FOLLOWUPS.md` "2026-11-03 T-710" (line 38) and "2026-11-05 - T-810c" (lines 58-61). Governing: ADR-561 (the
review demo's lock order), ADR-712 (every family end locks the device row first), ADR-711 (the fresh check),
`docs/SECURITY.md` "Sign-in pathways" row 16 and "Signed-in devices and sessions". Migration: **0184** (new; staging is at
0182, 0183 is the newest file, 0156 stays reserved for T-810d). No TypeScript change, no new table, function, grant or
string. Delivers no FR. Decisions: none needed (no product choice; the lock orders go into `docs/rules.md`).

**Done when:** a code asked for the reviewer number while Prepare, Close or a number change commits is flagged from the
committed row, so no SMS goes out while the window is open; the sign-in sweep takes a family's device row before any of
that family's rows and never waits for one; end-others locks the caller's own device row with the others and re-checks it.

**Order.** (1) the failing race tests (section 6), (2) 0184, (3) the hand mutants (section 8), (4) the sweep measurement
(section 5), (5) docs. Security suites and `test/db/rehearsal.int.test.ts` run after step 2.

---

## 1. The latest definitions (read 2026-11-09, all of `apps/api/migrations` searched up to 0183)

| Function | Latest | Lock it takes today |
|---|---|---|
| `start_player_challenge` | 0144:182 | none on `review_demo`: the flag is a `DECLARE` default (`review_demo_open(key)`, unlocked); then `UPDATE` the key's open challenges, `INSERT` |
| `start_deletion_challenge` | 0144:490 | the same unlocked flag; then deletes and inserts deletion challenges |
| `sign_in_player`, `review_demo_sign_in` | 0144:271, 0144:218 | reads the challenge's flag unlocked; reviewer: `review_demo` FOR UPDATE, then the challenge FOR UPDATE |
| `verify_deletion_code` | 0144:517 | reviewer: `review_demo` FOR SHARE, then the deletion challenge |
| `console_review_demo_prepare` | 0166:16 | `review_demo` FOR UPDATE, cancel challenges, erase the reviewer (enrollments, `erase_rows`: device rows in id order, then its rows), update the row, cancel again, provision |
| `console_review_demo_create` / `_set_contact` / `_close` | 0144 | advisory key / `review_demo` FOR UPDATE, then challenges and `review_demo_revoke` |
| `review_demo_tick` | 0144 | `review_demo` FOR UPDATE SKIP LOCKED |
| `review_demo_revoke` | 0155:273 | `end_player_families`, then the player's sessions |
| `end_family` | 0155:115 | device FOR UPDATE, then refresh, sessions, re-auth code, push sends, push device |
| `end_player_families` | 0155:134 | `end_family` per family, device-id order |
| `issue_player_tokens` | 0155:161 | inserts the new family's device row, refresh, session; the 10-family cap ends the oldest in device-id order |
| `rotate_player_refresh` | 0155:195 | family read unlocked; device FOR UPDATE; presented refresh FOR UPDATE; successor; sessions; `issue_player_tokens` |
| `sign_out_player` | 0155:259 | `end_family` |
| `sweep_player_sign_in` | 0155:283 (`LANGUAGE sql`) | login, contact, re-auth codes; sessions; refresh `replaced_by`; refresh; **then** device rows |
| `end_player_device` | 0155:439 | target read unlocked, `end_family(target)`; never its own row |
| `end_other_player_devices` | 0155:471 | own row read unlocked (`player_current_device`), fresh check on that read, then the others FOR UPDATE in id order |
| `confirm_player_reauth` | 0155:406 | own device FOR UPDATE, then the code |
| `start_player_reauth` | 0155:376 | upserts the family's code; no device lock |
| `label_player_device` | 0155:336 | `UPDATE` of one device row |
| `confirm_contact_change` | 0155:786 | the code, `player_contact`, then `UPDATE` of its own device row |
| `admin_reset_player_sign_in`, `admin_ban_player` | 0155:717, 0155:747 | (ban: enrollments) login challenges, `end_player_families`, sessions, push |
| `erase_rows` (via `erase_account` 0129, `erase_player` 0166) | 0155:850 | ... all device rows of the player in id order, push, login challenges, ..., device, session, refresh deletes |

No later file restates any of them: 0156 to 0183 only read `player_sign_in_device` and `player_refresh` (the export,
0164:1080) and restate Prepare once (0166).

## 2. Issue A: the reviewer flag is read without a lock

**Scenario.** The window is closed (first Prepare, or after Close or the window's end), or Prepare rotates the contact key.
An admin clicks Prepare; it holds `review_demo` FOR UPDATE for its whole transaction (the reviewer's erasure makes this
hundreds of milliseconds). Meanwhile someone asks a sign-in code for the reviewer number. `start_player_challenge` computes
`flagged` in its `DECLARE` from a snapshot taken before Prepare commits: false. If the number had an open challenge, the
cancel `UPDATE` then waits for Prepare, but the flag is already fixed. The challenge is inserted unflagged after Prepare's
second cancel, so it survives, and the API sends a real SMS. The reviewer cannot use the fixed code on it (`wrong`) until
they ask again. `start_deletion_challenge` has the same `DECLARE` read and the same result. Close and a number change race
the same way in the safe direction: a stale "open" flag gives a challenge that `review_demo_sign_in` answers `expired`.

**Likelihood and cost.** Very low: someone must ask a code for Questify's own SIM during the second Prepare runs, a few
times a year. Cost: one SMS from the budget to Questify's SIM, and SECURITY row 16's "No SMS is sent while it is open" is
briefly untrue. No account is reached that the code holder could not already reach.

**Fix (smallest).** In both functions, before the flag: take the row FOR SHARE, **only for the reviewer number**, then
compute the flag in its own statement (a fresh snapshot, after the lock).

```sql
-- start_player_challenge, as 0144 with one change (start_deletion_challenge the same, after its channel check):
DECLARE
  flagged boolean := false;
BEGIN
  IF method = 'phone' THEN
    -- The reviewer number only: any other sign-in reads the row and locks nothing (no hot row).
    PERFORM 1 FROM review_demo d WHERE d.contact = contact_value FOR SHARE;
    flagged := review_demo_open(key);
  END IF;
  ... unchanged: cancel, insert, RETURN flagged;
```

Matching on `contact` and not `contact_key`: Prepare never changes `contact` (it refuses a changed number, RD409 `stale`) but
may change the key, so a match by key would miss the row exactly when Prepare catches up a rotated key. A start on the old
number while a number change commits waits, then the re-check of the row fails (`contact` changed), it takes no lock, and
the flag reads false: correct, the old number is no longer the reviewer's. A start on the new number sees no match until
then, and the window is closed by that change anyway.

**This depends on READ COMMITTED** (plan review NIT-6), and 0184's comment says so: the re-check of the locked row after
the wait, and the flag's new snapshot in the next statement, are what READ COMMITTED gives a PL/pgSQL function. Under
REPEATABLE READ the `FOR SHARE` would fail with `40001` after a Prepare, and the flag would read the old snapshot. The
API's pool runs every transaction at the default READ COMMITTED (`pool-options.ts` sets no isolation).

**Lock order after the fix.** `review_demo` first, then challenges (ADR-561), now for every door that reads the flag:

| Writer | Order |
|---|---|
| Create | advisory key, insert the row, challenges, provision |
| Set-contact, Prepare, Close | row FOR UPDATE, challenges, players (Prepare: the erasure's enrollments, devices, ...), sessions |
| Tick | row FOR UPDATE **SKIP LOCKED**, event, sessions |
| `sign_in_player` (reviewer), `verify_deletion_code` (reviewer) | row FOR UPDATE / FOR SHARE, then the challenge |
| `start_player_challenge`, `start_deletion_challenge` (reviewer number) | row FOR SHARE, then that key's challenges |
| `erase_rows`, reset, ban, the sweep | challenges only, never the row |

Deadlock-free: every path that takes the row takes it first, before any challenge, player or session lock, so no
transaction holds a challenge while waiting for the row. Two starts share FOR SHARE and never upgrade (a start's request
transaction takes no later `review_demo` lock: `openChallenge` runs the windows, then this one call). The tick never waits.

**Side effects.** A reviewer-number start waits for a Prepare or Close in flight (under the API's 2 s lock timeout:
Prepare must stay under it, which test 0 below checks on the review-demo fixture (plan review MINOR-4: no existing test
times Prepare); a timeout answers 503 and the app retries).
The tick skips one round while a reviewer-number start holds the row; the window can close one tick late, and
`review_demo_sign_in` re-checks `window_until > now()` anyway.

**Old API during the deploy.** Same signatures and results, `CREATE OR REPLACE`, grants restated as they are. The old API
only sees a start that may wait a moment. Safe both ways.

## 3. Issue B1: the sweep takes refresh rows before device rows

**Scenario, wider than the review's line.** The sweep is one transaction (`sweepIfDue`, at most every 10 minutes an
instance) that deletes sessions and refresh rows, then waits for device rows it deletes. Any writer that holds a device row
and then touches that family's rows (ADR-712's order) can close a cycle with it:

1. **Rotation of a long-idle family.** The device row is live, but every refresh row expired more than 7 days ago (the
   app unused for 187 days). The app presents its token: rotation locks the device row. The sweep has deleted the refresh
   row and waits for the device row (the family has no refresh row left). Rotation's `SELECT ... FOR UPDATE` of the refresh
   row waits for the sweep: `40P01`.
2. **Any `end_family` of that family:** sign-out with that token, end one device, end-others, the cap, reset, ban,
   `review_demo_revoke`. `end_family` holds the device and updates the family's refresh rows with `revoked_at IS NULL`,
   which includes the expired unrevoked ones the sweep holds. Same cycle; the same for its session update.
3. **An erasure** (self-erase, admin, Prepare's reviewer erase) of a player with a device that ended 7 days ago: erasure
   holds all the player's device rows, then deletes all its refresh rows, including the revoked ones the sweep holds; the
   sweep waits for that ended device row. No old token is needed here, only the timing.
4. **Without any device wait by the sweep:** a replay of a token used more than 7 days ago in a live family. Rotation
   holds the device and that row, finds it used, and calls `end_family` (reuse), whose update reaches the family's other
   old used rows the sweep holds; the sweep waits for the presented row. Locking device rows only for the families whose
   device row the sweep deletes would not cover this one.

**Likelihood and cost.** Very low: the cycle needs a writer on the same family inside the sweep's own transaction (well
under a second), and a family with rows past the 7-day mark. Each case aborts one side after `deadlock_timeout` (1 s):
rotation, ends and erasure answer 503 `busy` (`conventions.ts`, `DATABASE_BUSY`) and are retried; a sweep is logged
(`player.sweep_failed`) and runs again 10 minutes later. Nothing is half-applied.

**Options.**

| Option | Verdict |
|---|---|
| **Device rows first, `SKIP LOCKED`; family rows only for families held** | **Recommended.** The sweep never waits for a device row, and nobody can hold a row of a family whose device row the sweep holds. A skipped family is swept at the next run |
| Device rows first, waiting (`FOR UPDATE`) | Rejected. Rotation's cap takes its own device row, then others ascending; a waiting sweep crossing that can deadlock, and it would queue rotations behind it |
| Lock only the device rows the sweep deletes | Rejected. Misses case 4 |
| Two transactions (rows, then device rows) | Rejected. Removes cases 1 to 3's device wait, keeps case 4 |

The staff first-password plan (2026-11-07, section 5) kept this out because a device lock on live families would queue
rotations. With `SKIP LOCKED` the sweep never waits; a rotation can wait for the sweep, for at most the sweep's own run
(see the measurement in section 5).

**Fix.** `sweep_player_sign_in` becomes PL/pgSQL (rules: a definer on a request path), same signature and grant:

```sql
CREATE OR REPLACE FUNCTION sweep_player_sign_in() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cut  timestamptz := now() - interval '7 days';   -- one cut for every statement
  held uuid[];
BEGIN
  -- Not family rows, first as before, and never waited for (plan review MINOR-2): a reset or ban holds a login
  -- challenge and then waits for device rows (0155:717, :747), erasure holds device rows and then deletes login and
  -- contact challenges (0155:899), so a sweep waiting on a challenge could close a cycle through them.
  DELETE FROM player_login_challenge WHERE id IN (SELECT l.id FROM player_login_challenge l WHERE <old>
                                                  FOR UPDATE SKIP LOCKED);
  DELETE FROM player_contact_challenge WHERE id IN (SELECT c.id FROM player_contact_challenge c WHERE <old>
                                                    FOR UPDATE SKIP LOCKED);
  -- The device row of every family this run touches, in id order, before any of its rows, as rotation, end_family and
  -- erasure take them (ADR-712). A row another call holds is skipped: its family waits for the next run.
  SELECT coalesce(array_agg(h.family), '{}') INTO held FROM (
    SELECT d.family FROM player_sign_in_device d
    WHERE d.ended_at < cut
       OR NOT EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = d.family)
       OR d.family IN (SELECT r.family FROM player_refresh r WHERE <old refresh>
                       UNION ALL SELECT s.refresh_family FROM player_session s WHERE <old session>
                       UNION ALL SELECT c.family FROM player_reauth_challenge c
                                 WHERE c.expires_at < now() - interval '1 hour')
    ORDER BY d.id FOR UPDATE OF d SKIP LOCKED) h;
  -- Family rows: a held family, or one with no device row (before 0155; rotation answers invalid for it).
  UPDATE player_refresh SET replaced_by = NULL WHERE replaced_by IN (<old refresh ids>) AND <family held or rowless>;
  DELETE FROM player_refresh WHERE <old refresh> AND <family held or rowless>;
  DELETE FROM player_session WHERE <old session> AND (refresh_family IS NULL OR <family held or rowless>);
  DELETE FROM player_reauth_challenge WHERE expires_at < now() - interval '1 hour' AND <family held or rowless>;
  DELETE FROM player_sign_in_device d WHERE d.family = ANY (held)
    AND (d.ended_at < cut OR NOT EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = d.family));
END $$;
```

`<old refresh>` and `<old session>` are 0155's predicates unchanged (`cut` for `now() - interval '7 days'`); `<family held
or rowless>` is `(family = ANY (held) OR NOT EXISTS (SELECT 1 FROM player_sign_in_device x WHERE x.family = <family>))`.
Refresh before sessions, as `end_family` and rotation. `now()` is fixed in the transaction, so the rows found at the lock
are the rows deleted. The `replaced_by` rows are always old themselves (a row's successor was made when it was used), so
restricting them by family loses nothing. `sql-settings-allowlist.json` drops `sweep_player_sign_in()` (it only shrinks).
The shape above is one transaction; section 5's measurement decides whether it stays one or becomes bounded batches (the
same statements, each call limited to a fixed number of families), and whether the old-row scans get an index.

## 4. Issue B2: end-others reads its own device row without a lock

**Scenario.** Devices A and B of one player, both fresh, tap "Sign out other devices" at once. Each reads its own row
unlocked as live, locks only the others, and ends the other's family. Neither waits for the other (neither locks its own
row), both commit `ended 1`, and the player is signed out everywhere, by two requests one of which ran on a session that
had just been ended. The same with `end_player_device` from B ending A while A's end-others runs: A ends B after A itself
was ended. And the fresh check reads a stale `reauth_at`: a code confirmed on this device a moment before is not seen
(`reauth_required` for nothing). No privilege is gained (the caller was live and fresh when the request started), so the
review called it a race that changes nothing; its real effect is that an ended session still completes one action (V7.4.1).

**Likelihood.** Low: two of a player's devices acting within the same few milliseconds, or a reuse detection ending this
family while it ends the others (a stolen token racing the owner).

**Fix.** Lock the caller's row with the others in one statement in id order, then re-read it and check it is live and
fresh; end only the rows that statement locked (0155's promise: a sign-in that commits afterwards stays live).

```sql
-- end_other_player_devices, as 0155 with one change:
  here := player_current_device(session);            -- PN401 unless live (unchanged, no lock)
  SELECT array_agg(l.id ORDER BY l.id) INTO held FROM (
    SELECT d.id FROM player_sign_in_device d
    WHERE d.player_id = here.player_id AND (d.id = here.id OR d.ended_at IS NULL)
    ORDER BY d.id FOR UPDATE) l;
  SELECT d.* INTO here FROM player_sign_in_device d WHERE d.id = here.id;
  IF here.id IS NULL OR here.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a live session of the calling player is required' USING ERRCODE = 'PN401';
  END IF;
  IF player_device_fresh_until(here) IS NULL THEN RETURN QUERY SELECT 'reauth_required'::text, 0; RETURN; END IF;
  FOR other IN SELECT d.family FROM player_sign_in_device d
               WHERE d.id = ANY (held) AND d.id <> here.id AND d.ended_at IS NULL ORDER BY d.id LOOP
    ... unchanged (end_family, count, audit)
```

`end_player_device` is not changed: it locks only its target, never its own row, so it adds no cycle; it is the one-device
door, and the end-others case above is covered from the end-others side.

## 5. Lock order after the fix, and why no writer cycles

**Invariants.**
- **I1.** A transaction touches a family's refresh, session, re-auth or push rows only after it holds that family's device
  row (FOR UPDATE, or as the inserter of a new row): rotation, `end_family` and all its callers, `issue_player_tokens`,
  `confirm_player_reauth`, erasure (all the player's device rows in one statement) and now the sweep. Exceptions, each
  checked: `start_player_reauth` upserts one code and then waits for nothing; `label_player_device` and
  `confirm_contact_change` update one device row last; the reset, ban and `review_demo_revoke` update the player's
  sessions after `end_player_families` (they hold those families' devices, and the rest are revoked or have no family).
- **I2.** A transaction that waits for more than one device row takes them ascending by id: end-others (one statement),
  `end_player_families`, erasure, the sign-in cap (its own new row is invisible to others, so nobody waits for it).
- **I3.** The sweep never waits for a device row or a challenge row (`SKIP LOCKED` on both, plan review MINOR-2) and
  touches only rows of families whose device row it holds, rowless families, and the two challenge tables (before any
  device lock).

**Scope of the claim (plan review MINOR-2).** I1 to I3 and the proof below cover device rows and the family rows behind
them (refresh, session, re-auth code, push), plus the challenge rows the sweep now skips. They say nothing about the other
player tables, and one older cycle outside them stays: `confirm_contact_change` holds `player_contact` (`FOR UPDATE`, 0155)
and then needs a key-share lock on the player row (the `player_fingerprint` insert's foreign key), while erasure holds the
player row (`erase_target`, `FOR UPDATE`) and then deletes `player_contact`. A contact change confirmed during that
player's own erasure can deadlock; PostgreSQL ends one side (503 `busy`, retried; the erasure is retried by its caller).
Unchanged by 0184 and written in the rules paragraph as a known exception.

| Writer | Order after 0184 |
|---|---|
| Rotation | device FOR UPDATE → presented refresh → successor → sessions → (issue) refresh, session inserts → cap: other devices ascending |
| Sign-in (`issue_player_tokens`) | new device row (insert) → refresh, session → cap: older devices ascending |
| Sign-out, end one device | `end_family`: device → refresh → sessions → re-auth code → push sends → push device |
| End-others | own and live device rows ascending (one statement) → per other family, `end_family` |
| Reset, ban, `review_demo_revoke` | (ban: enrollments) → login challenges → devices ascending, one family at a time → player's sessions → push |
| Erasure | enrollments → ... → all devices ascending (one statement) → push → login challenges → ... → device, session, refresh deletes |
| Re-auth confirm | own device → its code |
| Sweep | login, contact codes SKIP LOCKED → devices SKIP LOCKED → held families' refresh → sessions → re-auth codes → devices |
| Prepare, Close, set-contact | `review_demo` → challenges → (Prepare) erasure's order → sessions; never a device before `review_demo` |
| Challenge starts | `review_demo` FOR SHARE (reviewer number) → challenges; no device |

**Proof sketch.** A cycle needs some T waiting for a row R held by T'. (a) R is a device row: by I2 both take device rows
ascending, so a cycle through device rows alone is impossible; T' cannot be the sweep waiting on a device (I3). (b) R is a
family row of family F: by I1, T' holds D(F), so T must hold D(F) to touch F's rows; only one transaction holds D(F)
FOR UPDATE, so T is waiting on D(F) itself, case (a). The I1 exceptions wait for nothing after their single write, so they
end every chain. (c) The sweep: by I3 it waits on no device and no challenge row; it can wait only on a family row of F it
holds D(F) for, which nobody else can hold (I1), or on the single write of an I1 exception, which waits for nothing. (d)
`review_demo`: always first (section 2). Rotation, sign-in, the sweep and erasure never take `review_demo`.

**Known exception, unchanged by 0184.** Rotation's cap takes its own device row, then older ones ascending, which breaks I2
when the player has more than 10 live families (only after two sign-ins raced past the cap). An end-others or erasure
crossing it can deadlock; PostgreSQL ends one side and the API answers 503 `busy`. It predates this plan and is noted in
the rules paragraph, beside the contact-change one above.

**Residual (corrected, plan review MINOR-3).** 0155's backfill (0155:79-85) gave a device row to every family that held a
live, unexpired refresh token, so the families left without one held only revoked or expired rows; 0155's own sweep
removed those 7 days after 0155 deployed. Since then every family is born with its device row (`issue_player_tokens`), and
only the sweep (holding the device row) and erasure (deleting the device row with the rest) delete one. So no refresh row
without a device row is expected today. The rowless branch stays: for sessions with `refresh_family` NULL (sessions from
before 0013 gave sessions a family, or written by hand), and as a safety net for any row found without a device row, which is swept without a
device lock (at most one aborted request against an `end_family` on such a family). How many such rows each environment
holds is not counted here (ADR-810: no CranL data in this checkout); the count is a read-only query for the deploy step
(RUNBOOK 0184 note): `SELECT count(*) FROM player_refresh r WHERE NOT EXISTS (SELECT 1 FROM player_sign_in_device d WHERE
d.family = r.family)` and the same for `player_session` by `refresh_family` (NULL counted apart).

**Measurement (rules, PERFORMANCE_AUDIT; plan review MAJOR-1).** The sweep runs inline in a code request before the SMS
(`players/sign-in.ts:382`, `:721`), under the API's 5 s statement timeout, and a rotation of a family it holds waits for it
under the 2 s lock timeout. The fixture is steady state: **100,000 players** (120,000 families, every fifth player on two
devices) each rotating every 4 hours on a random phase, with **7 days and 10 minutes of rotation history** left by a sweep
10 minutes ago: about 5 million used refresh rows and 5 million sessions, 2,000 families ended over the week, and an hour
and a half of sign-in, contact and re-auth codes. About 5,000 families cross the 7-day mark in the 10-minute slot.
`apps/api/test/perf/sign-in-sweep-timing.int.test.ts` builds it, times 0155's sweep (a copy) and 0184's, prints
`EXPLAIN (ANALYZE, BUFFERS)` of each statement, and measures rotations of the slot's families started while the sweep runs.

Two gates, at 100,000 players:
- **the sweep's duration**: the whole run under 1 s (a fifth of the statement timeout; the code request waits on it), and
  each transaction under 250 ms;
- **the longest wait of a rotation that crosses it**: under 250 ms (an eighth of the lock timeout).

Choice, by the numbers. If one transaction meets both gates, the sweep stays one call. If not, it becomes **bounded
batches**: each call locks at most a fixed number of families (and challenges), is its own short transaction, and answers
how many rows it found; `sweepIfDue` calls it again until a call finds nothing or a 1 s budget is spent (a TypeScript
change, with unit tests). The function's result changes from `void` to `integer`, so it is dropped and created (the old
API's `SELECT sweep_player_sign_in()` still runs). A partial or expression index is added on `player_refresh` and
`player_session` if `EXPLAIN` shows the old-row scans dominate (none exists on `revoked_at`, `used_at` or `expires_at`
today), and on `player_refresh.replaced_by` if the foreign key's check on each deleted row shows as a scan. Each index is
built inside 0184 (pre-launch tables are small; RUNBOOK notes the build's write lock). The plan records the numbers and the
choice when they are measured.

**Measured (2026-11-09, the build; `test/perf/sign-in-sweep-timing.int.test.ts`, local PostgreSQL 17, 128 MB shared
buffers).** Fixture as above: 5,164,894 refresh rows and 5,071,723 sessions; the 9-minute seed meant about two slots had
crossed the 7-day mark when measured (9,556 old refresh rows, 6,639 old sessions), more than one steady-state run.
- **0155's sweep does not finish.** It stopped at the 5 s statement timeout. The cause is the `replaced_by` foreign key:
  with no index on `replaced_by`, each deleted refresh row scans the whole table (`EXPLAIN` of 20 deletes: the trigger took
  12.9 s, 0.64 s a row), and the old-row scans are sequential (3.5 s and 3.1 s for the refresh and session tables). So at
  100,000 players today's sweep fails every run and the tables only grow.
- **One transaction (0184's statements without limits) misses both gates**: 2.2 to 4.7 s for about 39,000 rows on the
  exploration copy, and a rotation of a held family would wait that long.
- **Chosen: bounded batches plus indexes.** Indexes on `least(revoked_at, used_at, expires_at)` (refresh),
  `least(revoked_at, expires_at)` (sessions, plus a partial twin for sessions with no family, which otherwise cost 220 ms a
  batch to find none), `replaced_by` (partial) and `ended_at` (partial). A batch takes at most 500 families from each of
  the four old-row windows and 1,000 codes of each kind. Measured: 10 batches of 85 to 115 ms (about 1,000 rows each, the
  first 2,322), 11,845 rows; a run with a 1 s budget took 1,052 ms because a batch could start just before the budget
  ended, so the loop now starts a batch only when one as long as the last still ends inside it. Rotations of the old
  families run beside it on 6 connections: 870 rotations, median 4 ms, **longest 106 ms** (200 alone: longest 37 ms).
- Re-measured after the loop change on a fresh fixture (9,442 old refresh rows, 6,491 old sessions): **955 ms**, 9
  batches of 92 to 127 ms, 10,851 rows; 811 rotations beside it, median 4 ms, **longest 110 ms** (200 alone: 26 ms).
- Both gates pass: each batch under 250 ms, the run under 1 s, the longest rotation 110 ms against the 250 ms gate. One run removes about one steady-state slot at 100,000 players (10,000 to
  12,000 rows), so a single instance keeps up and two or more catch up a backlog; RUNBOOK says what to watch.
- Not a candidate set: "a live device row whose family has no refresh row" is no longer scanned for (a full pass over the
  device table each batch). No path leaves one: rows are born with the family, 0155's sweep removed such device rows in
  the transaction that removed the last refresh row, and 0184 does the same for the families it holds. One that existed
  would still go when its family is swept for any other reason.

## 6. Tests (test first; two connections, in the style of the existing race tests)

Style: `f.crossed(first, second)` in `test/support/questify.ts` (first held open, second started, `waited` from
`pg_stat_activity`, then commit), as in "Close and its races" (`review-demo.int.test.ts`), and the held-transaction plus
`waitForLock(pid)` pattern of "races (ADR-712)" (`signed-in-devices.int.test.ts`). Each test below either fails on
today's functions or, where marked, proves a property the fix must keep (tests 0, 5, 7, 16, 17, 18, 20, 21); the build
reports which failed before 0184.

**`apps/api/test/db/review-demo.int.test.ts`, new describe "the flag waits for the row (0184)":**
0. Prepare on the review-demo fixture (the reviewer erased with its rows, a fresh one provisioned) finishes under the
   API's 2 s lock timeout, timed in the test (plan review MINOR-4), so a reviewer-number start waiting on it gets its
   answer before the lock timeout.
1. Window closed (after Close), no open challenge: `crossed(prepare, start on the reviewer number)`: `waited` true and the
   start answers `reviewer: true`. Today: no wait, `false`.
2. The same with an open challenge on the number first: `reviewer: true`. Today the start waits (on the cancel) but answers
   `false`.
3. Window open: `crossed(close, start)`: waited, `reviewer: false`. Today: no wait, `true`.
4. `crossed(set-contact to a new number, start on the old number)`: waited, `reviewer: false`.
5. `crossed(prepare, start on another number)`: `waited` false. Guards against a lock for every sign-in (a hot row).
6. `crossed(prepare, start_deletion_challenge on the reviewer number)`: waited, `reviewer: true`.
7. `crossed(start on the reviewer number, review_demo_tick)` with the window past its end: the tick does not wait and
   answers 0; the next tick closes it.

**`apps/api/test/db/signed-in-devices.int.test.ts`, in "races (ADR-712)":**
8. Rotation of an idle family (owner sets its refresh and session rows' `expires_at` 8 days back): the holder takes the
   device row as rotation's first statement does, the sweep runs on the other connection and **finishes without waiting**,
   then the holder calls `rotate_player_refresh` in the same transaction: `invalid`, no `40P01` on either side; after the
   commit a second sweep removes the device and its rows. Today the sweep waits and one side gets `40P01`.
9. The same with `sign_out_player` (its `end_family`) in place of the rotation, the old session unrevoked: no `40P01`.
10. Erasure: a device ended 8 days ago with its revoked rows; the holder locks the player's device rows as `erase_rows`
    does, the sweep finishes without waiting, then the holder deletes the player's refresh and session rows: no `40P01`.
11. Replay of a token used 8 days ago in a live family (case 4): holder runs `rotate_player_refresh` with it up to its
    reuse `end_family`; crossed with the sweep in both orders: no `40P01`, the family ends, `player.refresh_reuse` audited.
12. A family the sweep skipped keeps its old rows after that run and loses them at the next.
13. Two fresh devices A and B, end-others from each at once: the second waits, then raises `PN401`; A stays live, B is
    ended. Today: no wait, both ended.
14. `end_player_device` from B ending A, held; end-others from A: waits, then `PN401`; B stays live. Today B is ended.
15. A stale device confirms a re-auth code (held, `confirm_player_reauth`); end-others from it: waits, then ends the others.
    Today: `reauth_required` without waiting.
16. A rotation of the caller's own family, held; end-others: waits, then ends the others (the new wait is harmless).
17. The existing "end-others ends exactly the families it locked; a sign-in that commits afterwards stays live", "the sweep
    removes device rows a week after they end" and "an end and a rotation of one family, both orders" stay green.
18. Two sweeps at once (no lease: every instance sweeps on its own clock): the first holds its transaction open after its
    run, the second finishes without waiting and finds nothing it can take; no `40P01`; after the commit nothing old is left.
19. A challenge row held (a reset's or ban's delete, an erasure's): the sweep finishes without waiting and leaves that row;
    the next sweep removes it. Today: the sweep waits.
20. `start_deletion_challenge` on another number while Prepare is held: `waited` false (no hot row), as test 5.
21. A family with no device row (refresh and session rows written by hand, and a session with `refresh_family` NULL, all
    past the 7-day mark): the sweep removes them; a live family's rows stay.

**Catalog and security:** `hot-path-plpgsql.int.test.ts` passes with the shrunken allowlist; `test/security/*` and
`rehearsal.int.test.ts` unchanged (no new object, grants as before).

## 7. ASVS (`docs/security/ASVS_L2.md`)

- **V7.4.1** (terminated sessions cannot be used), Met: evidence gains tests 13 and 14 (an ended device cannot end others).
- **V7.5.2** (users end their sessions after re-authenticating), Met: evidence gains test 15 (the fresh check is read under
  the lock).
- Issue A changes no row: the fixed code is SECURITY row 16 (pathway), and the race only sent an SMS. Row 16's "No SMS is
  sent while it is open" becomes exact; tests 1 to 6 join its evidence.
- Counts unchanged. Concurrency (V15.4) is level 3 and is not in the L2 file.

**Docs:** `docs/rules.md` gains "The player sign-in's lock order (T-810c, 0184)" with section 5's table, the cap exception
and the residual; `docs/SECURITY.md` row 16 evidence and "Signed-in devices and sessions" (the sweep skips held families);
FOLLOWUPS lines 38 and 58-61 removed; STATE bullet; RUNBOOK deploy note for 0184 (none needed beyond "safe on the old API").

## 8. Mutation

No TypeScript changes, so no Stryker globs. SQL is checked by hand mutants, applied one at a time on a scratch copy of 0184
and run against section 6, as 0146's `ORDER BY` mutant was:

| Mutant | Killed by |
|---|---|
| Drop `FOR SHARE` in `start_player_challenge` | 1, 2, 3 |
| Keep the flag in `DECLARE` (before the lock) | 1, 2 |
| Lock for every phone (no `contact` match) | 5 |
| Drop `FOR SHARE` in `start_deletion_challenge` | 6 |
| Sweep: `FOR UPDATE` without `SKIP LOCKED` | 8 (the sweep must finish while the holder waits) |
| Sweep: device lock after the refresh delete (0155's order) | 8, 9, 10 |
| Sweep: refresh delete not limited to held families | 8, 11, 12 |
| Sweep: session delete not limited | 9 |
| End-others: own row left out of the lock | 13, 14, 15 |
| End-others: no re-read of own row after the lock | 13, 14 |
| End-others: loop over a new `SELECT` instead of the locked ids | 17 (the late sign-in case) |
| Keep the flag in `DECLARE` in `start_deletion_challenge` (before the lock, plan review MINOR-5) | 6 |
| Sweep: challenge deletes without `SKIP LOCKED` | 19 |
| Sweep: rowless branch dropped | 21 |
| Sweep: re-auth code delete not limited to held families | equivalent: a family's re-auth code is written only by `start_player_reauth`, which takes no device row and waits for nothing after its one upsert, so no test can make the unlimited delete wait or deadlock (plan review MINOR-5) |
| Either `ORDER BY d.id` dropped | equivalent for these tests (a single crossing cannot show it); noted, as the rules allow |

**Run (2026-11-09, the build; each mutant applied alone to 0184 and the file's suite run).** 15 run, 13 killed, 2
equivalent survivors as planned (the re-auth code delete not limited; end-others' `ORDER BY d.id` dropped; the sweep has
no `ORDER BY` any more: it never waits, so its lock order cannot matter). Killed by more than the plan said: dropping
`FOR SHARE` in `start_player_challenge` also fails 4 and 7; the flag in `DECLARE` also fails 3 and 4; no `SKIP LOCKED` on
the device lock fails 8 to 12 and 18; 0155's order fails 9, 11, 12 and 18; the unlimited refresh delete fails 9, 11, 12
and 18; the unlimited session delete fails 18. The loop over a new `SELECT` survived the existing late-sign-in test (the
sign-in there commits after end-others returns), so the build added test 17b, "a sign-in that commits while it waits stays
live" (end-others waits on a rotation of its own family while a new device signs in), which kills it.

## 9. Deploy and the old API

0184: `SET LOCAL lock_timeout = '10s'`, header as 0166, four `CREATE OR REPLACE` restatements (`start_player_challenge`,
`start_deletion_challenge`, `sweep_player_sign_in`, `end_other_player_devices`), each with its arguments, results, owner and
grants unchanged (`REVOKE ... FROM PUBLIC`, `GRANT ... TO questify_app` restated beside each). No table lock, no backfill.
A call in flight keeps the body it started with.

| Old code on 0184 | What happens |
|---|---|
| Code request, deletion request | Same answer; a reviewer-number request may wait for a Prepare in flight |
| `sweepIfDue` | Same call, new body; a skipped family waits 10 minutes |
| End-others | The new `PN401` maps to 401 in `asDevicePlayer` already (`devices.ts:95`); the app treats it as signed out |
| Rollback of the API only | Nothing depends on the API version |

No down migration: the old bodies are the deadlock-prone ones.

## 10. Risks

- **Riskiest: the sweep's device locks.** It now holds the device row of every family it sweeps for its whole run, and a
  rotation of such a family waits for it. Bounded by the measurement gate in section 5; a run past the API's 2 s lock
  timeout would answer those rotations 503 and the app retries.
- A skipped family's rows stay up to one more sweep interval. Harmless: they are already unusable.
- Rotation's cap exception and the rowless legacy families stay as written in section 5.
- A Prepare that ran longer than 2 s would make reviewer-number code requests answer 503 meanwhile; measured on the fixture.
