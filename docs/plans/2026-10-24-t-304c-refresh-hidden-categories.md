# T-304c — Daily and weekly refresh, hidden categories

Delivers FR-236, FR-1619 (F-51) and FR-237 (F-99). Split from T-304 (ADR-200; FR-238, the hint push, is T-501).
**Core bar**: a refresh lets quests pay again, so it changes the repeat cap and the bonus's "once":
one Opus plan review, one Opus code review, mutation on GitHub. Migration **0046** (0042 to 0045 are undeployed but
belong to finished tasks; this task adds its own file). Depends on T-304 (gates, bonus), T-304b (the latest readers).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-204 and Q-168.

**CTO plan review 2026-10-24: 84/100, findings folded in** (two counts in `record_completion`, the bonus guard
across a refresh switch, the bonus row's period in every writer and reader, the scoped counting sites, grants, the
reveal route's order, the manual award of a hidden quest, the added tests, the named CHECK change).

## Refresh (FR-236, FR-1619)

- `category.refresh text NOT NULL DEFAULT 'none' CHECK (refresh IN ('none', 'daily', 'weekly'))`, in the builder's
  column grants.
- **The period** (`category_period_start(cat category, ev event) RETURNS timestamptz`, STABLE,
  `REVOKE ALL … FROM PUBLIC`): `none` → `-infinity`; `daily` → `event_day_start(ev, event_day(now(), ev))` (the
  event's day and its day-start hour, ADR-083, 0035); `weekly` → the start of the 7-day block counted from the event's
  first day (`event_day(ev.starts_at, ev)`), so week 1 is days 1 to 7 of the event whatever the weekday, and a
  `starts_at` that is not on the day-start hour still opens week 1 at that day's day-start hour.
- **Counting inside the period** (`period_count(member uuid, quest_row quest) RETURNS integer`, STABLE,
  `REVOKE ALL … FROM PUBLIC`): completions of the quest by the member with `created_at >= category_period_start`.
  `created_at` defaults to `now()`, the transaction's start, and the period is computed from the same `now()`, so a
  scan whose transaction began before the day turned and committed after counts in the old period, consistently.
- **Two counts in `record_completion`** (0045:423-431 today feeds one `done_count` to both): `lifetime_count`
  (`count(*)` as today) gives `occurrence = lifetime_count + 1`, so the `UNIQUE (enrollment_id, quest_id,
  occurrence)` key (0012:49) never repeats; `period_count` is compared with `repeat_cap` (`QD409`). Both are read
  under the enrollment lock the function already takes.
- **`pay_completion` (0044:251-254) stays on the lifetime count**: it numbers the occurrence and checks no cap.
- **Other counting sites stay as they are**: vote, quiz, survey, share, submission, passport and `submit_quest`
  (0040, 0041, 0042, 0045:517) count their own played-once types, which can never sit in a refreshing category (the
  type trigger below). Only `record_completion`'s cap reads the period.
- **The occurrence CHECK**: `ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_occurrence_check`, re-added
  as `CHECK (occurrence >= 1)` (a daily quest over a long event passes 100). `repeat_cap` stays 1 to 100, now per
  period.
- **Done** follows the period: `quest_done` counts only this period's completions (so `category_done`,
  `category_cleared`, `category_lock`'s in-order gate and the bonus all reset with it). The unlock-after gate reads
  the first category's current period too: a daily unlock category locks its follower again each day (Q-168).
  `earned` (points from the category) stays lifetime.
- **The bonus once per period**: `category_bonus` gains `period_start timestamptz NOT NULL DEFAULT '-infinity'`; the
  key becomes `(enrollment_id, category_id, period_start)`; `pay_category_bonus` writes the current period and pays
  only when **no row exists with `period_start >=` the current period's start**. That guard closes a switch from
  daily to none: the period becomes `-infinity`, the earlier daily rows (later `period_start`) block it, so the bonus
  is not paid again on a lifetime count. A switch from none to daily pays once in the new period (ADR-204). A bonus
  removed in a period is not paid again in that period (ADR-202 per period).
- **The bonus row's period everywhere it is read or written**: `pay_category_bonus`'s `UPDATE category_bonus SET
  entry_id` (0044:236) adds `AND b.period_start = <current period>`; `own_category_bonus` (0044:442) and
  `member_event_quests`'s `bonus.settled` EXISTS (0045:328) filter on the current period.
- **Points stay**: nothing is deleted or reversed at a reset; it is only the count that starts again (FR-1619).
  Ledger, XP (first completion only, ADR-083), removal (ADR-152) unchanged. Today's ranking unchanged.
- **Only repeatable types refresh**: a refreshing category holds only `scan_qr`, `enter_code` and `challenge` quests.
  Vote, quiz, survey, share, submission and passport are played once by design (0041, 0042, 0045); a trigger on
  `quest` (INSERT, UPDATE OF `category_id`, `type`) and on `category` (UPDATE OF `refresh`) refuses the mix with
  `QT422 refresh` under the event's lock; the builder answers `422 invalid_category {field: "refresh"}` first.
- **Changing it**: refresh can change until the event ends (the live-edit `confirm` as today). A switch changes the
  counting from then on; nothing paid is touched. None → daily: earlier completions sit before today's start, so the
  cap and "done" start fresh today. Daily → none: the cap counts the lifetime, so a capped quest stays capped.

## Hidden categories (FR-237)

- `category.hidden boolean NOT NULL DEFAULT false`, `category.reveal_version integer NOT NULL DEFAULT 1` (bumped by a
  reprint), in the column grants.
- `category_reveal (organizer_id, event_id, enrollment_id, category_id, created_at)`, PK `(enrollment_id,
  category_id)`, tenant FKs RESTRICT, RLS enabled and forced, `REVOKE ALL … FROM PUBLIC`, **no grant** (definers only),
  as `category_bonus` (0044:99-101).
- **The secret code**: `qr.ts` purpose `reveal`, format byte **0x05**, its own derived key, bound to the category
  (`revealCode`, `verifyRevealCode` → `valid | not_questify | forged | wrong_category`), the 37-byte layout, so
  `/q/{token}` and the scanner read it unchanged in shape. It never opens as any other code. The web `/q/{token}` page
  stays unchanged for a 0x05 code: it reads and calls nothing and shows only the scan-in-the-app message
  (`scan.title`, `scan.body`), never the category's name or event.
- `reveal_category(target uuid, proof_version integer)` (definer, player only): active member of a live event
  (`play_phase`), the category `hidden` and in the member's audience (else `QN403 not_for_you`), version current
  (`QV422 old`); `INSERT … ON CONFLICT DO NOTHING`; answers `{category_id, name_ar, name_en, revealed}` (`revealed`
  false when found before). Pays nothing; naturally idempotent, so no Idempotency-Key (ADR-204).
- **Seeing a category**: `sees_category(member uuid, cat category) RETURNS boolean` (STABLE, `REVOKE ALL … FROM
  PUBLIC`) = `in_audience(...)` AND (`NOT hidden` OR revealed). It replaces the category's `in_audience` check in
  `member_event_quests` (0045), `quest_open_check` (0044; unrevealed → `QN403 not_for_you`, as an audience miss),
  `category_lock` (an unrevealed hidden unlock category counts as met: no dead end), `member_vote`, `member_quiz`
  (0041), `member_survey`, `member_share` (0042), `member_passport` (0045). `public_event_quests` (0037, the public
  event page) leaves hidden categories out entirely.
- **Manual award of a hidden quest** (ADR-204, Q-168): `quest_open_check` with `skip_category` (an owner's or
  editor's manual award) still checks the audience but skips the reveal, and the award writes the player's
  `category_reveal` row in the same transaction (`ON CONFLICT DO NOTHING`), so the player sees what they were paid
  for. An operator scan does not skip it (`not_for_you`).
- Cleanup: `wipe_rehearsal` and `erase_rows` (latest, 0045) delete `category_reveal` rows; the wipe's JSON counts
  them (`reveals`).

## API (API.md)

- `POST /v1/categories/{categoryId}/reveal` `{code}` → `{categoryId, name: {ar, en}, revealed}`. **Order**: body
  shape (`400`), auth (`401`), then the code is verified (HMAC, then its category binding against the path id:
  `wrong_category` when they differ) **before any database read**, so `404`, `422 not_hidden` and `403` are only ever
  answered to a holder of that category's valid code and never confirm that a category id exists. Then `403
  quest_not_open {reason: event_not_live | not_for_you}` / `enrollment_inactive`, `404`, `422 not_hidden`, `422
  invalid_code {problem}` (forged logged, never the token).
- `GET /v1/events/{id}/quests`: each category gains `refresh: none | daily | weekly` and `resetsAt` (the next period
  start, null for none); `done` and `bonus.settled` are this period's; `earned` stays lifetime.
- Builder: category `refresh`, `hidden`; the codes page lists a secret code per hidden category, regenerated on its
  own (`reveal_version + 1`).

## App and dashboard

- **App:** the scanner reads 0x05 and posts to the reveal route; the sheet says the category was found and the quest
  list reloads. Category header notes "Resets daily" / "Resets weekly" with the time left. Strings in `messages.ts`
  (Arabic via `ux-araby`), RTL checked, Western digits.
- **Dashboard:** the category form's refresh select and hidden toggle (with a note that only scan, code and
  challenge quests refresh); the card's notes; the codes page's secret code.

## Tests (test first)

- **Database** (`categories-refresh.int.test.ts`, `categories-hidden.int.test.ts`): a daily quest completed, refused
  the same day (`QD409`), paid again after the event day turns (time moved by backdating `created_at`), points kept,
  `occurrence` keeps rising (no UNIQUE clash); `repeat_cap` 2 counts per day; the weekly block anchored to the event's
  first day, also when `starts_at` is not on the day-start hour; `occurrence` passes 100; a completion whose
  `created_at` is just before the day-start counts in the old period; the bonus once per period, again next period, a
  removed bonus not repaid in its period, the earlier period's row untouched by the next payment's `entry_id` update;
  switches: daily → none (bonus not repaid with `repeat_cap` > 1, capped quest stays capped), none → daily (cap and
  bonus fresh in the new period); `done` resets while `earned` stays lifetime; in-order and unlock gates reset; the
  type mix refused both ways (`QT422`); a manual award and an operator scan follow the period; parallel completions
  in one period pay once. Hidden: unseen in every reader and the public page, `not_for_you` on play; reveal by code
  shows it to that player only; a second reveal `revealed` false; old version `QV422`; not live; outside the
  audience; a hidden unlock category never locks its follower; a manual award of an unrevealed hidden quest pays and
  reveals, an operator scan of it is refused; rehearsal wipe (its JSON counts reveals) and erasure.
- **Security:** outsider and cross-tenant suites list `category_reveal`, `reveal_category`, `category_period_start`,
  `period_count`, `sees_category` and the recreated readers; a player of event A cannot reveal a category of event B.
- **Unit:** `revealCode`/`verifyRevealCode` (incl. `wrong_category`); the app's code reader and reset label. **Route:**
  the reveal route (a wrong-category code answers `422 invalid_code` with no database read; an unknown id with a code
  for another category never answers `404`), the quests read's new fields, the builder's fields, `/q/{token}` for a
  0x05 code (shape only, no category text). Browser: the category form (desktop and phone). `expo export`.
- **Mutation (GitHub):** `apps/api/src/quests/qr.ts`, `apps/api/src/reveal/**`, `apps/api/src/quests/categories.ts`,
  `apps/api/src/quests/codes.ts`, `apps/api/src/home/home.ts`, `apps/api/src/completions/complete.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0046 (refresh, then hidden) + database tests + security suites.
2. API: signer, reveal route, reads, builder, codes page.
3. App, dashboard, docs (API, DATA_MODEL, SRS status, TASKS).

## Proposed decisions and questions

- **ADR-204** Refresh counts the repeat cap, "done", the gates and the bonus inside the current period (the event's
  day, or 7-day blocks from its first day); the occurrence number stays lifetime; nothing paid is touched; only scan,
  code and challenge quests refresh; a bonus is not paid while any row of the current or a later period exists, so a
  switch to none never repays it. Hidden categories open per player by a signed secret code (0x05) that pays nothing
  and needs no key; unrevealed ones act as outside the audience, the public page never lists them, and a staff manual
  award passes the reveal and reveals the category to that player. Q-168.
