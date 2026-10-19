-- Configuration (T-007): platform settings and the add-ons unlocked per event.
-- Deny by default (docs/rules.md): forced row-level security, explicit grants, nothing for PUBLIC.

-- ---------------------------------------------------------------- platform settings
-- One row per block ("features", "tuning"). Every app reads them before anyone signs in, so reading is open
-- to the API role; only a Questify admin can write, and nothing is ever deleted.
CREATE TABLE platform_setting (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-zA-Z0-9]*$'),
  value      jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES staff_user (id)
);
ALTER TABLE platform_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_setting FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_setting_read ON platform_setting FOR SELECT TO questify_app USING (true);
CREATE POLICY platform_setting_insert ON platform_setting FOR INSERT TO questify_app
  WITH CHECK (app_is_admin());
CREATE POLICY platform_setting_update ON platform_setting FOR UPDATE TO questify_app
  USING (app_is_admin()) WITH CHECK (app_is_admin());

GRANT SELECT, INSERT ON platform_setting TO questify_app;
GRANT UPDATE (value, updated_at, updated_by) ON platform_setting TO questify_app;

-- ---------------------------------------------------------------- add-ons unlocked for an event (FR-1729)
-- Kept apart from event.config on purpose: the organizer can edit that column, and an organizer must not be
-- able to unlock an add-on for themselves. Only a Questify admin writes here.
CREATE TABLE event_entitlement (
  event_id     uuid NOT NULL,
  organizer_id uuid NOT NULL,
  feature      text NOT NULL CHECK (feature ~ '^[a-z][a-zA-Z0-9]*$'),
  granted_by   uuid REFERENCES staff_user (id),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, feature),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE event_entitlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_entitlement FORCE ROW LEVEL SECURITY;

-- Whoever can see the event can see which add-ons it has (the subquery is itself subject to the event rules,
-- so a private event's add-ons stay private).
CREATE POLICY entitlement_read ON event_entitlement FOR SELECT TO questify_app
  USING (EXISTS (SELECT 1 FROM event e WHERE e.id = event_entitlement.event_id));
CREATE POLICY entitlement_insert ON event_entitlement FOR INSERT TO questify_app
  WITH CHECK (app_is_admin());
CREATE POLICY entitlement_delete ON event_entitlement FOR DELETE TO questify_app
  USING (app_is_admin());

GRANT SELECT, INSERT, DELETE ON event_entitlement TO questify_app;
