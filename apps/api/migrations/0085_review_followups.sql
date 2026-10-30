-- Follow-ups from the T-307b and T-504 reviews.
-- 1. set_finale accepts a start up to 23 hours after the event ends (0084 allowed 24). A paired screen stops working 24 hours
--    after the event ends (device_alive, 0057), so a finale set for the last hour would never be seen. 0084's body with the
--    one interval; its grants are repeated.
-- 2. ranking_on (0082) says what feature_enabled (0083) already says, so it now calls it (same answer, one rule).
-- Migrations 0084 and earlier untouched.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION ranking_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT feature_enabled(ev, 'ranking')
$$;
REVOKE ALL ON FUNCTION ranking_on(event) FROM PUBLIC;

-- Sets the finale's time and its goal (or no goal). Owner only (LF403); AN404 other event; BS403 add-on off; LF409 `started`
-- once the time has come (only Clear remains); LF422 `startsAt` (not in the future, before the event starts or more than 23
-- hours after it ends), `goal` (not a goal of this event), `goal_done` (already final), `goal_window` (the goal closes before
-- the finale starts). Audited `finale.update` with ids and the time only.
CREATE OR REPLACE FUNCTION set_finale(target_event uuid, new_starts timestamptz, new_goal uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  old    finale%ROWTYPE;
  picked community_goal%ROWTYPE;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner sets the finale' USING ERRCODE = 'LF403';
  END IF;
  IF NOT big_screen_on(ev) THEN
    RAISE EXCEPTION 'the big screen is not active for this event' USING ERRCODE = 'BS403';
  END IF;
  SELECT * INTO old FROM finale x WHERE x.event_id = ev.id FOR UPDATE;
  IF FOUND AND old.starts_at <= now() THEN
    RAISE EXCEPTION 'the finale has started' USING ERRCODE = 'LF409', DETAIL = 'started';
  END IF;
  IF new_starts IS NULL OR new_starts <= now() OR (ev.starts_at IS NOT NULL AND new_starts < ev.starts_at)
     OR (ev.ends_at IS NOT NULL AND new_starts > ev.ends_at + interval '23 hours') THEN
    RAISE EXCEPTION 'the finale time is not in the event''s window' USING ERRCODE = 'LF422', DETAIL = 'startsAt';
  END IF;
  IF new_goal IS NOT NULL THEN
    SELECT * INTO picked FROM community_goal g WHERE g.id = new_goal AND g.event_id = ev.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such community goal' USING ERRCODE = 'LF422', DETAIL = 'goal';
    END IF;
    IF picked.final_at IS NOT NULL THEN
      RAISE EXCEPTION 'the goal is already final' USING ERRCODE = 'LF422', DETAIL = 'goal_done';
    END IF;
    IF community_close_at(picked.ends_at, ev.ends_at) <= new_starts THEN
      RAISE EXCEPTION 'the goal closes before the finale starts' USING ERRCODE = 'LF422', DETAIL = 'goal_window';
    END IF;
  END IF;
  INSERT INTO finale (event_id, organizer_id, starts_at, goal_id, updated_by)
  VALUES (ev.id, ev.organizer_id, new_starts, new_goal, app_staff_user_id())
  ON CONFLICT (event_id) DO UPDATE
  SET starts_at = excluded.starts_at, goal_id = excluded.goal_id, updated_at = now(), updated_by = excluded.updated_by;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'finale.update', 'event', ev.id::text,
          CASE WHEN old.event_id IS NULL THEN NULL
               ELSE jsonb_build_object('startsAt', old.starts_at, 'goalId', old.goal_id) END,
          jsonb_build_object('startsAt', new_starts, 'goalId', new_goal), request);
  RETURN finale_json(ev);
END $$;
REVOKE ALL ON FUNCTION set_finale(uuid, timestamptz, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_finale(uuid, timestamptz, uuid, uuid) TO questify_app;
