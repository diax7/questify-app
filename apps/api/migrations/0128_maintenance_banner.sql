-- Maintenance mode and the scheduled banner (T-703b, FR-1771, FR-1772, ADR-470): two more blocks of `platform_setting`,
-- edited from the console's Switches page and composed into `GET /v1/config`.
--
--   maintenance  {"global": {ar, en}?, "events": {"<event uuid>": {ar, en}}}  a message present means play is paused
--   banner       {"message": {ar, en}, "startsAt": ..., "endsAt": ...}         {} means none (rows are never deleted)
--
-- Deny by default: the write policies of 0122 name the keys the generic writer may touch; this widens them by exactly the
-- two new keys, for an active platform admin only. The new function is for the API role alone (PUBLIC revoked).

DROP POLICY platform_setting_insert ON platform_setting;
DROP POLICY platform_setting_update ON platform_setting;
CREATE POLICY platform_setting_insert ON platform_setting FOR INSERT TO questify_app
  WITH CHECK (app_admin_id() IS NOT NULL AND key IN ('features', 'tuning', 'maintenance', 'banner'));
CREATE POLICY platform_setting_update ON platform_setting FOR UPDATE TO questify_app
  USING (app_admin_id() IS NOT NULL AND key IN ('features', 'tuning', 'maintenance', 'banner'))
  WITH CHECK (app_admin_id() IS NOT NULL AND key IN ('features', 'tuning', 'maintenance', 'banner'));

-- Only the fields each block knows (the API validates the rest; this keeps a stray write from adding others).
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_maintenance_check CHECK (
  key <> 'maintenance' OR value - ARRAY['global', 'events'] = '{}'::jsonb);
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_banner_check CHECK (
  key <> 'banner' OR value - ARRAY['message', 'startsAt', 'endsAt'] = '{}'::jsonb);

-- The event a play door acts on, for the maintenance wall: the API holds a door's request by the event's own message.
-- `kind` is the id the door carries (quest, step, category, reward) or the join code; anything else, or an id that is not
-- a uuid, is null. Ids only, no event data. Called by the API after the player check, and only while some event has a
-- message; the role cannot read the tables themselves.
CREATE FUNCTION play_event_id(kind text, ref text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN kind = 'join_code' THEN (SELECT e.id FROM event e WHERE lower(e.join_code) = lower(ref))
    WHEN ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL
    WHEN kind = 'quest' THEN (SELECT q.event_id FROM quest q WHERE q.id = ref::uuid)
    WHEN kind = 'step' THEN (SELECT s.event_id FROM passport_step s WHERE s.id = ref::uuid)
    WHEN kind = 'category' THEN (SELECT c.event_id FROM category c WHERE c.id = ref::uuid)
    WHEN kind = 'reward' THEN (SELECT r.event_id FROM reward r WHERE r.id = ref::uuid)
  END
$$;
REVOKE ALL ON FUNCTION play_event_id(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION play_event_id(text, text) TO questify_app;
