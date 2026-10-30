# Follow-ups

MINOR and NIT review findings, and small leftovers, that are not worth a fix on their own (ADR-355). A cheap Sonnet
worker clears this list in one batch about every five tasks, then deletes the lines it finished. A BLOCKER or MAJOR
never waits here, and a line that grows into real work becomes a task in `docs/TASKS.md`.

Format: `- <date> <task>: <what and where> (<source>)`

- 2026-10-29 T-502: send failures in `apps/web/src/components/AnnouncementsPanel.tsx` render the alert behind the open confirmation modal; announce/render failures inside the modal for assistive technology. Deferred MINOR under ADR-355 (independent tier B review 84); not part of the two MAJOR fixes.

- 2026-10-28 T-411: `community.int`'s open-transaction settle check is load-sensitive (it reads `pg_stat_activity`) and failed once in a parallel full run; fix or quarantine it (T-501d review).
- 2026-10-28 T-501: a row held between in-lease tries returns `answered: false` even after a 500 was written, while running out of tries returns `true`; it only shifts the mass-invalid guard's denominator slightly (T-501 survivor chase).
- 2026-10-28 T-501: `apps/api/src/push/doors.ts` (60.5%) and `round.ts` (80.6%) were left under the 90% mutation bar; push code is outside the mutation scope of ADR-355, so this is accepted unless a bug shows up there.
- 2026-10-28 T-501b: 22 equivalent mutants in `h2.ts` and 13 in `apns.ts`/`fcm.ts` are listed in their test-file notes; no action unless the transport changes.
- 2026-10-28 T-501f: the streak scan rereads all of yesterday's streak rows every minute from 18:00 to 24:00 even after everyone is reminded (560 ms a call at 50k players, about 100k crosses the 1 s gate): keep a cursor per day or stop once a pass finds nothing (T-501f review).
- 2026-10-28 T-501f: the shop-closing text "open until {date}" shows only the date, so a close at 00:00 local reads as a day later; show the time as well (T-501f review).
- 2026-10-28 T-501f: the personal fan-out skips the per-kind audience rule, so a streak or invitation center row is still written if the player played or joined in the second between scan and fan-out; harmless (T-501f review).
- 2026-10-28 T-501g: the hint note renders at the top of the page (`QuestBuilder.tsx:~296`), far from the "Send a hint" button on a long builder; render it inside the category card or scroll it into view (T-501g review).
- 2026-10-28 T-501g: "Send a hint" has no category name in its accessible name (same as the existing "Edit category" buttons); fix both together (T-501g review).
- 2026-10-28 T-501g: the claim skip code for a category un-hidden before the claim is `not_member`, which is misleading; give it its own code (T-501g review).
- 2026-10-30 T-503: **before mail transport goes on** — `organizer-alerts/worker.ts` `sendRounds` breaks when a claim picks only skippable rows, so a backlog of ex-member rows throttles sending to 5 rows a minute; the claim door should report rows picked or loop until it leases one (T-503 review).
- 2026-10-30 T-503: **before mail transport goes on** — 0082 `alert_scan_flags` sends one alert per flag per member and `ORDER BY id LIMIT 2000` starves the newest flags in a storm; coalesce per event per window, newest first (T-503 review).
- 2026-10-30 T-503: 0082 `ranking_on` restates `composeFeatures` in SQL; add a parity test so the two cannot drift (T-503 review).
- 2026-10-30 T-503: `OrganizerAlertSwitchesPanel.tsx` keeps "Loading…" under a failed GET with no retry; `disabled={busy}` drops keyboard focus on each toggle, so use `aria-busy` (T-503 review).
- 2026-10-30 T-503: `rank_push_diff` reads `erased` before `fresh`, so a wipe committing between them diffs a pre-wipe snapshot; read it after (T-503 review, harmless today).
- 2026-10-30 T-503: a poison event hitting the 5 s timeout stays first in `rank_push_events` (`taken_at NULLS FIRST`); bump `taken_at` on failure (T-503 review).
- 2026-10-30 T-503: skip exit notices for a player excluded after the fact (`NOT ranking_eligible`); the cooldown test does not check the per-event part of the key; the `isAlertType`/`unknown_type` branch in `worker.ts` is unreachable (T-503 review).
- 2026-10-30 T-599c: `event words not read: ... answered 500` appeared in 2 of 8 local runs of the layout spec (both before the speed-up, none of the 5 with `E2E_API_LOG=1` on) and once in CI; run the layout spec with the log on until a 500 appears and fix the API route (`GET /v1/organizers/{id}/events/{id}`). Not reproduced on 2026-10-30 in the full browser suite and two more layout runs, all with the log on.
- 2026-10-30 T-505 (do in T-505b, it reworks these doors): `session_check_in` (0086:694) never checks the event's status, so it records attendance in draft, scheduled, ended or archived events (add `event_status_now(...) NOT IN ('ended','archived')` like the station scan); `session_delete` (0086:414) has no archived-event guard and no `FOR SHARE` on the event, and a check-in racing a delete hits an unmapped 23503 (500); a player checked in early who then cancels stays attended with no registration (0086:665); the message limit counts only `session_message`, not the announcement limit the plan names (0086:492) (T-505 review).
- 2026-10-30 T-505: CSV import drops rows past 500 silently, reads the whole file with no size cap and can render 500 failure notices (`packages/shared/src/sessions/sessions.ts:385`, `SessionImport.tsx:42`); "The selected link is not in this event" should name the quest (`messages.ts:6564`) (T-505 review).
- 2026-10-30 coordinator: the app never sends `X-App-Version`, so the API's update gate (426 `update_required`, `MIN_APP_VERSION`) cannot reach any phone; send the header from the API client (and set the app's version to 1.0.0 or lower staging's minimum first, or every request answers 426).
