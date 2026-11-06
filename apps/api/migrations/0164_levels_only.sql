-- T-404c part 2 of 2: levels only (ADR-760 to ADR-766; plan docs/plans/2026-11-06-t-404c-levels-only.md 2.1, 3, 4.2,
-- 6, 7). Gems and the Questify gem shop are removed everywhere: the gem ledger, the balance, the shop, the purchases,
-- the quest amounts and every door that read or wrote them. Balances vanish with no conversion (ADR-763); items bought
-- in the shop stay owned, rewritten to the keyless source `questify`. Achievement tiers pay XP when they are earned
-- (ADR-764), achievements may unlock one item at a chosen tier (ADR-765), event ranking rows carry the level derived from
-- XP (ADR-766), and the player reads their level rewards through own_level_rewards (ADR-767). Nothing is priced, in money,
-- in XP or in anything (FR-415).
--
-- Locks: every table this migration changes or references, up front, in live-path order and at the strongest mode a
-- later statement needs, so no lock is upgraded mid-way (0067's lesson; plan review 86). xp_entry first: a completion's
-- xp_credit and the sync's pre-check touch xp_entry before player_xp (0069, 0072). Not every path does: daily_finish_play
-- and xp_reverse lock player or player_xp first, so a daily finish or an XP removal in flight can deadlock with this
-- migration; PostgreSQL aborts one side (40P01) with no data harm, and the runner retries a deadlocked file (it rolls
-- back whole). player before player_xp: sign-up and erasure take the player first. Dropping a foreign key takes ACCESS
-- EXCLUSIVE on the table it references, so level_reached and achievement_earned (gem_entry's keys) and item
-- (gem_shop_item's key) are taken ACCESS EXCLUSIVE from the start; item after player_xp, as the scan, the sync and
-- erasure reach it. platform_setting is never touched (0163 did its part): a scan reads it before it locks player_xp.
--
-- Deny by default: the new table is closed to PUBLIC and the API role with row-level security forced; every new function
-- is revoked from PUBLIC next to its CREATE and only own_level_rewards is granted; every replaced door keeps exactly its
-- grants. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';
LOCK TABLE xp_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player IN EXCLUSIVE MODE;
LOCK TABLE player_xp IN ACCESS EXCLUSIVE MODE;
LOCK TABLE level_reached IN ACCESS EXCLUSIVE MODE;
LOCK TABLE achievement_earned IN ACCESS EXCLUSIVE MODE;
LOCK TABLE achievement IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE questify_quest IN ACCESS EXCLUSIVE MODE;
LOCK TABLE questify_award IN ACCESS EXCLUSIVE MODE;
LOCK TABLE gem_shop_item IN ACCESS EXCLUSIVE MODE;
LOCK TABLE gem_purchase IN ACCESS EXCLUSIVE MODE;
LOCK TABLE gem_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE item IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player_item IN ACCESS EXCLUSIVE MODE;
LOCK TABLE level_item IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE souvenir_rule IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the gem doors go (2.1)
DROP FUNCTION gem_buy(text, integer, uuid);
DROP FUNCTION gem_shop();
DROP FUNCTION own_gems();
DROP FUNCTION gems_due(uuid);
DROP FUNCTION gem_amounts();
DROP FUNCTION gem_amount(jsonb, text, integer);
DROP FUNCTION questify_gems_of(jsonb, integer);
DROP FUNCTION admin_shop_item_save(text, jsonb, bigint, uuid);
DROP FUNCTION admin_shop_items();
DROP FUNCTION admin_shop_item_doc(gem_shop_item);
DROP FUNCTION item_shop_checked(jsonb);

-- ================================================================ bought items stay, with the keyless source (ADR-763)
-- The guard freezes the source columns; the owner turns it off by name for this one UPDATE, under the table's ACCESS
-- EXCLUSIVE lock, and turns it back on ALWAYS at once. No door can write `questify`: no function inserts it.
ALTER TABLE player_item DROP CONSTRAINT player_item_source_check;
ALTER TABLE player_item DISABLE TRIGGER owned_item_guard;
UPDATE player_item SET source = 'questify', source_purchase_id = NULL WHERE source = 'shop';
ALTER TABLE player_item ENABLE ALWAYS TRIGGER owned_item_guard;
ALTER TABLE player_item DROP CONSTRAINT player_item_shop_fk;
ALTER TABLE player_item DROP COLUMN source_purchase_id;

-- ================================================================ the gem tables and columns go (2.1, ADR-763)
DROP TABLE gem_entry;
DROP TABLE gem_purchase;
DROP TABLE gem_shop_item;
DROP FUNCTION gem_append_only();
ALTER TABLE player_xp DROP COLUMN gems;
ALTER TABLE questify_quest DROP COLUMN gems;
ALTER TABLE questify_award DROP CONSTRAINT questify_award_owner_key;

-- ================================================================ achievement items (ADR-765)
-- At most one item per achievement, given at the tier the admin picks. An item has one source: a level, a souvenir or
-- an achievement (souvenir_catalog_guard). Seeded and changed by the console door only.
CREATE TABLE achievement_item (
  achievement_id text PRIMARY KEY REFERENCES achievement (id),
  tier           text NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
  item_id        text NOT NULL UNIQUE REFERENCES item (id),
  UNIQUE (achievement_id, item_id)
);
ALTER TABLE achievement_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE achievement_item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON achievement_item FROM PUBLIC, questify_app;

-- As 0124, with the shop replaced by the achievement map: an item is a level reward, a souvenir or an achievement's
-- item, never two. The three source-map writers lock the item first; an item an active souvenir names is frozen.
CREATE OR REPLACE FUNCTION souvenir_catalog_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path = public, pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME IN ('level_item', 'souvenir_rule', 'achievement_item') THEN
  PERFORM 1 FROM item i WHERE i.id = NEW.item_id FOR UPDATE;
 END IF;
 IF TG_TABLE_NAME <> 'item' THEN
  IF TG_TABLE_NAME <> 'souvenir_rule' AND EXISTS (SELECT 1 FROM souvenir_rule r WHERE r.item_id = NEW.item_id) THEN
   RAISE EXCEPTION 'item already has a souvenir source' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME <> 'level_item' AND EXISTS (SELECT 1 FROM level_item l WHERE l.item_id = NEW.item_id) THEN
   RAISE EXCEPTION 'item already has a level source' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME <> 'achievement_item' AND EXISTS (SELECT 1 FROM achievement_item a WHERE a.item_id = NEW.item_id) THEN
   RAISE EXCEPTION 'item already has an achievement source' USING ERRCODE = '23514';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM souvenir_rule r WHERE r.item_id = OLD.id AND r.status <> 'draft') THEN
  RAISE EXCEPTION 'active souvenir content is frozen' USING ERRCODE = 'SV409', DETAIL = 'souvenir_locked';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION souvenir_catalog_guard() FROM PUBLIC;
CREATE TRIGGER achievement_item_source BEFORE INSERT OR UPDATE ON achievement_item
  FOR EACH ROW EXECUTE FUNCTION souvenir_catalog_guard();
ALTER TABLE achievement_item ENABLE ALWAYS TRIGGER achievement_item_source;

-- Each achievement's gold tier unlocks one of the former shop frames (Q-723). Desert ring and the six titles stay
-- unassigned for the console.
INSERT INTO achievement_item (achievement_id, tier, item_id) VALUES
  ('events-attended', 'gold', 'shop-compass-ring'),
  ('quests-done', 'gold', 'shop-falcon-ring'),
  ('cities-played', 'gold', 'shop-dune-ring'),
  ('top-ten', 'gold', 'shop-moon-ring'),
  ('community-goals', 'gold', 'shop-pearl-ring');

-- The locker's fourth source: an achievement's item, bound to the same player's earned tier and to the map.
ALTER TABLE player_item ADD COLUMN source_achievement_id text, ADD COLUMN source_tier text;
ALTER TABLE player_item ADD CONSTRAINT player_item_source_check CHECK (
  (source = 'level' AND source_level IS NOT NULL AND source_rule_id IS NULL AND source_event_id IS NULL
   AND source_achievement_id IS NULL AND source_tier IS NULL)
  OR (source = 'souvenir' AND source_level IS NULL AND source_rule_id IS NOT NULL AND source_event_id IS NOT NULL
      AND source_achievement_id IS NULL AND source_tier IS NULL)
  OR (source = 'questify' AND source_level IS NULL AND source_rule_id IS NULL AND source_event_id IS NULL
      AND source_achievement_id IS NULL AND source_tier IS NULL)
  OR (source = 'achievement' AND source_level IS NULL AND source_rule_id IS NULL AND source_event_id IS NULL
      AND source_achievement_id IS NOT NULL AND source_tier IS NOT NULL));
ALTER TABLE player_item ADD CONSTRAINT player_item_achievement_tier_fk
  FOREIGN KEY (player_id, source_achievement_id, source_tier)
  REFERENCES achievement_earned (player_id, achievement_id, tier);
ALTER TABLE player_item ADD CONSTRAINT player_item_achievement_map_fk
  FOREIGN KEY (source_achievement_id, item_id) REFERENCES achievement_item (achievement_id, item_id);
-- The console's "anyone owns this item" checks (art lock, a given achievement item).
CREATE INDEX player_item_item_idx ON player_item (item_id);

-- As 0067, with the achievement source in the frozen set instead of the purchase.
CREATE OR REPLACE FUNCTION owned_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.erasure', true) = 'on' THEN RETURN OLD; END IF;
 ELSIF (NEW.player_id, NEW.item_id, NEW.source, NEW.source_level, NEW.source_rule_id, NEW.source_event_id,
        NEW.source_achievement_id, NEW.source_tier, NEW.earned_at)
   IS NOT DISTINCT FROM (OLD.player_id, OLD.item_id, OLD.source, OLD.source_level, OLD.source_rule_id,
        OLD.source_event_id, OLD.source_achievement_id, OLD.source_tier, OLD.earned_at)
 THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'earned items can only be acknowledged or erased' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION owned_item_guard() FROM PUBLIC;

-- ================================================================ achievement tiers pay XP (ADR-764)
-- One entry per player, achievement and tier, ever, bound to the earned tier. The append-only and player-status
-- triggers of xp_entry cover it.
ALTER TABLE xp_entry
  ADD COLUMN achievement_id text,
  ADD COLUMN tier text,
  ADD CONSTRAINT xp_entry_achievement_fkey FOREIGN KEY (player_id, achievement_id, tier)
    REFERENCES achievement_earned (player_id, achievement_id, tier),
  DROP CONSTRAINT xp_entry_shape,
  ADD CONSTRAINT xp_entry_shape CHECK (
    (source = 'quest' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NOT NULL AND quest_id IS NOT NULL
     AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL
     AND achievement_id IS NULL AND tier IS NULL)
    OR (source = 'removal' AND delta < 0 AND reverses IS NOT NULL AND ledger_entry_id IS NOT NULL
        AND quest_id IS NOT NULL AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL
        AND achievement_id IS NULL AND tier IS NULL)
    OR (source = 'questify' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NOT NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL
        AND achievement_id IS NULL AND tier IS NULL)
    OR (source = 'streak' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NULL AND streak_reward_id IS NOT NULL AND daily_finish_id IS NULL
        AND achievement_id IS NULL AND tier IS NULL)
    OR (source = 'daily' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NOT NULL
        AND achievement_id IS NULL AND tier IS NULL)
    OR (source = 'achievement' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL
        AND achievement_id IS NOT NULL AND tier IS NOT NULL AND tier IN ('bronze', 'silver', 'gold')));

-- Partial, so a scan's XP entry writes no extra index entry: the completion path must not move (ADR-734).
CREATE UNIQUE INDEX xp_entry_achievement_key ON xp_entry (player_id, achievement_id, tier) WHERE achievement_id IS NOT NULL;

-- The XP each tier pays: `bronzeXp`, `silverXp` and `goldXp` of the `xp` setting (0 to 1000, 0163's CHECK), falling
-- back to 50, 150 and 300 when absent. Internal.
CREATE FUNCTION achievement_xp() RETURNS TABLE (bronze integer, silver integer, gold integer)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  setting jsonb := (SELECT p.value FROM platform_setting p WHERE p.key = 'xp');
BEGIN
  RETURN QUERY SELECT daily_xp_field(setting, 'bronzeXp', 1000, 50), daily_xp_field(setting, 'silverXp', 1000, 150),
                      daily_xp_field(setting, 'goldXp', 1000, 300);
END $$;
REVOKE ALL ON FUNCTION achievement_xp() FROM PUBLIC;

-- Whether an earned, not revoked tier of the player maps to an item they do not own yet (the sync's pre-check; at most
-- fifteen rows, no lock). Internal.
CREATE FUNCTION achievement_items_due(who uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM achievement_item m
    JOIN achievement_earned e ON e.player_id = who AND e.achievement_id = m.achievement_id AND e.tier = m.tier
    WHERE NOT tier_revoked(who, m.achievement_id, m.tier)
      AND NOT EXISTS (SELECT 1 FROM player_item o WHERE o.player_id = who AND o.item_id = m.item_id));
END $$;
REVOKE ALL ON FUNCTION achievement_items_due(uuid) FROM PUBLIC;

-- Gives the player every achievement item due (achievement_items_due), the map rows FOR KEY SHARE so a console change in
-- flight is waited for and then seen. Retroactive on purpose; a revoked tier's item waits for a restore; an item
-- already owned is skipped and never taken back. The caller holds the player's player_xp row lock. Answers what it gave.
CREATE FUNCTION achievement_items_give(who uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  given jsonb;
BEGIN
  WITH due AS MATERIALIZED (
    SELECT m.achievement_id, m.tier, m.item_id FROM achievement_item m
    JOIN achievement_earned e ON e.player_id = who AND e.achievement_id = m.achievement_id AND e.tier = m.tier
    WHERE NOT tier_revoked(who, m.achievement_id, m.tier)
      AND NOT EXISTS (SELECT 1 FROM player_item o WHERE o.player_id = who AND o.item_id = m.item_id)
    ORDER BY m.achievement_id
    FOR KEY SHARE OF m
  ), written AS (
    INSERT INTO player_item (player_id, item_id, source, source_achievement_id, source_tier, earned_at)
    SELECT who, d.item_id, 'achievement', d.achievement_id, d.tier, now() FROM due d ORDER BY d.achievement_id
    ON CONFLICT DO NOTHING
    RETURNING item_id, source_achievement_id, source_tier
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('achievementId', w.source_achievement_id, 'tier', w.source_tier,
                                               'item', item_json(w.item_id)) ORDER BY a.position), '[]'::jsonb)
  INTO given
  FROM written w JOIN achievement a ON a.id = w.source_achievement_id;
  RETURN given;
END $$;
REVOKE ALL ON FUNCTION achievement_items_give(uuid) FROM PUBLIC;

-- As 0124, without gems: each tier the call writes pays its XP in the same step (one entry, then xp_apply, so a level it
-- crosses gives its level item in this call); tiers earned before 0164 pay nothing. After the tiers, the quests and the
-- streak, the achievement items due are given. The answer loses `gems`; each tier carries `xp`; `items` lists the
-- achievement items given. Locks as before: player KEY SHARE, then player_xp FOR UPDATE.
CREATE OR REPLACE FUNCTION questify_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who     uuid;
 written jsonb;
 tiers   jsonb := '[]'::jsonb;
 earned  record;
 pays    integer;
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
 given   jsonb;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) AND NOT EXISTS (SELECT 1 FROM questify_due(who))
    AND NOT achievement_items_due(who) AND NOT streak_due(who) AND NOT levels_due(who) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb, 'quests', '[]'::jsonb, 'levelUp', NULL, 'items', '[]'::jsonb,
   'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', '[]'::jsonb) END);
 END IF;
 SELECT p.id INTO who FROM player p WHERE p.id = who AND p.status = 'active' FOR KEY SHARE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 PERFORM 1 FROM player_xp x WHERE x.player_id = who FOR UPDATE;
 caught := xp_catch_up(who);
 SELECT * INTO amount FROM achievement_xp();
 WITH made AS (
  INSERT INTO achievement_earned (player_id, achievement_id, tier)
  SELECT who, d.achievement_id, d.tier FROM achievements_due(who) d
  ON CONFLICT DO NOTHING
  RETURNING achievement_id, tier
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.achievement_id, 'tier', w.tier)
  ORDER BY a.position, array_position(ARRAY['bronze', 'silver', 'gold'], w.tier)), '[]'::jsonb)
 INTO written FROM made w JOIN achievement a ON a.id = w.achievement_id;
 FOR earned IN SELECT t.value ->> 'id' AS id, t.value ->> 'tier' AS tier
               FROM jsonb_array_elements(written) WITH ORDINALITY AS t (value, n) ORDER BY t.n
 LOOP
  pays := CASE earned.tier WHEN 'bronze' THEN amount.bronze WHEN 'silver' THEN amount.silver ELSE amount.gold END;
  IF pays > 0 THEN
   INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier)
   VALUES (who, pays, 'achievement', earned.id, earned.tier)
   RETURNING id INTO entry;
   PERFORM xp_apply(who, entry, pays);
   entries := entries || entry;
  END IF;
  tiers := tiers || jsonb_build_array(jsonb_build_object('id', earned.id, 'tier', earned.tier, 'xp', pays));
 END LOOP;
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
 given := achievement_items_give(who);
 RETURN jsonb_build_object('achievements', tiers, 'quests', paid, 'levelUp', questify_level_up(who, entries, caught),
  'items', given,
  'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', streaks) END);
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- ================================================================ Questify quests without gems
-- As 0067, without `gems`.
CREATE OR REPLACE FUNCTION questify_quest_json(q questify_quest) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('id', q.id, 'campaignId', q.campaign_id, 'metric', q.metric, 'target', q.target,
  'title', jsonb_build_object('ar', q.title_ar, 'en', q.title_en), 'xp', q.xp, 'position', q.position,
  'status', q.status, 'createdAt', q.created_at, 'updatedAt', q.updated_at)
