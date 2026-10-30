-- T-508: quest ratings and survey results (FR-1209, FR-1210, FR-1211, FR-1623, FR-1624; plan
-- docs/plans/2026-10-30-t-508-ratings-survey-results.md; ADR-376). A player who completed a quest may rate it with a
-- thumb up or down, or skip, while the owner has switched ratings on for the event; the team reads each quest's counts.
-- The owner or an editor shares one survey quest's results with its speaker through a link: the speaker holds no account,
-- the link holds a random token whose hash is the only thing stored, and what it opens is the quest's totals, counts,
-- averages and text answers, never a name. The results themselves are computed by one internal function that the team's
-- door (survey_summary, restated here with the same answer) and the speaker's door share. Deny by default: the two new
-- tables keep row-level security forced and no grant; every function is closed to PUBLIC in the group that creates it and
-- only the doors are granted to the API role. No EXCEPTION block. Migrations 0088 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- The event, the enrollment and the quest are foreign-key targets of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE enrollment IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quest IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the tables (ADR-376 (2))
-- A rating: one per player and quest, a thumb or a recorded skip (a skipped prompt does not come back). Personal data: it
-- goes with the enrollment (a deleted account, the rehearsal wipe) and with its quest. Nothing but the team's counts and
-- the player's own row ever reads it.
CREATE TABLE quest_rating (
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  quest_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  thumb         text NOT NULL CHECK (thumb IN ('up', 'down', 'skip')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, quest_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE
);
CREATE INDEX quest_rating_quest ON quest_rating (quest_id, thumb);
ALTER TABLE quest_rating ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_rating FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_rating FROM PUBLIC, questify_app;

-- A survey quest's share link: at most one per quest (making a new link replaces the old one, which stops working at
-- once). Only the SHA-256 of the token is stored, so a copy of the database opens nothing. It goes with its quest.
CREATE TABLE survey_share (
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  quest_id     uuid NOT NULL PRIMARY KEY,
  token_hash   text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE
);
ALTER TABLE survey_share ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_share FORCE ROW LEVEL SECURITY;
REVOKE ALL ON survey_share FROM PUBLIC, questify_app;

-- ================================================================ quest ratings (ADR-376 (3))
-- The event's own switch (`config.features.questRatings`): on only when the owner set it to true (FR-1623). The platform's
-- switch is composed by the API (T-007), as the share quests' is.
CREATE FUNCTION quest_ratings_on(target_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT e.config -> 'features' -> 'questRatings' = 'true'::jsonb FROM event e WHERE e.id = target_event),
                  false)
$$;
REVOKE ALL ON FUNCTION quest_ratings_on(uuid) FROM PUBLIC;

-- The caller's enrollment for a quest: the quest's event not archived, the caller an active member of it and a person (a
-- paired device is never a member). NULL otherwise, so an unknown quest and a stranger's quest answer alike.
CREATE FUNCTION rating_member(target uuid) RETURNS enrollment
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT n.* FROM quest x
  JOIN enrollment n ON n.event_id = x.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN event e ON e.id = x.event_id AND e.status <> 'archived'
  WHERE x.id = target AND app_device_id() IS NULL
$$;
REVOKE ALL ON FUNCTION rating_member(uuid) FROM PUBLIC;

-- The player rates a quest they completed: 'up', 'down' or 'skip'. A thumb replaces an earlier thumb or skip (the player
-- may change their mind); a skip never replaces a thumb. Answers the stored value. QR404 (no such quest for this caller),
-- QR422 (not one of the three), QR409 `ratings_off` / `not_completed`. Writes nothing to the points record: a rating pays
-- nothing and takes nothing.
CREATE FUNCTION rate_quest(target uuid, new_thumb text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := rating_member(target);
  stored text;
BEGIN
  IF member.id IS NULL THEN
    RAISE EXCEPTION 'no such quest' USING ERRCODE = 'QR404';
  ELSIF new_thumb IS NULL OR new_thumb NOT IN ('up', 'down', 'skip') THEN
    RAISE EXCEPTION 'rate with up, down or skip' USING ERRCODE = 'QR422';
  ELSIF NOT quest_ratings_on(member.event_id) THEN
    RAISE EXCEPTION 'ratings are off for this event' USING ERRCODE = 'QR409', DETAIL = 'ratings_off';
  ELSIF NOT EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = member.id AND c.quest_id = target) THEN
    RAISE EXCEPTION 'complete the quest first' USING ERRCODE = 'QR409', DETAIL = 'not_completed';
  END IF;
  INSERT INTO quest_rating (organizer_id, event_id, quest_id, enrollment_id, thumb)
  VALUES (member.organizer_id, member.event_id, target, member.id, new_thumb)
  ON CONFLICT (enrollment_id, quest_id) DO UPDATE
    SET thumb = excluded.thumb, updated_at = now()
    WHERE excluded.thumb <> 'skip'
  RETURNING thumb INTO stored;
  IF stored IS NULL THEN
    SELECT r.thumb INTO stored FROM quest_rating r WHERE r.enrollment_id = member.id AND r.quest_id = target;
  END IF;
  RETURN stored;
