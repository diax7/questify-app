-- T-613 review fix (ADR-398): an audit entry may hold up to 256 KiB per side, not 64 KiB.
-- `event.layout.update` stores the whole layout as before and after. With the info page and the extra page filled to
-- their limits in both languages a layout is about 100 KB, so 0006's 64 KiB check refused the save (a 500). The cap stays:
-- an entry is still bounded, only wider than the largest layout. No new table or function, so nothing new to close; the
-- table's row-level security, grants and append-only rules are those of 0006. 0006 is deployed and untouched.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_before_check;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_after_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_before_check CHECK (pg_column_size(before) < 262144);
ALTER TABLE audit_log ADD CONSTRAINT audit_log_after_check CHECK (pg_column_size(after) < 262144);