$$;
REVOKE ALL ON FUNCTION questify_quest_json(questify_quest) FROM PUBLIC;

-- As 0067, without `gems`: the metric and target are frozen once the quest can pay.
CREATE OR REPLACE FUNCTION questify_quest_save(chosen uuid, fields jsonb, request uuid) RETURNS jsonb
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

-- As 0067, without each card's `gems`.
CREATE OR REPLACE FUNCTION own_questify_quests() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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

-- ================================================================ the locker (2.2)
-- As 0143, plus `source_achievement`: the achievement's id, name and tier for an achievement item (NULL otherwise). A
-- bought item now reads `questify`.
DROP FUNCTION own_locker(timestamptz, text, integer);
CREATE FUNCTION own_locker(before_time timestamptz, before_item text, page_size integer)
 RETURNS TABLE(item jsonb, earned_at timestamptz, source_level smallint, source_event jsonb, seen boolean, source text,
               presented_by jsonb, source_achievement jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT item_json(o.item_id), o.earned_at, o.source_level,
  CASE WHEN o.source = 'souvenir' THEN jsonb_build_object('id', o.source_event_id, 'name', jsonb_build_object(
   'ar', coalesce(e.name_ar, e.name_en, 'فعالية سابقة'), 'en', coalesce(e.name_en, e.name_ar, 'Past event'))) END,
  o.seen_at IS NOT NULL, o.source,
  CASE WHEN o.source = 'souvenir' THEN souvenir_presented_by(o.source_rule_id) END,
  CASE WHEN o.source = 'achievement' THEN jsonb_build_object('id', a.id,
   'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en), 'tier', o.source_tier) END
 FROM player_item o LEFT JOIN event e ON e.id = o.source_event_id LEFT JOIN achievement a ON a.id = o.source_achievement_id
 WHERE o.player_id = profile_player() AND (before_time IS NULL OR (o.earned_at, o.item_id) < (before_time, before_item))
 ORDER BY o.earned_at DESC, o.item_id DESC LIMIT least(greatest(coalesce(page_size, 30), 1), 101)
$$;
REVOKE ALL ON FUNCTION own_locker(timestamptz, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_locker(timestamptz, text, integer) TO questify_app;

-- ================================================================ the level rewards read (ADR-767)
-- The caller's level and its bar, every level of the curve with its item and whether the caller owns it, and every
-- achievement with an item: the tier, the item, owned, and whether the caller holds that tier now (not revoked). The
-- caller only; PI401 for anyone who is not an active player.
CREATE FUNCTION own_level_rewards() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := profile_player();
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  RETURN jsonb_build_object(
    'level', (SELECT jsonb_build_object('number', l.level, 'title', jsonb_build_object('ar', l.title_ar, 'en', l.title_en),
                                        'xp', l.xp, 'levelFrom', l.level_from, 'nextLevelAt', l.next_level_at)
              FROM own_level(NULL) l),
    'levels', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'level', l.level, 'xpFrom', l.xp_from, 'item', item_json(m.item_id),
                 'owned', EXISTS (SELECT 1 FROM player_item o WHERE o.player_id = who AND o.item_id = m.item_id))
                 ORDER BY l.level), '[]'::jsonb)
               FROM xp_level l LEFT JOIN level_item m ON m.level = l.level),
    'achievements', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'id', a.id, 'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
                       'visualKey', a.visual_key, 'tier', m.tier, 'item', item_json(m.item_id),
                       'owned', EXISTS (SELECT 1 FROM player_item o WHERE o.player_id = who AND o.item_id = m.item_id),
                       'earned', EXISTS (SELECT 1 FROM achievement_earned e
                                         WHERE e.player_id = who AND e.achievement_id = a.id AND e.tier = m.tier
                                           AND NOT tier_revoked(who, a.id, m.tier)))
                       ORDER BY a.position), '[]'::jsonb)
                     FROM achievement_item m JOIN achievement a ON a.id = m.achievement_id));