END $$;
REVOKE ALL ON FUNCTION rate_quest(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_quest(uuid, text) TO questify_app;

-- What the app needs to decide whether to ask: the quest's event, whether ratings are on for it and the caller's own thumb
-- ('up', 'down', 'skip' or null). NULL when the caller is not an active member who may rate this quest (the API answers
-- 404). Reads only the caller's own row.
CREATE FUNCTION member_quest_rating(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := rating_member(target);
BEGIN
  IF member.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'eventId', member.event_id, 'on', quest_ratings_on(member.event_id),
    'thumb', (SELECT r.thumb FROM quest_rating r WHERE r.enrollment_id = member.id AND r.quest_id = target));
END $$;
REVOKE ALL ON FUNCTION member_quest_rating(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_quest_rating(uuid) TO questify_app;

-- The team's counts: for each quest of the event with at least one thumb, how many up and how many down (skips are not
-- counted). No player, no enrollment, no time. AN404 for an event that is not the caller's.
CREATE FUNCTION quest_rating_scores(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN jsonb_build_object(
    'on', quest_ratings_on(ev.id),
    'scores', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', s.quest_id, 'up', s.up, 'down', s.down) ORDER BY s.quest_id)
      FROM (SELECT r.quest_id,
                   count(*) FILTER (WHERE r.thumb = 'up')::integer AS up,
                   count(*) FILTER (WHERE r.thumb = 'down')::integer AS down
            FROM quest_rating r WHERE r.event_id = ev.id AND r.thumb <> 'skip'
            GROUP BY r.quest_id) s), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION quest_rating_scores(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_rating_scores(uuid) TO questify_app;

-- ================================================================ survey results (ADR-376 (4))
-- A survey quest's results, the one body of survey_summary (0042) moved here so the speaker's door reads the same
-- numbers: the total of responses and, per question, the answer count, the full choice counts, the rating average (two
-- decimals) and the newest 50 text answers. Nothing says who answered. NULL when the quest is not a survey quest of the
-- event. Internal: no grant.
CREATE FUNCTION survey_results_core(target_event uuid, target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  config jsonb;
BEGIN
  SELECT q.type_config INTO config FROM quest q WHERE q.id = target AND q.event_id = target_event AND q.type = 'survey';
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'total', (SELECT count(*) FROM survey_response r WHERE r.quest_id = target),
    'questions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q ->> 'id', 'kind', q ->> 'kind', 'text', q -> 'text',
               'answered', (SELECT count(*) FROM survey_response r WHERE r.quest_id = target AND r.answers ? (q ->> 'id')),
               'choices', CASE WHEN q ->> 'kind' = 'choice' THEN (
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', c ->> 'id', 'text', c -> 'text',
                          'count', (SELECT count(*) FROM survey_response r
                                    WHERE r.quest_id = target AND r.answers ->> (q ->> 'id') = c ->> 'id'))
                        ORDER BY j)
                 FROM jsonb_array_elements(q -> 'choices') WITH ORDINALITY AS u(c, j)) END,
               'average', CASE WHEN q ->> 'kind' = 'rating' THEN (
                 SELECT round(avg((r.answers ->> (q ->> 'id'))::numeric), 2) FROM survey_response r
                 WHERE r.quest_id = target AND r.answers ? (q ->> 'id')) END,
               'texts', CASE WHEN q ->> 'kind' = 'text' THEN coalesce((
                 SELECT jsonb_agg(newest.body ORDER BY newest.at DESC)
                 FROM (SELECT r.answers ->> (q ->> 'id') AS body, r.created_at AS at FROM survey_response r
                       WHERE r.quest_id = target AND r.answers ? (q ->> 'id')
                       ORDER BY r.created_at DESC, r.enrollment_id LIMIT 50) newest), '[]'::jsonb) END)
             ORDER BY i)
      FROM jsonb_array_elements(config -> 'questions') WITH ORDINALITY AS t(q, i)), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION survey_results_core(uuid, uuid) FROM PUBLIC;

