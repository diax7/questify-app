-- T-509: Cheers (FR-1841, F-343; plan docs/plans/2026-10-31-t-509-cheers.md; ADR-377). The owner starts a cheers moment on the
-- event's big screen for a few minutes; while it is live the app shows a cheer button with five fixed reactions (heart,
-- applause, fire, star, party) and the big screen runs a Cheers scene that floats them up. No free text, so nothing to
-- moderate, and nothing on the screen names a player. A player may send a limited number of cheers a minute (the database
-- counts them, so the limit holds however many servers run). The event's own Cheers switch (`config.features.cheers`, on by
-- default) and the platform's switch end every effect at once; starting a moment needs the big-screen add-on.
-- Deny by default: the two new tables keep row-level security forced and no grant; every function is closed to PUBLIC in the
-- group that creates it and only the doors are granted to the API role. No EXCEPTION block. Migrations 0089 and earlier
-- untouched; big_screen_running() is restated (0084's body with a live moment running alone).
SET LOCAL lock_timeout = '10s';
-- The event and the enrollment are foreign-key targets of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE enrollment IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ small rules (internal)
-- The five reactions there are: the vocabulary of the table, the door and the screen.
CREATE FUNCTION cheers_reactions() RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY['heart', 'applause', 'fire', 'star', 'party']::text[]
$$;
REVOKE ALL ON FUNCTION cheers_reactions() FROM PUBLIC;

-- How many cheers one player may send in any 60 seconds.
CREATE FUNCTION cheers_per_minute() RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 30
$$;
REVOKE ALL ON FUNCTION cheers_per_minute() FROM PUBLIC;

-- ================================================================ the tables
-- The event's cheers moment: at most one row per event, replaced when the owner starts the next one. It is live while
-- `ends_at` is in the future; Stop sets `ends_at` to now. The rehearsal wipe keeps it (setup, as the finale).
CREATE TABLE cheers_moment (
  event_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ends_at      timestamptz NOT NULL,
  started_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  CHECK (ends_at >= started_at),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE cheers_moment ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheers_moment FORCE ROW LEVEL SECURITY;
REVOKE ALL ON cheers_moment FROM PUBLIC, questify_app;

-- One cheer. Append-only within a moment; starting the next moment clears the last one's cheers, so the table holds only the
-- current moment of each event. Personal data (it names the enrollment, for the per-minute limit only): it goes with the
-- enrollment (a deleted account, the rehearsal wipe) and with its event. No screen and no team door reads who sent it.
CREATE TABLE cheer (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  reaction      text NOT NULL CHECK (reaction = ANY (cheers_reactions())),
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE CASCADE
);
CREATE INDEX cheer_by_player ON cheer (enrollment_id, created_at DESC);
CREATE INDEX cheer_by_event ON cheer (event_id, id DESC);
ALTER TABLE cheer ENABLE ROW LEVEL SECURITY;
ALTER TABLE cheer FORCE ROW LEVEL SECURITY;
REVOKE ALL ON cheer FROM PUBLIC, questify_app;

-- ================================================================ when cheers are live (internal)
-- The end of the event's live moment, or NULL: the event is live, the big-screen add-on is active, and neither the event's
-- nor the platform's Cheers switch is off, and a moment has not ended. Everything that shows or takes a cheer asks this.
CREATE FUNCTION cheers_live_until(ev event) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT m.ends_at FROM cheers_moment m
  WHERE m.event_id = ev.id AND m.ends_at > now() AND feature_enabled(ev, 'cheers') AND big_screen_on(ev)
    AND event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live'
$$;
REVOKE ALL ON FUNCTION cheers_live_until(event) FROM PUBLIC;

-- The Big screen page's reading: the add-on, the event's own switch, whether the platform allows Cheers, and the live moment.
CREATE FUNCTION cheers_json(ev event) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'enabled', big_screen_on(ev),
    'switch', coalesce(ev.config -> 'features' -> 'cheers' <> 'false'::jsonb, true),
    'platformOn', coalesce((SELECT s.value -> 'cheers' -> 'enabled' <> 'false'::jsonb
                            FROM platform_setting s WHERE s.key = 'features'), true),
    'live', (SELECT jsonb_build_object('startedAt', m.started_at, 'endsAt', m.ends_at)
             FROM cheers_moment m WHERE m.event_id = ev.id AND cheers_live_until(ev) IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION cheers_json(event) FROM PUBLIC;

-- ================================================================ the team's doors
-- The event's Cheers reading for its team (AN404 for any other event).
CREATE FUNCTION event_cheers(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN cheers_json(ev);
END $$;
REVOKE ALL ON FUNCTION event_cheers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_cheers(uuid) TO questify_app;

-- Starts a cheers moment of 1 to 30 minutes now, replacing the last one and clearing its cheers. Owner only (CH403); AN404
-- other event; BS403 add-on off; CH409 `cheers_off` (the event's or the platform's switch) or `not_live` (the event is not
-- live); CH422 `minutes`. Audited `cheers.start` with the minutes and the end.
CREATE FUNCTION start_cheers_moment(target_event uuid, minutes integer, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  ending  timestamptz;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner starts a cheers moment' USING ERRCODE = 'CH403';
  END IF;
  IF NOT big_screen_on(ev) THEN
    RAISE EXCEPTION 'the big screen is not active for this event' USING ERRCODE = 'BS403';
  END IF;
  IF NOT feature_enabled(ev, 'cheers') THEN
    RAISE EXCEPTION 'cheers are off for this event' USING ERRCODE = 'CH409', DETAIL = 'cheers_off';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'live' THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'CH409', DETAIL = 'not_live';
  END IF;
  IF minutes IS NULL OR minutes < 1 OR minutes > 30 THEN
    RAISE EXCEPTION 'a moment lasts 1 to 30 minutes' USING ERRCODE = 'CH422', DETAIL = 'minutes';
  END IF;
  ending := now() + minutes * interval '1 minute';
  DELETE FROM cheer c WHERE c.event_id = ev.id;
  INSERT INTO cheers_moment (event_id, organizer_id, started_at, ends_at, started_by)
  VALUES (ev.id, ev.organizer_id, now(), ending, app_staff_user_id())
  ON CONFLICT (event_id) DO UPDATE
  SET started_at = excluded.started_at, ends_at = excluded.ends_at, started_by = excluded.started_by;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'cheers.start', 'event', ev.id::text,
          jsonb_build_object('minutes', minutes, 'endsAt', ending), request);
  RETURN cheers_json(ev);
END $$;
REVOKE ALL ON FUNCTION start_cheers_moment(uuid, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_cheers_moment(uuid, integer, uuid) TO questify_app;

-- Ends the live moment now; the screen goes back to its scenes and the app's button goes. Owner only (CH403); AN404 other
-- event. No live moment changes nothing. Audited `cheers.stop`.
CREATE FUNCTION stop_cheers_moment(target_event uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  stopped cheers_moment%ROWTYPE;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner stops a cheers moment' USING ERRCODE = 'CH403';
  END IF;
  UPDATE cheers_moment m SET ends_at = greatest(m.started_at, now())
  WHERE m.event_id = ev.id AND m.ends_at > now() RETURNING * INTO stopped;
  IF FOUND THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                           request_id)
    VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'cheers.stop', 'event', ev.id::text,
            jsonb_build_object('startedAt', stopped.started_at), request);
  END IF;
  RETURN cheers_json(ev);
END $$;
REVOKE ALL ON FUNCTION stop_cheers_moment(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stop_cheers_moment(uuid, uuid) TO questify_app;

-- ================================================================ the player's doors
-- The caller's enrollment in the event: an active person (never a paired device) in a living, not archived event. NULL
-- otherwise, so an unknown event and a stranger's event answer alike. Internal.
CREATE FUNCTION cheers_member(target_event uuid) RETURNS enrollment
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT n.* FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN event e ON e.id = n.event_id AND e.status <> 'archived'
  WHERE n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active' AND app_device_id() IS NULL
$$;
REVOKE ALL ON FUNCTION cheers_member(uuid) FROM PUBLIC;

-- Whether the event has a live moment, for anyone: the API's 3-second cache asks it before any per-player read, so an event
-- with no moment costs one answer per few seconds. It says nothing else.
CREATE FUNCTION event_has_cheers(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT cheers_live_until(e) IS NOT NULL FROM event e WHERE e.id = target), false)
$$;
REVOKE ALL ON FUNCTION event_has_cheers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_has_cheers(uuid) TO questify_app;

-- What the app needs to decide whether to show the cheer button: the end of the live moment, or NULL when none is live or the
-- caller is not an active member of the event.
CREATE FUNCTION member_cheers(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := cheers_member(target_event);
  ending timestamptz;
BEGIN
  IF member.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT cheers_live_until(e) INTO ending FROM event e WHERE e.id = member.event_id;
  RETURN CASE WHEN ending IS NULL THEN NULL ELSE jsonb_build_object('endsAt', ending) END;
END $$;
REVOKE ALL ON FUNCTION member_cheers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_cheers(uuid) TO questify_app;

-- The player sends one cheer. CH404 (not an active member of the event), CH422 (not one of the five), CH409 `not_live` (no
-- live moment), CH429 (over the per-minute limit: the DETAIL is the seconds to wait). One player's sends are serialized, so
-- the limit holds under any number of taps at once. Writes nothing to the points record: a cheer pays nothing.
CREATE FUNCTION send_cheer(target_event uuid, new_reaction text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := cheers_member(target_event);
  frees  timestamptz;
BEGIN
  IF member.id IS NULL THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'CH404';
  ELSIF new_reaction IS NULL OR NOT (new_reaction = ANY (cheers_reactions())) THEN
    RAISE EXCEPTION 'send one of the five reactions' USING ERRCODE = 'CH422';
  ELSIF NOT EXISTS (SELECT 1 FROM event e WHERE e.id = member.event_id AND cheers_live_until(e) IS NOT NULL) THEN
    RAISE EXCEPTION 'no cheers moment is live' USING ERRCODE = 'CH409', DETAIL = 'not_live';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cheer:' || member.id, 0));
  SELECT c.created_at + interval '60 seconds' INTO frees
  FROM cheer c WHERE c.enrollment_id = member.id AND c.created_at > now() - interval '60 seconds'
  ORDER BY c.created_at DESC OFFSET cheers_per_minute() - 1 LIMIT 1;
  IF frees IS NOT NULL THEN
    RAISE EXCEPTION 'too many cheers' USING ERRCODE = 'CH429',
      DETAIL = greatest(1, ceil(extract(epoch FROM frees - now())))::text;
  END IF;
  INSERT INTO cheer (organizer_id, event_id, enrollment_id, reaction)
  VALUES (member.organizer_id, member.event_id, member.id, new_reaction);
  RETURN jsonb_build_object('sent', true);
END $$;
REVOKE ALL ON FUNCTION send_cheer(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_cheer(uuid, text) TO questify_app;

-- ================================================================ what a screen may read
-- The scenes the screen runs now: a live cheers moment alone (the owner chose it), else as 0084 (the picked list, then the
-- finale last while one is set; from its time on, and for good once the event has ended, the finale alone). Internal.
CREATE OR REPLACE FUNCTION big_screen_running(ev event) RETURNS text[]
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN cheers_live_until(ev) IS NOT NULL THEN ARRAY['cheers']::text[]
              WHEN f.event_id IS NULL THEN big_screen_plan(ev)
              WHEN f.starts_at <= now() OR event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
                THEN ARRAY['finale']::text[]
              ELSE big_screen_plan(ev) || ARRAY['finale']::text[] END
  FROM (SELECT 1) base LEFT JOIN finale f ON f.event_id = ev.id
$$;

-- The Cheers scene: `shut` says why nothing shows (archived, add-on off); `cheers` is NULL while no moment is live. Live, it
-- holds the end, the count of each reaction in the moment, the total and the newest 40 cheers in order, each a sequence
-- number and a reaction only (the page floats the ones it has not shown). Nothing names or counts a player.
CREATE FUNCTION screen_cheers() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := screen_event();
  shut   text := CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'archived' THEN 'event_ended'
                      WHEN NOT big_screen_on(ev) THEN 'feature_off' END;
  ending timestamptz;
BEGIN
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  ending := cheers_live_until(ev);
  IF ending IS NULL THEN
    RETURN jsonb_build_object('shut', NULL, 'cheers', NULL);
  END IF;
  RETURN jsonb_build_object('shut', NULL, 'cheers', jsonb_build_object(
    'endsAt', ending,
    'totals', (SELECT jsonb_object_agg(r.reaction, coalesce(n.sent, 0))
               FROM unnest(cheers_reactions()) AS r(reaction)
               LEFT JOIN (SELECT c.reaction, count(*) AS sent FROM cheer c WHERE c.event_id = ev.id
                          GROUP BY c.reaction) n ON n.reaction = r.reaction),
    'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('seq', k.id, 'reaction', k.reaction) ORDER BY k.id)
                        FROM (SELECT c.id, c.reaction FROM cheer c WHERE c.event_id = ev.id
                              ORDER BY c.id DESC LIMIT 40) k), '[]'::jsonb)));
END $$;
REVOKE ALL ON FUNCTION screen_cheers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_cheers() TO questify_app;
