-- T-403b: always-on and seasonal Questify quests, their campaigns and the console's doors; a met quest pays its XP
-- once through xp_entry's new `questify` source (ADR-278, ADR-280). Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';
-- Every table lock first, in the order a scan takes them (xp_entry, then player_xp), so a scan, a sync or an erasure
-- crossing the deploy never holds one of them while waiting on the other behind this migration.
LOCK TABLE xp_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player_xp IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the catalog (ADR-278)
-- A seasonal window: entered in Saudi time by the console, stored as instants. Written only by the admin doors below.
CREATE TABLE questify_campaign (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name_ar text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 80
  AND name_ar !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
 name_en text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 80
  AND name_en !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
 created_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (starts_at < ends_at)
);
ALTER TABLE questify_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE questify_campaign FORCE ROW LEVEL SECURITY;
REVOKE ALL ON questify_campaign FROM PUBLIC, questify_app;

-- One quest: always-on (no campaign) or seasonal. The metric list is closed code; the rest is data.
CREATE TABLE questify_quest (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 campaign_id uuid REFERENCES questify_campaign (id),
 metric text NOT NULL CHECK (metric IN ('events', 'cities', 'quests')),
 target integer NOT NULL CHECK (target BETWEEN 1 AND 1000),
 title_ar text NOT NULL CHECK (length(btrim(title_ar)) BETWEEN 1 AND 80
  AND title_ar !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
 title_en text NOT NULL CHECK (length(btrim(title_en)) BETWEEN 1 AND 80
  AND title_en !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
 xp integer NOT NULL CHECK (xp BETWEEN 1 AND 10000),
 position smallint NOT NULL DEFAULT 1 CHECK (position BETWEEN 1 AND 1000),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
 created_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX questify_quest_campaign_idx ON questify_quest (campaign_id);
ALTER TABLE questify_quest ENABLE ROW LEVEL SECURITY;
ALTER TABLE questify_quest FORCE ROW LEVEL SECURITY;
REVOKE ALL ON questify_quest FROM PUBLIC, questify_app;
-- Seeded always-on quests (ADR-279, Q-240): live from the deploy; a veteran who qualifies gets them at the next sync.
INSERT INTO questify_quest (metric, target, title_ar, title_en, xp, position, status) VALUES
 ('events', 3, 'شارك في 3 فعاليات', 'Attend 3 events', 300, 1, 'active'),
 ('cities', 2, 'العب في مدينتين', 'Play in 2 cities', 300, 2, 'active');

-- Each quest a player met, once. Points at player_xp (as the XP rows) and is kept on the erasure tombstone.
CREATE TABLE questify_award (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 player_id uuid NOT NULL REFERENCES player_xp (player_id),
 quest_id uuid NOT NULL REFERENCES questify_quest (id) ON DELETE RESTRICT,
 earned_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (player_id, quest_id)
);
ALTER TABLE questify_award ENABLE ROW LEVEL SECURITY;
ALTER TABLE questify_award FORCE ROW LEVEL SECURITY;
REVOKE ALL ON questify_award FROM PUBLIC, questify_app;
CREATE OR REPLACE FUNCTION history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'earned achievements, Questify awards and final ranks can never be changed or removed'
  USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION history_append_only() FROM PUBLIC;
CREATE TRIGGER questify_award_no_update_or_delete BEFORE UPDATE OR DELETE ON questify_award
 FOR EACH ROW EXECUTE FUNCTION history_append_only();
CREATE TRIGGER questify_award_no_truncate BEFORE TRUNCATE ON questify_award
 FOR EACH STATEMENT EXECUTE FUNCTION history_append_only();
ALTER TABLE questify_award ENABLE ALWAYS TRIGGER questify_award_no_update_or_delete;
ALTER TABLE questify_award ENABLE ALWAYS TRIGGER questify_award_no_truncate;

-- ================================================================ the XP row of an award
-- quest and removal keep 0039's shape; a questify entry pays once per award, has no ledger entry or event quest, and
-- reverses nothing. xp_reverse follows only ledger_entry_id, so a removal can never take a Questify award back.
ALTER TABLE xp_entry
 ALTER COLUMN ledger_entry_id DROP NOT NULL,
 ALTER COLUMN quest_id DROP NOT NULL,
 ADD COLUMN questify_award_id bigint UNIQUE REFERENCES questify_award (id),
 DROP CONSTRAINT xp_entry_source_check,
 DROP CONSTRAINT xp_entry_check,
 ADD CONSTRAINT xp_entry_shape CHECK (
  (source = 'quest' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NOT NULL AND quest_id IS NOT NULL
   AND questify_award_id IS NULL)
  OR (source = 'removal' AND delta < 0 AND reverses IS NOT NULL AND ledger_entry_id IS NOT NULL
      AND quest_id IS NOT NULL AND questify_award_id IS NULL)
  OR (source = 'questify' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
      AND questify_award_id IS NOT NULL));

-- ================================================================ the campaign window (MINOR-6)
-- As 0065, bounded to the credits whose ledger entry was written in [since, until) (NULL: unbounded). The ledger's
-- time, not the XP row's: 0039's backfill gave older XP rows the migration's timestamp. Internal.
CREATE FUNCTION standing_credits(who uuid, since timestamptz, until timestamptz)
 RETURNS TABLE (enrollment_id uuid, event_id uuid, credit_id bigint)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT n.id, n.event_id, x.id
 FROM xp_entry x JOIN ledger_entry l ON l.id = x.ledger_entry_id JOIN enrollment n ON n.id = l.enrollment_id
 WHERE x.player_id = who AND x.source = 'quest' AND played_enrollment(n.status, n.joined_via)
   AND (since IS NULL OR l.created_at >= since) AND (until IS NULL OR l.created_at < until)
   AND NOT EXISTS (SELECT 1 FROM xp_entry r WHERE r.source = 'removal' AND r.reverses = x.id)
$$;
REVOKE ALL ON FUNCTION standing_credits(uuid, timestamptz, timestamptz) FROM PUBLIC;
CREATE OR REPLACE FUNCTION standing_credits(who uuid) RETURNS TABLE (enrollment_id uuid, event_id uuid, credit_id bigint)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT * FROM standing_credits(who, NULL, NULL)
$$;

-- As 0065 over a window. top10 and goals are lifetime only, so a bounded call answers events, quests and cities.
CREATE FUNCTION player_metrics(who uuid, since timestamptz, until timestamptz) RETURNS TABLE (metric text, value integer)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 WITH credit AS MATERIALIZED (SELECT * FROM standing_credits(who, since, until)),
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
 WHERE since IS NULL AND until IS NULL
 UNION ALL
 SELECT 'goals', (SELECT count(DISTINCT c.goal_id) FROM enrollment n
                  JOIN community_contributor c ON c.enrollment_id = n.id
                  JOIN community_goal g ON g.id = c.goal_id AND g.status = 'reached'
                  WHERE n.player_id = who AND played_enrollment(n.status, n.joined_via))::integer
 WHERE since IS NULL AND until IS NULL
$$;
REVOKE ALL ON FUNCTION player_metrics(uuid, timestamptz, timestamptz) FROM PUBLIC;
CREATE OR REPLACE FUNCTION player_metrics(who uuid) RETURNS TABLE (metric text, value integer)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT * FROM player_metrics(who, NULL, NULL)
$$;

-- ================================================================ the evaluator (ADR-274, ADR-278)
-- Every quest the player now meets and was not awarded: active always-on quests on lifetime metrics, and active
-- quests of a published campaign from its start until 3 days after its end on the facts of [starts_at, ends_at). The
-- grace only pays a late sync for an in-window play; the list stops offering the quest at the end. Internal.
CREATE FUNCTION questify_due(who uuid) RETURNS TABLE (quest_id uuid)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 WITH open AS MATERIALIZED (
  SELECT q.id, q.metric, q.target, c.starts_at AS since, c.ends_at AS until
  FROM questify_quest q LEFT JOIN questify_campaign c ON c.id = q.campaign_id
  WHERE q.status = 'active'
    AND (q.campaign_id IS NULL
         OR (c.status = 'published' AND c.starts_at <= now() AND now() < c.ends_at + interval '3 days'))
    AND NOT EXISTS (SELECT 1 FROM questify_award a WHERE a.player_id = who AND a.quest_id = q.id)
 ),
 span AS (SELECT DISTINCT o.since, o.until FROM open o)
 SELECT o.id
 FROM span s CROSS JOIN LATERAL player_metrics(who, s.since, s.until) m
 JOIN open o ON o.since IS NOT DISTINCT FROM s.since AND o.until IS NOT DISTINCT FROM s.until AND o.metric = m.metric
 WHERE m.value >= o.target
$$;
REVOKE ALL ON FUNCTION questify_due(uuid) FROM PUBLIC;

-- The highest level the given XP entries reached first, its title and the level items they gave; NULL if none.
-- The completion answer's LevelUp shape (T-401, T-402). Internal.
CREATE FUNCTION questify_level_up(who uuid, entries bigint[]) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('level', top.level, 'title', jsonb_build_object('ar', t.name_ar, 'en', t.name_en),
  'items', (SELECT coalesce(jsonb_agg(item_json(o.item_id) ORDER BY r.level), '[]'::jsonb)
            FROM level_reached r JOIN player_item o ON o.player_id = r.player_id AND o.source_level = r.level
            WHERE r.player_id = who AND r.xp_entry_id = ANY (entries)))
 FROM (SELECT max(r.level) AS level FROM level_reached r WHERE r.player_id = who AND r.xp_entry_id = ANY (entries)) top
 CROSS JOIN LATERAL level_title_of(top.level) t
 WHERE top.level IS NOT NULL
$$;
REVOKE ALL ON FUNCTION questify_level_up(uuid, bigint[]) FROM PUBLIC;

-- As 0065, plus Questify quests after the tiers under the same locks: each met quest writes one award, one XP entry
-- (its xp read under the lock) and xp_apply, so the total, the level, level_reached and the level items follow in this
-- transaction. The pre-check answers at once when nothing is due. Lock order unchanged: player KEY SHARE, then
-- player_xp FOR UPDATE; the award's key check takes KEY SHARE on the quest, which an admin save (NO KEY UPDATE) never
-- blocks.
CREATE OR REPLACE FUNCTION questify_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who     uuid;
 tiers   jsonb;
 quest   record;
 award   bigint;
 entry   bigint;
 paid    jsonb := '[]'::jsonb;
 entries bigint[] := '{}';
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) AND NOT EXISTS (SELECT 1 FROM questify_due(who)) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb, 'quests', '[]'::jsonb, 'levelUp', NULL);
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
 RETURN jsonb_build_object('achievements', tiers, 'quests', paid, 'levelUp', questify_level_up(who, entries));
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- The caller's Questify quests: active always-on quests on lifetime progress, then each published campaign running
-- now with its active quests on progress inside its window (the evaluator's bounds); `done` once awarded. NULL for a
-- caller who is not an active player.
CREATE FUNCTION own_questify_quests() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH me AS MATERIALIZED (SELECT profile_player() AS id),
 shown AS MATERIALIZED (
  SELECT q.id, q.campaign_id, q.metric, q.target, q.title_ar, q.title_en, q.xp, q.position,
         c.starts_at AS since, c.ends_at AS until
  FROM questify_quest q LEFT JOIN questify_campaign c ON c.id = q.campaign_id
  WHERE q.status = 'active'
    AND (q.campaign_id IS NULL OR (c.status = 'published' AND c.starts_at <= now() AND now() < c.ends_at))
 ),
 span AS (SELECT DISTINCT s.since, s.until FROM shown s),
 progress AS MATERIALIZED (
  SELECT s.since, s.until, m.metric, m.value
  FROM me CROSS JOIN span s CROSS JOIN LATERAL player_metrics(me.id, s.since, s.until) m
  WHERE me.id IS NOT NULL
 ),
 card AS MATERIALIZED (
  SELECT s.campaign_id, s.position, s.id, jsonb_build_object('id', s.id,
   'title', jsonb_build_object('ar', s.title_ar, 'en', s.title_en), 'metric', s.metric, 'target', s.target,
   'progress', p.value, 'xp', s.xp,
   'done', EXISTS (SELECT 1 FROM me JOIN questify_award a ON a.player_id = me.id AND a.quest_id = s.id)) AS body
  FROM shown s
  JOIN progress p ON p.since IS NOT DISTINCT FROM s.since AND p.until IS NOT DISTINCT FROM s.until AND p.metric = s.metric
 )
 SELECT jsonb_build_object(
  'alwaysOn', (SELECT coalesce(jsonb_agg(k.body ORDER BY k.position, k.id), '[]'::jsonb) FROM card k
               WHERE k.campaign_id IS NULL),
  'seasonal', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'campaign', jsonb_build_object('id', c.id, 'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
                                                'endsAt', c.ends_at),
                 'quests', (SELECT jsonb_agg(k.body ORDER BY k.position, k.id) FROM card k WHERE k.campaign_id = c.id))
                ORDER BY c.ends_at, c.id), '[]'::jsonb)
               FROM questify_campaign c WHERE c.id IN (SELECT k.campaign_id FROM card k)))
 FROM me WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_questify_quests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_questify_quests() TO questify_app;

