-- T-813 part 1, the ledger's key on its quest (docs/PERFORMANCE_AUDIT.md, "T-813 results"; ADR-816, Q-753). Every quest
-- deleted checks that no ledger row names it. `ledger_entry_quest_id_fkey` was on `quest_id` alone, which no full index
-- leads, so each check scanned the whole ledger: 290 ms a quest at 2.1 million rows, and a draft of 26 quests took 7.8 s,
-- past the API's 5 s statement_timeout. The key now names `(quest_id, event_id)` against `quest_id_event_key` (0012), as
-- quest_completion's does, so the check reads `ledger_entry_event_idx` for that quest's event only. No index is added, so
-- no write pays for it; the insert's check probes `quest_id_event_key` in place of the primary key, as cheap. ON DELETE
-- RESTRICT as before; NULL `quest_id` rows are unchecked as before (`event_id` is NOT NULL), and a ledger row's event
-- must now be its quest's, which every writer already does (0175 checks the history).
--
-- Added NOT VALID, so this file reads no row; the old key is dropped here, so a quest is never without one. Dropping a
-- foreign key needs ACCESS EXCLUSIVE on both tables: taken up front, quest before ledger_entry (a completion locks the
-- quest, then writes the ledger), held for milliseconds once taken; while it waits (up to
-- 10 s) quest reads queue and API calls hit their 2 s lock_timeout, so production needs a quiet window. 0175 validates under a lock that lets writers through.
SET LOCAL lock_timeout = '10s';
LOCK TABLE quest IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ledger_entry IN ACCESS EXCLUSIVE MODE;

ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_quest_id_event_id_fkey FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id)
  ON DELETE RESTRICT NOT VALID;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_quest_id_fkey;
