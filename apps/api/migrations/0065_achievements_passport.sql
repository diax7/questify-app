-- T-403: event city, the final-rank snapshot, achievements and their sync evaluator, the Event Passport and owner
-- history, and the public profile's achievements and passport (ADR-274 to ADR-277). Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ cities (ADR-277)
-- Seeded and read-only until the console edits it (T-703/T-709); no `active` flag until then.
CREATE TABLE city (
 id text PRIMARY KEY CHECK (id ~ '^sa-[a-z0-9-]{2,30}$'),
 name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 60
  AND name_ar !~ '[\x01-\x1F\x7F-\x9F  ‪-‮⁦-⁩]'),
 name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 60
  AND name_en !~ '[\x01-\x1F\x7F-\x9F  ‪-‮⁦-⁩]'),
 position smallint NOT NULL UNIQUE CHECK (position >= 1)
);
ALTER TABLE city ENABLE ROW LEVEL SECURITY;
ALTER TABLE city FORCE ROW LEVEL SECURITY;
REVOKE ALL ON city FROM PUBLIC, questify_app;
INSERT INTO city (id, name_ar, name_en, position) VALUES
 ('sa-riyadh', 'الرياض', 'Riyadh', 1),
 ('sa-jeddah', 'جدة', 'Jeddah', 2),
 ('sa-makkah', 'مكة المكرمة', 'Makkah', 3),
 ('sa-madinah', 'المدينة المنورة', 'Madinah', 4),
 ('sa-dammam', 'الدمام', 'Dammam', 5),
 ('sa-khobar', 'الخبر', 'Khobar', 6),
 ('sa-dhahran', 'الظهران', 'Dhahran', 7),
 ('sa-taif', 'الطائف', 'Taif', 8),
 ('sa-abha', 'أبها', 'Abha', 9),
 ('sa-tabuk', 'تبوك', 'Tabuk', 10),
 ('sa-buraidah', 'بريدة', 'Buraidah', 11),
 ('sa-hail', 'حائل', 'Hail', 12),
 ('sa-jazan', 'جازان', 'Jazan', 13),
 ('sa-najran', 'نجران', 'Najran', 14),
 ('sa-al-ahsa', 'الأحساء', 'Al-Ahsa', 15),
 ('sa-alula', 'العلا', 'AlUla', 16),
 ('sa-yanbu', 'ينبع', 'Yanbu', 17),
 ('sa-al-baha', 'الباحة', 'Al Baha', 18),
 ('sa-jubail', 'الجبيل', 'Jubail', 19),
 ('sa-khamis-mushait', 'خميس مشيط', 'Khamis Mushait', 20);

CREATE FUNCTION city_list() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en))
  ORDER BY c.position), '[]'::jsonb) FROM city c
$$;
REVOKE ALL ON FUNCTION city_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION city_list() TO questify_app;

-- The owner or an editor sets it under the event's own policy; none for a virtual event.
ALTER TABLE event ADD COLUMN city_id text REFERENCES city (id),
 ADD CONSTRAINT event_virtual_no_city CHECK (kind <> 'virtual' OR city_id IS NULL);
GRANT INSERT (city_id), UPDATE (city_id) ON event TO questify_app;

-- A played event's city never moves (MINOR-3): no change once live, ended or archived, for every role.
-- event_times_guard fires only on the time columns, so the city has its own trigger.
CREATE FUNCTION event_city_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
 IF event_status_now(OLD.status, OLD.starts_at, OLD.ends_at) IN ('live', 'ended', 'archived') THEN
  RAISE EXCEPTION 'an event keeps its city once it is live' USING ERRCODE = 'CY409';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_city_guard() FROM PUBLIC;
CREATE TRIGGER event_city_guard BEFORE UPDATE OF city_id ON event
 FOR EACH ROW WHEN (OLD.city_id IS DISTINCT FROM NEW.city_id) EXECUTE FUNCTION event_city_guard();

-- ================================================================ append-only history
CREATE FUNCTION history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'earned achievements and final ranks can never be changed or removed'
  USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION history_append_only() FROM PUBLIC;

