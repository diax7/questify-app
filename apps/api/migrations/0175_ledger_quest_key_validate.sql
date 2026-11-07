-- T-813 part 1 (ADR-816): validates the key 0174 added NOT VALID. Its own transaction, so it holds SHARE UPDATE EXCLUSIVE
-- on ledger_entry and ROW SHARE on quest: reads and writes go on, only DDL and VACUUM wait. 0.72 s at 2.1 million rows.
-- A ledger row whose event is not its quest's fails this file and the deploy stops with 0174 already committed: the
-- NOT VALID key then stands alone and does not catch such a row on a quest delete. Count them first (RUNBOOK).
SET LOCAL lock_timeout = '10s';
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_quest_id_event_id_fkey;
