# T-609 plan note: organizer alerts, second part, and the usage view (tier B)

**Reads:** `docs/TASKS.md` T-609 and its notes, ADR-360/363 (T-503 alerts), `docs/FOLLOWUPS.md` (the sender line), `docs/ux/DASHBOARD_AND_CONSOLE.md` §4.6.
**Boundary:** reuse T-503's switches, outbox, worker and team panel; mail transport stays OFF; no player data in alert text; `content_unpublished` stays with T-701.
Nothing touches points, sign-in or tenant isolation (the quest-item trigger fires on an `UPDATE` of `quest_item` that completions already make; it writes
`organizer_alert` rows only when a stock first runs low, as the reward trigger does).

## Migration 0104 (staging has run through 0102, 0103 is pushed)
1. `alert_claim` restated: skip the unsendable rows among the 500 oldest queued, then lease up to `size` sendable rows from anywhere in the queue.
2. `alert_on_item_low` and trigger `quest_item_alert_low`: the reward rule for quest items, type `stock_low`.
3. `usage_organizers()`, `usage_events(organizer)`: read-only admin doors, US404 otherwise, granted to the API's role alone. No table, no index.

## API, web, shared
`GET /v1/admin/usage`, `GET /v1/admin/usage/organizers/:organizerId` (console scope); `packages/shared/src/usage` schemas; page `/console/usage`
(`ConsoleUsage`, nav item, `LAYOUT_PAGES`), strings in Arabic and English; the stock alert wording names quest items.

## Tests (first)
- Old claim fails: 620 rows to skip ahead of two sendable rows, one run sends 2 (it sent 0); the twice-run workaround is gone.
- Quest item: crossing, no reopen on a total change, recovery and a new fall, zero total, removed, not live, switch off.
- Usage doors: counts per organizer and event (rehearsal and pending excluded, only `sent` alert rows), US404 for team, editor, player, system, non-admin and disabled admin seats;
  outsider holds no EXECUTE; route inventory; route unit tests; web reader tests; browser spec (English, Arabic, phone width) and the layout check.

## Decisions
ADR-394 and Q-361 Proposed. Not built: login SMS, promotional email, push volume, storage (no durable count exists), a period filter, platform totals.