-- ================================================================ the final-rank snapshot (ADR-275)
-- Every ranked member's place, written once by confirm_results with result_place. Kept on erasure tombstones.
CREATE TABLE final_rank (
 event_id uuid NOT NULL REFERENCES event_result (event_id),
 enrollment_id uuid NOT NULL,
 rank integer NOT NULL CHECK (rank >= 1),
 PRIMARY KEY (event_id, enrollment_id),
 UNIQUE (event_id, rank),
 FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id)
);
CREATE INDEX final_rank_enrollment_idx ON final_rank (enrollment_id);
ALTER TABLE final_rank ENABLE ROW LEVEL SECURITY;
ALTER TABLE final_rank FORCE ROW LEVEL SECURITY;
REVOKE ALL ON final_rank FROM PUBLIC, questify_app;
CREATE TRIGGER final_rank_no_update_or_delete BEFORE UPDATE OR DELETE ON final_rank
 FOR EACH ROW EXECUTE FUNCTION history_append_only();
CREATE TRIGGER final_rank_no_truncate BEFORE TRUNCATE ON final_rank
 FOR EACH STATEMENT EXECUTE FUNCTION history_append_only();
ALTER TABLE final_rank ENABLE ALWAYS TRIGGER final_rank_no_update_or_delete;
ALTER TABLE final_rank ENABLE ALWAYS TRIGGER final_rank_no_truncate;

-- Every ranked member's place in one ordering; current_places is its first result_depth rows. Internal.
CREATE FUNCTION all_places(ev event)
 RETURNS TABLE (rank integer, enrollment_id uuid, score bigint, score_version bigint)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT (row_number() OVER (ORDER BY r.score DESC, r.score_version, r.id))::integer, r.id, r.score, r.score_version
 FROM ranked_enrollments(ev.id) r
 WHERE r.ranked
 ORDER BY r.score DESC, r.score_version, r.id
$$;
REVOKE ALL ON FUNCTION all_places(event) FROM PUBLIC;
CREATE OR REPLACE FUNCTION current_places(ev event)
 RETURNS TABLE (rank integer, enrollment_id uuid, score bigint, score_version bigint)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT a.rank, a.enrollment_id, a.score, a.score_version FROM all_places(ev) a ORDER BY a.rank LIMIT result_depth(ev)
$$;
REVOKE ALL ON FUNCTION current_places(event) FROM PUBLIC;

