-- Feature layers (T-711, FR-1826, ADR-105, ADR-500): a Questify admin overrides a feature's platform switch for one
-- organizer, On or Off. The override is laid over the platform's switch by the composed configuration (TypeScript,
-- `platformForOrganizer`) and by the four SQL rules that read the platform switch for an event: `feature_enabled`, `flash_on`,
-- `shop_on` and `cheers_json`'s platform reading. With no override row every answer is the one given before this migration.
--
-- Only the 12 features whose platform rule reaches one event can be overridden. `boosts`, `community`, `meetSomeone` and
-- `miniGames` (platform switch read platform-wide in code, SQL rules in the points path) are T-711b; the Questify-wide
-- features have no organizer. The CHECK below equals `isOrganizerOverridable` over the registry
-- (packages/shared/src/config/registry.ts); `test/db/feature-layers.int.test.ts` compares the two.
--
-- Deny by default: forced row-level security. An admin writes (checked against the account, `app_admin_id()`, not the
-- context flag alone); anyone who can see one of the organizer's events can read the organizer's rows, as the add-ons of an
-- event (`event_entitlement`, 0003); nobody else sees a row. PUBLIC holds nothing on the table or the new function; the
-- function is internal like the rules that call it. Migrations 0135 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- The organizer is the foreign-key target, locked up front. `set_by` is a plain id (the audit log names the admin too), so the
-- sign-in path's staff_user table is never locked here.
LOCK TABLE organizer IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE organizer_feature_override (
  organizer_id uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  feature      text NOT NULL CHECK (feature IN (
                 'agenda', 'bigScreen', 'cheers', 'flashQuests', 'helpDesk', 'maps', 'polls', 'questRatings',
                 'ranking', 'rankingToday', 'shareQuests', 'shop')),
  enabled      boolean NOT NULL,
  set_by       uuid,
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_id, feature)
);
ALTER TABLE organizer_feature_override ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_feature_override FORCE ROW LEVEL SECURITY;

CREATE POLICY feature_override_read ON organizer_feature_override FOR SELECT TO questify_app
  USING (app_admin_id() IS NOT NULL
         OR EXISTS (SELECT 1 FROM event e WHERE e.organizer_id = organizer_feature_override.organizer_id));
CREATE POLICY feature_override_insert ON organizer_feature_override FOR INSERT TO questify_app
  WITH CHECK (app_admin_id() IS NOT NULL);
CREATE POLICY feature_override_update ON organizer_feature_override FOR UPDATE TO questify_app
  USING (app_admin_id() IS NOT NULL) WITH CHECK (app_admin_id() IS NOT NULL);
CREATE POLICY feature_override_delete ON organizer_feature_override FOR DELETE TO questify_app
  USING (app_admin_id() IS NOT NULL);

GRANT SELECT, INSERT, DELETE ON organizer_feature_override TO questify_app;
GRANT UPDATE (enabled, set_by, set_at) ON organizer_feature_override TO questify_app;

-- ================================================================ the platform switch as one organizer sees it
-- The organizer's override when Questify set one, else the platform's switch (`platform_setting` features.<k>.enabled), on
-- when neither says. Internal: no grant; the definers and rules that call it run as their owner.
CREATE FUNCTION platform_feature_on(org uuid, k text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT o.enabled FROM organizer_feature_override o WHERE o.organizer_id = org AND o.feature = k),
    coalesce((SELECT s.value -> k -> 'enabled' <> 'false'::jsonb FROM platform_setting s WHERE s.key = 'features'), true))
$$;
REVOKE ALL ON FUNCTION platform_feature_on(uuid, text) FROM PUBLIC;

-- ================================================================ the rules that read the platform switch for an event
-- 0083's rule with the platform part read through the organizer.
CREATE OR REPLACE FUNCTION feature_enabled(ev event, feature text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> feature <> 'false'::jsonb, true)
     AND platform_feature_on(ev.organizer_id, feature)
$$;

-- 0055's and 0079's rules said what feature_enabled says (as ranking_on has since 0085): they now call it.
CREATE OR REPLACE FUNCTION flash_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$ SELECT feature_enabled(ev, 'flashQuests') $$;

CREATE OR REPLACE FUNCTION shop_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$ SELECT feature_enabled(ev, 'shop') $$;

-- 0090's body with the platform reading of Cheers through the organizer.
CREATE OR REPLACE FUNCTION cheers_json(ev event) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'enabled', big_screen_on(ev),
    'switch', coalesce(ev.config -> 'features' -> 'cheers' <> 'false'::jsonb, true),
    'platformOn', platform_feature_on(ev.organizer_id, 'cheers'),
    'live', (SELECT jsonb_build_object('startedAt', m.started_at, 'endsAt', m.ends_at)
             FROM cheers_moment m WHERE m.event_id = ev.id AND cheers_live_until(ev) IS NOT NULL))
$$;
