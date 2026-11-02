-- T-709d: the console's XP table with its level reward map, and Questify's item catalog (FR-1403; plan
-- docs/plans/2026-11-02-t-709d-xp-curve-items.md; ADR-440, ADR-441; Q-399, Q-401, Q-402).
--
-- The curve door writes xp_level and level_item only, under row locks, and never a player row. Invariant L: every write
-- to xp_level or level_item happens while the writer holds FOR UPDATE on every xp_level row, and every insert into
-- level_reached happens while the inserter holds FOR KEY SHARE on each level it inserts (levels_reach, the only inserter).
-- Lock order everywhere: player, player_xp, xp_level (rising level), level_item, item, audit_log. The door takes level 1
-- first (no reach ever locks it, so two doors queue there), then the other levels one row per statement, within one lock
-- budget of 1 s for the whole save (CA503 when it is used up, 55P03 when one wait runs out; both answer 503 busy), so a
-- scan queued behind it stays under the API's 2 s lock timeout.
--
-- Each player's stored level follows under that player's own player_xp lock: xp_apply at their next XP, and
-- questify_sync's catch-up (xp_catch_up, run before any XP of its own, so every level a sync locks rises) writes the
-- levels a lowering made due, which give the level item and the level-up gems once. Money that cannot come back: a save
-- that can pay needs `confirmed` (CA428, the detail names the levels and the gems per level).
--
-- Deny by default: no table changes its grants; every new function is revoked from PUBLIC in the group that creates it;
-- only the doors go to questify_app. Earlier migrations untouched.
SET LOCAL lock_timeout = '10s';

-- The door's level_held and reward_given probes. A deploy that cannot get the SHARE lock at once fails and is retried,
-- rather than holding level-ups behind it (plan review 2026-11-02).
SET LOCAL lock_timeout = '2s';
CREATE INDEX level_reached_level_idx ON level_reached (level);
SET LOCAL lock_timeout = '10s';

-- ================================================================ reaching levels (ADR-440)
-- Writes the levels at or below `total` the player has not reached yet, each under FOR KEY SHARE taken in level order, so
-- a curve save in flight is waited for and then seen (a removed level is skipped, a moved start is tested again, the item
-- trigger reads the new mapping). Locks nothing when nothing is new. The caller holds the player's player_xp row lock.
-- Answers the levels written. The only code that inserts into level_reached.
CREATE FUNCTION levels_reach(who uuid, made bigint, total bigint) RETURNS smallint[]
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  WITH due AS MATERIALIZED (
    SELECT l.level FROM xp_level l
    WHERE l.level > 1 AND l.xp_from <= total
      AND NOT EXISTS (SELECT 1 FROM level_reached r WHERE r.player_id = who AND r.level = l.level)
    ORDER BY l.level
    FOR KEY SHARE OF l
  ), written AS (
    INSERT INTO level_reached (player_id, level, xp_entry_id)
    SELECT who, d.level, made FROM due d ORDER BY d.level
    ON CONFLICT DO NOTHING
    RETURNING level
  )
  SELECT coalesce(array_agg(w.level ORDER BY w.level), '{}'::smallint[]) FROM written w
$$;
REVOKE ALL ON FUNCTION levels_reach(uuid, bigint, bigint) FROM PUBLIC;

-- As 0072, with one change: the levels reached go through levels_reach.
CREATE OR REPLACE FUNCTION xp_apply(who uuid, made bigint, delta integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
  month text := xp_month_of(made);
  target text;
BEGIN
  IF month IS NULL THEN
    RAISE EXCEPTION 'XP entry % does not exist', made USING ERRCODE = 'internal_error';
  END IF;
  UPDATE player_xp x SET xp = x.xp + delta, level = xp_level_of(x.xp + delta), updated_at = now()
  WHERE x.player_id = who
  RETURNING x.xp INTO total;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'player % has no XP row', who USING ERRCODE = 'internal_error';
  END IF;
  IF delta > 0 THEN
    PERFORM levels_reach(who, made, total);
  END IF;
  FOREACH target IN ARRAY ARRAY['all', month] LOOP
    UPDATE xp_board b SET xp = b.xp + delta, xp_version = greatest(b.xp_version, made)
    WHERE b.board = target AND b.player_id = who;
    IF NOT FOUND THEN
      INSERT INTO xp_board (board, player_id, xp, xp_version) VALUES (target, who, delta, made);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION xp_apply(uuid, bigint, integer) FROM PUBLIC;

-- Brings one player in line with the curve in force: the levels a lowering made due (carrying the player's latest XP
-- credit) and the stored level. The caller holds the player's player_xp row lock. Answers the levels written.
CREATE FUNCTION xp_catch_up(who uuid) RETURNS smallint[]
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  total  bigint;
  made   bigint;
  caught smallint[] := '{}';
BEGIN
  SELECT x.xp INTO total FROM player_xp x WHERE x.player_id = who;
  SELECT e.id INTO made FROM xp_entry e WHERE e.player_id = who AND e.delta > 0 ORDER BY e.id DESC LIMIT 1;
  IF made IS NOT NULL THEN
    caught := levels_reach(who, made, total);
  END IF;
  UPDATE player_xp x SET level = xp_level_of(x.xp), updated_at = now()
  WHERE x.player_id = who AND x.level <> xp_level_of(x.xp);
  RETURN caught;
END $$;
REVOKE ALL ON FUNCTION xp_catch_up(uuid) FROM PUBLIC;

-- Whether the player's stored level or reached levels lag the curve in force (the sync's unlocked pre-check).
CREATE FUNCTION levels_due(who uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM player_xp x
    WHERE x.player_id = who
      AND (x.level <> xp_level_of(x.xp)
           OR EXISTS (SELECT 1 FROM xp_level l
                      WHERE l.level > 1 AND l.xp_from <= x.xp
                        AND NOT EXISTS (SELECT 1 FROM level_reached r WHERE r.player_id = who AND r.level = l.level))))