-- As 0053, plus: result_place and final_rank in one statement that reads all_places once (MINOR-4).
CREATE OR REPLACE FUNCTION confirm_results(target_event uuid, expected uuid[], request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  now_places uuid[];
  due        quiz_attempt%ROWTYPE;
  finished   boolean := false;
  pending    record;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  IF expected IS NULL OR array_position(expected, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'the places seen are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT * INTO ev FROM event e WHERE e.id = ev.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RETURN 'replayed';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'ended' THEN
    RAISE EXCEPTION 'results are confirmed after the event ends' USING ERRCODE = 'RF409', DETAIL = 'not_ended';
  END IF;
  SELECT * INTO pending FROM community_pending(ev.id);
  IF pending.goals > 0 OR pending.due > 0 THEN
    RAISE EXCEPTION 'community rewards are still being paid' USING ERRCODE = 'RF409', DETAIL = 'community_paying',
      HINT = jsonb_build_object('goals', pending.goals, 'due', pending.due)::text;
  END IF;
  -- Quizzes still open pay what they earned before the places freeze (T-302); a change commits and is reported.
  FOR due IN SELECT a.* FROM quiz_attempt a WHERE a.event_id = ev.id AND a.status = 'open' ORDER BY a.id LOOP
    PERFORM 1 FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    SELECT * INTO due FROM quiz_attempt a WHERE a.id = due.id FOR UPDATE;
    CONTINUE WHEN due.status <> 'open';
    UPDATE quiz_attempt a SET swept = true WHERE a.id = due.id RETURNING * INTO due;
    finished := finish_quiz(due) = 'paid' OR finished;
  END LOOP;
  now_places := ARRAY(SELECT c.enrollment_id FROM current_places(ev) c ORDER BY c.rank);
  IF finished AND now_places <> expected THEN
    PERFORM mark_ranking_repair(ev.id);
    RETURN 'results_changed';
  END IF;
  IF now_places <> expected THEN
    RAISE EXCEPTION 'the places changed' USING ERRCODE = 'RF409', DETAIL = 'results_changed';
  END IF;

  INSERT INTO event_result (event_id, organizer_id, confirmed_by) VALUES (ev.id, ev.organizer_id, app_staff_user_id());
  WITH places AS MATERIALIZED (SELECT * FROM all_places(ev)),
  kept AS (
    INSERT INTO final_rank (event_id, enrollment_id, rank) SELECT ev.id, c.enrollment_id, c.rank FROM places c
  )
  INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version, open_flags, rank_prize_id)
  SELECT ev.id, c.rank, c.enrollment_id, c.score, c.score_version,
         (SELECT count(*) FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'),
         prize_for_rank(ev, c.rank)
  FROM places c
  WHERE c.rank <= result_depth(ev);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.results_confirmed', 'event', ev.id::text,
          jsonb_build_object('places', cardinality(now_places),
                             'flagged', (SELECT count(*) FROM result_place x WHERE x.event_id = ev.id AND x.open_flags > 0)),
          request);
  RETURN 'confirmed';
END $$;

-- Events confirmed before this migration: their result_place ranks first, then the other ranked members in order
-- after them. An event that already has rows is skipped, so a second run adds nothing.
CREATE FUNCTION backfill_final_ranks() RETURNS void LANGUAGE sql SET search_path = public, pg_temp AS $$
 WITH todo AS MATERIALIZED (
  SELECT x.event_id FROM event_result x WHERE NOT EXISTS (SELECT 1 FROM final_rank f WHERE f.event_id = x.event_id)
 ), placed AS (
  INSERT INTO final_rank (event_id, enrollment_id, rank)
  SELECT p.event_id, p.enrollment_id, p.rank FROM todo t JOIN result_place p ON p.event_id = t.event_id
 )
 INSERT INTO final_rank (event_id, enrollment_id, rank)
 SELECT t.event_id, a.enrollment_id, d.depth + row_number() OVER (PARTITION BY t.event_id ORDER BY a.rank)
 FROM todo t JOIN event ev ON ev.id = t.event_id
 CROSS JOIN LATERAL (SELECT coalesce(max(p.rank), 0) AS depth FROM result_place p WHERE p.event_id = t.event_id) d
 CROSS JOIN LATERAL all_places(ev) a
 WHERE NOT EXISTS (SELECT 1 FROM result_place p WHERE p.event_id = t.event_id AND p.enrollment_id = a.enrollment_id)
$$;
REVOKE ALL ON FUNCTION backfill_final_ranks() FROM PUBLIC;
-- No confirmation may run while the snapshot is backfilled (0039 precedent); the event table is already held above.
LOCK TABLE event_result IN SHARE ROW EXCLUSIVE MODE;
SELECT backfill_final_ranks();

-- ================================================================ achievements (ADR-274, ADR-279)
-- Data, not code: T-709 edits thresholds and names; a threshold change never removes an earned row.
CREATE TABLE achievement (
 id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,63}$'),
 metric text NOT NULL UNIQUE CHECK (metric IN ('events', 'quests', 'cities', 'top10', 'goals')),
 bronze integer NOT NULL CHECK (bronze BETWEEN 1 AND 100000),
 silver integer NOT NULL CHECK (silver BETWEEN 1 AND 100000),
 gold integer NOT NULL CHECK (gold BETWEEN 1 AND 100000),
 name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 60
  AND name_ar !~ '[\x01-\x1F\x7F-\x9F  ‪-‮⁦-⁩]'),
 name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 60
  AND name_en !~ '[\x01-\x1F\x7F-\x9F  ‪-‮⁦-⁩]'),
 -- The shipped badge art (docs/design/assets/achievements); the app draws nothing else.
 visual_key text NOT NULL CHECK (visual_key ~ '^ach-(first-steps|collector|swift|summit|social|power-up)$'),
 position smallint NOT NULL UNIQUE CHECK (position >= 1),
 CHECK (bronze < silver AND silver < gold)
);
ALTER TABLE achievement ENABLE ROW LEVEL SECURITY;
ALTER TABLE achievement FORCE ROW LEVEL SECURITY;
REVOKE ALL ON achievement FROM PUBLIC, questify_app;
INSERT INTO achievement (id, metric, bronze, silver, gold, name_ar, name_en, visual_key, position) VALUES
 ('events-attended', 'events', 1, 5, 15, 'رحّالة', 'Wanderer', 'ach-first-steps', 1),
 ('quests-done', 'quests', 10, 50, 200, 'صائد المهام', 'Quest Hunter', 'ach-collector', 2),
 ('cities-played', 'cities', 2, 4, 8, 'جوّاب المدن', 'City Roamer', 'ach-swift', 3),
 ('top-ten', 'top10', 1, 3, 10, 'نخبة العشرة', 'Top Ten', 'ach-summit', 4),
 ('community-goals', 'goals', 1, 5, 15, 'يدٌ واحدة', 'Teamwork', 'ach-social', 5);

