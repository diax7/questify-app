-- Audit log (T-004): who changed what, before and after, and when (FR-1029, FR-1030, FR-1410, NFR-019).
-- Append-only: no role can change or remove an entry. Deny by default: forced row-level security, explicit grants.
-- Keep it low-volume: points and scans have their own record (the ledger), not this table.

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('admin', 'staff', 'system')),
  actor_id     uuid,
  -- No foreign keys: an entry must outlive what it describes (an event can be deleted, FR-1003; its history stays).
  organizer_id uuid,
  event_id     uuid,
  action       text NOT NULL CHECK (action ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$'),
  target_type  text NOT NULL CHECK (target_type ~ '^[a-z][a-z_]*$'),
  target_id    text CHECK (length(target_id) <= 200),
  before       jsonb CHECK (pg_column_size(before) < 65536),
  after        jsonb CHECK (pg_column_size(after) < 65536),
  request_id   uuid,
  CHECK ((actor_type = 'system') = (actor_id IS NULL)),
  CHECK (event_id IS NULL OR organizer_id IS NOT NULL)
);
-- The organizer's change log (FR-1029) and the event's history, newest first.
CREATE INDEX audit_log_organizer_idx ON audit_log (organizer_id, id DESC) WHERE organizer_id IS NOT NULL;
CREATE INDEX audit_log_event_idx ON audit_log (event_id, id DESC) WHERE event_id IS NOT NULL;
-- "What did this person do" for the console (T-701, T-709).
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id, id DESC) WHERE actor_id IS NOT NULL;

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Writing: only in your own name. A staff entry inside an organizer must be that organizer's, and an entry about an
-- event must name the event's own organizer (checked against the event rules, so you can only name events you see).
-- There is no 'system' branch: only the owner connection (the CLI, jobs) writes system entries.
CREATE POLICY audit_insert ON audit_log FOR INSERT TO questify_app
  WITH CHECK (
    (
      (actor_type = 'admin' AND app_is_admin() AND actor_id = app_staff_user_id())
      OR (actor_type = 'staff' AND actor_id = app_staff_user_id()
          AND (organizer_id IS NULL OR organizer_id = app_organizer_id()))
    )
    AND (event_id IS NULL
         OR EXISTS (SELECT 1 FROM event e WHERE e.id = audit_log.event_id AND e.organizer_id = audit_log.organizer_id))
  );
-- Reading: an organizer reads its own log (including a Questify admin's support work in its events, ADR-068);
-- a Questify admin reads everything.
CREATE POLICY audit_read ON audit_log FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() OR app_is_admin());

-- The API cannot choose the id or the time of an entry, only what it says.
GRANT INSERT (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after, request_id)
  ON audit_log TO questify_app;
GRANT SELECT ON audit_log TO questify_app;

-- Append-only for every role, the owner included (FR-1030). The triggers fire ALWAYS, so even a session that sets
-- session_replication_role cannot skip them. Changing the table itself (DDL) is guarded by migration review only.
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit log entries can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION audit_log_append_only() FROM PUBLIC;
CREATE TRIGGER audit_log_no_update_or_delete BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_update_or_delete;
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;