-- ================================================================ the console's doors (ADR-278, ADR-280)
-- Each door re-reads the admin from the account (app_admin_id), so the request flag alone opens nothing; every write
-- is audited with ids and changed field names only. Refusals: QY403 (not an active platform admin; its own code so a
-- real 42501, such as a lost EXECUTE grant, stays a server fault), QY404, QY409 with the reason in DETAIL, QY422 with
-- the field in DETAIL.
CREATE FUNCTION questify_admin() RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
 admin uuid := app_admin_id();
BEGIN
 IF admin IS NULL THEN
  RAISE EXCEPTION 'only a Questify admin can do this' USING ERRCODE = 'QY403';
 END IF;
 RETURN admin;
END $$;
REVOKE ALL ON FUNCTION questify_admin() FROM PUBLIC;

CREATE FUNCTION questify_campaign_json(c questify_campaign) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('id', c.id, 'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
  'startsAt', c.starts_at, 'endsAt', c.ends_at, 'status', c.status, 'createdAt', c.created_at, 'updatedAt', c.updated_at)
$$;
REVOKE ALL ON FUNCTION questify_campaign_json(questify_campaign) FROM PUBLIC;
CREATE FUNCTION questify_quest_json(q questify_quest) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('id', q.id, 'campaignId', q.campaign_id, 'metric', q.metric, 'target', q.target,
  'title', jsonb_build_object('ar', q.title_ar, 'en', q.title_en), 'xp', q.xp, 'position', q.position,
  'status', q.status, 'createdAt', q.created_at, 'updatedAt', q.updated_at)
