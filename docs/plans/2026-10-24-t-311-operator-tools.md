# T-311 — Operator tools: My station today and practice mode (renamed "quest" and "category" move to T-311b)

F-181, F-182: operator Home shows **My station today** for the picked station (done today, the last hour, waiting
items), and Tools gets a **practice mode** switch: test scans show the real station result screens but award and record
nothing. Delivers FR-928 and FR-929, and the practice entry of FR-922's Tools list. **Core bar** (it sits on the points
door, operator powers and tenant isolation): one Opus plan review, one Opus code review, mutation on GitHub.
Migration **0060** (new file; two functions, no table; 0057 to 0059 are undeployed and untouched). Depends on T-205
(station scan, `operator_stations`), T-310 (the Inbox count), T-211 (rehearsal), all done.

Dhia is away: open choices are my recommendation, written as **Proposed** ADR-249 to ADR-251 and Q-212 to Q-214.

## Split: FR-942 moves to T-311b (recorded in TASKS.md)

Renaming "quest" and "category" is a different job from the two operator tools: it touches no points and no operator
power, and its size is a string sweep, not code. `messages.ts` has about 165 Arabic lines naming a quest or a category
across the app, staff mode and the dashboard; each needs ADR-058's label, heading or rephrase rule and a `ux-araby`
check (T-117's table for two words was 30 rows). Putting it beside a core change would make one review cover both and
hold practice mode behind copy work. **T-311b** (Standard bar, Sonnet review) is outlined at the end so its worker
starts from the same facts.

## What T-311 builds on

- **The station scan** (T-205, `apps/api/src/operators/scan.ts`): `POST /v1/operator/scan` opens the My QR in the API,
  then `operator_complete_quest(quest, player, version, key)` (last stated in 0030:316) checks the operator, the
  `scan_quests` ability, the quest limit, self-scan and the code version, and calls `record_completion` (last stated in
  0058), which pays the completion, the ledger entry, XP, boosts, category bonuses, community and passport effects,
  flags and audit in one transaction. `operator_scan_subject` names who was scanned. After the commit the route calls
  `deps.ranking.afterCompletion` (Redis). Both station kinds go through it: `scan_qr` and `challenge` (ADR-197) quests
  with `my_qr` in their verification.
- **No side effect leaves the transaction** inside these functions: no `pg_notify`, no job queue, no dblink in any
  migration (checked). The only outside effects of a scan are the ranking call and the log line, both in TypeScript.
- **Operator Home** (`apps/app/app/operator/[eventId]/(tabs)/index.tsx`) lists `operator_stations` (0042:448): each
  station with this operator's completions today and in all (`ledger_entry.operator_id = me`), the event's day by its
  timezone and `day_start_hour`. The picked station lives in `OperatorContext` (kept on the phone, FR-923).
- **The Inbox count** (T-310): `GET /v1/operator/events/:eventId/inbox/count`, polled every 30 s by the tab badge
  (`useInboxBadge` in the tabs layout); OA403 for an operator with neither `review` nor `help_desk`.
- **Rate limits**: `holdBack` with a `BUCKETS` entry (`apps/api/src/devices/limits.ts`, T-310's `inboxRead`).
- **Index**: `quest_completion_quest_idx (quest_id, created_at)` (0012) already serves a range count per quest; no
  new index.
- **UX**: `docs/ux/OPERATOR_MODE.md` §3.1 (Home's "Today at this station" block) and §3.4 (the practice switch, the
  strip "Practice: nothing is saved").

## Practice mode: how a practice scan can never write (ADR-249)

A practice scan runs **the real door**, so the result is exactly what a real scan would show (every rule, boost,
occurrence and refusal, with no second copy of the rules to drift), and **the database undoes it before it returns**.
Three walls, each tested on its own:

1. **The database wall.** `operator_practice_scan(target uuid, scanned uuid, scanned_version integer)` is `SECURITY
   INVOKER` (it runs as `questify_app` and gains no privilege; it can only call what the API could call). Its body:

   ```sql
   BEGIN
     SELECT c.points, c.occurrence INTO would_points, would_occurrence
     FROM operator_complete_quest(target, scanned, scanned_version, 'practice:' || gen_random_uuid()::text) c;
     RAISE EXCEPTION 'practice scan undone' USING ERRCODE = 'PX000';
   EXCEPTION
     WHEN SQLSTATE 'PX000' THEN outcome := 'completed';
     WHEN OTHERS THEN
       GET STACKED DIAGNOSTICS refusal = RETURNED_SQLSTATE, refusal_detail = PG_EXCEPTION_DETAIL;
       outcome := 'refused';
   END;
   RETURN QUERY SELECT outcome, would_points, would_occurrence, refusal, refusal_detail;
   ```

   A PL/pgSQL block with an exception handler is a subtransaction: everything written inside it is rolled back when it
   raises. The `RAISE` is unconditional, so there is no path where the inner writes survive; any refusal also lands in
   the handler. PL/pgSQL variables are not transactional, so the would-be points and occurrence survive the undo. The
   key is fresh and marked `practice:`, so a practice scan never replays, collides with or uses up a real scan's key.
   The function writes nothing of its own, so even a committed transaction around it changes nothing.
2. **The API wall.** The practice route runs in `withRolledBackContext` (new, in `apps/api/src/db/context.ts`, beside
   `withRequestContext`): `BEGIN`, the same request settings, the work, then **always `ROLLBACK`**, never `COMMIT`, on
   success and on error. The scan subject is read in the same transaction.
3. **The route wall.** `POST /v1/operator/scan/practice` is a separate route with its own module
   (`apps/api/src/operators/practice.ts`). Its deps are `Pick<ScanDeps, "pool" | "myKey">`: it has no ranking, so it
   cannot move a place. It uses the `player` guard, not `playerIdempotent`, so it takes no Idempotency-Key and leaves no
   entry in the idempotency store. The real route `/v1/operator/scan` is not changed; there is no `practice` flag on
   it (a missing or mistyped flag defaulting to "real" is the bug this avoids).

The refusal codes are mapped by the real scan's `REFUSALS` table (exported from `scan.ts`, one source of truth); a
code it does not know (a deadlock, a serialization failure, a bug) is thrown as a 500 with the code in the log, never
shown as a red result. `not_operator` (OP403) answers 403 like the real route, and the app leaves staff mode.

### What a practice scan answers

The real route's body plus `"practice": true`: `completed` with `points` and `occurrence` (no `replayed`),
`already_completed`, or `refused` with the same `reason` and `detail`, and the same `player` (@username and avatar).
The log line is `operator.practice_scan {questId, result, reason?}` (no player id, no code).

### Which scans can be practised (ADR-250)

| Scan | Practised? | Why |
|---|---|---|
| Station scan of a My QR, `scan_qr` quest | yes | FR-929's "station result screens" |
| Station scan of a My QR, `challenge` quest (staff confirm) | yes | the same door and screen |
| NFC tap, screen QR (rotating code), kiosk scan | no | the player's phone or a paired device scans, not the operator; the operator's phone only shows or writes the code |
| Manual award, prize desk hand-over and cancel, review approve or reject, ticket answers, NFC write, device pairing | no, **locked** while practice is on | not scans; each writes real records; Q-212 asks whether any should be practised later |

**Before the event**: a real player's code in a Scheduled event answers the real red "not open yet". To practise a
green before the doors open, the team scans a rehearsal account (T-211), whose completions are real only until the
go-live wipe; in practice even those are undone. The Tools hint says so.

## Practice mode in the app (ADR-250)

- **The switch** is Tools → Practice mode (FR-922's fifth entry), a switch with the hint "Scans show the real result.
  Nothing is saved." It lives in `OperatorContext` **in memory only**: never written to the phone, so leaving staff
  mode, switching to player mode, or restarting the app turns it off. The default is off.
- **While on**, every staff-mode screen shows the strip **"Practice: nothing is saved"** (one `PracticeStrip` in the
  staff layout, beside the rehearsal strip; colour and text, never colour alone).
- **The station scan** calls `practiceScanPlayer` (`/v1/operator/scan/practice`, no key) instead of `scanPlayer`. The
  choice is made in one function, `scanFor(practice)` in `src/operator/operator-api.ts`, tested both ways. The result
  cover is the real one (green, orange, red, the same words, the same buzz) with a **"Practice · not saved"** line under
  the result, and the scanner footer reads "Practice". The repeat-hold logic is unchanged.
- **Locked screens**: Desk and Inbox tabs, and Tools → Manual award, Review, Write NFC tag, Rotating QR, Pair a device,
  My devices show one `PracticeLock` card: "Practice mode is on. Leave it to use this." with **Leave practice**. The
  strip's promise stays true, and an operator never hands over a prize or awards points believing it is a test. The
  Inbox badge still counts (a read).
- **Home** still works (reads only), and its numbers never move with practice scans.

## My station today (ADR-251)

- **What it counts**: completions of the picked station's quest, by **every** method and every operator, in the
  event's day (its timezone and `day_start_hour`, as `operator_stations`) and in the last 60 minutes. The station is
  the quest, so two operators at one booth see the same numbers. Rehearsal completions count while they exist (the wipe
  removes them). This operator's own count stays on the station list ("Today", "In all", T-205). Q-213 asks whether
  "the station" should mean only this operator's scans.
- **Waiting items**: the Inbox count (T-310: submissions to review and open tickets inside the quest limit and the
  operator's abilities). It moves from the tab layout into `OperatorContext` (`useWaiting`), so one 30-second poll
  feeds the badge and Home. Hidden for an operator with neither ability (OA403 → no line). It opens Inbox.
- **Who may read**: an operator of the event (`OP403`), the quest a station quest of that event (`scan_qr` or
  `challenge` with `my_qr`; `OQ404` otherwise, also for another event's quest), inside the operator's quest limit
  (`OS403`). Counts only: no names, no players, no points. Owners and editors have the dashboard.
- **Function** (0060): `operator_station_today(target_event uuid, target_quest uuid) RETURNS TABLE (today bigint,
  last_hour bigint)`, `STABLE SECURITY DEFINER`, `SET search_path = public, pg_temp`. The day's bounds are computed
  once as `timestamptz` values, so the count is a range scan on `quest_completion_quest_idx`:
  `day_start := (date_trunc('day', (now() AT TIME ZONE tz) - offset) + offset) AT TIME ZONE tz`, `day_end := day_start
  + 1 day` (the same day as `operator_stations` computes, tested at the boundary).
- **Route**: `GET /v1/operator/events/:eventId/stations/:questId/today` → `{today, lastHour}`; 403 `not_operator`,
  404 for an unknown or non-station quest, 403 `outside_station`; `holdBack` 60 a minute per player (new bucket
  `stationToday`, `too_many_attempts` with Retry-After).
- **App**: Home's "Today at this station" block under the picker: Done today, Last hour, Waiting. Read on focus and
  every 30 s while Home is focused and the app is in the foreground. No station picked: "Pick your station to see
  today's numbers." and no numbers (FR-928's second case). A failed read: "No signal. Numbers cannot load." with Retry;
  the last numbers are not shown as current.
- **Cost**: one indexed range count per open Home every 30 s. A busy station has a few thousand completions a day:
  well under 5 ms. 100 operators: about 3 reads a second. Practice scans cost what a real scan costs (one transaction,
  undone) and take no rate limit, like real station scans (ADR-139); a practice scan needs the player's code in front of
  the camera, so it cannot be used to sweep players.

## Functions (migration 0060; each `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO questify_app`)

| Function | Kind | Notes |
|---|---|---|
| `operator_practice_scan(uuid, uuid, integer)` | `VOLATILE SECURITY INVOKER` | the three-wall undo above; returns `(outcome, points, occurrence, refusal, refusal_detail)` |
| `operator_station_today(uuid, uuid)` | `STABLE SECURITY DEFINER` | counts only; OP403, OQ404, OS403 |

No table, no grant on a table, no change to `operator_complete_quest` or `record_completion`. The migration header says
why the wrapper is an invoker (no privilege of its own) and why its `RAISE` must stay unconditional.

## API (API.md rows)

| Route | Guard | Answers |
|---|---|---|
| `POST /v1/operator/scan/practice` | `player` (no key) | `{result, player, points?, occurrence?, reason?, detail?, practice: true}`; 403 `not_operator`; 422 for a bad body |
| `GET /v1/operator/events/:eventId/stations/:questId/today` | `player` | `{today, lastHour}`; 403 `not_operator` / `outside_station`; 404; 429 |

Both are classified in `route-access.ts` and `routes.int.test.ts`.

## Strings (Arabic through `ux-araby` at build; Western digits; RTL checked; no renamed noun is counted, ADR-058)

| Key | Arabic | English |
|---|---|---|
| `operator.practice.title` | وضع التدريب | Practice mode |
| `operator.practice.hint` | يعرض المسح النتيجة الحقيقية ولا يُحفظ شيء. قبل بدء الفعالية امسح حساب تجربة. | Scans show the real result. Nothing is saved. Before the event opens, scan a rehearsal account. |
| `operator.practice.strip` | تدريب: لا يُحفظ شيء | Practice: nothing is saved |
| `operator.practice.result` | تدريب · لم يُحفظ | Practice · not saved |
| `operator.practice.locked` | وضع التدريب مفعّل. أوقفه لتستخدم هذه الأداة. | Practice mode is on. Leave it to use this. |
| `operator.practice.leave` | إيقاف التدريب | Leave practice |
| `operator.stationToday.title` | اليوم في هذه المحطة | Today at this station |
| `operator.stationToday.done` | أُنجز اليوم: {count} | Done today: {count} |
| `operator.stationToday.lastHour` | آخر ساعة: {count} | Last hour: {count} |
| `operator.stationToday.waiting` | بانتظارك: {count} | Waiting: {count} |
| `operator.stationToday.pick` | اختر محطتك لترى أرقام اليوم. | Pick your station to see today's numbers. |
| `operator.stationToday.failed` | لا اتصال. تعذّر تحميل الأرقام. | No signal. Numbers cannot load. |

The existing `operator.today` / `operator.total` keys (the station list, this operator's own counts) are unchanged.

## Tests (test first)

- **The fingerprint helper** (`apps/api/test/db/fingerprint.ts`): for every base table in every application schema
  (`public`, and the job schema when present), `md5(string_agg(t::text, '|' ORDER BY t::text))`, read as the table
  owner. Nothing is excluded, so a table added later is covered without editing the test.
- **Database** (`test/db/practice-scan.int.test.ts`), each case taking the fingerprint before and after the practice
  scan, and comparing the practice answer with the real scan of the same case run afterwards:
  - **Green**: a `scan_qr` station; a `challenge` station; a repeatable quest (the next occurrence is shown, nothing
    stored); a flash boost running (the boosted points are shown); a completion that would earn a category bonus, a
    community step, XP and a passport stamp (none of them written).
  - **Orange**: the player already completed it.
  - **Red, every refusal**: OQ404, OP403 (`not_operator`), OA403, OS403, OY409, OM422, QC404, QC403 (left, banned),
    QN403 (scheduled, ended, a community-locked quest), QV422, QP403.
  - **Rehearsal**: a rehearsal account in a Scheduled event is green; an event just gone live, whose wipe is owed, is
    not wiped by a practice scan (undone) and is wiped by the next real call.
  - **FR-929's two cases**: practice green, score and ledger unchanged; practice off (the real route), the same player
    is paid; practice again is orange.
  - **Wall 1 alone**: `operator_practice_scan` called in a transaction that **commits**: the fingerprint is unchanged.
  - **Keys**: a real scan with key K, then a practice scan (orange), then the real retry with K replays the first answer.
  - **Crossed**: a practice scan and a real scan of the same player at once (two connections): one completion in all,
    the practice answer green or orange, the fingerprint after equal to the real scan's alone.
  - **Today**: FR-928's 40 today and 6 in the last hour (rows dated as the owner); the day's start at `day_start_hour`
    in the event's zone (one minute before and after); 59 and 61 minutes ago; other methods and other operators counted;
    another quest's not; a rehearsal row counted, gone after the wipe; OP403, OQ404 (another event's quest, a quest
    without `my_qr`), OS403 (outside the limit), an unlimited operator.
- **Security**: outsider suite (both functions refused to `anon` and `PUBLIC`); cross-tenant (an operator of event A
  practises a quest of event B: `not_operator`, nothing written; reads B's station numbers: 403); `routes.int.test.ts`.
- **Route/unit** (`apps/api/src/operators/practice.test.ts`, `station-today.test.ts`): a recording fake client shows
  `withRolledBackContext` sends `ROLLBACK` and never `COMMIT`, on success and on error (wall 2 alone); a ranking spy in
  the app's deps is never called by the practice route (and Redis's board is unchanged in the int test); no
  Idempotency-Key needed or read; the body carries `practice: true`; an unknown SQLSTATE is a 500; the log line has no
  player id; the 429 with Retry-After.
- **App**: `scanFor(true)` posts only to `/scan/practice` and `scanFor(false)` only to `/scan`; the switch starts off,
  is never written to the key-value store, and is off after leaving staff mode; the strip on every staff screen while
  on; each locked screen shows the lock card and Leave practice turns practice off; the result cover's practice line;
  Home's block (numbers, no station, failure, waiting hidden on OA403, the shared poll); RTL and Arabic;
  `expo export`.
- **On a device** (not a CI gate): practise at a station on one phone while the player's Home on another shows no
  change; leave practice, scan again, the player is paid.
- **Mutation (GitHub)**: `apps/api/src/operators/practice.ts`, `apps/api/src/operators/station-today.ts`,
  `apps/api/src/db/context.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0060, `withRolledBackContext`, the practice and today modules and routes, the fingerprint helper, the
   database, security and route tests.
2. The app: the context's practice flag and shared waiting count, the strip and lock, the station scan, Home's block,
   Tools' switch, tests, `expo export`.
3. Docs: API.md, DATA_MODEL.md (the two functions), SECURITY.md (the practice walls), OPERATOR_MODE.md as built,
   TASKS, STATE.

## Proposed decisions and questions

- **ADR-249** — practice scans run the real door and are undone in the database (the three walls).
- **ADR-250** — practice mode: station scans only, in memory, a strip on every staff screen, writing tools locked.
- **ADR-251** — My station today counts the station's quest for everyone; waiting is the Inbox count.
- **Q-212** — practise the desk, manual awards or reviews too? (Recommended: no, until an organizer asks.)
- **Q-213** — "at the operator's station": everyone's completions of the quest, or only this operator's?
- **Q-214** — staff mode does not use the event's renamed words today (found here; T-311b fixes it).

## T-311b outline — renamed "quest" and "category" (FR-942; Standard bar)

- **Data**: `EventTerms` gains `quest` and `category` (`packages/shared/src/config/terms.ts`), the same all-or-none
  rule per word, `readEventTerms` tolerant per word, defaults «مهمة / مهام», "quest / quests" and «فئة / فئات»,
  "category / categories" (the words `messages.ts` uses now). Same route (`PUT …/terms`), same audit; PUT still replaces
  the whole object. Answers Q-105 (2): FR-942 now asks for it.
- **Dashboard**: the Event words section gets the two words with the preview; the builder's headings and labels that
  name a quest or a category take the event's word (FR-942 "everywhere in that event").
- **App**: the Quests tab title, the quest sheet, Home and every player string that names a quest or a category, by
  ADR-058's rules (label, heading, or rephrase; Arabic never counts the noun), each row in a table like T-117's.
- **Staff mode** (Q-214): `OperatorProvider` loads the event's composed configuration like `EventProvider` and gives
  `useTerms()`, so staff screens use the event's player, operator, quest and currency words too (FR-941's gap).
- **Questify home** and Questify-level quests keep the defaults (FR-942's second case).
- **Done when**: an event that renames "quest" to "mission" shows "Missions" on the Quests tab and in staff mode in
  English, and «…» as typed in Arabic; Questify home still says "Quests".
