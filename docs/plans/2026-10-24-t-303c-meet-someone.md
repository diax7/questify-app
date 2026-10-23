# T-303c — Meet-someone quests: both players paid, repeat pairs refused, a daily cap

Delivers FR-212, FR-213 (F-84) and the meet-someone switch of FR-1009 (F-25). Split from T-303 by ADR-196. **Core
bar**: one request pays two players at once (the points ledger, two enrollment locks), and it needs its own proof
because My QR is fixed (ADR-137): one Opus plan review, one Opus code review, mutation on GitHub. Migration **0049**
(0048 is undeployed and belongs to T-303b; this task adds its own file). Depends on T-303 (`play_quest`, the type
pattern), T-209 (`raise_completion_flags`), T-303b (`keep_position`, the 12-parameter `record_completion`).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-209 to ADR-211 and Q-173 to Q-175.

**CTO plan review 2026-10-24: 84/100, findings folded in** (the meeting row written after both payments, both
completions keyed by the pass; the replay re-checked under the locks; both device advisory locks taken in ascending
key order before the inserts; the account-status and operator-may-play checks of `play_enter` on both sides and at
issue; the `reveal_results` change dropped for a rule on lockers that run during play; the daily cap counted from each
player's own completions; app lines for every refusal; a limit on pass polling; the other player's id never leaves the
server).

**What a meeting proves** (ADR-209): that the shown player's app produced a fresh code for this quest within the last
minute, and the scanning player's app read it, once. Two friends who agree to cheat can still relay a code over a
video call; the daily cap, the single use and the flags bound that. It cannot be done from a screenshot posted in a
group chat, which a fixed My QR would allow.

## The proof: a meet code, not My QR (ADR-209)

My QR (ADR-137) is a fixed signed code: shared once, it would pay its owner a meeting with everyone who has it. So a
meet quest uses its own code:

- **Short-lived and single-use.** The shown player taps "Show my code" on the meet quest's sheet. The API makes a
  128-bit random token, returns `questify/meet/v1/<token base64url>` and keeps only its SHA-256 hash, with the quest,
  the player's enrollment, the device it was shown on and `expires_at = now() + 60 s`. The first meeting that pays
  uses it up. A new code ends the player's earlier open code for that quest (at most one open per player and quest).
