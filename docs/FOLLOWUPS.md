# Follow-ups

MINOR and NIT review findings, and small leftovers, that are not worth a fix on their own (ADR-355). A cheap Sonnet
worker clears this list in one batch about every five tasks, then deletes the lines it finished. A BLOCKER or MAJOR
never waits here, and a line that grows into real work becomes a task in `docs/TASKS.md`.

Format: `- <date> <task>: <what and where> (<source>)`

- 2026-10-28 T-411: `community.int`'s open-transaction settle check is load-sensitive (it reads `pg_stat_activity`) and failed once in a parallel full run; fix or quarantine it (T-501d review).
- 2026-10-28 T-501: a row held between in-lease tries returns `answered: false` even after a 500 was written, while running out of tries returns `true`; it only shifts the mass-invalid guard's denominator slightly (T-501 survivor chase).
- 2026-10-28 T-501: `apps/api/src/push/doors.ts` (60.5%) and `round.ts` (80.6%) were left under the 90% mutation bar; push code is outside the mutation scope of ADR-355, so this is accepted unless a bug shows up there.
- 2026-10-28 T-501b: 22 equivalent mutants in `h2.ts` and 13 in `apns.ts`/`fcm.ts` are listed in their test-file notes; no action unless the transport changes.
