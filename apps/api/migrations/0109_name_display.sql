-- T-615: name display (FR-1842, ADR-400, Q-367). An event shows its players by username, by full name or by both, to its
-- staff only or to every player in it. The full name is the answer to the event's "Full name" join field and nothing else.
--
-- Two gates, both in the database, so no client and no route can skip them:
--   1. the event's setting (`name_display`, `name_audience`), and
--   2. the player's own notice: the join card says who will see the name, the join sends back what it showed, and
--      `join_name_notice` keeps it on the enrollment (`name_notice`). A full name reaches other players only for an
--      enrollment whose notice is `everyone`; a player who joined before, or while only the staff were to see it, shows
--      by username whatever the event's setting says (`public_full_name`).
-- Widening to "everyone" is refused while a player who was not told is in the event (`event_name_display_guard`, ND409);
-- narrowing is always allowed. The staff reads (an operator's scan, the prize desk) need no per-player notice: the staff
-- already receive the answer the card disclosed, and the setting alone decides.
--
-- Closed by default: the new columns have no grant beyond the event's settings columns; `public_full_name`,
-- `staff_full_name` and `event_name_notice` are internal (no grant); the doors below are granted to questify_app only.
-- 0108 and earlier are untouched. Functions restated as they were, plus the name: screen_ranking, screen_finale,
-- operator_scan_subject, event_results, public_event_join_rules, my_invitations.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the setting and the notice
ALTER TABLE event
  ADD COLUMN name_display  text NOT NULL DEFAULT 'username' CHECK (name_display IN ('username', 'full_name', 'both')),
  ADD COLUMN name_audience text NOT NULL DEFAULT 'staff' CHECK (name_audience IN ('staff', 'everyone'));
GRANT UPDATE (name_display, name_audience) ON event TO questify_app;

-- Who the player was told would see their full name when they joined; NULL when the card said nothing about it.
ALTER TABLE enrollment ADD COLUMN name_notice text CHECK (name_notice IN ('staff', 'everyone'));

-- Who the join card must tell: the audience of a shown full name, NULL when the event shows usernames only. Internal.
CREATE FUNCTION event_name_notice(ev event) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN ev.name_display = 'username' THEN NULL ELSE ev.name_audience END
$$;
REVOKE ALL ON FUNCTION event_name_notice(event) FROM PUBLIC;

-- How other players are named in the event: the display when everyone may see it, else usernames. Internal.
CREATE FUNCTION event_player_names(ev event) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN ev.name_audience = 'everyone' THEN ev.name_display ELSE 'username' END
$$;
REVOKE ALL ON FUNCTION event_player_names(event) FROM PUBLIC;

-- The full name another player may see for an enrollment: the event shows it to everyone, the enrollment is active, the
-- player was told so when they joined, and they gave the name (its first 60 characters: a row is one line). NULL
-- otherwise. Internal: the definers below use it.
CREATE FUNCTION public_full_name(target_enrollment uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT left(a.value, 60)
  FROM enrollment n
  JOIN event e ON e.id = n.event_id
  JOIN event_join_field f ON f.event_id = e.id AND f.kind = 'full_name'
  JOIN join_answer a ON a.enrollment_id = n.id AND a.field_id = f.id
  WHERE n.id = target_enrollment AND n.status = 'active'
    AND e.name_audience = 'everyone' AND e.name_display <> 'username'
    AND n.name_notice = 'everyone'
$$;
REVOKE ALL ON FUNCTION public_full_name(uuid) FROM PUBLIC;

-- The part of a scene row that carries the full name: `{"fullName": ...}` where `public_full_name` answers, else `{}`, so
-- a screen of an event that shows usernames only receives exactly what it did before. Internal.
CREATE FUNCTION full_name_part(target_enrollment uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('fullName', public_full_name(target_enrollment))
                   WHERE public_full_name(target_enrollment) IS NOT NULL), '{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION full_name_part(uuid) FROM PUBLIC;

-- The part of a scene that says how players are named: `{"names": ...}` unless the screen shows usernames, else `{}`.
-- Internal.
CREATE FUNCTION names_part(ev event) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN event_player_names(ev) = 'username' THEN '{}'::jsonb
              ELSE jsonb_build_object('names', event_player_names(ev)) END
$$;
REVOKE ALL ON FUNCTION names_part(event) FROM PUBLIC;

-- The full name the event's staff may see for a player who joined, whatever the audience: NULL while the event shows
-- usernames only or the player gave none. The caller has checked the staff seat. Internal.
CREATE FUNCTION staff_full_name(target_event uuid, subject uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT a.value
  FROM event e
  JOIN enrollment n ON n.event_id = e.id AND n.player_id = subject
  JOIN event_join_field f ON f.event_id = e.id AND f.kind = 'full_name'
  JOIN join_answer a ON a.enrollment_id = n.id AND a.field_id = f.id
  WHERE e.id = target_event AND e.name_display <> 'username'
$$;
REVOKE ALL ON FUNCTION staff_full_name(uuid, uuid) FROM PUBLIC;

-- ================================================================ the guard on the setting
-- ND422: a full name needs the event's Full name join field. ND409: widening to everyone is refused while a player who
-- was not told is in the event (pending requests count; rehearsal accounts and operators do not). Joins read the event
-- FOR SHARE, so a change and a join run one after the other and this sees a join that committed first. The guard is a
-- definer so it sees every enrollment whatever the writer's row-level rules; the owner connection is trusted, told apart
-- by `session_user` because `current_user` is the function's owner here.
CREATE FUNCTION event_name_display_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF session_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NEW.name_display <> 'username'
     AND NOT EXISTS (SELECT 1 FROM event_join_field f WHERE f.event_id = NEW.id AND f.kind = 'full_name') THEN
    RAISE EXCEPTION 'a full name needs the Full name join field' USING ERRCODE = 'ND422', DETAIL = 'full_name_field';
  END IF;
  IF event_name_notice(NEW) IS NOT DISTINCT FROM 'everyone' AND event_name_notice(OLD) IS DISTINCT FROM 'everyone'
     AND EXISTS (SELECT 1 FROM enrollment n
                 WHERE n.event_id = NEW.id AND n.status IN ('active', 'pending')
                   AND coalesce(n.joined_via, '') NOT IN ('rehearsal', 'operator')
                   AND n.name_notice IS DISTINCT FROM 'everyone') THEN
    RAISE EXCEPTION 'players joined without being told their name would show' USING ERRCODE = 'ND409',
      DETAIL = 'name_display_locked';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_name_display_guard() FROM PUBLIC;
CREATE TRIGGER event_name_display_guard BEFORE UPDATE OF name_display, name_audience ON event
  FOR EACH ROW WHEN (OLD.name_display IS DISTINCT FROM NEW.name_display OR OLD.name_audience IS DISTINCT FROM NEW.name_audience)
  EXECUTE FUNCTION event_name_display_guard();

-- ================================================================ the join records the notice
-- Called by the API right after a join that made or renewed the enrollment, in the same transaction. `shown` is the
-- audience the card showed the player (NULL when it showed none). It must equal what the event requires now, else NN409
-- (DETAIL `<display>/<audience>/<answers|none>`, what the card must say now) and the join rolls back, so the player sees the card
-- again and nobody joins on a notice that was not true. Only the player's own, active or pending enrollment.
CREATE FUNCTION join_name_notice(target_enrollment uuid, shown text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  mine enrollment%ROWTYPE;
  ev event%ROWTYPE;
BEGIN
  SELECT n.* INTO mine FROM enrollment n
  WHERE n.id = target_enrollment AND n.player_id = me AND n.status IN ('active', 'pending');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not your enrollment' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = mine.event_id FOR SHARE;
  IF shown IS DISTINCT FROM event_name_notice(ev) THEN
    RAISE EXCEPTION 'the name notice changed' USING ERRCODE = 'NN409', DETAIL = ev.name_display || '/' || ev.name_audience || '/'
        || CASE WHEN EXISTS (SELECT 1 FROM event_join_field f WHERE f.event_id = ev.id) THEN 'answers' ELSE 'none' END;
  END IF;
  UPDATE enrollment n SET name_notice = shown WHERE n.id = mine.id;
END $$;
REVOKE ALL ON FUNCTION join_name_notice(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_name_notice(uuid, text) TO questify_app;

-- ================================================================ the join card
-- As 0028 plus the event's name setting, so the card can say who sees the name. Return types change: dropped and made again.
DROP FUNCTION public_event_join_rules(text);
CREATE FUNCTION public_event_join_rules(code text)
  RETURNS TABLE (guest_list_only boolean, email_domains text[], welcome_points integer, fields jsonb,
                 name_display text, name_audience text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.guest_list_only, e.email_domains, e.welcome_points, event_join_fields_json(e.id), e.name_display,
         e.name_audience
  FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
$$;
REVOKE ALL ON FUNCTION public_event_join_rules(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_event_join_rules(text) TO questify_app;

DROP FUNCTION my_invitations();
CREATE FUNCTION my_invitations()
  RETURNS TABLE (id uuid, name_ar text, name_en text, venue_ar text, venue_en text, kind text, timezone text,
                 starts_at timestamptz, ends_at timestamptz, status_now text, access text, email_domains text[],
                 welcome_points integer, fields jsonb, name_display text, name_audience text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT pc.phone_e164, pc.email, p.id FROM player p JOIN player_contact pc ON pc.player_id = p.id
    WHERE p.id = app_player_id() AND p.status = 'active'
  )
  SELECT e.id, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at), e.access, e.email_domains, e.welcome_points,
         event_join_fields_json(e.id), e.name_display, e.name_audience
  FROM me
  JOIN event e ON e.id IN (
    SELECT g.event_id FROM event_guest g
    WHERE (g.kind = 'phone' AND g.value = me.phone_e164) OR (g.kind = 'email' AND g.value = me.email))
  WHERE event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = e.id AND n.player_id = me.id
                    AND n.status NOT IN ('left', 'pending', 'declined'))
  ORDER BY e.starts_at, e.id
  LIMIT 20
$$;
REVOKE ALL ON FUNCTION my_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_invitations() TO questify_app;

-- ================================================================ what a player reads
-- How the event names other players, for a player who reads its ranking: 'username', 'full_name' or 'both'. NULL for
-- anyone who is not an active player of the event.
CREATE FUNCTION player_name_display(target uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT event_player_names(e) FROM event e WHERE e.id = target AND ranking_reader_enrollment(target) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION player_name_display(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_name_display(uuid) TO questify_app;

-- The full names of the enrollments in `ids` (ranked rows the API read itself) that the reader may see: QR403 unless the
-- caller is an active player of the event, and a row only where `public_full_name` answers.
CREATE FUNCTION ranking_names(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, full_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT n.id, x.name
    FROM enrollment n, LATERAL (SELECT public_full_name(n.id) AS name) x
    WHERE n.id = ANY (ids) AND n.event_id = target AND x.name IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION ranking_names(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_names(uuid, uuid[]) TO questify_app;

-- As 0034 plus `full_name` and `names` (how the event names players), through `public_full_name`.
DROP FUNCTION event_results(uuid);
CREATE FUNCTION event_results(target uuid)
  RETURNS TABLE (rank integer, username text, avatar text, score bigint, prize_kind text, prize_name_ar text,
                 prize_name_en text, mine boolean, redemption_id uuid, redemption_status text,
                 claim_until timestamptz, full_name text, names text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT x.rank, p.username, p.avatar, x.score, k.kind, k.name_ar, k.name_en, x.enrollment_id = me.id,
         CASE WHEN x.enrollment_id = me.id THEN d.id END, CASE WHEN x.enrollment_id = me.id THEN d.status END,
         res.claim_until, public_full_name(n.id), event_player_names(ev)
  FROM me
  JOIN event ev ON ev.id = target
  JOIN event_result res ON res.event_id = target AND res.revealed_at IS NOT NULL
  JOIN result_place x ON x.event_id = res.event_id
  JOIN enrollment n ON n.id = x.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN rank_prize k ON k.id = x.rank_prize_id
  LEFT JOIN redemption d ON d.id = x.redemption_id
  ORDER BY x.rank
$$;
REVOKE ALL ON FUNCTION event_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_results(uuid) TO questify_app;

-- ================================================================ what the big screen reads
-- As 0106 plus `names` (how the event names players on the screen: its display when everyone may see it) and, in each
-- row, `fullName` where `public_full_name` answers; both are left out for an event that shows usernames, so its screen
-- receives what it did before. Every other rule of 0106 is unchanged.
CREATE OR REPLACE FUNCTION screen_ranking() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev          event := screen_event();
  shut        text := screen_shut(ev);
  looks       jsonb := ev.config #> '{layout,looks,ranking}';
  show_scores boolean;
BEGIN
  IF shut IS NULL AND NOT ranking_on(ev) THEN
    shut := 'ranking_off';
  END IF;
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  show_scores := looks IS NULL
    OR (jsonb_typeof(looks) = 'object' AND ((looks -> 'scores') IS NULL OR looks -> 'scores' = '"shown"'::jsonb));
  RETURN jsonb_build_object('shut', NULL, 'rows', coalesce((
    SELECT jsonb_agg(
      CASE WHEN show_scores
           THEN jsonb_build_object('place', u.place, 'username', p.username, 'avatar', p.avatar, 'score', e.score)
           ELSE jsonb_build_object('place', u.place, 'username', p.username, 'avatar', p.avatar) END
           || full_name_part(e.id)
      ORDER BY u.place)
    FROM unnest(rank_top_ten_ids(ev.id)) WITH ORDINALITY AS u(enrollment_id, place)
    JOIN enrollment e ON e.id = u.enrollment_id
    JOIN player p ON p.id = e.player_id), '[]'::jsonb)) || names_part(ev);
END $$;
REVOKE ALL ON FUNCTION screen_ranking() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_ranking() TO questify_app;

-- As 0084 plus `names` and, in each winner, `fullName` where `public_full_name` answers.
CREATE OR REPLACE FUNCTION screen_finale() RETURNS jsonb
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
        SELECT jsonb_agg(jsonb_build_object('place', x.rank, 'username', p.username, 'avatar', p.avatar)
                         || full_name_part(n.id) ORDER BY x.rank)
        FROM result_place x
        JOIN enrollment n ON n.id = x.enrollment_id
        JOIN player p ON p.id = n.player_id
        WHERE x.event_id = ev.id AND x.rank <= 10), '[]'::jsonb)) || names_part(ev));
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

-- ================================================================ what the staff read
-- As 0026 plus `full_name`: the name the event's staff may see while the event shows full names (any audience).
DROP FUNCTION operator_scan_subject(uuid, uuid);
CREATE FUNCTION operator_scan_subject(target uuid, scanned uuid)
  RETURNS TABLE (username text, avatar text, full_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.username, p.avatar, staff_full_name(q.event_id, scanned)
  FROM quest q
  JOIN staff_assignment sa ON sa.event_id = q.event_id AND sa.player_id = app_player_id()
  JOIN enrollment e ON e.event_id = q.event_id AND e.player_id = scanned
  JOIN player p ON p.id = scanned
  WHERE q.id = target
$$;
REVOKE ALL ON FUNCTION operator_scan_subject(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_scan_subject(uuid, uuid) TO questify_app;

-- The full name of the player a prize-desk operator just found by username, while the event shows full names. The desk
-- seat is checked (OP403/OA403 as desk_operator raises them); NULL for a player who is not in the event or gave none.
CREATE FUNCTION desk_full_name(target_event uuid, by_username text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM desk_operator(target_event, app_player_id());
  RETURN (SELECT staff_full_name(target_event, p.id) FROM player p
          WHERE username_fold(p.username) = username_fold(by_username) LIMIT 1);
END $$;
REVOKE ALL ON FUNCTION desk_full_name(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_full_name(uuid, text) TO questify_app;