$$;
REVOKE ALL ON FUNCTION levels_due(uuid) FROM PUBLIC;

-- As 0066's two-argument helper, also counting the levels the sync's catch-up wrote as reached by this sync.
CREATE FUNCTION questify_level_up(who uuid, entries bigint[], caught smallint[]) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('level', top.level, 'title', jsonb_build_object('ar', t.name_ar, 'en', t.name_en),
  'items', (SELECT coalesce(jsonb_agg(item_json(o.item_id) ORDER BY r.level), '[]'::jsonb)
            FROM level_reached r JOIN player_item o ON o.player_id = r.player_id AND o.source_level = r.level
            WHERE r.player_id = who AND (r.xp_entry_id = ANY (entries) OR r.level = ANY (caught))))
 FROM (SELECT max(r.level) AS level FROM level_reached r
       WHERE r.player_id = who AND (r.xp_entry_id = ANY (entries) OR r.level = ANY (caught))) top
 CROSS JOIN LATERAL level_title_of(top.level) t
 WHERE top.level IS NOT NULL
$$;
REVOKE ALL ON FUNCTION questify_level_up(uuid, bigint[], smallint[]) FROM PUBLIC;

-- As 0122, with three changes: the pre-check also runs when levels are due; the catch-up runs right after the player_xp
-- lock, before any XP of the sync's own; the answer's level-up counts the caught levels.
CREATE OR REPLACE FUNCTION questify_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who     uuid;
 tiers   jsonb;
 quest   record;
 mile    record;
 award   bigint;
 reward  bigint;
 entry   bigint;
 paid    jsonb := '[]'::jsonb;
 streaks jsonb := '[]'::jsonb;
 entries bigint[] := '{}';
 caught  smallint[];
 amount  record;
 earned  bigint;
 balance bigint;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) AND NOT EXISTS (SELECT 1 FROM questify_due(who))
    AND NOT gems_due(who) AND NOT streak_due(who) AND NOT levels_due(who) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb, 'quests', '[]'::jsonb, 'levelUp', NULL,
   'gems', jsonb_build_object('earned', 0, 'balance', (SELECT x.gems FROM player_xp x WHERE x.player_id = who)),
   'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', '[]'::jsonb) END);
 END IF;
 SELECT p.id INTO who FROM player p WHERE p.id = who AND p.status = 'active' FOR KEY SHARE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 PERFORM 1 FROM player_xp x WHERE x.player_id = who FOR UPDATE;
 caught := xp_catch_up(who);
 WITH written AS (
  INSERT INTO achievement_earned (player_id, achievement_id, tier)
  SELECT who, d.achievement_id, d.tier FROM achievements_due(who) d
  ON CONFLICT DO NOTHING
  RETURNING achievement_id, tier
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.achievement_id, 'tier', w.tier)
  ORDER BY a.position, array_position(ARRAY['bronze', 'silver', 'gold'], w.tier)), '[]'::jsonb)
 INTO tiers FROM written w JOIN achievement a ON a.id = w.achievement_id;
 FOR quest IN
  SELECT q.id, q.title_ar, q.title_en, q.xp
  FROM questify_due(who) d JOIN questify_quest q ON q.id = d.quest_id LEFT JOIN questify_campaign c ON c.id = q.campaign_id
  ORDER BY c.starts_at NULLS FIRST, q.position, q.id
 LOOP
  INSERT INTO questify_award (player_id, quest_id) VALUES (who, quest.id) ON CONFLICT DO NOTHING RETURNING id INTO award;
  CONTINUE WHEN award IS NULL;
  INSERT INTO xp_entry (player_id, delta, source, questify_award_id) VALUES (who, quest.xp, 'questify', award)
  RETURNING id INTO entry;
  PERFORM xp_apply(who, entry, quest.xp);
  entries := entries || entry;
  paid := paid || jsonb_build_array(jsonb_build_object('id', quest.id,
   'title', jsonb_build_object('ar', quest.title_ar, 'en', quest.title_en), 'xp', quest.xp));
 END LOOP;
 IF daily_streak_on() THEN
  FOR mile IN
   SELECT m.days, m.xp FROM questify_streak_milestone m
   WHERE m.days <= daily_streak_length(who)
     AND NOT EXISTS (SELECT 1 FROM questify_streak_reward r WHERE r.player_id = who AND r.days = m.days)
   ORDER BY m.days
  LOOP
   INSERT INTO questify_streak_reward (player_id, days, xp) VALUES (who, mile.days, mile.xp)
   ON CONFLICT DO NOTHING RETURNING id INTO reward;
   CONTINUE WHEN reward IS NULL;
   INSERT INTO xp_entry (player_id, delta, source, streak_reward_id) VALUES (who, mile.xp, 'streak', reward)
   RETURNING id INTO entry;
   PERFORM xp_apply(who, entry, mile.xp);
   entries := entries || entry;
   streaks := streaks || jsonb_build_array(jsonb_build_object('days', mile.days, 'xp', mile.xp));
  END LOOP;
 END IF;
 SELECT * INTO amount FROM gem_amounts();
 WITH due AS (
  SELECT 'level' AS source, r.level AS source_level, NULL::text AS achievement_id, NULL::text AS tier,
         NULL::bigint AS award_id, amount.level_up AS delta, r.reached_at AS at
  FROM level_reached r
  WHERE r.player_id = who
    AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.source_level = r.level)
  UNION ALL
  SELECT 'achievement', NULL, e.achievement_id, e.tier, NULL,
         CASE e.tier WHEN 'bronze' THEN amount.bronze WHEN 'silver' THEN amount.silver ELSE amount.gold END,
         e.earned_at
  FROM achievement_earned e
  WHERE e.player_id = who
    AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.achievement_id = e.achievement_id
                    AND g.tier = e.tier)
    AND NOT tier_revoked(who, e.achievement_id, e.tier)
  UNION ALL
  SELECT 'questify', NULL, NULL, NULL, a.id, q.gems, a.earned_at
  FROM questify_award a JOIN questify_quest q ON q.id = a.quest_id
  WHERE a.player_id = who AND q.gems > 0 AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.questify_award_id = a.id)
 ), written AS (
  INSERT INTO gem_entry (player_id, delta, source, source_level, achievement_id, tier, questify_award_id)
  SELECT who, d.delta, d.source, d.source_level, d.achievement_id, d.tier, d.award_id FROM due d
  ORDER BY d.at, d.source, d.source_level, d.achievement_id, array_position(ARRAY['bronze', 'silver', 'gold'], d.tier),
           d.award_id
  ON CONFLICT DO NOTHING
  RETURNING delta
 )
 SELECT coalesce(sum(w.delta), 0) INTO earned FROM written w;
 IF earned > 0 THEN
  UPDATE player_xp x SET gems = x.gems + earned WHERE x.player_id = who RETURNING x.gems INTO balance;
 ELSE
  SELECT x.gems INTO balance FROM player_xp x WHERE x.player_id = who;
 END IF;
 RETURN jsonb_build_object('achievements', tiers, 'quests', paid, 'levelUp', questify_level_up(who, entries, caught),
  'gems', jsonb_build_object('earned', earned, 'balance', balance),
  'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', streaks) END);
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- ================================================================ readers that derive the level from XP (ADR-440)
-- As 0039, with the level (and so its range, the next level and the title) derived from the XP: a stored level a save
-- removed or left stale never drops the row or misleads the player before their next sync.
CREATE OR REPLACE FUNCTION own_level(completion bigint)
  RETURNS TABLE (xp bigint, level smallint, level_from bigint, next_level_at bigint, title_ar text, title_en text,
                 level_up smallint, up_title_ar text, up_title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.xp, cur.level, cur.xp_from, nxt.xp_from, t.name_ar, t.name_en, up.level, ut.name_ar, ut.name_en
  FROM player_xp x
  JOIN player p ON p.id = x.player_id AND p.status = 'active'
  JOIN xp_level cur ON cur.level = xp_level_of(x.xp)
  LEFT JOIN xp_level nxt ON nxt.level = cur.level + 1
  LEFT JOIN LATERAL level_title_of(cur.level) t ON true
  LEFT JOIN LATERAL (SELECT max(r.level) AS level FROM level_reached r
                     JOIN xp_entry e ON e.id = r.xp_entry_id
                     JOIN ledger_entry l ON l.id = e.ledger_entry_id
                     WHERE r.player_id = x.player_id AND l.completion_id = completion AND l.kind = 'quest') up ON true
  LEFT JOIN LATERAL level_title_of(up.level) ut ON true
  WHERE x.player_id = app_player_id()
$$;
REVOKE ALL ON FUNCTION own_level(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_level(bigint) TO questify_app;

-- As 0063, with the next reward at the level after the one the XP stands at.
CREATE OR REPLACE FUNCTION own_equipment() RETURNS TABLE(equipment jsonb,next_reward jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('character',item_json(e.character_id),'frame',item_json(e.frame_id),'title',item_json(e.title_id)),item_json(m.item_id)
 FROM player_xp x LEFT JOIN player_equipment e ON e.player_id=x.player_id LEFT JOIN level_item m ON m.level=xp_level_of(x.xp)+1
 WHERE x.player_id=profile_player()
$$;
REVOKE ALL ON FUNCTION own_equipment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_equipment() TO questify_app;

-- As 0122, with the level derived from the XP: the admin sees the level the player stands at.
CREATE OR REPLACE FUNCTION console_player_record(target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  p      player;
  answer jsonb;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'PA404';
  END IF;
  IF p.status = 'deleted' THEN
    answer := jsonb_build_object('player', jsonb_build_object('id', p.id, 'status', p.status,
                                                              'createdAt', p.created_at, 'deletedAt', p.deleted_at));
  ELSE
    answer := jsonb_build_object(
      'player', jsonb_build_object(
        'id', p.id, 'username', p.username, 'avatar', p.avatar, 'status', p.status, 'createdAt', p.created_at,
        'level', coalesce((SELECT xp_level_of(x.xp) FROM player_xp x WHERE x.player_id = p.id), 1),
        'xp', coalesce((SELECT x.xp FROM player_xp x WHERE x.player_id = p.id), 0)),
      'contacts', coalesce((SELECT contact_masked(pc.phone_e164, pc.email)
                            FROM player_contact pc WHERE pc.player_id = p.id),
                           jsonb_build_object('phone', NULL, 'email', NULL)),
      'contactsChanged', (SELECT jsonb_build_object('at', a.at, 'channel', a.after ->> 'channel',
                                                    'kind', a.after ->> 'kind')
                          FROM audit_log a
                          WHERE a.action = 'player.contact_change' AND a.target_id = p.id::text
                          ORDER BY a.at DESC LIMIT 1),
      'usernames', coalesce((SELECT jsonb_agg(jsonb_build_object('username', h.username, 'reason', h.reason,
                                                                 'changedAt', h.changed_at)
                                              ORDER BY h.changed_at DESC, h.id DESC)
                             FROM (SELECT * FROM username_history u WHERE u.player_id = p.id
                                   ORDER BY u.changed_at DESC, u.id DESC LIMIT 50) h), '[]'::jsonb),
      'events', console_player_events(p.id),
      'achievements', console_player_tiers(p.id),
      'sessions', (SELECT count(DISTINCT r.family)::integer FROM player_refresh r
                   WHERE r.player_id = p.id AND r.revoked_at IS NULL AND r.expires_at > now()
                     AND r.created_at > coalesce(p.tokens_valid_after, '-infinity'::timestamptz)),
      'actions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                    'id', a.id, 'kind', a.kind, 'reasonCode', a.reason_code, 'note', a.note,
                                    'fromUsername', a.from_username, 'toUsername', a.to_username,
                                    'by', s.email, 'at', a.created_at) ORDER BY a.created_at DESC, a.id)
                           FROM (SELECT * FROM player_admin_action x WHERE x.player_id = p.id
                                 ORDER BY x.created_at DESC LIMIT 100) a
                           JOIN staff_user s ON s.id = a.admin_id), '[]'::jsonb))
      || console_player_flags_reports(p.id);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, 'console.player_read', 'player', p.id::text, request);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION console_player_record(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_record(uuid, uuid) TO questify_app;

-- ================================================================ the XP table door (ADR-440)
-- The curve and its reward map as the console edits them and an audit entry holds them.
CREATE FUNCTION admin_xp_table_doc() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('levels', coalesce(jsonb_agg(
    jsonb_build_object('level', l.level, 'xpFrom', l.xp_from, 'itemId', m.item_id) ORDER BY l.level), '[]'::jsonb))
  FROM xp_level l LEFT JOIN level_item m ON m.level = l.level
$$;
REVOKE ALL ON FUNCTION admin_xp_table_doc() FROM PUBLIC;

-- The table and, per level, whether anyone reached it (the console's lock icons).
CREATE FUNCTION admin_xp_table() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN jsonb_build_object('levels', coalesce((
    SELECT jsonb_agg(jsonb_build_object('level', l.level, 'xpFrom', l.xp_from, 'itemId', m.item_id,
                                        'reached', EXISTS (SELECT 1 FROM level_reached r WHERE r.level = l.level))
                     ORDER BY l.level)
    FROM xp_level l LEFT JOIN level_item m ON m.level = l.level), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION admin_xp_table() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_xp_table() TO questify_app;

-- A document checked and put in its stored shape (CA400, the detail names the field and, past the list, the level):
-- only `levels`; levels 1 to N in order, N 2 to 100; level 1 starts at 0 with no item; every other level starts at a whole
-- 1 to 100,000,000, strictly rising, and has its own item id.
CREATE FUNCTION xp_table_checked(doc jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  e      jsonb;
  i      integer := 0;
  start  bigint;
  prior  bigint := -1;
  chosen text;
  seen   text[] := '{}';
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - 'levels' <> '{}'::jsonb
     OR jsonb_typeof(doc -> 'levels') IS DISTINCT FROM 'array'
     OR jsonb_array_length(doc -> 'levels') NOT BETWEEN 2 AND 100 THEN
    RAISE EXCEPTION 'give 2 to 100 levels' USING ERRCODE = 'CA400', DETAIL = 'levels';
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(doc -> 'levels') AS x LOOP
    i := i + 1;
    IF jsonb_typeof(e) IS DISTINCT FROM 'object' OR e - ARRAY['level', 'xpFrom', 'itemId'] <> '{}'::jsonb
       OR e -> 'level' IS DISTINCT FROM to_jsonb(i) THEN
      RAISE EXCEPTION 'level % is out of order or has unknown fields', i USING ERRCODE = 'CA400', DETAIL = 'level:' || i;
    END IF;
    IF jsonb_typeof(e -> 'xpFrom') IS DISTINCT FROM 'number' OR (e ->> 'xpFrom') !~ '^(0|[1-9][0-9]{0,8})$' THEN
      RAISE EXCEPTION 'level % needs a whole starting XP', i USING ERRCODE = 'CA400', DETAIL = 'xpFrom:' || i;
    END IF;
    start := (e ->> 'xpFrom')::bigint;
    IF (i = 1 AND start <> 0) OR (i > 1 AND start NOT BETWEEN 1 AND 100000000) OR start <= prior THEN
      RAISE EXCEPTION 'level % must start at 0 for level 1, else from 1 to 100000000 and above the level before', i
        USING ERRCODE = 'CA400', DETAIL = 'xpFrom:' || i;
    END IF;
    chosen := CASE WHEN jsonb_typeof(e -> 'itemId') = 'string' THEN e ->> 'itemId' END;
    IF (i = 1 AND coalesce(jsonb_typeof(e -> 'itemId'), 'null') <> 'null')
       OR (i > 1 AND (chosen IS NULL OR chosen !~ '^[a-z][a-z0-9-]{0,63}$' OR chosen = ANY (seen))) THEN
      RAISE EXCEPTION 'level % needs its own item (level 1 has none)', i USING ERRCODE = 'CA400', DETAIL = 'itemId:' || i;
    END IF;
    seen := seen || chosen;
    prior := start;
  END LOOP;
  RETURN jsonb_build_object('levels', (
    SELECT jsonb_agg(jsonb_build_object('level', o.n, 'xpFrom', (x ->> 'xpFrom')::bigint,
                                        'itemId', CASE WHEN o.n = 1 THEN NULL ELSE x ->> 'itemId' END) ORDER BY o.n)
    FROM jsonb_array_elements(doc -> 'levels') WITH ORDINALITY AS o (x, n)));
END $$;
REVOKE ALL ON FUNCTION xp_table_checked(jsonb) FROM PUBLIC;

-- What is left of the save's 1 s lock budget, in milliseconds; CA503 (503 busy) when it is used up.
CREATE FUNCTION xp_lock_left(started timestamptz) RETURNS text
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  left_ms integer := 1000 - floor(extract(epoch FROM clock_timestamp() - started) * 1000)::integer;
BEGIN
  IF left_ms <= 0 THEN
    RAISE EXCEPTION 'players are levelling up right now; try again in a moment' USING ERRCODE = 'CA503';
  END IF;
  RETURN left_ms || 'ms';
END $$;
REVOKE ALL ON FUNCTION xp_lock_left(timestamptz) FROM PUBLIC;

-- The refusal of one level as the API reads it: {"reason": ..., "level": n}.
CREATE FUNCTION xp_table_refuse(reason text, at_level integer, message text) RETURNS void
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%', message
    USING ERRCODE = 'CA409', DETAIL = jsonb_build_object('reason', reason, 'level', at_level)::text;
END $$;
REVOKE ALL ON FUNCTION xp_table_refuse(text, integer, text) FROM PUBLIC;

-- Each level of a saved document beside the same level before it (NULLs for an added level).
CREATE FUNCTION xp_table_changes(old_doc jsonb, new_doc jsonb)
  RETURNS TABLE (level smallint, was bigint, now bigint, item_was text, item_now text)
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT n.level, o."xpFrom", n."xpFrom", o."itemId", n."itemId"
  FROM jsonb_to_recordset(new_doc -> 'levels') AS n (level smallint, "xpFrom" bigint, "itemId" text)
  LEFT JOIN jsonb_to_recordset(old_doc -> 'levels') AS o (level smallint, "xpFrom" bigint, "itemId" text)
    ON o.level = n.level
$$;
REVOKE ALL ON FUNCTION xp_table_changes(jsonb, jsonb) FROM PUBLIC;

-- The highest XP anyone holds, inactive players included (one probe of the board's rank index; 0 when nobody has XP).
CREATE FUNCTION xp_board_top() RETURNS bigint
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT b.xp FROM xp_board b WHERE b.board = 'all' AND b.xp > 0 ORDER BY b.xp DESC LIMIT 1), 0)
$$;
REVOKE ALL ON FUNCTION xp_board_top() FROM PUBLIC;

-- The checks of a save that need the locks (ADR-440): a new item exists and has no other source; a removed level nobody
-- reached or stands at; a changed reward on a level nobody reached. Both documents are in their stored shape.
CREATE FUNCTION xp_table_refusals(old_doc jsonb, new_doc jsonb) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  top     bigint := xp_board_top();
  at      integer;
  unknown boolean;
BEGIN
  SELECT c.level, i.id IS NULL INTO at, unknown
  FROM xp_table_changes(old_doc, new_doc) c LEFT JOIN item i ON i.id = c.item_now
  WHERE c.level > 1 AND c.item_was IS DISTINCT FROM c.item_now
    AND (i.id IS NULL OR c.item_now LIKE 'souvenir-%'
         OR EXISTS (SELECT 1 FROM souvenir_rule s WHERE s.item_id = c.item_now)
         OR EXISTS (SELECT 1 FROM gem_shop_item g WHERE g.item_id = c.item_now))
  ORDER BY c.level LIMIT 1;
  IF at IS NOT NULL THEN
    PERFORM xp_table_refuse(CASE WHEN unknown THEN 'item_unknown' ELSE 'item_has_source' END, at,
                            'there is no such item, or it is sold in the shop or is a souvenir');
  END IF;
  SELECT o.level INTO at
  FROM jsonb_to_recordset(old_doc -> 'levels') AS o (level integer, "xpFrom" bigint)
  WHERE o.level > jsonb_array_length(new_doc -> 'levels')
    AND (top >= o."xpFrom" OR EXISTS (SELECT 1 FROM level_reached x WHERE x.level = o.level))
  ORDER BY o.level LIMIT 1;
  IF at IS NOT NULL THEN
    PERFORM xp_table_refuse('level_held', at, 'players reached that level, or stand at it');
  END IF;
  SELECT c.level INTO at
  FROM xp_table_changes(old_doc, new_doc) c
  WHERE c.level > 1 AND c.was IS NOT NULL AND c.item_was IS DISTINCT FROM c.item_now
    AND EXISTS (SELECT 1 FROM level_reached x WHERE x.level = c.level)
  ORDER BY c.level LIMIT 1;
  IF at IS NOT NULL THEN
    PERFORM xp_table_refuse('reward_given', at, 'players already got that level''s reward');
  END IF;
END $$;
REVOKE ALL ON FUNCTION xp_table_refusals(jsonb, jsonb) FROM PUBLIC;

-- The levels a save makes due to someone: a kept level whose start falls, and an added level at or below the highest XP
-- anyone holds. Empty when the save pays nothing.
CREATE FUNCTION xp_table_paying(old_doc jsonb, new_doc jsonb) RETURNS integer[]
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(n.level ORDER BY n.level), '{}')
  FROM jsonb_to_recordset(new_doc -> 'levels') AS n (level integer, "xpFrom" bigint)
  LEFT JOIN jsonb_to_recordset(old_doc -> 'levels') AS o (level integer, "xpFrom" bigint) ON o.level = n.level
  WHERE n.level > 1
    AND (n."xpFrom" < o."xpFrom" OR (o.level IS NULL AND n."xpFrom" <= xp_board_top()))
$$;
REVOKE ALL ON FUNCTION xp_table_paying(jsonb, jsonb) FROM PUBLIC;

-- Writes a checked document over the locked table in an order the non-deferrable xp_from UNIQUE never trips on: removed
-- levels (their rewards first), raised starts from the top down, lowered starts from the bottom up, added levels; then the
-- changed rewards (the source guard locks each new item and refuses a second source).
CREATE FUNCTION xp_table_write(old_doc jsonb, new_doc jsonb) RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  kept integer := jsonb_array_length(new_doc -> 'levels');
  r    record;
BEGIN
  DELETE FROM level_item m WHERE m.level > kept;
  DELETE FROM xp_level l WHERE l.level > kept;
  FOR r IN SELECT c.level, c.now FROM xp_table_changes(old_doc, new_doc) c WHERE c.now > c.was ORDER BY c.level DESC LOOP
    UPDATE xp_level l SET xp_from = r.now WHERE l.level = r.level;
  END LOOP;
  FOR r IN SELECT c.level, c.now FROM xp_table_changes(old_doc, new_doc) c WHERE c.now < c.was ORDER BY c.level LOOP
    UPDATE xp_level l SET xp_from = r.now WHERE l.level = r.level;
  END LOOP;
  INSERT INTO xp_level (level, xp_from)
  SELECT c.level, c.now FROM xp_table_changes(old_doc, new_doc) c WHERE c.was IS NULL ORDER BY c.level;
  DELETE FROM level_item m USING xp_table_changes(old_doc, new_doc) c
  WHERE m.level = c.level AND c.was IS NOT NULL AND c.item_was IS DISTINCT FROM c.item_now;
  INSERT INTO level_item (level, item_id)
  SELECT c.level, c.item_now FROM xp_table_changes(old_doc, new_doc) c
  WHERE c.level > 1 AND c.item_was IS DISTINCT FROM c.item_now ORDER BY c.level;
END $$;
REVOKE ALL ON FUNCTION xp_table_write(jsonb, jsonb) FROM PUBLIC;

-- Saves the curve and its reward map (ADR-440). Locks, all within the 1 s budget: level 1 (two saves queue there), then
-- every other level one row per statement in level order (a new statement each, so levels another save just added are
-- included), then the rewards it changes or removes, then the new reward items in id order. Under those locks: the
-- document's checks, the refusals (CA409 item_unknown, item_has_source, level_held, reward_given; the detail names the
-- level), and a save that pays (a start falls, or an added level is within someone's XP) needs `confirmed` (CA428, the
-- detail names the levels and the gems per level). No player row is written: each player follows at their next XP or
-- sync. A save that changes nothing writes nothing. `revert_of` is the audit entry a revert undoes. Answers admin_xp_table().
CREATE FUNCTION admin_xp_table_save(doc jsonb, revert_of bigint, confirmed boolean, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  started timestamptz := clock_timestamp();
  old     jsonb;
  edited  jsonb;
  paying  integer[];
  target  smallint;
  chosen  text;
BEGIN
  PERFORM console_admin();
  PERFORM set_config('lock_timeout', xp_lock_left(started), true);
  PERFORM 1 FROM xp_level l WHERE l.level = 1 FOR UPDATE;
  FOR target IN SELECT l.level FROM xp_level l WHERE l.level > 1 ORDER BY l.level LOOP
    PERFORM set_config('lock_timeout', xp_lock_left(started), true);
    PERFORM 1 FROM xp_level l WHERE l.level = target FOR UPDATE;
  END LOOP;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('xp_level', 'all', revert_of);
  END IF;
  edited := xp_table_checked(doc);
  old := admin_xp_table_doc();
  IF old = edited THEN
    RETURN admin_xp_table();
  END IF;
  FOR target IN
    SELECT o.level FROM jsonb_to_recordset(old -> 'levels') AS o (level smallint, "itemId" text)
    LEFT JOIN jsonb_to_recordset(edited -> 'levels') AS n (level smallint, "itemId" text) ON n.level = o.level
    WHERE o.level > 1 AND o."itemId" IS DISTINCT FROM n."itemId"
    ORDER BY o.level
  LOOP
    PERFORM set_config('lock_timeout', xp_lock_left(started), true);
    PERFORM 1 FROM level_item m WHERE m.level = target FOR UPDATE;
  END LOOP;
  FOR chosen IN
    SELECT DISTINCT n."itemId" FROM jsonb_to_recordset(edited -> 'levels') AS n (level smallint, "itemId" text)
    LEFT JOIN jsonb_to_recordset(old -> 'levels') AS o (level smallint, "itemId" text) ON o.level = n.level
    WHERE n.level > 1 AND o."itemId" IS DISTINCT FROM n."itemId"
    ORDER BY 1
  LOOP
    PERFORM set_config('lock_timeout', xp_lock_left(started), true);
    PERFORM 1 FROM item i WHERE i.id = chosen FOR UPDATE;
  END LOOP;
  PERFORM xp_table_refusals(old, edited);
  paying := xp_table_paying(old, edited);
  IF cardinality(paying) > 0 AND confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'a lower curve pays level rewards and gems that cannot be taken back; confirm it'
      USING ERRCODE = 'CA428',
            DETAIL = jsonb_build_object('levels', to_jsonb(paying), 'levelUp', (SELECT g.level_up FROM gem_amounts() g))::text;
  END IF;
  PERFORM xp_table_write(old, edited);
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.xp_table.revert' ELSE 'catalog.xp_table.update' END,
                        'xp_level', 'all', old, edited, request);
  RETURN admin_xp_table();
END $$;
REVOKE ALL ON FUNCTION admin_xp_table_save(jsonb, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_xp_table_save(jsonb, bigint, boolean, uuid) TO questify_app;

-- Active players with XP from `low` up to (not including) `high`: one range of the board's rank index, less the few
-- inactive players' rows in it (player_inactive_idx), as the rankings count (ADR-322).
CREATE FUNCTION xp_board_active_between(low bigint, high bigint) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM xp_board b WHERE b.board = 'all' AND b.xp > 0 AND b.xp >= low AND b.xp < high)
       - (SELECT count(*) FROM player p JOIN xp_board b ON b.board = 'all' AND b.player_id = p.id
          WHERE p.status <> 'active' AND b.xp > 0 AND b.xp >= low AND b.xp < high)
$$;
REVOKE ALL ON FUNCTION xp_board_active_between(bigint, bigint) FROM PUBLIC;

-- What a document would do to active players now (read only, no locks, advisory): how many go up and down a level, how
-- many level rewards fall due, and the gems they pay at the level-up amount in force. The XP ranges between the old and
-- new starts are classed from the two curves alone; players are counted only in the ranges where something changes, so
-- a small edit reads a small part of the board.
CREATE FUNCTION admin_xp_table_preview(doc jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  edited   jsonb;
  level_up integer := (SELECT g.level_up FROM gem_amounts() g);
  answer   jsonb;
BEGIN
  PERFORM console_admin();
  edited := xp_table_checked(doc);
  WITH new_curve AS MATERIALIZED (
    SELECT n.level, n."xpFrom" AS xp_from FROM jsonb_to_recordset(edited -> 'levels') AS n (level integer, "xpFrom" bigint)
  ), starts AS (
    SELECT DISTINCT s FROM (SELECT l.xp_from FROM xp_level l UNION SELECT n.xp_from FROM new_curve n) u (s) WHERE s > 0
  ), ranges AS (
    SELECT s AS low, coalesce(lead(s) OVER (ORDER BY s), 9223372036854775807) AS high FROM starts
  ), classed AS (
    SELECT r.low, r.high,
           (SELECT max(l.level) FROM xp_level l WHERE l.xp_from <= r.low) AS was,
           (SELECT max(n.level) FROM new_curve n WHERE n.xp_from <= r.low) AS now,
           (SELECT count(*) FROM new_curve n LEFT JOIN xp_level l ON l.level = n.level
            WHERE n.level > 1 AND n.xp_from <= r.low AND (l.level IS NULL OR l.xp_from > r.low)) AS due
    FROM ranges r
  ), counted AS (
    SELECT c.was, c.now, c.due, xp_board_active_between(c.low, c.high) AS players
    FROM classed c WHERE c.was <> c.now OR c.due > 0
  )
  SELECT jsonb_build_object('up', coalesce(sum(c.players) FILTER (WHERE c.now > c.was), 0),
                            'down', coalesce(sum(c.players) FILTER (WHERE c.now < c.was), 0),
                            'levels', coalesce(sum(c.players * c.due), 0),
                            'gems', coalesce(sum(c.players * c.due), 0) * level_up,
                            'levelUp', level_up)
  INTO answer FROM counted c;
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION admin_xp_table_preview(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_xp_table_preview(jsonb) TO questify_app;

-- ================================================================ the item catalog (ADR-441)
-- As 0067, with one change: an item with a shop row may change its names (its art stays frozen: buyers keep what they
-- saw, Q-402). Every source writer still locks the item FOR UPDATE and is refused a second source.
CREATE OR REPLACE FUNCTION souvenir_catalog_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path = public, pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME IN ('level_item', 'souvenir_rule', 'gem_shop_item') THEN
  PERFORM 1 FROM item i WHERE i.id = NEW.item_id FOR UPDATE;
 END IF;
 IF TG_TABLE_NAME <> 'item' THEN
  IF TG_TABLE_NAME <> 'souvenir_rule' AND EXISTS (SELECT 1 FROM souvenir_rule r WHERE r.item_id = NEW.item_id) THEN
   RAISE EXCEPTION 'item already has a souvenir source' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME <> 'level_item' AND EXISTS (SELECT 1 FROM level_item l WHERE l.item_id = NEW.item_id) THEN
   RAISE EXCEPTION 'item already has a level source' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME <> 'gem_shop_item' AND EXISTS (SELECT 1 FROM gem_shop_item g WHERE g.item_id = NEW.item_id) THEN
   RAISE EXCEPTION 'item is sold in the gem shop' USING ERRCODE = '23514';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM souvenir_rule r WHERE r.item_id = OLD.id AND r.status <> 'draft') THEN
  RAISE EXCEPTION 'active souvenir content is frozen' USING ERRCODE = 'SV409', DETAIL = 'souvenir_locked';
 ELSIF NEW.visual_key IS DISTINCT FROM OLD.visual_key AND EXISTS (SELECT 1 FROM gem_shop_item g WHERE g.item_id = OLD.id) THEN
  RAISE EXCEPTION 'gem shop art is frozen' USING ERRCODE = 'GS409', DETAIL = 'shop_item_locked';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION souvenir_catalog_guard() FROM PUBLIC;

-- Whether an item is an organizer's souvenir (never listed or edited here).
CREATE FUNCTION item_is_souvenir(target text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT target LIKE 'souvenir-%' OR EXISTS (SELECT 1 FROM souvenir_rule r WHERE r.item_id = target)
$$;
REVOKE ALL ON FUNCTION item_is_souvenir(text) FROM PUBLIC;

-- What an admin edits of an item, as the audit entry and a revert hold it.
CREATE FUNCTION admin_item_doc(i item) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('name', jsonb_build_object('ar', i.name_ar, 'en', i.name_en), 'visualKey', i.visual_key)
$$;
REVOKE ALL ON FUNCTION admin_item_doc(item) FROM PUBLIC;

-- One item as the console lists it: its source (a level, the shop with its status, or none) and why its art is locked.
CREATE FUNCTION admin_item_row(i item) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT admin_item_doc(i) || jsonb_build_object(
    'id', i.id, 'kind', i.kind,
    'source', CASE WHEN m.level IS NOT NULL THEN jsonb_build_object('level', m.level)
                   WHEN s.item_id IS NOT NULL THEN jsonb_build_object('shop', jsonb_build_object('status', s.status)) END,
    'locked', jsonb_build_object('art', CASE
      WHEN s.item_id IS NOT NULL THEN 'on_sale'
      WHEN m.level IS NOT NULL AND EXISTS (SELECT 1 FROM level_reached r WHERE r.level = m.level) THEN 'owned' END))
  FROM (SELECT 1) one
  LEFT JOIN level_item m ON m.item_id = i.id
  LEFT JOIN gem_shop_item s ON s.item_id = i.id
$$;
REVOKE ALL ON FUNCTION admin_item_row(item) FROM PUBLIC;

-- Questify's items: level rewards, shop items and unassigned ones, never a souvenir.
CREATE FUNCTION admin_items() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((SELECT jsonb_agg(admin_item_row(i) ORDER BY i.id) FROM item i WHERE NOT item_is_souvenir(i.id)),
                  '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_items() TO questify_app;

-- Changes an item's names and, while it has no shop row and is not the reward of a level anyone reached, its art (a
-- shipped visual key for its kind; the table's CHECK is the last word, 23514). Names take FOR NO KEY UPDATE, which waits on
-- no reach or buy; an art change takes FOR UPDATE, which waits for reaches and buys of the item in flight and then sees
-- them (CA409 item_on_sale, item_owned). CA404 for an unknown or souvenir item. A save that changes nothing writes nothing.
CREATE FUNCTION admin_item_save(target text, doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old    item;
  made   item;
  edited jsonb;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM item i WHERE i.id = target FOR NO KEY UPDATE;
  IF NOT FOUND OR item_is_souvenir(target) THEN
    RAISE EXCEPTION 'no such item' USING ERRCODE = 'CA404';
  END IF;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('item', target, revert_of);
  END IF;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['name', 'visualKey'] <> '{}'::jsonb
     OR coalesce(jsonb_typeof(doc -> 'visualKey'), 'missing') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'an item has its names and its art only' USING ERRCODE = 'CA400', DETAIL = 'doc';
  END IF;
  edited := jsonb_build_object('name', jsonb_build_object('ar', catalog_text(doc #>> '{name,ar}', 'name.ar', 60),
                                                          'en', catalog_text(doc #>> '{name,en}', 'name.en', 60)),
                               'visualKey', doc -> 'visualKey');
  IF admin_item_doc(old) = edited THEN
    RETURN admin_item_row(old);
  END IF;
  IF (edited ->> 'visualKey') IS DISTINCT FROM old.visual_key THEN
    PERFORM 1 FROM item i WHERE i.id = target FOR UPDATE;
    IF EXISTS (SELECT 1 FROM gem_shop_item g WHERE g.item_id = target) THEN
      RAISE EXCEPTION 'an item in the shop keeps its art' USING ERRCODE = 'CA409',
        DETAIL = jsonb_build_object('reason', 'item_on_sale')::text;
    END IF;
    IF EXISTS (SELECT 1 FROM level_item m JOIN level_reached r ON r.level = m.level WHERE m.item_id = target) THEN
      RAISE EXCEPTION 'players own this item; it keeps its art' USING ERRCODE = 'CA409',
        DETAIL = jsonb_build_object('reason', 'item_owned')::text;
    END IF;
  END IF;
  UPDATE item i SET name_ar = edited #>> '{name,ar}', name_en = edited #>> '{name,en}', visual_key = edited ->> 'visualKey'
  WHERE i.id = target
  RETURNING * INTO made;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.item.revert' ELSE 'catalog.item.update' END,
                        'item', target, admin_item_doc(old), edited, request);
  RETURN admin_item_row(made);
END $$;
REVOKE ALL ON FUNCTION admin_item_save(text, jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_item_save(text, jsonb, bigint, uuid) TO questify_app;

-- One optional shop listing of a new item: price 1 to 100,000, place 1 to 1,000, status active or retired (CA400 `shop`).
CREATE FUNCTION item_shop_checked(shop jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(shop) IS DISTINCT FROM 'object' OR shop - ARRAY['price', 'position', 'status'] <> '{}'::jsonb
     OR NOT amount_field_ok(shop, 'price', 1, 100000) OR NOT amount_field_ok(shop, 'position', 1, 1000)
     OR coalesce(shop ->> 'status', '') NOT IN ('active', 'retired') THEN
    RAISE EXCEPTION 'a shop listing has a price, a place and a status' USING ERRCODE = 'CA400', DETAIL = 'shop';
  END IF;
  RETURN shop;
END $$;
REVOKE ALL ON FUNCTION item_shop_checked(jsonb) FROM PUBLIC;

-- Makes a new item with its id, kind, names and art, optionally on sale in the same transaction (the source guard locks
-- the new item and refuses a second source). CA400 for a bad field (the detail names it; a `souvenir-` id is an
-- organizer's), CA409 `exists` when the id is taken (two admins with one id: one wins). Audited as catalog.item.create
-- with no before, so it has nothing to revert.
CREATE FUNCTION admin_item_create(doc jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made  item;
  shop  jsonb;
BEGIN
  PERFORM console_admin();
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['id', 'kind', 'name', 'visualKey', 'shop'] <> '{}'::jsonb
     OR coalesce(jsonb_typeof(doc -> 'visualKey'), 'missing') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'a new item has an id, a kind, names, its art and an optional shop listing'
      USING ERRCODE = 'CA400', DETAIL = 'doc';
  END IF;
  IF coalesce(doc ->> 'id', '') !~ '^[a-z][a-z0-9-]{0,63}$' OR doc ->> 'id' LIKE 'souvenir-%' THEN
    RAISE EXCEPTION 'an item id is lowercase letters, digits and dashes, not souvenir-' USING ERRCODE = 'CA400', DETAIL = 'id';
  END IF;
  IF coalesce(doc ->> 'kind', '') NOT IN ('character', 'frame', 'title') THEN
    RAISE EXCEPTION 'an item is a character, a frame or a title' USING ERRCODE = 'CA400', DETAIL = 'kind';
  END IF;
  IF doc ? 'shop' THEN
    shop := item_shop_checked(doc -> 'shop');
  END IF;
  INSERT INTO item (id, kind, name_ar, name_en, visual_key)
  VALUES (doc ->> 'id', doc ->> 'kind', catalog_text(doc #>> '{name,ar}', 'name.ar', 60),
          catalog_text(doc #>> '{name,en}', 'name.en', 60), doc ->> 'visualKey')
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO made;
  IF made.id IS NULL THEN
    RAISE EXCEPTION 'an item with that id exists' USING ERRCODE = 'CA409',
      DETAIL = jsonb_build_object('reason', 'exists')::text;
  END IF;
  IF shop IS NOT NULL THEN
    INSERT INTO gem_shop_item (item_id, price, status, position)
    VALUES (made.id, (shop ->> 'price')::integer, shop ->> 'status', (shop ->> 'position')::smallint);
  END IF;
  PERFORM catalog_audit('catalog.item.create', 'item', made.id, NULL,
                        admin_item_doc(made) || jsonb_build_object('kind', made.kind, 'shop', shop), request);
  RETURN admin_item_row(made);
END $$;
REVOKE ALL ON FUNCTION admin_item_create(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_item_create(jsonb, uuid) TO questify_app;