-- Each tier a player earned, once. Points at player_xp (as the XP rows), so its key checks never wait on
-- erase_player's player lock. Append-only for every role; kept on the tombstone (no personal data).
CREATE TABLE achievement_earned (
 player_id uuid NOT NULL REFERENCES player_xp (player_id),
 achievement_id text NOT NULL REFERENCES achievement (id) ON DELETE RESTRICT,
 tier text NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
 earned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (player_id, achievement_id, tier)
);
ALTER TABLE achievement_earned ENABLE ROW LEVEL SECURITY;
ALTER TABLE achievement_earned FORCE ROW LEVEL SECURITY;
REVOKE ALL ON achievement_earned FROM PUBLIC, questify_app;
CREATE TRIGGER achievement_earned_no_update_or_delete BEFORE UPDATE OR DELETE ON achievement_earned
 FOR EACH ROW EXECUTE FUNCTION history_append_only();
CREATE TRIGGER achievement_earned_no_truncate BEFORE TRUNCATE ON achievement_earned
 FOR EACH STATEMENT EXECUTE FUNCTION history_append_only();
ALTER TABLE achievement_earned ENABLE ALWAYS TRIGGER achievement_earned_no_update_or_delete;
ALTER TABLE achievement_earned ENABLE ALWAYS TRIGGER achievement_earned_no_truncate;

-- ================================================================ what counts as playing (ADR-274, MINOR-2)
-- The one membership rule every metric, the passport and the history's `played` share. Internal.
CREATE FUNCTION played_enrollment(status text, joined_via text) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
 SELECT status NOT IN ('banned', 'removed') AND joined_via IS DISTINCT FROM 'rehearsal'
$$;
REVOKE ALL ON FUNCTION played_enrollment(text, text) FROM PUBLIC;

-- A player's standing quest XP credits (never reversed) on memberships that count. Internal.
CREATE FUNCTION standing_credits(who uuid) RETURNS TABLE (enrollment_id uuid, event_id uuid, credit_id bigint)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT n.id, n.event_id, x.id
 FROM xp_entry x JOIN ledger_entry l ON l.id = x.ledger_entry_id JOIN enrollment n ON n.id = l.enrollment_id
 WHERE x.player_id = who AND x.source = 'quest' AND played_enrollment(n.status, n.joined_via)
   AND NOT EXISTS (SELECT 1 FROM xp_entry r WHERE r.source = 'removal' AND r.reverses = x.id)
$$;
REVOKE ALL ON FUNCTION standing_credits(uuid) FROM PUBLIC;

-- The five lifetime metrics, one row each. T-403b adds the campaign window. Internal.
CREATE FUNCTION player_metrics(who uuid) RETURNS TABLE (metric text, value integer)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 WITH credit AS MATERIALIZED (SELECT * FROM standing_credits(who)),
 played AS MATERIALIZED (SELECT DISTINCT c.event_id FROM credit c)
 SELECT 'events', (SELECT count(*) FROM played)::integer
 UNION ALL
 SELECT 'quests', (SELECT count(*) FROM credit)::integer
 UNION ALL
 SELECT 'cities', (SELECT count(DISTINCT e.city_id) FROM played p JOIN event e ON e.id = p.event_id)::integer
 UNION ALL
 -- A place counts only on a membership with a standing credit: welcome points alone rank a member who never played.
 SELECT 'top10', (SELECT count(*) FROM final_rank f
                  JOIN event_result r ON r.event_id = f.event_id AND r.revealed_at IS NOT NULL
                  WHERE f.rank <= 10 AND f.enrollment_id IN (SELECT c.enrollment_id FROM credit c))::integer
 UNION ALL
 SELECT 'goals', (SELECT count(DISTINCT c.goal_id) FROM enrollment n
                  JOIN community_contributor c ON c.enrollment_id = n.id
                  JOIN community_goal g ON g.id = c.goal_id AND g.status = 'reached'
                  WHERE n.player_id = who AND played_enrollment(n.status, n.joined_via))::integer
$$;
REVOKE ALL ON FUNCTION player_metrics(uuid) FROM PUBLIC;

-- Every tier now met and not yet earned. Internal.
CREATE FUNCTION achievements_due(who uuid) RETURNS TABLE (achievement_id text, tier text)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT a.id, t.tier
 FROM player_metrics(who) m JOIN achievement a ON a.metric = m.metric
 CROSS JOIN LATERAL (VALUES ('bronze', a.bronze), ('silver', a.silver), ('gold', a.gold)) t (tier, threshold)
 WHERE m.value >= t.threshold
   AND NOT EXISTS (SELECT 1 FROM achievement_earned e WHERE e.player_id = who AND e.achievement_id = a.id AND e.tier = t.tier)