END $$;
REVOKE ALL ON FUNCTION own_level_rewards() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_level_rewards() TO questify_app;

-- ================================================================ the level on event ranking rows (ADR-766)
-- As 0120, plus `level`: derived from the player's XP, kept for a blocked row (as its place and score).
-- The same derivation as xp_level_of, written inline as one subquery per answered row: that function is SQL with SET and
-- SECURITY DEFINER, so calling it per row cost about 0.5 ms a row, and a join of player_xp would read it for every enrollment
-- of the event before the sort. A subquery this size runs after the sort and LIMIT (the plan's gate: +0.5 ms or +10%).
DROP FUNCTION ranking_top(uuid, integer);
CREATE FUNCTION ranking_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, score bigint, score_version bigint,
                 level smallint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, CASE WHEN NOT hide.v THEN p.username END, CASE WHEN NOT hide.v THEN p.avatar END,
         CASE WHEN NOT hide.v THEN jsonb_build_object('character', item_json(eq.character_id),
                                                      'frame', item_json(eq.frame_id),
                                                      'title', item_json(eq.title_id)) END,
         r.score, r.score_version, (SELECT coalesce(max(l.level), 1)::smallint FROM player_xp x JOIN xp_level l ON l.xp_from <= x.xp
          WHERE x.player_id = p.id)
  FROM reader, ranked_enrollments(target) r JOIN player p ON p.id = r.player_id
  LEFT JOIN player_equipment eq ON eq.player_id = p.id, LATERAL (SELECT blocked_by_me(p.id) AS v) hide
  WHERE reader.id IS NOT NULL AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_top(uuid, integer) TO questify_app;

-- As 0120, plus `level`.
DROP FUNCTION ranking_day_top(uuid, integer);
CREATE FUNCTION ranking_day_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, score bigint, score_version bigint,
                 level smallint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, CASE WHEN NOT hide.v THEN p.username END, CASE WHEN NOT hide.v THEN p.avatar END,
         CASE WHEN NOT hide.v THEN jsonb_build_object('character', item_json(eq.character_id),
                                                      'frame', item_json(eq.frame_id),
                                                      'title', item_json(eq.title_id)) END,
         r.score, r.score_version, (SELECT coalesce(max(l.level), 1)::smallint FROM player_xp x JOIN xp_level l ON l.xp_from <= x.xp
          WHERE x.player_id = p.id)
  FROM reader, event ev,
       LATERAL ranked_day(target, event_day(now(), ev)) r JOIN player p ON p.id = r.player_id
       LEFT JOIN player_equipment eq ON eq.player_id = p.id, LATERAL (SELECT blocked_by_me(p.id) AS v) hide
  WHERE reader.id IS NOT NULL AND ev.id = target AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_day_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_day_top(uuid, integer) TO questify_app;

-- As 0120, plus `level`.
DROP FUNCTION ranking_rows(uuid, uuid[]);
CREATE FUNCTION ranking_rows(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, ranked boolean, level smallint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT e.id, CASE WHEN shown.v THEN p.username END, CASE WHEN shown.v THEN p.avatar END,
           CASE WHEN shown.v THEN jsonb_build_object('character', item_json(eq.character_id),
                                                     'frame', item_json(eq.frame_id),
                                                     'title', item_json(eq.title_id)) END,
           rule.ok, (SELECT coalesce(max(l.level), 1)::smallint FROM player_xp x JOIN xp_level l ON l.xp_from <= x.xp
          WHERE x.player_id = p.id)
    FROM enrollment e JOIN player p ON p.id = e.player_id LEFT JOIN player_equipment eq ON eq.player_id = p.id,
         LATERAL (SELECT ranking_eligible(e) AS ok) rule,
         LATERAL (SELECT rule.ok AND NOT blocked_by_me(p.id) AS v) shown
    WHERE e.id = ANY (ids) AND e.event_id = target;
END $$;
REVOKE ALL ON FUNCTION ranking_rows(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_rows(uuid, uuid[]) TO questify_app;

-- ================================================================ the console: amounts (2.2, ADR-764)
-- As 0122, with one group `xp` of seven fields: the scan and daily amounts and the three tier amounts. Internal.
CREATE OR REPLACE FUNCTION admin_amounts_doc() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'xp', jsonb_build_object('questXp', quest_xp(), 'dailyFinishXp', d.finish, 'dailyRightXp', d.per_right,
                             'dailyWordXp', d.word, 'bronzeXp', t.bronze, 'silverXp', t.silver, 'goldXp', t.gold))
  FROM daily_xp() d CROSS JOIN achievement_xp() t
$$;
REVOKE ALL ON FUNCTION admin_amounts_doc() FROM PUBLIC;

CREATE OR REPLACE FUNCTION admin_amounts() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN admin_amounts_doc() || jsonb_build_object('stored', jsonb_build_object(
    'xp', EXISTS (SELECT 1 FROM platform_setting s WHERE s.key = 'xp')));
END $$;
REVOKE ALL ON FUNCTION admin_amounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_amounts() TO questify_app;

-- As 0122, for the one `xp` row. A revert of an entry written before 0164 drops its `gems` group and keeps the tier
-- amounts in force (that entry never held them). From the save on, each tier earned pays the new amount; XP already
-- credited never changes.
CREATE OR REPLACE FUNCTION admin_amounts_save(doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  old    jsonb;
  edited jsonb;
BEGIN
  INSERT INTO platform_setting (key, value, updated_by) VALUES ('xp', admin_amounts_doc() -> 'xp', me)
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM platform_setting s WHERE s.key = 'xp' FOR UPDATE;
  old := admin_amounts_doc();
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('platform_setting', 'amounts', revert_of) - 'gems';
    IF jsonb_typeof(doc -> 'xp') = 'object' THEN
      doc := jsonb_build_object('xp', (old -> 'xp') || (doc -> 'xp'));
    END IF;
  END IF;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['xp'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'give the xp amounts only' USING ERRCODE = 'CA400', DETAIL = 'amounts';
  END IF;
  edited := jsonb_build_object(
    'xp', amounts_group(doc, 'xp',
                        ARRAY['questXp', 'dailyFinishXp', 'dailyRightXp', 'dailyWordXp', 'bronzeXp', 'silverXp', 'goldXp'],
                        ARRAY[1, 0, 0, 0, 0, 0, 0], ARRAY[99999, 400, 200, 1000, 1000, 1000, 1000]));
  IF old <> edited THEN
    UPDATE platform_setting s SET value = s.value || (edited -> 'xp'), updated_at = now(), updated_by = me
    WHERE s.key = 'xp';
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.amounts.revert' ELSE 'catalog.amounts.update' END,
                          'platform_setting', 'amounts', old, edited, request);
  END IF;
  RETURN admin_amounts();
END $$;
REVOKE ALL ON FUNCTION admin_amounts_save(jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_amounts_save(jsonb, bigint, uuid) TO questify_app;

-- ================================================================ the console: achievements (ADR-765)
-- An achievement's item as the console edits it, {tier, itemId}, or NULL. Internal.
CREATE FUNCTION admin_achievement_item(target text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN (SELECT jsonb_build_object('tier', m.tier, 'itemId', m.item_id)
          FROM achievement_item m WHERE m.achievement_id = target);
END $$;
REVOKE ALL ON FUNCTION admin_achievement_item(text) FROM PUBLIC;

-- As 0119, plus `item`.
CREATE OR REPLACE FUNCTION admin_achievements() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(admin_achievement_doc(a) || jsonb_build_object(
             'id', a.id, 'metric', a.metric, 'visualKey', a.visual_key, 'position', a.position,
             'item', admin_achievement_item(a.id))
           ORDER BY a.position)
    FROM achievement a), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_achievements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_achievements() TO questify_app;

-- One refusal of the achievement door as the API reads it: {"reason": ...} (CA409).
CREATE FUNCTION achievement_refuse(reason text, message text) RETURNS void
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '%', message USING ERRCODE = 'CA409', DETAIL = jsonb_build_object('reason', reason)::text;
END $$;
REVOKE ALL ON FUNCTION achievement_refuse(text, text) FROM PUBLIC;

-- The `item` of a document: absent keeps `kept`; null removes it; otherwise exactly {tier, itemId} (CA400 `item`).
CREATE FUNCTION achievement_item_checked(doc jsonb, kept jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  part jsonb := doc -> 'item';
BEGIN
  IF NOT doc ? 'item' THEN
    RETURN kept;
  END IF;
  IF jsonb_typeof(part) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR part - ARRAY['tier', 'itemId'] <> '{}'::jsonb
     OR NOT coalesce(part ->> 'tier' IN ('bronze', 'silver', 'gold'), false)
     OR jsonb_typeof(part -> 'itemId') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'an achievement item is a tier and an item id' USING ERRCODE = 'CA400', DETAIL = 'item';
  END IF;
  RETURN jsonb_build_object('tier', part ->> 'tier', 'itemId', part ->> 'itemId');
END $$;
REVOKE ALL ON FUNCTION achievement_item_checked(jsonb, jsonb) FROM PUBLIC;

-- Writes a changed achievement item under the locks the door holds: the map row FOR UPDATE (it waits for a sync giving
-- the item, then sees it), then the new item FOR UPDATE. Refusals (CA409): item_given (a player owns the item from this
-- achievement, so it never changes), item_unknown (no such item, or a souvenir), item_has_source (a level's or another
-- achievement's item). Internal.
CREATE FUNCTION achievement_item_write(target text, was jsonb, now_item jsonb) RETURNS void
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM achievement_item m WHERE m.achievement_id = target FOR UPDATE;
  IF was IS NOT NULL AND EXISTS (SELECT 1 FROM player_item o
                                 WHERE o.item_id = was ->> 'itemId' AND o.source = 'achievement'
                                   AND o.source_achievement_id = target) THEN
    PERFORM achievement_refuse('item_given', 'players got this achievement''s item; it stays');
  END IF;
  IF now_item IS NOT NULL THEN
    PERFORM 1 FROM item i WHERE i.id = now_item ->> 'itemId' FOR UPDATE;
    IF NOT FOUND OR item_is_souvenir(now_item ->> 'itemId') THEN
      PERFORM achievement_refuse('item_unknown', 'there is no such item');
    END IF;
    IF EXISTS (SELECT 1 FROM level_item l WHERE l.item_id = now_item ->> 'itemId')
       OR EXISTS (SELECT 1 FROM achievement_item a WHERE a.item_id = now_item ->> 'itemId' AND a.achievement_id <> target) THEN
      PERFORM achievement_refuse('item_has_source', 'that item is a level''s or another achievement''s reward');
    END IF;
  END IF;
  DELETE FROM achievement_item m WHERE m.achievement_id = target;
  IF now_item IS NOT NULL THEN
    INSERT INTO achievement_item (achievement_id, tier, item_id) VALUES (target, now_item ->> 'tier', now_item ->> 'itemId');
  END IF;
END $$;
REVOKE ALL ON FUNCTION achievement_item_write(text, jsonb, jsonb) FROM PUBLIC;

-- As 0122, plus the optional `item` ({tier, itemId} or null; absent keeps it, so an entry written before 0164 reverts
-- without touching it). A lower threshold pays XP and the item to every player who then reaches the tier, at their next
-- sync, and nothing takes them back: refused unless `confirmed` (CA428; the detail names, per lowered tier, the XP it
-- pays and its item id or null). Setting the item gives it at players' next syncs, with no confirmation (cosmetic).
CREATE OR REPLACE FUNCTION admin_achievement_save(achievement_id text, doc jsonb, revert_of bigint, confirmed boolean,
                                                  request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old      achievement;
  made     achievement;
  was_item jsonb;
  now_item jsonb;
  edited   jsonb;
  lowered  jsonb;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM achievement a WHERE a.id = achievement_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such achievement' USING ERRCODE = 'CA404';
  END IF;
  was_item := admin_achievement_item(achievement_id);
  IF revert_of IS NOT NULL THEN
    doc := admin_achievement_doc(old) || catalog_revert_doc('achievement', achievement_id, revert_of);
  END IF;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object'
     OR doc - ARRAY['name', 'bronze', 'silver', 'gold', 'item'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'an achievement has a name, three thresholds and an item only' USING ERRCODE = 'CA400', DETAIL = 'doc';
  END IF;
  now_item := achievement_item_checked(doc, was_item);
  edited := jsonb_build_object('name', jsonb_build_object('ar', catalog_text(doc #>> '{name,ar}', 'name.ar', 60),
                                                          'en', catalog_text(doc #>> '{name,en}', 'name.en', 60)),
                               'bronze', achievement_threshold(doc, 'bronze'),
                               'silver', achievement_threshold(doc, 'silver'),
                               'gold', achievement_threshold(doc, 'gold'));
  IF NOT ((edited ->> 'bronze')::integer < (edited ->> 'silver')::integer
          AND (edited ->> 'silver')::integer < (edited ->> 'gold')::integer) THEN
    RAISE EXCEPTION 'the thresholds must rise from bronze to gold' USING ERRCODE = 'CA400', DETAIL = 'thresholds';
  END IF;
  IF admin_achievement_doc(old) = edited AND was_item IS NOT DISTINCT FROM now_item THEN
    RETURN edited || jsonb_build_object('id', old.id, 'metric', old.metric, 'visualKey', old.visual_key,
                                        'position', old.position, 'item', was_item);
  END IF;
  SELECT coalesce(jsonb_object_agg(t.tier, jsonb_build_object('xp', t.pays,
           'itemId', CASE WHEN now_item ->> 'tier' = t.tier THEN now_item ->> 'itemId' END)), '{}'::jsonb)
  INTO lowered
  FROM achievement_xp() g
  CROSS JOIN LATERAL (VALUES ('bronze', old.bronze, g.bronze), ('silver', old.silver, g.silver),
                             ('gold', old.gold, g.gold)) t (tier, was, pays)
  WHERE (edited ->> t.tier)::integer < t.was;
  IF lowered <> '{}'::jsonb AND confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'a lower threshold pays XP and items that cannot be taken back; confirm it'
      USING ERRCODE = 'CA428', DETAIL = lowered::text;
  END IF;
  IF was_item IS DISTINCT FROM now_item THEN
    PERFORM achievement_item_write(achievement_id, was_item, now_item);
  END IF;
  UPDATE achievement a SET name_ar = edited #>> '{name,ar}', name_en = edited #>> '{name,en}',
         bronze = (edited ->> 'bronze')::integer, silver = (edited ->> 'silver')::integer,
         gold = (edited ->> 'gold')::integer
  WHERE a.id = achievement_id
  RETURNING * INTO made;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.achievement.revert' ELSE 'catalog.achievement.update' END,
                        'achievement', achievement_id,
                        admin_achievement_doc(old) || jsonb_build_object('item', was_item),
                        edited || jsonb_build_object('item', now_item), request);
  RETURN edited || jsonb_build_object('id', made.id, 'metric', made.metric, 'visualKey', made.visual_key,
                                      'position', made.position, 'item', now_item);
END $$;
REVOKE ALL ON FUNCTION admin_achievement_save(text, jsonb, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_achievement_save(text, jsonb, bigint, boolean, uuid) TO questify_app;

-- ================================================================ the console: the XP table (2.1)
-- As 0124, with the achievement map in place of the shop: a level's new item has no other source.
CREATE OR REPLACE FUNCTION xp_table_refusals(old_doc jsonb, new_doc jsonb) RETURNS void
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
         OR EXISTS (SELECT 1 FROM achievement_item a WHERE a.item_id = c.item_now))
  ORDER BY c.level LIMIT 1;
  IF at IS NOT NULL THEN
    PERFORM xp_table_refuse(CASE WHEN unknown THEN 'item_unknown' ELSE 'item_has_source' END, at,
                            'there is no such item, or it is an achievement''s reward or a souvenir');
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

-- As 0124, with the confirmation naming only the levels it pays (their items; no gems).
CREATE OR REPLACE FUNCTION admin_xp_table_save(doc jsonb, revert_of bigint, confirmed boolean, request uuid) RETURNS jsonb
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
    RAISE EXCEPTION 'a lower curve pays level rewards that cannot be taken back; confirm it'
      USING ERRCODE = 'CA428', DETAIL = jsonb_build_object('levels', to_jsonb(paying))::text;
  END IF;
  PERFORM xp_table_write(old, edited);
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.xp_table.revert' ELSE 'catalog.xp_table.update' END,
                        'xp_level', 'all', old, edited, request);
  RETURN admin_xp_table();
END $$;
REVOKE ALL ON FUNCTION admin_xp_table_save(jsonb, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_xp_table_save(jsonb, bigint, boolean, uuid) TO questify_app;

-- As 0124, answering {up, down, levels} only: no gems.
CREATE OR REPLACE FUNCTION admin_xp_table_preview(doc jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  edited jsonb;
  answer jsonb;
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
                            'levels', coalesce(sum(c.players * c.due), 0))
  INTO answer FROM counted c;
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION admin_xp_table_preview(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_xp_table_preview(jsonb) TO questify_app;

-- ================================================================ the console: items (2.1)
-- As 0124, with the source a level, an achievement ({id, tier}) or none, and the art locked once any player owns the
-- item (`owned`).
CREATE OR REPLACE FUNCTION admin_item_row(i item) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT admin_item_doc(i) || jsonb_build_object(
    'id', i.id, 'kind', i.kind,
    'source', CASE WHEN m.level IS NOT NULL THEN jsonb_build_object('level', m.level)
                   WHEN a.item_id IS NOT NULL THEN jsonb_build_object('achievement', jsonb_build_object(
                     'id', a.achievement_id, 'tier', a.tier)) END,
    'locked', jsonb_build_object('art', CASE
      WHEN EXISTS (SELECT 1 FROM player_item o WHERE o.item_id = i.id)
        OR (m.level IS NOT NULL AND EXISTS (SELECT 1 FROM level_reached r WHERE r.level = m.level)) THEN 'owned' END))
  FROM (SELECT 1) one
  LEFT JOIN level_item m ON m.item_id = i.id
  LEFT JOIN achievement_item a ON a.item_id = i.id
$$;
REVOKE ALL ON FUNCTION admin_item_row(item) FROM PUBLIC;

-- As 0124, with the art locked once any player owns the item or its level was reached (CA409 item_owned); no shop.
CREATE OR REPLACE FUNCTION admin_item_save(target text, doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
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
    IF EXISTS (SELECT 1 FROM player_item o WHERE o.item_id = target)
       OR EXISTS (SELECT 1 FROM level_item m JOIN level_reached r ON r.level = m.level WHERE m.item_id = target) THEN
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

-- As 0124, without the shop listing: an id, a kind, names and art.
CREATE OR REPLACE FUNCTION admin_item_create(doc jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made item;
BEGIN
  PERFORM console_admin();
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['id', 'kind', 'name', 'visualKey'] <> '{}'::jsonb
     OR coalesce(jsonb_typeof(doc -> 'visualKey'), 'missing') NOT IN ('string', 'null') THEN
    RAISE EXCEPTION 'a new item has an id, a kind, names and its art' USING ERRCODE = 'CA400', DETAIL = 'doc';
  END IF;
  IF coalesce(doc ->> 'id', '') !~ '^[a-z][a-z0-9-]{0,63}$' OR doc ->> 'id' LIKE 'souvenir-%' THEN
    RAISE EXCEPTION 'an item id is lowercase letters, digits and dashes, not souvenir-' USING ERRCODE = 'CA400', DETAIL = 'id';
  END IF;
  IF coalesce(doc ->> 'kind', '') NOT IN ('character', 'frame', 'title') THEN
    RAISE EXCEPTION 'an item is a character, a frame or a title' USING ERRCODE = 'CA400', DETAIL = 'kind';
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
  PERFORM catalog_audit('catalog.item.create', 'item', made.id, NULL,
                        admin_item_doc(made) || jsonb_build_object('kind', made.kind), request);
  RETURN admin_item_row(made);
END $$;
REVOKE ALL ON FUNCTION admin_item_create(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_item_create(jsonb, uuid) TO questify_app;

-- ================================================================ the data export without gems (2.1)
-- As 0155, without `gems`.
CREATE OR REPLACE FUNCTION data_export_account(p player) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'account', jsonb_build_object(
      'username', p.username, 'birthYear', p.birth_year, 'avatar', p.avatar, 'status', p.status,
      'createdAt', data_export_time(p.created_at),
      'level', coalesce((SELECT xp_level_of(x.xp) FROM player_xp x WHERE x.player_id = p.id), 1),
      'xp', coalesce((SELECT x.xp FROM player_xp x WHERE x.player_id = p.id), 0)),
    'contacts', coalesce((SELECT jsonb_build_object('phone', c.phone_e164, 'email', c.email)
                          FROM player_contact c WHERE c.player_id = p.id),
                         jsonb_build_object('phone', NULL, 'email', NULL)),
    'usernames', coalesce((SELECT jsonb_agg(jsonb_build_object('username', h.username, 'reason', h.reason,
                                                               'changedAt', data_export_time(h.changed_at))
                                            ORDER BY h.changed_at, h.id)
                           FROM username_history h WHERE h.player_id = p.id), '[]'),
    'acceptances', coalesce((SELECT jsonb_agg(jsonb_build_object('document', a.document, 'version', a.version,
                                                                 'method', a.method,
                                                                 'acceptedAt', data_export_time(a.accepted_at))
                                              ORDER BY a.accepted_at, a.document)
                             FROM player_acceptance a WHERE a.player_id = p.id), '[]'),
    'marketing', jsonb_build_object(
      'consents', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', m.channel, 'granted', m.granted,
                                                                'method', m.method, 'textVersion', m.text_version,
                                                                'language', m.language,
                                                                'at', data_export_time(m.created_at))
                                             ORDER BY m.created_at, m.id)
                            FROM marketing_consent m WHERE m.player_id = p.id), '[]'),
      'state', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', m.channel, 'optedIn', m.opted_in,
                                                             'language', m.language,
                                                             'changedAt', data_export_time(m.changed_at))
                                          ORDER BY m.channel)
                         FROM marketing_state m WHERE m.player_id = p.id), '[]')),
    'preferences', (SELECT jsonb_build_object('cityId', f.city_id, 'interests', to_jsonb(f.interests),
                                              'updatedAt', data_export_time(f.updated_at))
                    FROM player_preference f WHERE f.player_id = p.id),
    'pushTopics', jsonb_build_object(
      'muted', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', t.topic, 'at', data_export_time(t.muted_at))
                                          ORDER BY t.topic)
                         FROM push_topic_mute t WHERE t.player_id = p.id), '[]'),
      'on', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', t.topic, 'at', data_export_time(t.chosen_at))
                                       ORDER BY t.topic)
                      FROM push_topic_on t WHERE t.player_id = p.id), '[]')),
    'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', d.platform, 'language', d.language,
                                                             'appVersion', d.app_version,
                                                             'createdAt', data_export_time(d.token_set_at),
                                                             'lastSeenAt', data_export_time(d.seen_at))
                                          ORDER BY d.token_set_at, d.id)
                         FROM push_device d WHERE d.player_id = p.id), '[]'),
    'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object('createdAt', data_export_time(s.created_at),
                                                              'expiresAt', data_export_time(s.expires_at),
                                                              'endedAt', data_export_time(s.revoked_at))
                                           ORDER BY s.created_at, s.id)
                          FROM player_session s WHERE s.player_id = p.id), '[]'),
    'signedInDevices', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', d.platform, 'model', d.model,
                                                                     'signedInAt', data_export_time(d.signed_in_at),
                                                                     'lastUsedAt', data_export_time(l.last_used))
                                                  ORDER BY d.signed_in_at, d.id)
                                 FROM player_sign_in_device d
                                 CROSS JOIN LATERAL (SELECT max(r.created_at) AS last_used FROM player_refresh r
                                                     WHERE r.family = d.family AND r.revoked_at IS NULL
                                                       AND r.expires_at > now()) l
                                 WHERE d.player_id = p.id AND d.ended_at IS NULL AND l.last_used IS NOT NULL), '[]'),
    'invitations', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', i.channel, 'state', i.state,
                                                                 'createdAt', data_export_time(i.created_at),
                                                                 'sentAt', data_export_time(i.sent_at),
                                                                 'openedAt', data_export_time(i.opened_at),
                                                                 'joinedAt', data_export_time(i.joined_at))
                                              ORDER BY i.created_at, i.id)
                             FROM invitation_recipient i WHERE i.player_id = p.id), '[]'))