- The app redraws a fresh code when the old one expires or is used while the screen is open, so the player never
  sees a dead code. No secret lives on the phone and nothing works offline: meeting needs a connection on both
  phones (an event's scans already do).
- **Issuing checks the shown player first**: the quest is open for them, the switch is on, they are under the caps
  (below). So a player at their daily cap learns it before showing a code, not from the other player's screen.
- The code names its quest, so the scanner can read it anywhere: the meet quest's "Scan their code" button and the
  app's general scanner both route `questify/meet/v1/` to the meet call. The other player's quest sheet does not need
  to be open.
- **FR-212 is amended** ("scans the other's meet code", not "personal QR") and FR-306's "another player
  (meet-someone)" is removed; F-84 and F-104's notes follow. My QR is untouched.
- The token is a body field (never a URL or header); the server's request log writes method and URL only. Only
  hashes reach the database. The hash is compared by equality on a unique index (a 128-bit random value needs no
  constant-time compare: a guess is a lookup miss).

## The rules (FR-212, FR-213; ADR-210)

- **Both paid or neither.** The scanner (A) and the shown player (B) each get one completion of the quest, the
  quest's points, the quest's item on their first completion and any category bonus (through `pay_completion`, so XP,
  balance and the shop window follow as for every other payer). If either side is refused, nobody is paid.
- **Repeat pairs refused**, in either direction, per quest: one `meeting` row per unordered pair and quest (unique on
  `(quest_id, least(a, b), greatest(a, b))`). B scanning A after A scanned B answers `already_met` (FR-212's second
  case, FR-213's first). Two different meet quests in one event are two separate pairs.
- **Daily cap** (`type_config.dailyCap`, integer 1 to 50, default 5, organizer-set): the player's own completions of
  this quest with `method IN ('meet_scan', 'meet_shown')` (either side) since the start of today's event day (CTO 6:
  counted from the player's own rows, so the other player's erasure, which deletes meetings, never lowers it) (`event_day_start(ev, event_day(now(), ev))`,
  0035; the event's time zone, as T-216). A player at the cap can neither scan nor be scanned: `daily_cap` (A's own)
  or `their_daily_cap` (B's), and neither is paid (FR-213's second case).
- **The quest's repeat cap** (1 to 100) is the most meetings it pays a player overall; meet is not a refreshing type
  (`REFRESHING_QUEST_TYPES` unchanged), so `period_count` is the lifetime count. At the cap: `done` or `their_done`.
  The builder refuses `dailyCap > repeatCap` (`422 invalid_quest {field: dailyCap}`) and the database checks
  `dailyCap` 1 to 50.
- **Both must be able to play it** (CTO 4): the checks of `play_enter` (0041:201-213) for each side: the player's
  account `active` (a suspended or deleted account cannot meet), the enrollment found, the quest open for them
  (`quest_open_check`: audience, category gates and locks, times, bans) and an operator only when operators may play
  (`QP403`). A fails with its own codes; for B, every failure is one generic `not_for_them`: A never learns why (B's audience or
  ban is B's business).
- **Refused outright**: A's own code (`self`); the same device on both sides (`same_device`, both device ids present
  and equal: one phone cannot show and scan itself; client-reported, so a cheap first check, not a guard); A not
  enrolled in the code's event (`not_in_event`, with no name of B); an expired or used code (`expired`, `used`: "ask
  for a fresh code"); a code that matches nothing (`bad_code`).
- **Other ways in**: a manual award (T-207) of a meet quest pays one player, as for any quest, and counts towards the
  repeat cap (not the daily cap or a pair). `complete_quest` and the operator's My QR scan refuse a meet quest
  (`wrong_method`): its verification list is empty, like vote and survey. Removing one side's award (`remove_award`)
  reverses that player only; the pair stays used (ADR-152's rule).
- **Event switch** `meetSomeone` (`config.features.meetSomeone`, default on; FR-1009), the share pattern of 0042:398:
  `meet_on(event)`; off, meet quests are hidden from the quests tab, Home and the public quests
  (`src/quests/switched-off.ts`), passes are not issued and scans answer `403 feature_off`. Allowed in every event
  kind (a virtual event can meet over video; the organizer decides) — Q-174.
- **Older builds** do not know `meet`: they show the quest with their "update the app" line and no action (no quest
  QR, so no fallback). A meet code read by an older build's scanner is not a quest code and answers its "not a
  Questify code" line.

## Data (migration 0049; deny by default)

- `quest_type_known` gains `meet`; `quest_verification_known` puts `meet` in the "no verification" list (it already
  is by the last clause); a check `quest_meet_cap`: `type <> 'meet' OR (type_config ->> 'dailyCap') ~ '^[0-9]{1,2}$'
  AND (type_config ->> 'dailyCap')::integer BETWEEN 1 AND 50`. `quest_completion_method_check` gains `meet_scan` (A)
  and `meet_shown` (B).
- `meet_pass (id bigint identity PK, organizer_id, event_id, quest_id, enrollment_id, device_id uuid NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length = 32), created_at, expires_at, ended_at NULL)`, tenant FKs as
  `quest_completion` (RESTRICT); partial index on `(enrollment_id, quest_id) WHERE ended_at IS NULL`. `ended_at` is
  set when the pass is used or replaced; an expired pass simply stays past `expires_at`. A daily job is not needed:
  rows older than a day are deleted by the next issue for that enrollment (cheap, bounded) and by erasure and the wipe.
- `meeting (id bigint identity PK, organizer_id, event_id, quest_id, scanner_enrollment, shown_enrollment, pass_id
  UNIQUE, request_key text NOT NULL, scanner_completion bigint NOT NULL REFERENCES quest_completion ON DELETE
  CASCADE, shown_completion … ON DELETE CASCADE, created_at)`, `CHECK (scanner_enrollment <> shown_enrollment)`,
  `UNIQUE (quest_id, least(scanner_enrollment, shown_enrollment), greatest(…))` (expression index),
  `UNIQUE (scanner_enrollment, request_key)` (the replay). Tenant FKs; the cascade removes a meeting with either
  completion (the rehearsal wipe). The row is inserted **after** both payments, with both completion ids (CTO 1). The
  daily count reads `quest_completion` (its existing `(enrollment_id, quest_id)` index), so no extra index.
- Both tables: RLS enabled and forced, `REVOKE ALL … FROM PUBLIC`, **no grant to `questify_app`**, no policy; only the
  definers below read or write them (the `completion_position` pattern, 0048).
- **Reserved key**: both completions carry `idempotency_key = 'meet:' || pass.id` (CTO 1: known before anything is
  written; a pass pays at most one meeting; distinct enrollments, so one key twice is fine). `record_completion` is made again (`CREATE OR REPLACE`, the 0048 body unchanged otherwise, same
  signature and REVOKE) with `meet:%` added to its reserved prefixes, so no player's own key can collide with it and
  break a later meeting (the database's check is the only one today; the API passes the header through).
- `pay_completion` (latest 0047:292) is dropped and made again with an 8th parameter `device uuid DEFAULT NULL`
  written to `quest_completion.device_id` (body otherwise unchanged; REVOKE repeated). Every existing caller passes 7
  arguments and keeps working; a DB test calls each (submission approval, quiz, passport) after the migration.

## Functions (each `REVOKE ALL … FROM PUBLIC`; entry points granted to `questify_app`; each ≤100 lines)

- `meet_on(event uuid)` (internal): the switch.
- `meet_caps(enrolled enrollment, quest_row quest) RETURNS text` (internal): `'done'`, `'daily_cap'` or NULL; reads
  `period_count` and the player's own `meet_scan`/`meet_shown` completions today. Called under the enrollment lock by
  the payer, under the issuer's own lock by the issuer (an early answer only; the payer decides).
- `meet_may_play(enrolled enrollment, quest_row quest) RETURNS void` (internal): `play_enter`'s checks without its
  lock: the account `active`, `quest_open_check`, the operator-may-play rule (`QP403`). Used for A, for B (any error
  mapped to `not_for_them`) and by the issuer.
- `issue_meet_pass(target uuid, token_hash bytea, device uuid) RETURNS TABLE (pass_id bigint, expires_at
  timestamptz)` (definer, granted): `app_player_id()`; the quest is `meet`, the switch on; `ensure_rehearsal_wiped`;
  the caller's enrollment `FOR NO KEY UPDATE`; `meet_may_play`; `meet_caps` (`QD409 done` / `QM409 daily_cap`);
  then ends the caller's open passes for this quest, deletes their passes older than a day, inserts the new one.
  Errors: `QC404` unknown quest, `QF403 meet_off`, the existing quest-open codes.
- `meet_pass_state(pass bigint) RETURNS TABLE (state text, username text, avatar text, points bigint)` (definer,
  granted, STABLE): only the pass's own player (else no row). `open`, `expired`, or `used` with the scanner's username,
  avatar and the points B got, for B's screen. Nothing else about A.
- `meet_player(token_hash bytea, request_key text, device uuid, reading jsonb DEFAULT NULL) RETURNS TABLE
  (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean, quest_id
  uuid, other_completion bigint, other_player uuid, other_username text, other_avatar text)` (definer, granted;
  `other_player` is for the API's ranking update only and is never sent to A, CTO 9). In order:
  1. `app_player_id()`; the pass by hash (no lock) else `QM422 bad_code`; the quest and its event; the switch.
  2. A's enrollment in that event (no lock) else `QM403 not_in_event`. A fast replay path: a meeting with
     `(scanner_enrollment, request_key)` answers it (`replayed = true`) when its pass is this one, `QK422` otherwise.
  3. Early refusals with no lock: `self`, `same_device`, `expired` (`expires_at <= now()`).
  4. `ensure_rehearsal_wiped(event)`, then **the locks (below)**, then everything re-read under them, **the replay
     first** (CTO 2, as `record_completion` does at 0048:253-266): a duplicate request that waited on the first one's
     locks finds its meeting and answers it as a replay, never `used`. Then the pass (`expired`, `used`),
     `meet_may_play` for A (its own codes) and for B (`not_for_them`), the pair (`already_met`), `meet_caps` for A
     (`done`, `daily_cap`) and B (`their_done`, `their_daily_cap`).
  5. `pay_meeting`: `lock_quest_items(quest)` explicitly, then both device advisory keys in ascending key order (below),
     then pay the lower enrollment id first, then the other, each through `pay_completion(enrolled, quest, points,
     'meet_scan' | 'meet_shown', 'meet:' || pass.id, NULL, NULL, device)` with A's request device for A and the pass's
     device for B; `keep_position(A's completion, A, reading)` (T-303b: a usable reading is kept as rounded distances; a
     bad or absent one stores nothing, never refuses); then insert the meeting with both completion ids (CTO 1); end
     the pass.
  6. Answer A's completion, A's score and balance, B's username and avatar; B's player id and completion go to the API
     for the ranking update only.
  Refusals are `QM422` (code: `bad_code`, `expired`, `used`, `self`, `same_device`), `QM409` (`already_met`,
  `daily_cap`, `their_daily_cap`, `done`, `their_done`), `QM403` (`not_in_event`, `not_for_them`), DETAIL the reason.
  The steps are split into `meet_pass_for(hash)`, `meet_refusal(...)` and `pay_meeting(...)` to stay under 100 lines.

## Locks: a deadlock-free order with two enrollments (ADR-211)

Every payer today locks **one** enrollment, then (0047) the quest's and category's items in id order
(`lock_quest_items`), then the redemption rows (`give_item`); the completion insert's trigger takes the
`device:<event>:<device>` advisory lock (0031) after those. The meet payer keeps that order and adds one rule:

1. `event_rehearsal FOR SHARE` (`ensure_rehearsal_wiped`), as every payer: the wipe, which takes it `FOR UPDATE`
   first and then the rehearsal enrollments in id order, can never hold an enrollment the meet needs while waiting
   for it.
2. **Both enrollments in one statement, in id order**: `SELECT … FROM enrollment WHERE id IN (a, b) ORDER BY id FOR
   NO KEY UPDATE`. Two meets sharing a player (A–B and B–C), and B's own scan meanwhile, all take enrollments in
   ascending id, so no cycle.
3. The pass row `FOR UPDATE` (only ever locked after its owner's enrollment: `issue_meet_pass` takes B's enrollment
   before touching B's passes, so issue and scan agree).
4. `lock_quest_items(quest)`, called explicitly by `pay_meeting` (the two `pay_completion` calls re-lock rows already
   held).
5. **Both device advisory locks, before any insert** (CTO 3): the keys `hashtextextended('device:' || event || ':' ||
   device, 0)` of A's request device and B's pass device (the NULLs skipped, one key when equal), taken in ascending
   key order. The completion trigger (0031) takes the same key again later, which is re-entrant. Without this, two
   meets sharing two phones (A on phone X scans B shown on Y, while C on Y scans D shown on X) would each hold one
   device key and wait for the other. A single payer takes one device key after its items, so it never holds a device
   key while waiting for a second.
6. Inside the inserts: XP's ledger trigger, `give_item`'s redemption rows, the category bonus.

**The rule** (written into ARCHITECTURE.md's lock order and `rules.md`): a function that runs **during play** and
locks more than one enrollment takes them all in one statement, in id order, before any item, redemption or advisory
lock, and takes more than one device key only in ascending key order. Lockers that run only after play ends
(`reveal_results`, 0034:864, rank order; `confirm_results`, 0041:1043, quiz-attempt order) are left as they are (CTO
5): a meet refuses a closed quest, so they never overlap play's lockers in a way that matters, and changing them buys
nothing.

The API takes no advisory lock for a meet beyond the non-waiting `pg_try_advisory_xact_lock` of the rate limiter
(`auth/throttle.ts`), which never waits, so it cannot join a cycle. A DB test runs A–B and B–A at once, and A–B with
B–C at once, and two meets sharing two phones crosswise (two connections, barrier), 50 rounds each: no deadlock
error, exactly the right payments.

## Collusion and the flags (ADR-211)

- The scanner's side (`meet_scan`) is A's own action and counts like a scan: `raise_completion_flags` sees its
  device (shared device), counts it in the burst, and A's optional reading feeds T-303b's far-from-venue flag through
  `keep_position` (the API sends A's last fix with the scan, leniently, exactly as for a QR scan). Meet quests have
  no place (not a spot type), so the speed flag never reads them.
- The shown side (`meet_shown`) carries the device that showed the code: the shared-device detector sees it (two
  accounts showing codes from one phone are flagged), but it is **left out of the burst count**: B did not act at
  that moment, and a popular player shown 10 times in 5 minutes is not a script. `raise_completion_flags` is made
  again (`CREATE OR REPLACE`, the 0048 body) with `AND c.method <> 'meet_shown'` in the burst query and an early
  skip of the burst block when `NEW.method = 'meet_shown'`.
- **No pair distance.** Comparing A's and B's positions would need B's coordinates kept until the scan, which
  ADR-206 rules out. B's position is not sent at all (Q-175).
- No new flag kind: the single use, the minute's life, the pair rule and the daily cap bound what two colluding
  players earn (at most `dailyCap` meetings a day each), and the organizer sees meet scans in the burst and device
  cases with their method label. A "ring" detector (a small group meeting only each other) waits for real data.
- `flag_detail` needs no change (its completion lines show the method; the Flags page labels the two new methods).

## API (API.md)

- `POST /v1/quests/{id}/meet-pass` (player; no Idempotency-Key: issuing twice just ends the first) → `201 {code,
  passId, expiresAt}`; `403 quest_not_open`, `403 feature_off`, `409 already_completed`, `409 meet_refused {reason:
  daily_cap}`. Limit: 30 per player per 10 minutes (`429 too_many_attempts`).
- `GET /v1/meet-passes/{passId}` → `{state: open | expired | used, met?: {username, avatar, points}}`; another
  player's pass is `404`. The app polls it every 2 s while the code is on screen (at most 60 s per code). Limit (CTO
  8): 60 reads per player per minute (`429 too_many_attempts`; the app then slows to every 5 s).
- `POST /v1/meet` (player; Idempotency-Key required) body `{code, position?}` → `200` as a completion (`completionId,
  points, occurrence, score, balance, replayed, rank, bonus`) plus `questId` and `met: {username, avatar}` (never B's
  player id or completion id, CTO 9). Refusals:
  `422 meet_refused {reason: bad_code | expired | used | self | same_device}`, `409 meet_refused {reason:
  already_met | daily_cap | their_daily_cap | done | their_done}`, `403 meet_refused {reason: not_in_event |
  not_for_them}`, `403 feature_off`. `position` lenient (dropped when malformed, T-303b). Refused meets have their own
  limit: 20 per scanner per 10 minutes (`429`); a token is never echoed in an error or log.
- After a paying meet the API calls `ranking.afterCompletion` for **both** players (A's place is in the answer; B's
  cache entry and today's ranking move too) and the T-216 day board for both.
- The `meetSomeone` event switch: `PUT /v1/events/{id}/meet-someone` (owner and editors, the share switch's route
  shape), composed into the event config.
- Builder: `type: meet` with `config: {dailyCap}`; no place, no verification.

## App

- The meet quest's sheet: title, points, "Met N of M" and "N today (cap D)", two buttons: **Show my code** and **Scan
  their code**. Show: full-screen QR with a one-minute ring, the brightness raised while shown, a fresh code when it
  runs out, polling `state`; on `used`, the celebration "You met @A · +50" for B. Scan: the existing scanner, then
  the celebration with B's avatar and name for A. A line for every refusal (CTO 7; drafts, Arabic checked with
  `ux-araby` in the build; "meet code" is رمز التعارف throughout):

  | Reason | English | Arabic |
  |---|---|---|
  | `already_met` | You already met @{name} on this quest. | سبق أن التقيت ‎@{name} في هذه المهمة. |
  | `daily_cap` | You've met {count} people today. You can meet more tomorrow. | التقيت {count} أشخاص اليوم. يمكنك لقاء المزيد غدًا. |
  | `their_daily_cap` | They've reached today's limit. Try again tomorrow. | بلغ هذا اللاعب حد اليوم. حاولا مجددًا غدًا. |
  | `done` | You've reached this quest's limit. | وصلت إلى الحد الأقصى لهذه المهمة. |
  | `their_done` | They've reached this quest's limit. | وصل هذا اللاعب إلى الحد الأقصى لهذه المهمة. |
  | `expired`, `used` | This code has ended. Ask for a fresh one. | انتهى هذا الرمز. اطلب رمزًا جديدًا. |
  | `self` | That's your own code. Scan another player's code. | هذا رمزك. امسح رمز لاعب آخر. |
  | `same_device` | You can't scan a code shown on this phone. Scan it from the other player's phone. | لا يمكنك مسح رمز معروض على هذا الجوال. امسحه من جوال اللاعب الآخر. |
  | `not_in_event` | This code is for an event you haven't joined. | هذا الرمز لفعالية لم تنضم إليها. |
  | `not_for_them` | This quest isn't open for them. | هذه المهمة غير متاحة لهذا اللاعب. |
  | `bad_code` | This isn't a Questify meet code. | هذا ليس رمز تعارف من Questify. |

  `{count}` uses Western digits and the plural rules of `messages.ts` (Arabic 1, 2, 3–10, 11+ forms).
- The general scanner routes `questify/meet/v1/` codes to `POST /v1/meet`.
- Strings in `messages.ts` (Arabic via `ux-araby`), RTL checked, Western digits. No new native module and no new
  permission (the camera is already granted for the scanner): no new EAS build is needed beyond the current one.

## Dashboard

- Quest builder: the `meet` type with "Daily cap per player" (1 to 50) beside the repeat cap ("most people a player
  can meet for points"), and a note: "Each player shows a one-minute code from their app; screenshots stop working."
- Event features: the meet-someone switch (FR-1009). Flags page: method labels "Meet (scanned)" and "Meet (shown)".
  Arabic and English, RTL.

## Erasure and rehearsal

- `erase_rows` (latest 0048:685, `CREATE OR REPLACE`): deletes the player's `meet_pass` rows and every `meeting` row
  with the player on either side (who met whom is personal data of both; the other player's completion and points
  stay, keyed `meet:<pass id>`, and still count towards their daily and repeat caps).
- `wipe_rehearsal` (latest 0047:1155, `CREATE OR REPLACE`): deletes the event's `meet_pass` rows; meetings go with
  their completions (cascade). Its JSON is unchanged.
- Older than the event: Q-075's retention covers both tables (written into Q-175).

## Tests (test first)

- **Database** (`meet.int.test.ts`): A scans B, both paid once with the quest's points, items and category bonus
  (FR-212 first case); B then scans A: `already_met`, nothing paid (FR-212 second case, FR-213 first, also on another
  event day); the daily cap stops A (`daily_cap`) and stops a scan of a capped B (`their_daily_cap`), neither paid,
  and the next event day pays again (time zone edge); the repeat cap on either side; `self`, `same_device`,
  `expired` (61 s), `used`, `bad_code`, `not_in_event`, `not_for_them` (B outside the audience, B banned, B left, B's
  category locked); a suspended account or an operator when operators may not play, on either side and at issue (A:
  its own code, B: `not_for_them`, issue: refused) (CTO 4); the daily cap still holds for A after B's account is
  erased (CTO 6); the switch off refuses issue and scan; a replay with the same key answers the first meeting and
  pays nothing; the same key on another pass is `QK422`; a new pass ends the old one; issuing refuses a capped
  player; `meet_pass_state` shows only the owner's pass and A's name only once used; a manual award of a meet quest
  pays one side and counts towards the repeat cap; `complete_quest` and the operator scan refuse a meet quest;
  `remove_award` of one side keeps the pair used; `pay_completion`'s callers still pay (7 arguments); a player key
  `meet:1` is refused by `record_completion`; flags: A's side counts in the burst and shared device, B's side only in
  shared device; A's reading kept and far-from-venue raised; B's side keeps no position. **Races** (two connections,
  50 rounds): A–B and B–A at once (one meeting, two payments total); A–B and A–C on a cap of 1 (one pays); one pass
  scanned by C and D at once (one pays, the other `used`); the same request twice at once, the second waiting on the
  first's locks (one meeting, the second answers `replayed`, never `used`) (CTO 2); A–B with B–C (no deadlock); A on
  phone X scanning B shown on Y while C on Y scans D shown on X (no deadlock) (CTO 3); a meet beside a single QR scan
  on the same phone (no deadlock). Erasure deletes both tables' rows for the player; the rehearsal wipe removes them.
- **Security**: the outsider suite lists `meet_pass` and `meeting` (no SELECT, INSERT, UPDATE, DELETE for `PUBLIC`
  or `questify_app`) and the new functions (only `issue_meet_pass`, `meet_pass_state`, `meet_player` executable, and
  only by the API role; `meet_on`, `meet_caps`, the helpers and the new `pay_completion` signature by nobody).
  Cross-tenant: a pass of event X scanned by a player of event Y only is `not_in_event` with no name; an editor of
  event A cannot read B's meetings (no read exists); `meet_pass_state` of another player's pass returns no row.
- **Route and unit**: the code's shape and prefix parsing, the token never echoed (error answers, zod text, logged
  errors), the hash sent to the database, both rankings updated, the limits, the reason mapping, the switch route,
  the builder's `dailyCap` and `dailyCap > repeatCap`. App: the sheet, the code ring and refresh, polling stops on
  `used` or leaving, every refusal line, the scanner routing; web: the builder fields, the switch, the flag labels.
  Browser: the builder and the switch (desktop and phone). `expo export`.
- **Mutation (GitHub)**: `apps/api/src/plays/meet.ts`, `apps/api/src/plays/routes.ts`,
  `packages/shared/src/quests/meet-code.ts` (the code parser).

## Phases (CTO code review once, at the end)

1. Migration 0049 (type, checks, methods, the two tables, `pay_completion` and `record_completion` again, the meet
   functions, `raise_completion_flags` burst rule, erasure, wipe) + database tests and
   races + security suites.
2. API: the three routes, the hashing, limits, both ranking updates, the switch, the builder's type.
3. App (sheet, code screen, scanner routing), dashboard (builder, switch, flag labels), docs (API, DATA_MODEL,
   SECURITY data table, ARCHITECTURE lock order, `rules.md`, SRS FR-212 and FR-306 amended and the status of FR-212,
   FR-213, F-84 and F-104 notes, TASKS, STATE).

## Proposed decisions and questions

- **ADR-209** Meet proof: a meet quest uses its own code, not My QR: a 128-bit random token shown by the player's app
  for one minute, used by the first meeting that pays, one open per player and quest, kept only as a hash; issuing
  checks the shown player's caps first; the code names its quest so any scanner can read it. Both players are paid
  together or neither. FR-212 says "meet code" and FR-306 drops meet-someone. Q-173.
- **ADR-210** Meet rules: one meeting per unordered pair per quest; a daily cap (organizer-set, 1 to 50, default 5)
  per player per event day counts the player's own meet completions on either side; the quest's repeat cap is the
  most meetings paid; either side at a cap or unable to play the quest (account status, operator rule, audience,
  gates) means neither is paid, and the scanner is told only "not for them"; manual awards pay one side and count
  towards the repeat cap; the event switch `meetSomeone` (on by default); allowed in every event kind. Q-174.
- **ADR-211** Meet locks and collusion: a function that runs during play and locks more than one enrollment takes them
  in one id-ordered statement before items, redemptions and advisory locks, and takes several device keys only in
  ascending key order (the meet payer takes both before writing); lockers that run only after play ends are left as
  they are; the
  scanner's side counts in every flag, the shown side in shared device only (not the burst); the same device on both
  sides is refused; no pair distance and no position for the shown player (no coordinates are kept, ADR-206); no new
  flag kind until real data shows a pattern. Q-175.
