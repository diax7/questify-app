-- T-510: default notification topics per event (FR-1836; plan docs/plans/2026-10-31-t-510-topic-defaults.md; ADR-379).
-- An event may start some of the four push topics (ADR-347) OFF for its players. The default is a layer under the player's
-- own choice: a player who turned a topic on (`push_topic_on`) or muted it (`push_topic_mute`) is never overruled; a
-- player who never chose follows the event of the notice. Read where a push is planned (push_plan) and again at the claim
-- (push_skip_reason); the center row is written either way. A kind with no topic, a notice with no event and the streak
-- reminder (no event) ignore the layer. The layer only ever turns pushes off, so it can send nothing new.
-- Deny by default: the two new tables keep row-level security forced and no grant; every function is closed to PUBLIC in
-- the group that creates it and only the three doors are granted to the API role. No EXCEPTION block. Migrations 0090 and
-- earlier untouched; push_plan, push_skip_reason, own_push_topics, set_push_topics and erase_rows are restated and
-- push_muted gains the event.
SET LOCAL lock_timeout = '10s';
-- The event and the player are foreign-key targets of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE player IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the vocabulary and the check (internal)
-- The four topics there are, as in push_topic_mute's check.
CREATE FUNCTION push_topics_all() RETURNS text[]
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY['announcements', 'rank', 'community', 'reminders']::text[]
$$;
REVOKE ALL ON FUNCTION push_topics_all() FROM PUBLIC;

-- PN422 `topics` for an unknown topic (a NULL one included) or a topic named in both lists.
CREATE FUNCTION push_topics_checked(turn_on text[], turn_off text[]) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(turn_on || turn_off) AS t (topic) WHERE t.topic IS NULL OR t.topic <> ALL (push_topics_all()))
     OR turn_on && turn_off THEN
    RAISE EXCEPTION 'a topic is announcements, rank, community or reminders, and named once' USING ERRCODE = 'PN422', DETAIL = 'topics';
  END IF;
END $$;
REVOKE ALL ON FUNCTION push_topics_checked(text[], text[]) FROM PUBLIC;

-- ================================================================ the tables
-- A topic that starts OFF for an event's players; no row means it starts on. Setup, like the event's switches: the
-- rehearsal wipe keeps it. It goes with its event.
CREATE TABLE event_topic_off (
  event_id     uuid NOT NULL,
  organizer_id uuid NOT NULL,
  topic        text NOT NULL CHECK (topic IN ('announcements', 'rank', 'community', 'reminders')),
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, topic),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE event_topic_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_topic_off FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_topic_off FROM PUBLIC, questify_app;

-- A topic the player turned on themselves, for every event (the mirror of push_topic_mute). It is what keeps an event's
-- default from overruling a choice the player made. Personal data of the player: erased with the account.
CREATE TABLE push_topic_on (
  player_id uuid NOT NULL REFERENCES player (id),
  topic     text NOT NULL CHECK (topic IN ('announcements', 'rank', 'community', 'reminders')),
  chosen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, topic)
);
ALTER TABLE push_topic_on ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_topic_on FORCE ROW LEVEL SECURITY;
REVOKE ALL ON push_topic_on FROM PUBLIC, questify_app;