-- As 0042: a survey's results for the event's owners and editors (AN404 otherwise; operators and players never).
CREATE OR REPLACE FUNCTION survey_summary(target_event uuid, target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  results jsonb := survey_results_core(ev.id, target);
BEGIN
  IF results IS NULL THEN
    RAISE EXCEPTION 'no such survey quest in this event' USING ERRCODE = 'AN404';
  END IF;
  RETURN results;
END $$;

-- ================================================================ the speaker's link (ADR-376 (5))
-- Whether the quest has a link. AN404 for an event that is not the caller's or a quest that is not a survey of it.
CREATE FUNCTION survey_share_state(target_event uuid, target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target AND q.event_id = ev.id AND q.type = 'survey') THEN
    RAISE EXCEPTION 'no such survey quest in this event' USING ERRCODE = 'AN404';
  END IF;
  RETURN jsonb_build_object(
    'shared', EXISTS (SELECT 1 FROM survey_share s WHERE s.quest_id = target),
    'createdAt', (SELECT s.created_at FROM survey_share s WHERE s.quest_id = target));
END $$;
REVOKE ALL ON FUNCTION survey_share_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION survey_share_state(uuid, uuid) TO questify_app;

-- Makes the quest's link: stores the hash of a token the API made, replacing an earlier link. AN404. Audited
-- `survey.share` with the quest id only, never the hash. An archived event may still be shared: the speaker reads the
-- results after the event.
CREATE FUNCTION survey_share_save(target_event uuid, target uuid, new_hash text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target AND q.event_id = ev.id AND q.type = 'survey') THEN
    RAISE EXCEPTION 'no such survey quest in this event' USING ERRCODE = 'AN404';
  END IF;
  INSERT INTO survey_share (organizer_id, event_id, quest_id, token_hash, created_by)
  VALUES (ev.organizer_id, ev.id, target, new_hash, app_staff_user_id())
  ON CONFLICT (quest_id) DO UPDATE SET token_hash = excluded.token_hash, created_by = excluded.created_by,
                                       created_at = now();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'survey.share', 'quest', target::text,
          jsonb_build_object('shared', true), request);
  RETURN jsonb_build_object('shared', true);
END $$;
REVOKE ALL ON FUNCTION survey_share_save(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION survey_share_save(uuid, uuid, text, uuid) TO questify_app;

-- Stops the quest's link at once. Answers whether there was one. AN404 as above. Audited `survey.unshare` when it
-- removed a link.
CREATE FUNCTION survey_share_revoke(target_event uuid, target uuid, request uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  removed boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target AND q.event_id = ev.id AND q.type = 'survey') THEN
    RAISE EXCEPTION 'no such survey quest in this event' USING ERRCODE = 'AN404';
  END IF;
  DELETE FROM survey_share s WHERE s.quest_id = target AND s.event_id = ev.id;
  removed := FOUND;
  IF removed THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
    VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'survey.unshare', 'quest', target::text,
            jsonb_build_object('shared', false), request);
  END IF;
  RETURN removed;
END $$;
REVOKE ALL ON FUNCTION survey_share_revoke(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION survey_share_revoke(uuid, uuid, uuid) TO questify_app;

-- The speaker's door: the results of the one quest whose link has this token hash, with the quest's and the event's names,
-- or NULL (the API answers 404 for an unknown, replaced or revoked link). It
-- reads no row about a player: the same numbers and text answers as the team sees, names not shown. The API holds back
-- text answers that look like a contact detail before it answers (ADR-376 (5)).
CREATE FUNCTION survey_shared_results(link_hash text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  share survey_share;
  results jsonb;
BEGIN
  SELECT s.* INTO share FROM survey_share s WHERE s.token_hash = link_hash;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  results := survey_results_core(share.event_id, share.quest_id);
  IF results IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN results || jsonb_build_object(
    'quest', (SELECT jsonb_build_object('ar', coalesce(q.title_ar, q.title_en), 'en', coalesce(q.title_en, q.title_ar))
              FROM quest q WHERE q.id = share.quest_id),
    'event', (SELECT jsonb_build_object('ar', coalesce(e.name_ar, e.name_en), 'en', coalesce(e.name_en, e.name_ar))
              FROM event e WHERE e.id = share.event_id));
END $$;
REVOKE ALL ON FUNCTION survey_shared_results(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION survey_shared_results(text) TO questify_app;