$$;
REVOKE ALL ON FUNCTION data_export_account(player) FROM PUBLIC;

-- As 0129, without the gem entries and purchases; each item names its achievement and tier when it has them.
CREATE OR REPLACE FUNCTION data_export_questify(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'levelReached', coalesce((SELECT jsonb_agg(jsonb_build_object('level', l.level, 'at', data_export_time(l.reached_at))
                                               ORDER BY l.level) FROM level_reached l WHERE l.player_id = target), '[]'),
    'xpEntries', coalesce((SELECT jsonb_agg(jsonb_build_object('delta', x.delta, 'source', x.source,
                                                               'at', data_export_time(x.created_at)) ORDER BY x.created_at, x.id)
                           FROM xp_entry x WHERE x.player_id = target), '[]'),
    'achievements', coalesce((SELECT jsonb_agg(jsonb_build_object('achievementId', a.achievement_id, 'tier', a.tier,
                                                                  'earnedAt', data_export_time(a.earned_at))
                                               ORDER BY a.earned_at, a.achievement_id, a.tier)
                              FROM achievement_earned a WHERE a.player_id = target), '[]'),
    'achievementChanges', coalesce((SELECT jsonb_agg(jsonb_build_object('achievementId', a.achievement_id,
                                                                        'tier', a.tier, 'change', a.change,
                                                                        'at', data_export_time(a.created_at))
                                                     ORDER BY a.created_at, a.id)
                                    FROM achievement_revocation a WHERE a.player_id = target), '[]'),
    'awards', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', a.quest_id, 'at', data_export_time(a.earned_at))
                                         ORDER BY a.earned_at, a.id) FROM questify_award a WHERE a.player_id = target), '[]'),
    'streakDays', coalesce((SELECT jsonb_agg(d.day ORDER BY d.day)
                            FROM questify_streak_day d WHERE d.player_id = target), '[]'),
    'streakRewards', coalesce((SELECT jsonb_agg(jsonb_build_object('days', r.days, 'xp', r.xp,
                                                                   'at', data_export_time(r.created_at)) ORDER BY r.created_at, r.id)
                               FROM questify_streak_reward r WHERE r.player_id = target), '[]'),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                'itemId', i.item_id, 'source', i.source, 'level', i.source_level,
                                'achievementId', i.source_achievement_id, 'tier', i.source_tier,
                                'event', CASE WHEN e.id IS NOT NULL
                                  THEN jsonb_build_object('ar', e.name_ar, 'en', e.name_en) END,
                                'earnedAt', data_export_time(i.earned_at)) ORDER BY i.earned_at, i.item_id)
                       FROM player_item i LEFT JOIN event e ON e.id = i.source_event_id
                       WHERE i.player_id = target), '[]'),
    'equipment', (SELECT jsonb_build_object('character', q.character_id, 'frame', q.frame_id, 'title', q.title_id)
                  FROM player_equipment q WHERE q.player_id = target),
    'souvenirReceipts', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                           'itemId', s.item_id, 'event', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
                                           'at', data_export_time(s.earned_at)) ORDER BY s.earned_at, s.item_id)
                                  FROM souvenir_receipt s JOIN event e ON e.id = s.event_id
                                  WHERE s.player_id = target), '[]'),
    'daily', jsonb_build_object(
      'plays', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'kind', d.kind, 'day', d.starts_on,
                                  'answers', coalesce((SELECT jsonb_agg(jsonb_build_object('position', a.position,
                                                                                           'choice', a.choice,
                                                                                           'correct', a.correct)
                                                                        ORDER BY a.position)
                                                       FROM daily_answer a WHERE a.play_id = d.id), '[]'),
                                  'guesses', coalesce((SELECT jsonb_agg(jsonb_build_object('guess', g.guess,
                                                                                           'marks', g.marks)
                                                                        ORDER BY g.attempt)
                                                       FROM daily_guess g WHERE g.play_id = d.id), '[]'),
                                  'finish', (SELECT jsonb_build_object('solved', f.solved, 'correct', f.correct,
                                                                       'xp', f.xp, 'at', data_export_time(f.created_at))
                                             FROM daily_finish f WHERE f.play_id = d.id))
                                ORDER BY d.starts_on, d.id)
                         FROM daily_play d WHERE d.player_id = target), '[]')))
$$;
REVOKE ALL ON FUNCTION data_export_questify(uuid) FROM PUBLIC;