-- ================================================================ the layer (internal)
-- Whether a push on `muted_topic` for the notice's event (`for_event`, NULL when it has none) must not go to the player:
-- they muted it, or they never chose it and the event starts it off. A NULL topic cannot be muted. Replaces the two-argument
-- push_muted of 0076; its two callers are restated below.
CREATE FUNCTION push_muted(who uuid, muted_topic text, for_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT muted_topic IS NOT NULL
     AND (EXISTS (SELECT 1 FROM push_topic_mute m WHERE m.player_id = who AND m.topic = muted_topic)
          OR (EXISTS (SELECT 1 FROM event_topic_off d WHERE d.event_id = for_event AND d.topic = muted_topic)
              AND NOT EXISTS (SELECT 1 FROM push_topic_on o WHERE o.player_id = who AND o.topic = muted_topic)))
$$;
REVOKE ALL ON FUNCTION push_muted(uuid, text, uuid) FROM PUBLIC;

-- 0076's push_plan with the event passed to push_muted.
CREATE OR REPLACE FUNCTION push_plan(made bigint[]) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH planned AS (
    INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at)
    SELECT c.id, d.id, nt.id, push_target(d.platform, d.environment), k.priority, nt.expires_at
    FROM notification c
    JOIN notice nt ON nt.id = c.notice_id
    JOIN notice_kind k ON k.kind = nt.kind
    JOIN push_live_devices() d ON d.player_id = c.player_id
    LEFT JOIN event e ON e.id = nt.event_id
    WHERE c.id = ANY (made) AND nt.expires_at > now()
      AND e.status IS DISTINCT FROM 'archived'
      AND NOT push_muted(c.player_id, k.topic, nt.event_id)
      AND (k.class <> 'promo' OR push_consented(c.player_id))
    ORDER BY c.id, d.id
    ON CONFLICT (notification_id, device_id) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer FROM planned
$$;
REVOKE ALL ON FUNCTION push_plan(bigint[]) FROM PUBLIC;

-- 0079's push_skip_reason with the event passed to push_muted: the claim checks the layer again.
CREATE OR REPLACE FUNCTION push_skip_reason(send bigint) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  SELECT p.status AS player_status, c.player_id AS recipient, e.status AS event_status, d AS device, k.class,
         k.topic, nt AS note, n AS member
  INTO r
  FROM push_send s
  JOIN notification c ON c.id = s.notification_id
  JOIN notice nt ON nt.id = c.notice_id
  JOIN notice_kind k ON k.kind = nt.kind
  JOIN push_device d ON d.id = s.device_id
  LEFT JOIN player p ON p.id = c.player_id
  LEFT JOIN event e ON e.id = nt.event_id
  LEFT JOIN enrollment n ON n.event_id = nt.event_id AND n.player_id = c.player_id
  WHERE s.id = send;
  RETURN CASE
    WHEN r.player_status IS DISTINCT FROM 'active' THEN 'player'
    WHEN r.event_status = 'archived' THEN 'archived'
    WHEN (r.device).player_id <> r.recipient OR NOT push_pushable(r.device) THEN 'device'
    WHEN r.class = 'promo' AND NOT push_consented(r.recipient) THEN 'consent'
    WHEN push_muted(r.recipient, r.topic, (r.note).event_id) THEN 'muted'
    WHEN NOT notice_membership_ok(r.note, r.member) THEN 'not_member'
    WHEN (r.note).event_id IS NOT NULL AND NOT notice_visible(r.note, r.member) THEN 'not_visible'
    WHEN NOT notice_audience_ok(r.note, r.member) THEN 'not_member'
  END;
END $$;
REVOKE ALL ON FUNCTION push_skip_reason(bigint) FROM PUBLIC;

DROP FUNCTION push_muted(uuid, text);

-- Where one topic stands for a player, for the Settings switch: `muted` and `on` are their own choices; otherwise
-- `event_off` when an event they are an active member of (not archived) starts the topic off, else `default` (on).
CREATE FUNCTION push_topic_state(who uuid, wanted text) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM push_topic_mute m WHERE m.player_id = who AND m.topic = wanted) THEN 'muted'
    WHEN EXISTS (SELECT 1 FROM push_topic_on o WHERE o.player_id = who AND o.topic = wanted) THEN 'on'
    WHEN EXISTS (SELECT 1 FROM enrollment n
                 JOIN event e ON e.id = n.event_id AND e.status <> 'archived'
                 JOIN event_topic_off d ON d.event_id = e.id AND d.topic = wanted
                 WHERE n.player_id = who AND n.status = 'active') THEN 'event_off'
    ELSE 'default'
  END
$$;
REVOKE ALL ON FUNCTION push_topic_state(uuid, text) FROM PUBLIC;

