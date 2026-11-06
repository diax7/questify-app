# FOLLOWUPS batch 10 (plan note)

Tier B, migration 0167 (new and undeployed; 0156 stays reserved for T-810d). No points, sign-in or redemption locking.

| Line | Change |
|---|---|
| T-714 next page | The door holds the size to 51, the route still shows 50 and asks for one more. The answer's shape stays, so the previous release keeps working in the seconds before the new API takes over. The organizers page's loading state stays in FOLLOWUPS. |
| T-711 `set_by` | Column grant without `set_by`. `upsertOverride` stops reading `EXCLUDED.set_by`, which needs SELECT on that column. |
| T-612 replay | `desk_offer_sale` answers `expired` in the replay branch, a read only. Nothing is written, so the row keeps `offered` as DATA_MODEL says. The desk's poll already ends the wait. |
| T-503 scan | One alert per event per 15-minute window of `raised_at`; `lim` counts event windows, newest first. |
| T-710 confinement | Confirmed, no code: ADR-563 and the T-710 plan refuse a real player in the demo event, and `review-demo.int.test.ts` covers it. `staff_assignment.player_id` is NOT NULL. The sign-in half of the line stays in FOLLOWUPS. |
| T-602d held | New read `my_held_prizes`: reserved only, no price or code, no LIMIT. |
| Batch 4 NIT | Drop `event_organizer_idx`. Not an exact duplicate, see ADR-811. |
| T-612 word | `my_desk_sales` gains `currency`; the API and My QR's card read it, with the default for an event that keeps it. |
