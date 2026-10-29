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
