-- Guided setup progress (T-605, FR-1751 to FR-1756, FR-1846): where an event's setup wizard stands, so the organizer
-- (or another team member) comes back to the same step. The row holds progress only: the wizard's choices are saved by
-- the same operations the dashboard pages use, so nothing the wizard writes lives here and nothing here changes what
-- players see. `steps` has one letter per step, in order: n = not decided, d = done, s = skipped. A skipped step keeps
-- the template's defaults, because it writes nothing. No function is created.
-- Deny by default: forced row-level security, no PUBLIC grant, no DELETE grant, column grants for the API's role alone.
-- A row is visible and writable only to an owner or an editor of its organizer inside the editor's event limit; a
-- player's or an operator's context has no staff user, so the policy shows it nothing.
SET LOCAL lock_timeout = '10s';
-- The event is a foreign-key target of the new table.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;

-- `updated_by` names the staff member without a foreign key, as change_set.created_by: a removed team member's last
-- save stays explained. The last save wins (FR-1754); a row is made by the first save and removed with its event.
CREATE TABLE event_setup (
  event_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  current_step smallint NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 10),
  steps        text NOT NULL DEFAULT 'nnnnnnnnnn' CHECK (steps ~ '^[nds]{10}$'),
  finished_at  timestamptz,
  updated_by   uuid NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE event_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_setup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_setup FROM PUBLIC;

GRANT SELECT ON event_setup TO questify_app;
GRANT INSERT (event_id, organizer_id, current_step, steps, finished_at, updated_by) ON event_setup TO questify_app;
GRANT UPDATE (current_step, steps, finished_at, updated_by, updated_at) ON event_setup TO questify_app;

-- Owners and editors inside their event limit: the organizer, a staff user (not a player or an operator) and the event.
CREATE POLICY event_setup_member ON event_setup FOR ALL TO questify_app
  USING (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
         AND in_event_scope(event_id, app_event_scope()))
  WITH CHECK (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
              AND updated_by = app_staff_user_id() AND in_event_scope(event_id, app_event_scope()));
