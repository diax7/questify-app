# T-603 — Live control room

FR-1024 (scan feed with each quest's completion rate), FR-1025 (flash quest, boost, announcement, live poll on one
screen), FR-1028 (live counters). Tier B: one new read, no write, nothing that changes what a quest pays or accepts.
Migration **0096** (CranL runs through 0095). Proposed ADR-385, Q-352.

## Split out: T-603b (tier A)

FR-1026 (pause a quest, skip a broken step) is **not built here**. Pausing makes `complete_quest` /
`record_completion` refuse a quest and skipping lets a player past an in-order step without a completion; both change
the completion engine and the points path. They become T-603b, tier A: plan, plan review, build, review, mutation.

## What is built

- **One page**, `/organizers/{o}/events/{e}/control`, "Control room" first in the menu's Run group. It composes the
  doors that exist: the quest list's flash and live-poll buttons and their confirmations (now one hook,
  `useQuestLiveActions`, shared with the quest builder), the Up next pin (`PUT …/focus`), the boosts manager (the
  Boosts page without its header), and the announcement composer with its confirmation (`AnnouncementSender`, sharing
  `useAnnouncementPress` with the Announcements page). An action whose event switch is off (flash quests, double
  points) is not offered. An ended event shows the numbers and no buttons.
- **One read**, `GET /v1/organizers/{o}/events/{e}/control` (owner, editor): `{counts, feed, done}`.
  - `feed`: the 30 newest completions, newest first: id, time, quest id and title, method, username, avatar. No
    contact detail, install id or points.
  - `counts`: `players` (active members), `online` (active members with a completion in the last 15 minutes: the app
    keeps no presence), `lowStock` (active rewards at or under the stock-low alert's line, migration 0082's rule),
    `inbox` (open help requests of the event's queue plus submissions waiting), `flags` (open cases).
  - `done`: players who completed each quest at least once, by quest id. The page computes the rate against `players`
    (whole percent, never over 100; 0 for a quest nobody completed).
- **Three read-only database doors** (migration 0096): `control_feed`, `control_counts`, `control_done`, definers
  guarded by `award_event_of` (AN404 for another organizer, a player, a stranger, an editor outside their event
  limit). PUBLIC holds no EXECUTE; only the API's role does. One new index, `quest_completion_event_recent_idx
  (event_id, created_at DESC, id DESC)`, serves the feed and the 15-minute count.
- **Cheap at scale (ADR-365).** The page polls every 5 seconds while the tab is shown (and once when it returns), one
  request at a time, with no stream. The feed and the counters are index reads of a few rows. `done` walks every first
  completion of the event, so the API keeps one answer per event for 30 seconds and shares it, concurrent callers
  included; it is read only after the feed has been answered for this member, so the cache never serves a caller the
  database refused. A failed poll keeps the last good view and says "Offline. Showing data from 14:02".

## Tests

DB suite `test/db/control-room.int.test.ts` (order, page bounds, each counter's rule, per-quest counts, every refusal
and the editor limit); HTTP suite `test/control/routes.int.test.ts` (shape, no contact detail, 404s, 401, the 30-second
share on a fake clock, no cache for a refused caller); outsider (grants), cross-tenant and route-map entries; web unit
tests for the parser, the rate and the method labels; browser spec `control-room.spec.ts` (counters, feed, rates, pin,
flash launch, boost, announcement confirmation, English heading, switches off).