$$;
REVOKE ALL ON FUNCTION questify_quest_json(questify_quest) FROM PUBLIC;

CREATE FUNCTION questify_audit(admin uuid, verb text, kind text, target uuid, after jsonb, request uuid) RETURNS void
 LANGUAGE sql SET search_path = public, pg_temp AS $$
 INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
 VALUES ('admin', admin, 'questify.' || verb, kind, target::text, after, request)
$$;
REVOKE ALL ON FUNCTION questify_audit(uuid, text, text, uuid, jsonb, uuid) FROM PUBLIC;

-- A published campaign's window: the start moves only before it starts and never into the past; once started it is
-- fixed and the end only moves later; once ended the window is fixed. A draft's window is free. Internal.
CREATE FUNCTION questify_window_check(old questify_campaign, starts timestamptz, ends timestamptz) RETURNS void
 LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
 IF old.status = 'draft' THEN RETURN; END IF;
 IF old.ends_at <= now() AND (starts, ends) IS DISTINCT FROM (old.starts_at, old.ends_at) THEN
  RAISE EXCEPTION 'the campaign has ended' USING ERRCODE = 'QY409', DETAIL = 'ended';
 END IF;
 IF old.starts_at <= now() AND starts IS DISTINCT FROM old.starts_at THEN
  RAISE EXCEPTION 'the campaign has started' USING ERRCODE = 'QY409', DETAIL = 'started';
 END IF;
 IF old.starts_at <= now() AND ends < old.ends_at THEN
  RAISE EXCEPTION 'a running campaign only ends later' USING ERRCODE = 'QY409', DETAIL = 'ends_earlier';
 END IF;
 IF old.starts_at > now() AND starts < now() THEN
  RAISE EXCEPTION 'a published campaign cannot start in the past' USING ERRCODE = 'QY409', DETAIL = 'start_passed';
 END IF;