-- The event's four topics, true when they start on.
CREATE FUNCTION event_topic_defaults_json(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_object_agg(t.topic, NOT EXISTS (SELECT 1 FROM event_topic_off d WHERE d.event_id = target AND d.topic = t.topic))
  FROM unnest(push_topics_all()) AS t (topic)
$$;
REVOKE ALL ON FUNCTION event_topic_defaults_json(uuid) FROM PUBLIC;

-- ================================================================ the player's doors
-- The caller's four topics, true when on. A topic the player never chose is off while an event they are in starts it off;
-- `eventOff` names those topics, so the app can say why a switch the player never touched is off.
CREATE OR REPLACE FUNCTION own_push_topics() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  RETURN (SELECT jsonb_object_agg(s.topic, s.state IN ('on', 'default'))
                 || jsonb_build_object('eventOff',
                      coalesce(jsonb_agg(s.topic ORDER BY s.position) FILTER (WHERE s.state = 'event_off'), '[]'::jsonb))
          FROM (SELECT t.topic, t.position, push_topic_state(who, t.topic) AS state
                FROM unnest(push_topics_all()) WITH ORDINALITY AS t (topic, position)) s);
END $$;
REVOKE ALL ON FUNCTION own_push_topics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_push_topics() TO questify_app;

-- Changes the topics named and keeps the others (a topic in `turn_on` becomes the player's own "on", one in `muted` their
-- own mute); PN422 `topics` for an unknown topic or one named in both lists. Answers the four topics. Replaces the
-- muted-set form of 0076.
CREATE FUNCTION set_push_topics(turn_on text[], muted text[]) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
  want_on  text[] := coalesce(turn_on, '{}'::text[]);
  want_off text[] := coalesce(muted, '{}'::text[]);
BEGIN
  PERFORM push_topics_checked(want_on, want_off);
  DELETE FROM push_topic_mute m WHERE m.player_id = who AND m.topic = ANY (want_on);
  DELETE FROM push_topic_on o WHERE o.player_id = who AND o.topic = ANY (want_off);
  INSERT INTO push_topic_on (player_id, topic)
  SELECT DISTINCT who, t.topic FROM unnest(want_on) AS t (topic)
  ON CONFLICT (player_id, topic) DO NOTHING;
  INSERT INTO push_topic_mute (player_id, topic)
  SELECT DISTINCT who, t.topic FROM unnest(want_off) AS t (topic)
  ON CONFLICT (player_id, topic) DO NOTHING;
  RETURN own_push_topics();
END $$;
REVOKE ALL ON FUNCTION set_push_topics(text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_push_topics(text[], text[]) TO questify_app;
DROP FUNCTION set_push_topics(text[]);

-- ================================================================ the team's doors
-- The event's default topics for its team (AN404 for any other event): true when the topic starts on.
CREATE FUNCTION event_push_defaults(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN event_topic_defaults_json(ev.id);
END $$;
REVOKE ALL ON FUNCTION event_push_defaults(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_push_defaults(uuid) TO questify_app;

-- Changes the event's defaults for the topics named and keeps the others: `starts_on` topics start on, `starts_off` topics
-- start off. Owner or editor (award_event_of; AN404 any other event); PN422 `topics` for an unknown topic or one named
-- twice. Takes the event's row so two changes do not interleave. Audited `push.defaults` (before and after) when
-- something changed. Answers the four topics.
CREATE FUNCTION set_event_push_defaults(target_event uuid, starts_on text[], starts_off text[], request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  want_on   text[] := coalesce(starts_on, '{}'::text[]);
  want_off  text[] := coalesce(starts_off, '{}'::text[]);
  was       jsonb;
  now_is    jsonb;
BEGIN
  PERFORM push_topics_checked(want_on, want_off);
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR NO KEY UPDATE;
  was := event_topic_defaults_json(ev.id);
  DELETE FROM event_topic_off d WHERE d.event_id = ev.id AND d.topic = ANY (want_on);
  INSERT INTO event_topic_off (event_id, organizer_id, topic)
  SELECT DISTINCT ev.id, ev.organizer_id, t.topic FROM unnest(want_off) AS t (topic)
  ON CONFLICT (event_id, topic) DO NOTHING;
  now_is := event_topic_defaults_json(ev.id);
  IF now_is <> was THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                           request_id)
    VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'push.defaults', 'event', ev.id::text, was, now_is,
            request);
  END IF;
  RETURN now_is;
END $$;
REVOKE ALL ON FUNCTION set_event_push_defaults(uuid, text[], text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_event_push_defaults(uuid, text[], text[], uuid) TO questify_app;

-- ================================================================ erasure
-- 0076's body plus the player's own "on" topics.
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
  DELETE FROM souvenir_receipt WHERE player_id = me;
  PERFORM set_config('app.erasure','',true);
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  DELETE FROM marketing_consent WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM marketing_state WHERE player_id = me;
  DELETE FROM player_preference WHERE player_id = me;
  DELETE FROM invitation_recipient WHERE player_id = me;
  DELETE FROM notice WHERE player_id = me;
  DELETE FROM notification WHERE player_id = me;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = me;
  DELETE FROM push_device WHERE player_id = me;
  DELETE FROM push_topic_mute WHERE player_id = me;
  DELETE FROM push_topic_on WHERE player_id = me;
  DELETE FROM player_fingerprint WHERE player_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM ticket WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  -- Last: the staff_assignment delete above enqueues while the enrollments are still active (enqueue_souvenir_on_staff).
  DELETE FROM souvenir_work WHERE enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid,uuid[],bytea) FROM PUBLIC;
