# FOLLOWUPS batch 14 (plan note)

Tier B, migration 0168 (new and undeployed; 0156 stays reserved for T-810d; 0167 is on staging and frozen). No sign-in, tenant
rule or redemption lock changes. `session_check_in` writes a ledger row and is restated: only its `who` line changes.

| Line | Change |
|---|---|
| T-710 numbers | `console_numbers()` leaves out the organizer in `review_demo`, its events (so the live figures too) and the accounts in `review_demo_player`. Staff counts stay. |
| T-505 limit | `session_message`'s 3 an hour and 10 a day add the event's `scheduled` or `sent` announcements with a send time inside the window. One due later does not count. One way only: `announcement_send` is not restated (ADR-813, Q-743). |
| T-615 door | `who` gains `fullName` through `staff_full_name`; the door's result cover shows it above the username, as the station scan. The rest of the line stays. |
| T-612 expired offers | No code. Batch 10 took the line's second option (a replay answers `expired`), and every reader goes by `desk_sale_live` or `offer_until`, so a row left `offered` after its time is the design in DATA_MODEL. |
| T-709d `own_level` | Read only: a level counts as the scan's when `reached_at = xp_entry.created_at`, both `now()` of the writing transaction. A later catch-up differs. The item id pre-check stays in FOLLOWUPS. |
| Batch 13 review | `inviteCancel` says withdrawn in both languages; `revertibleIds` reads `before` only for amounts; a real-database test of `previous`; the empty assertion is gone. The two device checks stay. |