$$;
REVOKE ALL ON FUNCTION achievements_due(uuid) FROM PUBLIC;

-- The highest tier a player earned of one achievement, or NULL (the silhouette). Internal.
CREATE FUNCTION earned_tier(who uuid, target text) RETURNS text
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT e.tier FROM achievement_earned e WHERE e.player_id = who AND e.achievement_id = target
 ORDER BY array_position(ARRAY['bronze', 'silver', 'gold'], e.tier) DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION earned_tier(uuid, text) FROM PUBLIC;

-- The only writer of earned rows (ADR-274). An unlocked pre-check answers at once when nothing is due (ADR-272
-- pattern); otherwise player KEY SHARE, then player_xp FOR UPDATE, then fresh reads and unique inserts. Erasure takes
-- player FOR UPDATE -> enrollments -> player_xp and completions take enrollment -> player_xp with no player lock
-- after it, so no cycle; two syncs serialize on player_xp and the second writes and reports nothing.
CREATE FUNCTION questify_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who  uuid;
 made jsonb;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb);
 END IF;
 SELECT p.id INTO who FROM player p WHERE p.id = who AND p.status = 'active' FOR KEY SHARE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 PERFORM 1 FROM player_xp x WHERE x.player_id = who FOR UPDATE;
 WITH written AS (
  INSERT INTO achievement_earned (player_id, achievement_id, tier)
  SELECT who, d.achievement_id, d.tier FROM achievements_due(who) d
  ON CONFLICT DO NOTHING
  RETURNING achievement_id, tier
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.achievement_id, 'tier', w.tier)
  ORDER BY a.position, array_position(ARRAY['bronze', 'silver', 'gold'], w.tier)), '[]'::jsonb)
 INTO made FROM written w JOIN achievement a ON a.id = w.achievement_id;
 RETURN jsonb_build_object('achievements', made);
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- The caller's five achievements: earned tier (NULL is the silhouette), live progress and the next tier to reach.
CREATE FUNCTION own_achievements() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
  'visualKey', a.visual_key, 'tier', t.tier, 'progress', m.value,
  'next', CASE t.tier WHEN 'gold' THEN NULL
                      WHEN 'silver' THEN jsonb_build_object('tier', 'gold', 'target', a.gold)
                      WHEN 'bronze' THEN jsonb_build_object('tier', 'silver', 'target', a.silver)
                      ELSE jsonb_build_object('tier', 'bronze', 'target', a.bronze) END)
  ORDER BY a.position)
 FROM (SELECT profile_player() AS id) me
 CROSS JOIN LATERAL player_metrics(me.id) m JOIN achievement a ON a.metric = m.metric
 CROSS JOIN LATERAL (SELECT earned_tier(me.id, a.id) AS tier) t
 WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_achievements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_achievements() TO questify_app;

-- ================================================================ the Event Passport and history (ADR-276)
-- Whether another player may see a played event's stamp now: public, not a workplace event, ended or archived
-- (MAJOR-1, MINOR-5). Internal.
CREATE FUNCTION public_stamp(e event) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT e.access = 'public' AND e.kind <> 'workplace'
   AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('ended', 'archived')
$$;
REVOKE ALL ON FUNCTION public_stamp(event) FROM PUBLIC;

