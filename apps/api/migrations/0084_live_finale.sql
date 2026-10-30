-- T-307b: the live finale (FR-254, FR-255, FR-1621; plan docs/plans/2026-10-30-t-307b-live-finale.md; ADR-369). The owner
-- sets a finale time for the event and may attach one community goal as its "last push". The big screen then runs a finale
-- scene: a countdown to the time, the push (the goal's progress bar), and, once the owner's existing Results page has
-- confirmed and revealed the winners, the top ten by place with a username and an avatar and no score. The finale never
-- decides, confirms or reveals anything; it only reads `event_result` and `result_place`. Confirming still needs the event
-- ended (ADR-163), so a screen with a finale stays open after the end (the device's own 24 hours bound it).
-- Deny by default: the new table keeps row-level security forced and no grant; every function is closed to PUBLIC in the
-- group that creates it, and only the team doors and the screen's door are granted to the API role. No EXCEPTION block.
-- Migrations 0083 and earlier untouched; device_view() is restated (0083's body plus the finale's running list and shut).
SET LOCAL lock_timeout = '10s';
-- The event and the goal are foreign-key targets of the new table.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE community_goal IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the finale
-- One closed row per event, written only by set_finale and clear_finale. The goal is optional (no goal: the countdown, then
-- "winners soon"); a goal deleted later leaves the finale without a push. The rehearsal wipe keeps it (setup, as big_screen).
CREATE TABLE finale (
  event_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  starts_at    timestamptz NOT NULL,
  goal_id      uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (goal_id, event_id) REFERENCES community_goal (id, event_id) ON DELETE SET NULL (goal_id)
);
ALTER TABLE finale ENABLE ROW LEVEL SECURITY;
ALTER TABLE finale FORCE ROW LEVEL SECURITY;
REVOKE ALL ON finale FROM PUBLIC, questify_app;

-- ================================================================ small rules (internal)
-- Whether the owner revealed the event's winners (FR-520): the only moment a finale reads any place. Internal.
CREATE FUNCTION finale_revealed(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id AND x.revealed_at IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION finale_revealed(event) FROM PUBLIC;

-- The scenes the screen runs now: the picked list, then the finale last while one is set; from its time on, and for good once
-- the event has ended, the finale alone. Internal.
CREATE FUNCTION big_screen_running(ev event) RETURNS text[]
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN f.event_id IS NULL THEN big_screen_plan(ev)
              WHEN f.starts_at <= now() OR event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
                THEN ARRAY['finale']::text[]
              ELSE big_screen_plan(ev) || ARRAY['finale']::text[] END
  FROM (SELECT 1) base LEFT JOIN finale f ON f.event_id = ev.id
$$;
REVOKE ALL ON FUNCTION big_screen_running(event) FROM PUBLIC;

-- Why a big screen shows nothing of its event: the event is archived, or ended with no finale to run, or the add-on is not
-- active. NULL otherwise. Internal.
CREATE FUNCTION screen_view_shut(ev event) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'archived'
                OR (event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'ended'
                    AND NOT EXISTS (SELECT 1 FROM finale f WHERE f.event_id = ev.id)) THEN 'event_ended'
              WHEN NOT big_screen_on(ev) THEN 'feature_off' END
$$;
REVOKE ALL ON FUNCTION screen_view_shut(event) FROM PUBLIC;

-- ================================================================ the team's doors
-- The Finale section's reading: the add-on, the event's end, where the results stand (not_ended, open, confirmed, revealed)
-- and the finale with its goal. Internal.
CREATE FUNCTION finale_json(ev event) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'enabled', big_screen_on(ev),
    'endsAt', ev.ends_at,
    'state', (SELECT r.state FROM results_state(ev.id) r),
    'finale', (SELECT jsonb_build_object(
                 'startsAt', f.starts_at, 'started', f.starts_at <= now(), 'goalId', f.goal_id,
                 'goal', CASE WHEN g.id IS NULL THEN NULL
                              ELSE jsonb_build_object('title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en),
                                                      'status', g.status, 'startsAt', g.starts_at, 'endsAt', g.ends_at) END)
               FROM finale f LEFT JOIN community_goal g ON g.id = f.goal_id
               WHERE f.event_id = ev.id))
$$;
REVOKE ALL ON FUNCTION finale_json(event) FROM PUBLIC;

-- The event's finale for its team (AN404 for any other event).
CREATE FUNCTION event_finale(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN finale_json(ev);
END $$;
REVOKE ALL ON FUNCTION event_finale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_finale(uuid) TO questify_app;

-- Sets the finale's time and its goal (or no goal). Owner only (LF403); AN404 other event; BS403 add-on off; LF409 `started`
-- once the time has come (only Clear remains); LF422 `startsAt` (not in the future, before the event starts or more than 24
-- hours after it ends: the screen's own life), `goal` (not a goal of this event), `goal_done` (already final), `goal_window`
-- (the goal closes before the finale starts). Audited `finale.update` with ids and the time only.
CREATE FUNCTION set_finale(target_event uuid, new_starts timestamptz, new_goal uuid, request uuid) RETURNS jsonb
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
     OR (ev.ends_at IS NOT NULL AND new_starts > ev.ends_at + interval '24 hours') THEN
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

-- Removes the finale, before or after it started (the screen goes back to its picked scenes, or to the Questify mark after the
-- end). Owner only (LF403); AN404 other event. Nothing to remove changes nothing. Audited `finale.clear`.
CREATE FUNCTION clear_finale(target_event uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := award_event_of(target_event);
  gone finale%ROWTYPE;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner clears the finale' USING ERRCODE = 'LF403';
  END IF;
  DELETE FROM finale x WHERE x.event_id = ev.id RETURNING * INTO gone;
  IF FOUND THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                           request_id)
    VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'finale.clear', 'event', ev.id::text,
            jsonb_build_object('startsAt', gone.starts_at, 'goalId', gone.goal_id), request);
  END IF;
  RETURN finale_json(ev);
END $$;
REVOKE ALL ON FUNCTION clear_finale(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clear_finale(uuid, uuid) TO questify_app;

-- ================================================================ what a screen may read
-- As 0083, and a big screen's `scenes` is the running list (the finale last, or alone from its time on) and its `shut` leaves
-- an ended event open while a finale is set.
CREATE OR REPLACE FUNCTION device_view() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d         paired_device := current_device();
  ev        event%ROWTYPE;
  quest_row quest%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = d.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = d.quest_id;
  RETURN jsonb_build_object(
    'kind', d.kind, 'label', d.label,
    'event', jsonb_build_object('nameAr', ev.name_ar, 'nameEn', ev.name_en),
    'quest', CASE WHEN d.quest_id IS NULL THEN NULL
                  ELSE jsonb_build_object('titleAr', quest_row.title_ar, 'titleEn', quest_row.title_en,
                                          'points', quest_row.points) END,
    'shut', CASE WHEN d.kind = 'screen' THEN screen_view_shut(ev)
                 WHEN device_paused(d) THEN 'paused'
                 ELSE device_quest_state(quest_row, d.kind) END,
    'scenes', CASE WHEN d.kind = 'screen' AND screen_view_shut(ev) IS NULL THEN to_jsonb(big_screen_running(ev)) END,
    'terms', CASE WHEN d.kind = 'screen' THEN ev.config -> 'terms' END);
END $$;

-- The finale scene (FR-254, FR-255, FR-1621). `shut` says why nothing shows (archived, add-on off); `finale` is NULL while none
-- is set. Phases: `reveal` once the owner revealed the winners (the top ten places, username and avatar only, from the frozen
-- places so spending never lowers one, ADR-043), else `countdown` before the time (nothing of the goal), `push` from the time
-- on while the goal is attached and community is on (its cached progress and milestones, no reward), else `waiting`.
-- No place is read before the reveal.
CREATE FUNCTION screen_finale() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := screen_event();
  shut text := CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'archived' THEN 'event_ended'
                    WHEN NOT big_screen_on(ev) THEN 'feature_off' END;
  f    finale%ROWTYPE;
  g    community_goal%ROWTYPE;
BEGIN
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  SELECT * INTO f FROM finale x WHERE x.event_id = ev.id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('shut', NULL, 'finale', NULL);
  END IF;
  IF finale_revealed(ev) THEN
    RETURN jsonb_build_object('shut', NULL, 'finale', jsonb_build_object(
      'startsAt', f.starts_at, 'phase', 'reveal', 'winners', coalesce((
        SELECT jsonb_agg(jsonb_build_object('place', x.rank, 'username', p.username, 'avatar', p.avatar) ORDER BY x.rank)
        FROM result_place x
        JOIN enrollment n ON n.id = x.enrollment_id
        JOIN player p ON p.id = n.player_id
        WHERE x.event_id = ev.id AND x.rank <= 10), '[]'::jsonb)));
  END IF;
  IF now() < f.starts_at THEN
    RETURN jsonb_build_object('shut', NULL, 'finale', jsonb_build_object('startsAt', f.starts_at, 'phase', 'countdown'));
  END IF;
  SELECT * INTO g FROM community_goal x
  WHERE x.id = f.goal_id AND community_on(ev) AND feature_enabled(ev, 'community');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('shut', NULL, 'finale', jsonb_build_object('startsAt', f.starts_at, 'phase', 'waiting'));
  END IF;
  RETURN jsonb_build_object('shut', NULL, 'finale', jsonb_build_object(
    'startsAt', f.starts_at, 'phase', 'push', 'goal', jsonb_build_object(
      'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure, 'target', g.target,
      'progress', g.progress, 'status', g.status, 'endsAt', community_close_at(g.ends_at, ev.ends_at),
      'steps', coalesce((SELECT jsonb_agg(jsonb_build_object('threshold', s.threshold, 'isGoal', s.is_goal,
                                                             'reached', r.reached_at IS NOT NULL) ORDER BY s.threshold)
                         FROM community_step s LEFT JOIN community_reach r ON r.step_id = s.id
                         WHERE s.goal_id = g.id), '[]'::jsonb))));
END $$;
REVOKE ALL ON FUNCTION screen_finale() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_finale() TO questify_app;
