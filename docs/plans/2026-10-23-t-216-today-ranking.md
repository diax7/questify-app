# T-216 — Today's ranking for multi-day events

Delivers FR-608, FR-610, FR-1611 (and FR-1715's ranking part). Standard bar: no ledger, score or trigger change (today's
points are read from the append-only ledger), so no plan review; one Sonnet code review. Migration **0035**. Depends on
T-106 (ranking, Redis copy, repair path) and T-102 (`day_start_hour`, `event_day`).

Dhia is away: the open choices are my recommendation, written as **Proposed** ADR-166 and Q-132.

## Rules (ADR-166)

- **Multi-day:** the event's start and end fall on different event days (FR-1714's day start; an end exactly at the
  day start belongs to the day before).
- **Today's points:** the sum of the enrollment's `score_delta` in ledger entries created inside the current event day
  (awards, removals and rank-lowering spends of that day count, as they do overall). The tie rule is the overall one:
  the ledger id that last changed today's points, lowest first.
- **Who is ranked:** the overall rule (`ranked_enrollments`: banned, removed, excluded, the team and operators out),
  and today's points above 0.
- **Available** when the event is multi-day, live now, the `ranking` feature is on and the new `rankingToday` feature
  is on. `rankingToday` is on unless the owner turns it off (FR-608); turning the ranking off hides both.
- **Reset:** the day is part of the copy's key, so a new event day starts from an empty board; nothing is deleted
  (yesterday's copy expires with Redis's 30-day lifetime).

## Data (migration 0035)

No table. Internal helpers (not executable by the API role): `event_day_start(ev, day)`, `event_multi_day(ev)`,
`ranked_day(event, day)`. Definers, revoked from PUBLIC and granted to the API role:
- `ranking_today(event)` → `day, multi_day, live, my_score` for the system or an active player of the event (no row
  for anyone else; `my_score` is the reader's own points today, NULL for the system).
- `ranking_day_entries(event, day)` (system only, like `ranking_entries`) for rebuilds.
- `ranking_day_entry_of(completion)` (the caller's own completion, multi-day events only) for the after-scan write.
- `ranking_day_top(event, size)` and `ranking_day_position(event)`: the PostgreSQL fallback, same shape as overall.

## API

- `GET /v1/events/{id}/ranking` gains `today: boolean` (today's ranking is available). `?scope=today` answers the
  same shape for today's points; 404 `today_ranking_off` when it is not available; `?scope=` anything else is 400.
- `PUT /v1/organizers/{org}/events/{id}/ranking-today` `{ enabled }` → `{ rankingToday }`, owner only (as FR-607's).
  The event read gains `rankingToday`.
- Redis: the day copy is the same store under the key `{event}/{day}`. A completion writes both copies; a repair or
  the backstop rebuilds today's copy with the overall one when the event is multi-day.

## Web and app

- Dashboard: a second box in the ranking card, "Show today's ranking" (owner), with a hint that it applies to events
  longer than one event day.
- App: the ranking screen shows "Whole event / Today" tabs when `today` is true; Today reads `?scope=today`; a
  `today_ranking_off` answer falls back to the whole event.

## Tests

- DB: today's points from today's entries only (yesterday's entry left out), the day start hour moves an entry into
  the day before, the tie rule, exclusions, a single-day event has no day entry, a stranger gets no row, system-only
  entries. Outsider: no grant on the new functions for anon; cross-tenant: another event's player gets nothing.
- Routes: `?scope=today` (yesterday 200 + today 50 → 50), single-day 404, the switch, bad scope 400, `today` flag,
  Redis down falls back to PostgreSQL with the same answer, the owner-only switch route.
- App: `readRanking` with `today`, `rankingAnswer` for `today_ranking_off`.
