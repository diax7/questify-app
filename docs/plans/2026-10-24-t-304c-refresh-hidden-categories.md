# T-304c — Daily and weekly refresh, hidden categories

Delivers FR-236, FR-1619 (F-51) and FR-237 (F-99). Split from T-304 (ADR-200; FR-238, the hint push, is T-501).
**Core bar**: a refresh lets quests pay again, so it changes the repeat cap every payer checks and the bonus's "once":
one Opus plan review, one Opus code review, mutation on GitHub. Migration **0046** (0042 to 0045 are undeployed but
belong to finished tasks; this task adds its own file). Depends on T-304 (gates, bonus), T-304b (the latest readers).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-204 and Q-168.

## Refresh (FR-236, FR-1619)

- `category.refresh text NOT NULL DEFAULT 'none' CHECK (refresh IN ('none', 'daily', 'weekly'))`, in the builder's
  column grants.
- **The period** (`category_period_start(cat category, ev event) RETURNS timestamptz`, STABLE, not granted):
  `none` → `-infinity`; `daily` → `event_day_start(ev, event_day(now(), ev))` (the event's day and its day-start hour,
  ADR-083, 0035); `weekly` → the start of the 7-day block counted from the event's first day
  (`event_day(ev.starts_at, ev)`), so week 1 is days 1 to 7 of the event whatever the weekday.
- **Counting inside the period** (one helper, `period_count(member, quest)`, used by every payer instead of its own
  `count(*)`): completions of the quest by the member with `created_at >= category_period_start`. Replaced from their
  latest versions: `record_completion` (0045), `pay_completion` (0044), and every other `done_count` site listed by
  `rg "INTO done_count" apps/api/migrations` (0040 submissions, 0041 plays, 0042) at their latest definitions.
  `occurrence` stays the lifetime count + 1 (the UNIQUE key), so `occurrence`'s CHECK loses its upper bound of 100
  (a daily quest over a long event passes it); `repeat_cap` stays 1 to 100, now per period.
- **Done** follows the period: `quest_done` counts only this period's completions (so `category_done`,
  `category_cleared`, `category_lock`'s in-order gate and the bonus all reset with it). The unlock-after gate reads
  the first category's current period too: a daily unlock category locks its follower again each day (Q-168).
- **The bonus once per period**: `category_bonus` gains `period_start timestamptz NOT NULL DEFAULT '-infinity'`; the
  key becomes `(enrollment_id, category_id, period_start)`; `pay_category_bonus` writes the current period. A bonus
  removed in a period is not paid again in that period (ADR-202 per period).
- **Points stay**: nothing is deleted or reversed at a reset; it is only the count that starts again (FR-1619).
  Ledger, XP (first completion only, ADR-083), removal (ADR-152) unchanged. Today's ranking unchanged.
- **Only repeatable types refresh**: a refreshing category holds only `scan_qr`, `enter_code` and `challenge` quests.
  Vote, quiz, survey, share, submission and passport are played once by design (0041, 0042, 0045); a trigger on
  `quest` (INSERT, UPDATE OF `category_id`, `type`) and on `category` (UPDATE OF `refresh`) refuses the mix with
  `QT422 refresh` under the event's lock; the builder answers `422 invalid_category {field: "refresh"}` first.
- **Changing it**: refresh can change until the event ends (the live-edit `confirm` as today). A switch changes the
  counting from then on; nothing paid is touched.

## Hidden categories (FR-237)

- `category.hidden boolean NOT NULL DEFAULT false`, `category.reveal_version integer NOT NULL DEFAULT 1` (bumped by a
  reprint), in the column grants.
- `category_reveal (organizer_id, event_id, enrollment_id, category_id, created_at)`, PK `(enrollment_id,
  category_id)`, tenant FKs RESTRICT, RLS forced, **no grant** (definers only).
- **The secret code**: `qr.ts` purpose `reveal`, format byte **0x05**, its own derived key, bound to the category
  (`revealCode`, `verifyRevealCode` → `valid | not_questify | forged | wrong_category`), the 37-byte layout, so
  `/q/{token}` and the scanner read it unchanged in shape. It never opens as any other code.
- `reveal_category(target uuid, proof_version integer)` (definer, player only): active member of a live event
  (`play_phase`), the category `hidden` and in the member's audience (else `QN403 not_for_you`), version current
  (`QV422 old`); `INSERT … ON CONFLICT DO NOTHING`; answers `{category_id, name_ar, name_en, revealed}` (`revealed`
  false when found before). Pays nothing; naturally idempotent, so no Idempotency-Key (ADR-204).
- **Seeing a category**: `sees_category(member, cat)` = `in_audience(...)` AND (`NOT hidden` OR revealed). It
  replaces the category's `in_audience` check in `member_event_quests` (0045), `quest_open_check` (0044; unrevealed
  → `QN403 not_for_you`, as an audience miss), `category_lock` (an unrevealed hidden unlock category counts as met: no
  dead end), `member_vote`, `member_quiz` (0041), `member_survey`, `member_share` (0042), `member_passport` (0045).
  `public_event_quests` (0037, the public event page) leaves hidden categories out entirely.
- Cleanup: `wipe_rehearsal` and `erase_rows` (latest, 0045) delete `category_reveal` rows.

## API (API.md)

- `POST /v1/categories/{categoryId}/reveal` `{code}` → `{categoryId, name: {ar, en}, revealed}`; `400`, `401`,
  `403 quest_not_open {reason: event_not_live | not_for_you}` / `enrollment_inactive`, `404`, `422 invalid_code
  {problem}` (forged logged, never the token), `422 not_hidden`.
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
  the same day (`QD409`), paid again after the event day turns (time moved by backdating `created_at`), points kept;
  `repeat_cap` 2 counts per day; the weekly block anchored to the event's first day; `occurrence` passes 100; the
  bonus once per period, again next period, a removed bonus not repaid in its period; in-order and unlock gates reset;
  the type mix refused both ways (`QT422`); a manual award and an operator scan follow the period; parallel
  completions in one period pay once. Hidden: unseen in every reader and the public page, `not_for_you` on play;
  reveal by code shows it to that player only; a second reveal `revealed` false; old version `QV422`; not live;
  outside the audience; a hidden unlock category never locks its follower; rehearsal wipe and erasure.
- **Security:** outsider and cross-tenant suites list `category_reveal`, `reveal_category` and the recreated readers;
  a player of event A cannot reveal a category of event B.
- **Unit:** `revealCode`/`verifyRevealCode`; the app's code reader and reset label. **Route:** the reveal route, the
  quests read's new fields, the builder's fields. Browser: the category form (desktop and phone). `expo export`.
- **Mutation (GitHub):** `apps/api/src/quests/qr.ts`, `apps/api/src/reveal/**`, `apps/api/src/quests/categories.ts`,
  `apps/api/src/quests/codes.ts`, `apps/api/src/home/home.ts`, `apps/api/src/completions/complete.ts`.

## Phases (CTO code review once, at the end)

1. Migration 0046 (refresh, then hidden) + database tests + security suites.
2. API: signer, reveal route, reads, builder, codes page.
3. App, dashboard, docs (API, DATA_MODEL, SRS status, TASKS).

## Proposed decisions and questions

- **ADR-204** Refresh counts the repeat cap, "done", the gates and the bonus inside the current period (the event's
  day, or 7-day blocks from its first day); nothing paid is touched; only scan, code and challenge quests refresh.
  Hidden categories open per player by a signed secret code (0x05) that pays nothing and needs no key; unrevealed
  ones act as outside the audience, and the public page never lists them. Q-168.
