-- T-813 part 1, indexes (docs/PERFORMANCE_AUDIT.md, "T-813 results"; ADR-816). Four new indexes on the ledger, the XP
-- record and the audit log. No new table or function, nothing here writes points differently, and no ledger row changes.
-- Deployed migrations untouched. The invitation queue is 0173 and the ledger's quest key 0174 and 0175, each in its own
-- transaction, so no lock here waits on them and theirs last milliseconds.
--
-- Every index below is a plain CREATE INDEX: the runner holds each file in one transaction, so CONCURRENTLY cannot run
-- (ADR-580). As 0162, every table this file indexes is locked up front, in one order: ledger_entry before xp_entry and
-- both before audit_log, the order a completion and a removal write them. SHARE stops writers for the build and lets
-- reads through: an API writer waits its 2 s lock_timeout and fails with 55P03, and every audited write waits on
-- audit_log (ADR-816). A clash within 10 seconds of lock waiting rolls the file back and the runner retries it. Measured
-- build on 2,000,000 ledger rows: 1.1 s for the largest.
SET LOCAL lock_timeout = '10s';
LOCK TABLE ledger_entry IN SHARE MODE;
LOCK TABLE xp_entry IN SHARE MODE;
LOCK TABLE audit_log IN SHARE MODE;

-- ================================================================ a removal found by the entry it reverses
-- `ledger_entry_removal_key` is partial on kind, so a read of `x.reverses = l.id` with no kind, and the foreign key's own
-- check, cannot use it: member_ledger and manual_awards scanned the whole table once per line (measured),
-- and session_bulk_targets and session_points_held read the same way (inferred, not measured); quest_bulk_targets read
-- it through a hash (ADR-816). `ledger_entry_removal_shape` makes this predicate the same rows as that key's, so a
-- quest entry adds nothing here; only a removal writes it.
CREATE INDEX ledger_entry_reverses_idx ON ledger_entry (reverses) WHERE reverses IS NOT NULL;

-- ================================================================ what a rehearsal wipe's foreign keys look up
-- Deleting a rehearsal's completions and ledger rows checks `ledger_entry.completion_id` and `xp_entry.ledger_entry_id`
-- per row. Both had partial keys only, which those checks cannot use, so each deleted row was a full table scan while
-- wipe_rehearsal held its locks. Each index adds one entry per quest row: ADR-816 records that price and what was left out.
CREATE INDEX ledger_entry_completion_idx ON ledger_entry (completion_id) WHERE completion_id IS NOT NULL;
CREATE INDEX xp_entry_ledger_idx ON xp_entry (ledger_entry_id) WHERE ledger_entry_id IS NOT NULL;

-- ================================================================ a player's own audit rows for their data export
-- data_export_support reads four actions of one player. Only three had an index, each its own, so the read scanned
-- audit_log. These actions are rare, so the rest of the log's writes pay nothing.
CREATE INDEX audit_log_player_export_idx ON audit_log (target_id)
  WHERE target_type = 'player'
    AND action IN ('player.signup', 'player.contact_change', 'player.qr_reset', 'player.data_export');
