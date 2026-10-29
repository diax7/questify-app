-- T-504: the big screen's scenes (FR-630 to FR-634, FR-1612, FR-1613; plan docs/plans/2026-10-30-t-504-big-screen.md;
-- ADR-365). A paired big screen (T-309, kind `screen`) shows the scenes its event's team picked, in the order they
-- picked: the live ranking, the community goal and the live poll. The picked list is one closed row per event
-- (`big_screen`); the screen reads each scene through a door of its own that takes no argument, so a device can only ever
-- ask about its own event. Ranking, community and poll are read exactly as the player's app reads them (the board's rule
-- `rank_top_ten_ids`, the cached `community_goal.progress`, the poll's results policy), and a scene never shows more than
-- a player in the room could see on a phone: usernames and avatars the boards already show, never a person's answer.
-- Deny by default: the new table keeps row-level security forced and no grant; every function is closed to PUBLIC in the
-- group that creates it, and only the doors are granted to the API role. No EXCEPTION block. Migrations 0082 and earlier
-- untouched; device_view() is restated (0058's body plus `scenes` and the screen's `feature_off`).
SET LOCAL lock_timeout = '10s';
-- The event is a foreign-key target of the new table.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ small rules (internal)
-- A feature that the event's own switch (`config.features.<key>`) and the platform's (`platform_setting` features)
-- have not turned off, as the composed configuration reads them (FR-607, FR-1503).
CREATE FUNCTION feature_enabled(ev event, feature text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> feature <> 'false'::jsonb, true)
     AND coalesce((SELECT s.value -> feature -> 'enabled' <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION feature_enabled(event, text) FROM PUBLIC;

-- The big screen is a gated add-on (FR-1729): Questify unlocked it for the event, and neither the event nor the
-- platform switched it off.
CREATE FUNCTION big_screen_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT feature_enabled(ev, 'bigScreen')
     AND EXISTS (SELECT 1 FROM event_entitlement x WHERE x.event_id = ev.id AND x.feature = 'bigScreen')
$$;
REVOKE ALL ON FUNCTION big_screen_on(event) FROM PUBLIC;

-- The scenes there are, in the order they are offered. The list is the screen's whole vocabulary: a scene is one of
-- these, at most once; zero is allowed (the screen then shows the event's name only).
CREATE FUNCTION big_screen_scenes_ok(scenes text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT scenes IS NOT NULL AND cardinality(scenes) <= 3 AND scenes <@ ARRAY['ranking', 'community', 'poll']::text[]
     AND cardinality(scenes) = (SELECT count(DISTINCT s) FROM unnest(scenes) s)
$$;
REVOKE ALL ON FUNCTION big_screen_scenes_ok(text[]) FROM PUBLIC;

-- ================================================================ the picked scenes
-- One row per event, written only by set_big_screen. No row means every scene, in this order (a screen paired before the
-- team opens the page still shows something). The rehearsal wipe keeps it (setup, as the devices).
CREATE TABLE big_screen (
  event_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  scenes       text[] NOT NULL CHECK (big_screen_scenes_ok(scenes)),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE big_screen ENABLE ROW LEVEL SECURITY;
ALTER TABLE big_screen FORCE ROW LEVEL SECURITY;
REVOKE ALL ON big_screen FROM PUBLIC, questify_app;

-- The scenes the screen runs now: the picked list (or all three) in its order, without the ranking while the event's
-- ranking is off (FR-1612). Internal.
CREATE FUNCTION big_screen_plan(ev event) RETURNS text[]
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(u.scene ORDER BY u.pos), '{}'::text[])
  FROM unnest(coalesce((SELECT b.scenes FROM big_screen b WHERE b.event_id = ev.id),
                       ARRAY['ranking', 'community', 'poll']::text[])) WITH ORDINALITY AS u(scene, pos)
  WHERE u.scene <> 'ranking' OR ranking_on(ev)
$$;
REVOKE ALL ON FUNCTION big_screen_plan(event) FROM PUBLIC;

-- The Big screen page's reading: the scenes running, the ones offered (the ranking only while it is on), and whether the
-- add-on is active for the event.
CREATE FUNCTION big_screen_json(ev event) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'scenes', to_jsonb(big_screen_plan(ev)),
    'offered', CASE WHEN ranking_on(ev) THEN '["ranking", "community", "poll"]'::jsonb
                    ELSE '["community", "poll"]'::jsonb END,
    'enabled', big_screen_on(ev))
$$;
REVOKE ALL ON FUNCTION big_screen_json(event) FROM PUBLIC;

-- The event's picked scenes for its team (AN404 for any other event).
CREATE FUNCTION event_big_screen(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN big_screen_json(ev);
END $$;
REVOKE ALL ON FUNCTION event_big_screen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_big_screen(uuid) TO questify_app;

-- Saves the picked scenes, in order (AN404 other event; BS403 add-on off; BS422 `scenes` unknown, repeated or too many,
-- `ranking_off` the ranking is not offered while it is off). Audited `big_screen.update`; the audit row holds the scene
-- names only.
CREATE FUNCTION set_big_screen(target_event uuid, new_scenes text[], request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  before text[];
BEGIN
  IF NOT big_screen_on(ev) THEN
    RAISE EXCEPTION 'the big screen is not active for this event' USING ERRCODE = 'BS403';
  END IF;
  IF NOT big_screen_scenes_ok(new_scenes) THEN
    RAISE EXCEPTION 'unknown, repeated or too many scenes' USING ERRCODE = 'BS422', DETAIL = 'scenes';
  END IF;
  IF 'ranking' = ANY (new_scenes) AND NOT ranking_on(ev) THEN
    RAISE EXCEPTION 'the ranking is off for this event' USING ERRCODE = 'BS422', DETAIL = 'ranking_off';
  END IF;
  before := big_screen_plan(ev);
  INSERT INTO big_screen (event_id, organizer_id, scenes, updated_by)
  VALUES (ev.id, ev.organizer_id, new_scenes, app_staff_user_id())
  ON CONFLICT (event_id) DO UPDATE
  SET scenes = excluded.scenes, updated_at = now(), updated_by = excluded.updated_by;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'big_screen.update', 'event', ev.id::text,
          jsonb_build_object('scenes', to_jsonb(before)), jsonb_build_object('scenes', to_jsonb(new_scenes)), request);
  RETURN big_screen_json(ev);
END $$;
REVOKE ALL ON FUNCTION set_big_screen(uuid, text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_big_screen(uuid, text[], uuid) TO questify_app;

-- ================================================================ what a screen may read
-- The event of the calling device, which must be a paired, activated, living big screen (DV401 otherwise). It takes no
-- argument: a device can never name another event. Internal.
CREATE FUNCTION screen_event() RETURNS event
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  d  paired_device := current_device();
  ev event%ROWTYPE;
BEGIN
  IF d.kind <> 'screen' THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DV401';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = d.event_id;
  RETURN ev;
END $$;
REVOKE ALL ON FUNCTION screen_event() FROM PUBLIC;

-- Why a screen shows nothing of its event now: the event is over, or the add-on is not active. NULL otherwise.
CREATE FUNCTION screen_shut(ev event) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN 'event_ended'
              WHEN NOT big_screen_on(ev) THEN 'feature_off' END
$$;
REVOKE ALL ON FUNCTION screen_shut(event) FROM PUBLIC;

-- As 0058, and a big screen carries its running scenes (the page learns a change of the list from its 3-second poll) and
-- the event's own words (FR-942: the currency beside a score), and is shut `feature_off` while the add-on is not
-- active. Nothing read from a ranking or a player.
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
    'shut', CASE WHEN d.kind = 'screen' THEN screen_shut(ev)
                 WHEN device_paused(d) THEN 'paused'
                 ELSE device_quest_state(quest_row, d.kind) END,
    'scenes', CASE WHEN d.kind = 'screen' AND screen_shut(ev) IS NULL THEN to_jsonb(big_screen_plan(ev)) END,
    'terms', CASE WHEN d.kind = 'screen' THEN ev.config -> 'terms' END);
END $$;

-- The live ranking scene (FR-632): the event's ten best under the board's own rule and order, the same ten the rank push
-- compares. Banned, excluded, deleted and team accounts never appear (ranking_eligible). `shut` says why nothing shows.
CREATE FUNCTION screen_ranking() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := screen_event();
  shut text := screen_shut(ev);
BEGIN
  IF shut IS NULL AND NOT ranking_on(ev) THEN
    shut := 'ranking_off';
  END IF;
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  RETURN jsonb_build_object('shut', NULL, 'rows', coalesce((
    SELECT jsonb_agg(jsonb_build_object('place', u.place, 'username', p.username, 'avatar', p.avatar,
                                        'score', e.score) ORDER BY u.place)
    FROM unnest(rank_top_ten_ids(ev.id)) WITH ORDINALITY AS u(enrollment_id, place)
    JOIN enrollment e ON e.id = u.enrollment_id
    JOIN player p ON p.id = e.player_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION screen_ranking() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_ranking() TO questify_app;

-- The community scene (FR-633): the goal running now or finished in the last 30 minutes, as member_community picks it,
-- with its cached progress and the milestones' thresholds and whether each was reached. No reward, no unlock target (a
-- surprise stays one) and nothing per player. `goal` is NULL when there is none.
CREATE FUNCTION screen_community() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := screen_event();
  shut text := screen_shut(ev);
BEGIN
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  RETURN jsonb_build_object('shut', NULL, 'goal', (
    SELECT jsonb_build_object(
      'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure, 'target', g.target,
      'progress', g.progress, 'status', g.status, 'endsAt', community_close_at(g.ends_at, ev.ends_at),
      'steps', coalesce((SELECT jsonb_agg(jsonb_build_object('threshold', s.threshold, 'isGoal', s.is_goal,
                                                             'reached', r.reached_at IS NOT NULL) ORDER BY s.threshold)
                         FROM community_step s LEFT JOIN community_reach r ON r.step_id = s.id
                         WHERE s.goal_id = g.id), '[]'::jsonb))
    FROM community_goal g
    WHERE g.event_id = ev.id AND g.settled_until IS NOT NULL
      AND (g.final_at IS NULL OR g.final_at > now() - interval '30 minutes')
      AND event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live'
      AND community_on(ev) AND feature_enabled(ev, 'community')
    ORDER BY g.starts_at DESC
    LIMIT 1));
END $$;
REVOKE ALL ON FUNCTION screen_community() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_community() TO questify_app;

-- The poll scene (FR-634, FR-1613): the newest sent poll that is open, else the one that closed in the last 15 minutes,
-- only a poll anyone in the room may see (its category has no audience and is not hidden; not held shut by a community
-- goal). The results follow the poll's own policy: `after_vote` live, `at_close` once it closed, `never` the number of
-- people who voted only. Counts only, never who voted. `poll` is NULL when there is none.
CREATE FUNCTION screen_poll() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := screen_event();
  shut   text := screen_shut(ev);
  poll_row record;
  people bigint;
  shown  boolean;
BEGIN
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  IF NOT polls_shown(ev) OR NOT feature_enabled(ev, 'polls') THEN
    RETURN jsonb_build_object('shut', NULL, 'poll', NULL);
  END IF;
  SELECT q.id, q.title_ar, q.title_en, q.type_config AS config, least(q.closes_at, ev.ends_at) AS closes,
         least(q.closes_at, ev.ends_at) <= now() AS closed
  INTO poll_row
  FROM quest q JOIN category c ON c.id = q.category_id
  WHERE q.event_id = ev.id AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible AND q.poll_sent_at IS NOT NULL
    AND q.opens_at <= now() AND least(q.closes_at, ev.ends_at) > now() - interval '15 minutes'
    AND c.audience_kind IS NULL AND NOT c.hidden AND quest_community_lock(q) IS NULL
  ORDER BY (least(q.closes_at, ev.ends_at) > now()) DESC, q.opens_at DESC, q.id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('shut', NULL, 'poll', NULL);
  END IF;
  shown := poll_row.config -> 'live' ->> 'results' = 'after_vote'
           OR (poll_row.config -> 'live' ->> 'results' = 'at_close' AND poll_row.closed);
  SELECT count(DISTINCT v.enrollment_id) INTO people FROM quest_vote v WHERE v.quest_id = poll_row.id;
  RETURN jsonb_build_object('shut', NULL, 'poll', jsonb_build_object(
    'title', jsonb_build_object('ar', poll_row.title_ar, 'en', poll_row.title_en), 'closesAt', poll_row.closes,
    'closed', poll_row.closed, 'voters', people,
    'options', CASE WHEN shown THEN (
      SELECT jsonb_agg(jsonb_build_object('text', o -> 'text', 'votes',
                                          (SELECT count(*) FROM quest_vote v
                                           WHERE v.quest_id = poll_row.id AND v.option_id = o ->> 'id'))
                       ORDER BY t.pos)
      FROM jsonb_array_elements(poll_row.config -> 'options') WITH ORDINALITY AS t(o, pos)) END));
END $$;
REVOKE ALL ON FUNCTION screen_poll() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_poll() TO questify_app;
