# T-307b: the live finale (plan note)

Tier B: it reads `event_result` and `result_place` and never writes them. It does not touch points, the ledger, `confirm_results`,
`reveal_results` or prize handover; the owner's existing Results page still confirms and reveals. Delivers FR-254, FR-255, FR-1621
and the app half of FR-407. Migration **0084** (CranL runs through 0083, frozen). Choices are **ADR-369 / Q-337 (Proposed)**.

## Shape (the T-307 plan's last section, with the changes below)
- `finale (event_id PK, organizer_id, starts_at, goal_id → community_goal | null, updated_at, updated_by)`: closed table, no grant.
  Written only by `set_finale` / `clear_finale` (owner; audited `finale.update`, `finale.clear`; ids and time only).
- The finale is **not** one of the three pickable scenes: a set finale joins the running list as its last scene
  (`big_screen_running`), and from `starts_at`, and for good once the event has ended, it takes the whole screen (list `['finale']`).
  `big_screen.scenes` and the dashboard's scene list are unchanged (the CHECK keeps three scenes).
- `screen_finale()`: the screen's own door (no argument; device kind `screen`). Phase now: `countdown` (before `starts_at`, the goal
  not yet named), `push` (from `starts_at` while a goal is attached and the event's community switch is on; the goal as the community
  scene shows it, cached `progress`, no reward), `waiting` (no goal), `reveal` (only once `event_result.revealed_at` is set: the top
  ten of `result_place` as place, username and avatar, never a score). Before the reveal no place is ever read.
- Confirming needs the event ended (ADR-163, Q-127 left as it is): the screen stays open after the end for the finale only
  (`device_view` is not `event_ended` while a finale exists), and the device's own 24 hours after the end bound it.
- Dashboard: a Finale section on the Big screen page (time in the event's zone, the goal picked from the event's goals, Clear), with the
  results state and a link to the Results page; it says "confirm first" while the state is not `confirmed` or `revealed` (FR-520).
- App: Home's read gains `finale: {revealed, place}`; once, per event, a full-screen "The winners are in" celebration shows on Home
  after the reveal (a key in the phone's store). It is not live: the reveal's push is T-501's.

## Tests
`test/db/finale.int.test.ts` (phases, takeover, reveal data, every refusal, other tenant), outsider and cross-tenant lists, route tests,
web units, `finale.spec.ts` (set, countdown, push, reveal through the Results page), app units. Full suite once.
Mutation: none (not tier A).