END $$;
REVOKE ALL ON FUNCTION questify_window_check(questify_campaign, timestamptz, timestamptz) FROM PUBLIC;

-- Creates a draft (target NULL) or replaces a campaign's name and window: `fields` = {name: {ar, en}, startsAt,
-- endsAt}. A retired campaign is fixed.
CREATE FUNCTION questify_campaign_save(target uuid, fields jsonb, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 admin   uuid := questify_admin();
 starts  timestamptz := (fields ->> 'startsAt')::timestamptz;
 ends    timestamptz := (fields ->> 'endsAt')::timestamptz;
 old     questify_campaign%ROWTYPE;
 made    questify_campaign%ROWTYPE;
 changed text[] := ARRAY['name', 'startsAt', 'endsAt'];
BEGIN
 IF target IS NULL THEN
  INSERT INTO questify_campaign (name_ar, name_en, starts_at, ends_at, created_by)
  VALUES (fields #>> '{name,ar}', fields #>> '{name,en}', starts, ends, admin) RETURNING * INTO made;
 ELSE
  SELECT c.* INTO old FROM questify_campaign c WHERE c.id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'QY404'; END IF;
  IF old.status = 'retired' THEN
   RAISE EXCEPTION 'a retired campaign is fixed' USING ERRCODE = 'QY409', DETAIL = 'retired';
  END IF;
  PERFORM questify_window_check(old, starts, ends);
  UPDATE questify_campaign c
  SET name_ar = fields #>> '{name,ar}', name_en = fields #>> '{name,en}', starts_at = starts, ends_at = ends,
      updated_at = now()
  WHERE c.id = old.id RETURNING * INTO made;
  changed := array_remove(ARRAY[
   CASE WHEN (made.name_ar, made.name_en) IS DISTINCT FROM (old.name_ar, old.name_en) THEN 'name' END,
   CASE WHEN made.starts_at IS DISTINCT FROM old.starts_at THEN 'startsAt' END,
   CASE WHEN made.ends_at IS DISTINCT FROM old.ends_at THEN 'endsAt' END], NULL);
 END IF;
 PERFORM questify_audit(admin, CASE WHEN target IS NULL THEN 'campaign_created' ELSE 'campaign_updated' END,
                        'questify_campaign', made.id, jsonb_build_object('fields', to_jsonb(changed)), request);
 RETURN questify_campaign_json(made);
END $$;
REVOKE ALL ON FUNCTION questify_campaign_save(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_campaign_save(uuid, jsonb, uuid) TO questify_app;

-- Publishes a draft that has not started yet (MINOR-6: facts before the start never count, so none is missed). A
-- published campaign answers as it is (a replay, not audited again).
CREATE FUNCTION questify_campaign_publish(target uuid, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 admin uuid := questify_admin();
 old   questify_campaign%ROWTYPE;
BEGIN
 SELECT c.* INTO old FROM questify_campaign c WHERE c.id = target FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'QY404'; END IF;
 IF old.status = 'published' THEN RETURN questify_campaign_json(old); END IF;
 IF old.status = 'retired' THEN
  RAISE EXCEPTION 'a retired campaign is fixed' USING ERRCODE = 'QY409', DETAIL = 'retired';
 END IF;
 IF old.starts_at < now() THEN
  RAISE EXCEPTION 'a campaign is published before it starts' USING ERRCODE = 'QY409', DETAIL = 'start_passed';
 END IF;
 UPDATE questify_campaign c SET status = 'published', updated_at = now() WHERE c.id = old.id RETURNING * INTO old;
 PERFORM questify_audit(admin, 'campaign_published', 'questify_campaign', old.id,
                        jsonb_build_object('status', 'published'), request);
 RETURN questify_campaign_json(old);
END $$;
REVOKE ALL ON FUNCTION questify_campaign_publish(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_campaign_publish(uuid, uuid) TO questify_app;

-- Retires a draft or published campaign at any time: hidden and paying nothing more; its awards stay.
CREATE FUNCTION questify_campaign_retire(target uuid, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 admin uuid := questify_admin();
 old   questify_campaign%ROWTYPE;
BEGIN
 SELECT c.* INTO old FROM questify_campaign c WHERE c.id = target FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'QY404'; END IF;
 IF old.status = 'retired' THEN RETURN questify_campaign_json(old); END IF;
 UPDATE questify_campaign c SET status = 'retired', updated_at = now() WHERE c.id = old.id RETURNING * INTO old;
 PERFORM questify_audit(admin, 'campaign_retired', 'questify_campaign', old.id,
                        jsonb_build_object('status', 'retired'), request);
 RETURN questify_campaign_json(old);
END $$;
REVOKE ALL ON FUNCTION questify_campaign_retire(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_campaign_retire(uuid, uuid) TO questify_app;

-- The campaign a quest lives in, locked before the quest (as publish locks it), open for changes: not retired and not
-- ended. A NULL campaign (always-on) answers an empty row. Internal.
CREATE FUNCTION questify_home(campaign uuid) RETURNS questify_campaign
 LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
 home questify_campaign%ROWTYPE;
BEGIN
 IF campaign IS NULL THEN RETURN home; END IF;
 SELECT c.* INTO home FROM questify_campaign c WHERE c.id = campaign FOR NO KEY UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'QY422', DETAIL = 'campaignId';
 END IF;
 IF home.status = 'retired' OR home.ends_at <= now() THEN
  RAISE EXCEPTION 'the campaign is closed' USING ERRCODE = 'QY409', DETAIL = 'campaign_closed';
 END IF;
 RETURN home;
END $$;
REVOKE ALL ON FUNCTION questify_home(uuid) FROM PUBLIC;

-- Creates (chosen NULL) or replaces a quest: `fields` = {campaignId (on create only; fixed after), metric, target,
-- title: {ar, en}, xp, position, status draft|active}. At most 20 quests not retired per campaign and 50 always-on
-- (cut 3: a count here, admin-only). Once it can pay (an active always-on quest, or its campaign published) its
-- metric and target are fixed (MINOR-7); active is one-way until retired; a changed xp pays later awards only.
CREATE FUNCTION questify_quest_save(chosen uuid, fields jsonb, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 admin   uuid := questify_admin();
 wanted  text := fields ->> 'status';
 old     questify_quest%ROWTYPE;
 home    questify_campaign%ROWTYPE;
 made    questify_quest%ROWTYPE;
 changed text[] := ARRAY['metric', 'target', 'title', 'xp', 'position', 'status'];
BEGIN
 IF wanted IS NULL OR wanted NOT IN ('draft', 'active') THEN
  RAISE EXCEPTION 'a quest is saved as a draft or active' USING ERRCODE = 'QY422', DETAIL = 'status';
 END IF;
 IF chosen IS NULL THEN
  home := questify_home((fields ->> 'campaignId')::uuid);
  -- A new quest counts plays from its campaign's start, so one added to a running campaign would pay past plays.
  IF home.status = 'published' AND home.starts_at <= now() THEN
   RAISE EXCEPTION 'the campaign has started' USING ERRCODE = 'QY409', DETAIL = 'started';
  END IF;
  IF (SELECT count(*) FROM questify_quest q WHERE q.status <> 'retired'
       AND q.campaign_id IS NOT DISTINCT FROM home.id) >= (CASE WHEN home.id IS NULL THEN 50 ELSE 20 END) THEN
   RAISE EXCEPTION 'too many quests' USING ERRCODE = 'QY409', DETAIL = 'too_many';
  END IF;
  INSERT INTO questify_quest (campaign_id, metric, target, title_ar, title_en, xp, position, status, created_by)
  VALUES (home.id, fields ->> 'metric', (fields ->> 'target')::integer, fields #>> '{title,ar}',
          fields #>> '{title,en}', (fields ->> 'xp')::integer, (fields ->> 'position')::smallint, wanted, admin)
  RETURNING * INTO made;
  changed := array_append(changed, 'campaignId');
 ELSE
  -- The campaign never changes, so it is read first and locked before the quest.
  SELECT q.* INTO old FROM questify_quest q WHERE q.id = chosen;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such quest' USING ERRCODE = 'QY404'; END IF;
  home := questify_home(old.campaign_id);
  SELECT q.* INTO old FROM questify_quest q WHERE q.id = chosen FOR NO KEY UPDATE;
  IF old.status = 'retired' THEN
   RAISE EXCEPTION 'a retired quest is fixed' USING ERRCODE = 'QY409', DETAIL = 'retired';
  END IF;
  IF ((old.campaign_id IS NULL AND old.status = 'active') OR home.status = 'published')
     AND ((fields ->> 'metric', (fields ->> 'target')::integer) IS DISTINCT FROM (old.metric, old.target)) THEN
   RAISE EXCEPTION 'the quest can pay, so its condition is fixed' USING ERRCODE = 'QY409', DETAIL = 'frozen';
  END IF;
  IF old.status = 'active' AND wanted = 'draft' THEN
   RAISE EXCEPTION 'an active quest stays active until retired' USING ERRCODE = 'QY409', DETAIL = 'frozen';
  END IF;
  UPDATE questify_quest q
  SET metric = fields ->> 'metric', target = (fields ->> 'target')::integer, title_ar = fields #>> '{title,ar}',
      title_en = fields #>> '{title,en}', xp = (fields ->> 'xp')::integer,
      position = (fields ->> 'position')::smallint, status = wanted, updated_at = now()
  WHERE q.id = old.id RETURNING * INTO made;
  changed := array_remove(ARRAY[
   CASE WHEN made.metric IS DISTINCT FROM old.metric THEN 'metric' END,
   CASE WHEN made.target IS DISTINCT FROM old.target THEN 'target' END,
   CASE WHEN (made.title_ar, made.title_en) IS DISTINCT FROM (old.title_ar, old.title_en) THEN 'title' END,
   CASE WHEN made.xp IS DISTINCT FROM old.xp THEN 'xp' END,
   CASE WHEN made.position IS DISTINCT FROM old.position THEN 'position' END,
   CASE WHEN made.status IS DISTINCT FROM old.status THEN 'status' END], NULL);
 END IF;
 PERFORM questify_audit(admin, CASE WHEN chosen IS NULL THEN 'quest_created' ELSE 'quest_updated' END,
                        'questify_quest', made.id, jsonb_build_object('fields', to_jsonb(changed)), request);
 RETURN questify_quest_json(made);
END $$;
REVOKE ALL ON FUNCTION questify_quest_save(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_quest_save(uuid, jsonb, uuid) TO questify_app;

-- Retires a quest at any time (a draft is retired, never deleted): hidden and paying nothing more; awards stay.
CREATE FUNCTION questify_quest_retire(chosen uuid, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 admin uuid := questify_admin();
 old   questify_quest%ROWTYPE;
BEGIN
 SELECT q.* INTO old FROM questify_quest q WHERE q.id = chosen FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'no such quest' USING ERRCODE = 'QY404'; END IF;
 IF old.status = 'retired' THEN RETURN questify_quest_json(old); END IF;
 UPDATE questify_quest q SET status = 'retired', updated_at = now() WHERE q.id = old.id RETURNING * INTO old;
 PERFORM questify_audit(admin, 'quest_retired', 'questify_quest', old.id, jsonb_build_object('status', 'retired'),
                        request);
 RETURN questify_quest_json(old);
END $$;
REVOKE ALL ON FUNCTION questify_quest_retire(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_quest_retire(uuid, uuid) TO questify_app;

-- The console's page: every always-on quest, and the 100 latest-starting campaigns with their quests. No personal
-- data, so not audited.
CREATE FUNCTION questify_admin_list() RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
 PERFORM questify_admin();
 RETURN jsonb_build_object(
  'alwaysOn', (SELECT coalesce(jsonb_agg(questify_quest_json(q) ORDER BY q.position, q.created_at, q.id), '[]'::jsonb)
               FROM questify_quest q WHERE q.campaign_id IS NULL),
  'campaigns', (SELECT coalesce(jsonb_agg(questify_campaign_json(c) || jsonb_build_object('quests',
                  (SELECT coalesce(jsonb_agg(questify_quest_json(q) ORDER BY q.position, q.created_at, q.id), '[]'::jsonb)
                   FROM questify_quest q WHERE q.campaign_id = c.id))
                 ORDER BY c.starts_at DESC, c.id), '[]'::jsonb)
                FROM questify_campaign c
                WHERE c.id IN (SELECT x.id FROM questify_campaign x ORDER BY x.starts_at DESC, x.id LIMIT 100)));
END $$;
REVOKE ALL ON FUNCTION questify_admin_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_admin_list() TO questify_app;