-- The caller's memberships (not rehearsal, pending or declined), newest event start first, on the (start, id) cursor;
-- `only_played` keeps the passport's played events. The rank shows once results are revealed.
CREATE FUNCTION own_events(only_played boolean, before_at timestamptz, before_event uuid, page_size integer)
 RETURNS TABLE (event_id uuid, name jsonb, local_date text, starts_at timestamptz, ends_at timestamptz,
                timezone text, city jsonb, event_status text, member_status text, score bigint, played boolean,
                rank integer, rank_state text, is_public boolean, sort_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH me AS MATERIALIZED (SELECT profile_player() AS id),
 credited AS MATERIALIZED (SELECT DISTINCT s.enrollment_id FROM me CROSS JOIN LATERAL standing_credits(me.id) s)
 SELECT e.id, jsonb_build_object('ar', coalesce(e.name_ar, e.name_en), 'en', coalesce(e.name_en, e.name_ar)),
  to_char(k.at AT TIME ZONE e.timezone, 'YYYY-MM-DD'), e.starts_at, e.ends_at, e.timezone,
  CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('ar', c.name_ar, 'en', c.name_en) END,
  st.now, n.status, n.score, p.enrollment_id IS NOT NULL,
  CASE WHEN r.revealed_at IS NOT NULL THEN f.rank END,
  CASE WHEN st.now NOT IN ('ended', 'archived') THEN 'live'
       WHEN r.revealed_at IS NULL THEN 'pending'
       WHEN f.rank IS NULL THEN 'unranked'
       ELSE 'final' END,
  p.enrollment_id IS NOT NULL AND public_stamp(e), k.at
 FROM me JOIN enrollment n ON n.player_id = me.id JOIN event e ON e.id = n.event_id
 LEFT JOIN credited p ON p.enrollment_id = n.id
 LEFT JOIN city c ON c.id = e.city_id
 LEFT JOIN event_result r ON r.event_id = e.id
 LEFT JOIN final_rank f ON f.event_id = e.id AND f.enrollment_id = n.id
 CROSS JOIN LATERAL (SELECT coalesce(e.starts_at, e.created_at) AS at) k
 CROSS JOIN LATERAL (SELECT event_status_now(e.status, e.starts_at, e.ends_at) AS now) st
 WHERE n.status NOT IN ('pending', 'declined') AND n.joined_via IS DISTINCT FROM 'rehearsal'
   AND (NOT coalesce(only_played, false) OR p.enrollment_id IS NOT NULL)
   AND (before_at IS NULL OR (k.at, e.id) < (before_at, before_event))
 ORDER BY k.at DESC, e.id DESC
 LIMIT least(greatest(coalesce(page_size, 21), 1), 51)
$$;
REVOKE ALL ON FUNCTION own_events(boolean, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_events(boolean, timestamptz, uuid, integer) TO questify_app;

-- Another player's view: tiers only, and at most 50 stamps of public_stamp events with no id, score or status.
CREATE FUNCTION public_achievements(who uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'tier', earned_tier(who, a.id)) ORDER BY a.position), '[]'::jsonb)
 FROM achievement a
$$;
REVOKE ALL ON FUNCTION public_achievements(uuid) FROM PUBLIC;
CREATE FUNCTION public_passport(who uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT coalesce(jsonb_agg(s.stamp ORDER BY s.at DESC, s.id DESC), '[]'::jsonb) FROM (
  SELECT e.id, k.at, jsonb_build_object(
   'name', jsonb_build_object('ar', coalesce(e.name_ar, e.name_en), 'en', coalesce(e.name_en, e.name_ar)),
   'date', to_char(k.at AT TIME ZONE e.timezone, 'YYYY-MM-DD'),
   'city', CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('ar', c.name_ar, 'en', c.name_en) END,
   'rank', CASE WHEN r.revealed_at IS NOT NULL THEN f.rank END) AS stamp
  FROM (SELECT DISTINCT s.enrollment_id, s.event_id FROM standing_credits(who) s) p
  JOIN event e ON e.id = p.event_id
  LEFT JOIN city c ON c.id = e.city_id
  LEFT JOIN event_result r ON r.event_id = e.id
  LEFT JOIN final_rank f ON f.event_id = e.id AND f.enrollment_id = p.enrollment_id
  CROSS JOIN LATERAL (SELECT coalesce(e.starts_at, e.created_at) AS at) k
  WHERE public_stamp(e)
  ORDER BY k.at DESC, e.id DESC
  LIMIT 50
 ) s
$$;
REVOKE ALL ON FUNCTION public_passport(uuid) FROM PUBLIC;

-- As 0063, plus `achievements` and `passport` (FR-702). The API also parses it through a stripping allowlist.
CREATE OR REPLACE FUNCTION public_player_profile(chosen_name text) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('username', p.username,
  'character', coalesce(item_json(e.character_id), jsonb_build_object('starter', p.avatar)),
  'frame', item_json(e.frame_id), 'title', item_json(e.title_id),
  'level', jsonb_build_object('number', x.level, 'title', jsonb_build_object('ar', t.name_ar, 'en', t.name_en)),
  'achievements', public_achievements(p.id), 'passport', public_passport(p.id))
 FROM player p JOIN player_xp x ON x.player_id = p.id LEFT JOIN player_equipment e ON e.player_id = p.id
 LEFT JOIN LATERAL level_title_of(x.level) t ON true
 WHERE profile_player() IS NOT NULL AND username_fold(p.username) = username_fold(chosen_name) AND p.status = 'active'
$$;
