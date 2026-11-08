-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 32): the redemptions export's page index holds only the rows
-- the file reads. One index replaced by its partial form; no table, no function, no grant, nothing that writes points or
-- XP, changes a sign-in, a tenant rule or a redemption. 0182 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the redemptions page index (batch 30 review, NIT)
-- `export_redemptions` (0182) reads only reward redemptions (`reward_id IS NOT NULL`); a rank prize or a quest item is
-- not in the file, so its entry in 0182's index was never read. The page read still walks this index in the file's
-- order and stops at the page; when what is left of the event is about two pages or less, the planner may instead read
-- those rows through it and sort them (`apps/api/test/perf/export-index-plans.int.test.ts`, FOLLOWUPS batch 32 in
-- STATE.md).
-- Built inside the migration's transaction, not CONCURRENTLY: the table is small before launch, and the build holds
-- writes to it for the build's length only.
DROP INDEX redemption_event_created_idx;
CREATE INDEX redemption_event_created_idx ON redemption (event_id, created_at, id) WHERE reward_id IS NOT NULL;
