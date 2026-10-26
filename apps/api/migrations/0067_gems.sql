-- T-404: gems and the Questify gem shop (ADR-285 to ADR-289; plan docs/plans/2026-10-27-t-404-gems.md). Gems are
-- earned only (level-ups, achievement tiers, Questify quests), paid once per earned row by questify_sync, and spent only
-- on cosmetic items through gem_buy. No money, no trading, no chance. Deployed migrations and 0063 to 0066 untouched.
SET LOCAL lock_timeout = '10s';
-- Every table this migration touches, up front, in live-path order and at the strongest mode a later statement needs,
-- so no lock is upgraded mid-migration (plan review MAJOR-1). `player` first drains erasures and every door that
-- row-locks the player before player_xp. platform_setting is never touched: a scan reads it before it locks player_xp.
LOCK TABLE player IN EXCLUSIVE MODE;
LOCK TABLE player_xp IN ACCESS EXCLUSIVE MODE;
LOCK TABLE level_reached IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE achievement_earned IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE questify_quest IN ACCESS EXCLUSIVE MODE;
LOCK TABLE questify_award IN ACCESS EXCLUSIVE MODE;
LOCK TABLE item IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player_item IN ACCESS EXCLUSIVE MODE;
LOCK TABLE level_item IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE souvenir_rule IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the balance and the ledger (ADR-285)
-- The balance, a cache of gem_entry like xp. On the row every sync and every purchase already locks FOR UPDATE; the
-- CHECK makes an overspend impossible even if a door were wrong.
ALTER TABLE player_xp ADD COLUMN gems bigint NOT NULL DEFAULT 0 CHECK (gems >= 0);

-- A Questify award's owner, so a gem entry can be bound to the same player's award.
ALTER TABLE questify_award ADD CONSTRAINT questify_award_owner_key UNIQUE (id, player_id);

-- ================================================================ the shop catalog (ADR-287, ADR-288)
-- Items for sale at a fixed gem price. Seeded only; T-709 edits prices and status. A retired item stays owned.
CREATE TABLE gem_shop_item (
 item_id text PRIMARY KEY REFERENCES item (id),
 price integer NOT NULL CHECK (price BETWEEN 1 AND 100000),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
 position smallint NOT NULL CHECK (position BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gem_shop_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE gem_shop_item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gem_shop_item FROM PUBLIC, questify_app;

-- One copy per player, ever. Append-only and kept on the erasure tombstone (no personal data), as xp_entry.
CREATE TABLE gem_purchase (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 player_id uuid NOT NULL REFERENCES player_xp (player_id),
 item_id text NOT NULL REFERENCES gem_shop_item (item_id),
 price integer NOT NULL CHECK (price BETWEEN 1 AND 100000),
 request_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (player_id, item_id),
 UNIQUE (player_id, request_key),
 UNIQUE (id, player_id),
 UNIQUE (player_id, item_id, id)
);
ALTER TABLE gem_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE gem_purchase FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gem_purchase FROM PUBLIC, questify_app;

-- The closed source list: level, achievement and questify credits, a purchase spend. Each entry names exactly the key
-- of its source, bound by a composite foreign key to the same player's row, and is unique per source row. There is no
-- transfer, gift, adjustment or expiry source (FR-724, FR-725, FR-1106).
CREATE TABLE gem_entry (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 player_id uuid NOT NULL REFERENCES player_xp (player_id),
 delta integer NOT NULL CHECK (delta <> 0),
 source text NOT NULL CHECK (source IN ('level', 'achievement', 'questify', 'purchase')),
 source_level smallint,
 achievement_id text,
 tier text,
 questify_award_id bigint,
 purchase_id bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT gem_entry_shape CHECK (
  (source = 'level' AND delta > 0 AND source_level IS NOT NULL AND achievement_id IS NULL AND tier IS NULL
   AND questify_award_id IS NULL AND purchase_id IS NULL)
  OR (source = 'achievement' AND delta > 0 AND source_level IS NULL AND achievement_id IS NOT NULL
      AND tier IS NOT NULL AND questify_award_id IS NULL AND purchase_id IS NULL)
  OR (source = 'questify' AND delta > 0 AND source_level IS NULL AND achievement_id IS NULL AND tier IS NULL
      AND questify_award_id IS NOT NULL AND purchase_id IS NULL)
  OR (source = 'purchase' AND delta < 0 AND source_level IS NULL AND achievement_id IS NULL AND tier IS NULL
      AND questify_award_id IS NULL AND purchase_id IS NOT NULL)),
 UNIQUE (player_id, source_level),
 UNIQUE (player_id, achievement_id, tier),
 UNIQUE (questify_award_id),
 UNIQUE (purchase_id),
 FOREIGN KEY (player_id, source_level) REFERENCES level_reached (player_id, level),
 FOREIGN KEY (player_id, achievement_id, tier) REFERENCES achievement_earned (player_id, achievement_id, tier),
 FOREIGN KEY (questify_award_id, player_id) REFERENCES questify_award (id, player_id),
 FOREIGN KEY (purchase_id, player_id) REFERENCES gem_purchase (id, player_id)
);
ALTER TABLE gem_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE gem_entry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gem_entry FROM PUBLIC, questify_app;

-- Append-only for every role, the owner included.
CREATE FUNCTION gem_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'gem entries and purchases can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION gem_append_only() FROM PUBLIC;
CREATE TRIGGER gem_entry_no_update_or_delete BEFORE UPDATE OR DELETE ON gem_entry
 FOR EACH ROW EXECUTE FUNCTION gem_append_only();
CREATE TRIGGER gem_entry_no_truncate BEFORE TRUNCATE ON gem_entry
 FOR EACH STATEMENT EXECUTE FUNCTION gem_append_only();
CREATE TRIGGER gem_purchase_no_update_or_delete BEFORE UPDATE OR DELETE ON gem_purchase
 FOR EACH ROW EXECUTE FUNCTION gem_append_only();
CREATE TRIGGER gem_purchase_no_truncate BEFORE TRUNCATE ON gem_purchase
 FOR EACH STATEMENT EXECUTE FUNCTION gem_append_only();
ALTER TABLE gem_entry ENABLE ALWAYS TRIGGER gem_entry_no_update_or_delete;
ALTER TABLE gem_entry ENABLE ALWAYS TRIGGER gem_entry_no_truncate;
ALTER TABLE gem_purchase ENABLE ALWAYS TRIGGER gem_purchase_no_update_or_delete;
ALTER TABLE gem_purchase ENABLE ALWAYS TRIGGER gem_purchase_no_truncate;

-- ================================================================ the locker's third source (ADR-287)
ALTER TABLE player_item DROP CONSTRAINT player_item_source_check;
ALTER TABLE player_item ADD COLUMN source_purchase_id bigint;
ALTER TABLE player_item ADD CONSTRAINT player_item_source_check CHECK(
 (source = 'level' AND source_level IS NOT NULL AND source_rule_id IS NULL AND source_event_id IS NULL
  AND source_purchase_id IS NULL)
 OR (source = 'souvenir' AND source_level IS NULL AND source_rule_id IS NOT NULL AND source_event_id IS NOT NULL
     AND source_purchase_id IS NULL)
 OR (source = 'shop' AND source_level IS NULL AND source_rule_id IS NULL AND source_event_id IS NULL
     AND source_purchase_id IS NOT NULL));
ALTER TABLE player_item ADD CONSTRAINT player_item_shop_fk
 FOREIGN KEY (player_id, item_id, source_purchase_id) REFERENCES gem_purchase (player_id, item_id, id);

-- As 0064, plus the purchase in the frozen set.
CREATE OR REPLACE FUNCTION owned_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.erasure', true) = 'on' THEN RETURN OLD; END IF;
 ELSIF (NEW.player_id, NEW.item_id, NEW.source, NEW.source_level, NEW.source_rule_id, NEW.source_event_id,
        NEW.source_purchase_id, NEW.earned_at)
   IS NOT DISTINCT FROM (OLD.player_id, OLD.item_id, OLD.source, OLD.source_level, OLD.source_rule_id,
        OLD.source_event_id, OLD.source_purchase_id, OLD.earned_at)
 THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'earned items can only be acknowledged or erased' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION owned_item_guard() FROM PUBLIC;

-- Six new procedural frame designs for the shop (T-404b renders them); souvenirs may use them too.
ALTER TABLE item DROP CONSTRAINT item_check1;
ALTER TABLE item ADD CONSTRAINT item_visual_key_check CHECK (
 (kind = 'title' AND visual_key IS NULL) OR (kind = 'character' AND visual_key = 'chest')
 OR (kind = 'frame' AND visual_key ~ '^frame-(0[1-9]|1[0-9]|20)$'));

-- ================================================================ exclusive sources (ADR-287)
-- As 0064, plus the shop: an item is a level reward, a souvenir or a shop item, never two, so a bought item can never
-- collide with a later level grant on player_item's (player, item) key. The three source-map writers serialize on the
-- item; an item an active souvenir or the shop names is frozen.
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
 ELSIF EXISTS (SELECT 1 FROM gem_shop_item g WHERE g.item_id = OLD.id) THEN
  RAISE EXCEPTION 'gem shop content is frozen' USING ERRCODE = 'GS409', DETAIL = 'shop_item_locked';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION souvenir_catalog_guard() FROM PUBLIC;
CREATE TRIGGER gem_shop_item_source BEFORE INSERT OR UPDATE ON gem_shop_item
 FOR EACH ROW EXECUTE FUNCTION souvenir_catalog_guard();
ALTER TABLE gem_shop_item ENABLE ALWAYS TRIGGER gem_shop_item_source;

-- The seeded catalog (ADR-288, Q-253): six titles (40 to 80 gems) and six frames (80 to 150), cheapest first.
INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES
 ('shop-map-reader', 'title', 'قارئ الخرائط', 'Map reader', NULL),
 ('shop-dune-watcher', 'title', 'راصد الكثبان', 'Dune watcher', NULL),
 ('shop-oasis-warden', 'title', 'حارس الواحة', 'Oasis warden', NULL),
 ('shop-pearl-diver', 'title', 'غوّاص اللؤلؤ', 'Pearl diver', NULL),
 ('shop-desert-knight', 'title', 'فارس الصحراء', 'Desert knight', NULL),
 ('shop-star-navigator', 'title', 'ملّاح النجوم', 'Star navigator', NULL),
 ('shop-dune-ring', 'frame', 'حلقة الكثبان', 'Dune ring', 'frame-15'),
 ('shop-compass-ring', 'frame', 'حلقة البوصلة', 'Compass ring', 'frame-16'),
 ('shop-falcon-ring', 'frame', 'حلقة الصقر', 'Falcon ring', 'frame-17'),
 ('shop-desert-ring', 'frame', 'حلقة الصحراء', 'Desert ring', 'frame-18'),
 ('shop-pearl-ring', 'frame', 'حلقة اللؤلؤ', 'Pearl ring', 'frame-19'),
 ('shop-moon-ring', 'frame', 'حلقة القمر', 'Moon ring', 'frame-20');
INSERT INTO gem_shop_item (item_id, price, position) VALUES
 ('shop-map-reader', 40, 1),
 ('shop-dune-watcher', 50, 2),
 ('shop-oasis-warden', 55, 3),
 ('shop-pearl-diver', 60, 4),
 ('shop-desert-knight', 70, 5),
 ('shop-star-navigator', 80, 6),
 ('shop-dune-ring', 80, 7),
 ('shop-compass-ring', 90, 8),
 ('shop-falcon-ring', 110, 9),
 ('shop-desert-ring', 120, 10),
 ('shop-pearl-ring', 135, 11),
 ('shop-moon-ring', 150, 12);

-- ================================================================ amounts as data (ADR-286, Q-251)
-- A quest's gems, 0 to 1000; the two seeded always-on quests pay 25. Frozen once the quest can pay (the console door).
ALTER TABLE questify_quest ADD COLUMN gems integer NOT NULL DEFAULT 0 CHECK (gems BETWEEN 0 AND 1000);
UPDATE questify_quest SET gems = 25
WHERE created_by IS NULL AND campaign_id IS NULL AND (metric, target) IN (('events', 3), ('cities', 2));

-- One field of the `gems` setting, used only when it is an integer 1 to 1000; anything else, or no row, is the
-- fallback, so a bad value can never pay 0 or a negative amount. T-709 adds the row and its CHECK with the editor.
CREATE FUNCTION gem_amount(setting jsonb, field text, fallback integer) RETURNS integer
 LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(setting -> field) = 'number' AND (setting ->> field) ~ '^[1-9][0-9]{0,3}$'
              AND (setting ->> field)::integer <= 1000
        THEN (setting ->> field)::integer ELSE fallback END
$$;
REVOKE ALL ON FUNCTION gem_amount(jsonb, text, integer) FROM PUBLIC;
CREATE FUNCTION gem_amounts() RETURNS TABLE (level_up integer, bronze integer, silver integer, gold integer)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT gem_amount(s.value, 'levelUp', 20), gem_amount(s.value, 'bronze', 10), gem_amount(s.value, 'silver', 25),
        gem_amount(s.value, 'gold', 50)
 FROM (SELECT (SELECT p.value FROM platform_setting p WHERE p.key = 'gems') AS value) s
$$;
REVOKE ALL ON FUNCTION gem_amounts() FROM PUBLIC;

-- ================================================================ earning (ADR-286)
-- Whether the player has an earned row with no gem entry yet; a 0-gem Questify award never counts. Internal.
CREATE FUNCTION gems_due(who uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM level_reached r WHERE r.player_id = who
                AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.source_level = r.level))
  OR EXISTS (SELECT 1 FROM achievement_earned e WHERE e.player_id = who
             AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.achievement_id = e.achievement_id
                             AND g.tier = e.tier))
  OR EXISTS (SELECT 1 FROM questify_award a JOIN questify_quest q ON q.id = a.quest_id
             WHERE a.player_id = who AND q.gems > 0
               AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.questify_award_id = a.id))
$$;
REVOKE ALL ON FUNCTION gems_due(uuid) FROM PUBLIC;

-- As 0066, then the gems: after the tiers and the Questify quests, under the same locks (player KEY SHARE, then
-- player_xp FOR UPDATE), every level_reached, achievement_earned and paying questify_award row of the caller with no
-- gem entry yet gets one, and the balance moves once. The only door that credits gems; nothing is added to the
-- completion transaction, so a level reached by a scan is paid at the next sync. The unlocked pre-check answers the
-- balance without a lock when nothing is due.
CREATE OR REPLACE FUNCTION questify_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who     uuid;
 tiers   jsonb;
 quest   record;
 award   bigint;
 entry   bigint;
 paid    jsonb := '[]'::jsonb;
 entries bigint[] := '{}';
 amount  record;
 earned  bigint;
 balance bigint;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) AND NOT EXISTS (SELECT 1 FROM questify_due(who))
    AND NOT gems_due(who) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb, 'quests', '[]'::jsonb, 'levelUp', NULL,
   'gems', jsonb_build_object('earned', 0, 'balance', (SELECT x.gems FROM player_xp x WHERE x.player_id = who)));
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
 RETURN jsonb_build_object('achievements', tiers, 'quests', paid, 'levelUp', questify_level_up(who, entries),
  'gems', jsonb_build_object('earned', earned, 'balance', balance));
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- The caller's balance; NULL for a caller who is not an active player (GET /v1/me).
CREATE FUNCTION own_gems() RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT x.gems FROM player_xp x WHERE x.player_id = profile_player()
$$;
REVOKE ALL ON FUNCTION own_gems() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_gems() TO questify_app;

-- ================================================================ the gem shop (ADR-287)
-- The caller's balance and the active items by position, each with its price and whether the caller owns it (any
-- source). Never another player's data; NULL for a caller who is not an active player.
CREATE FUNCTION gem_shop() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH me AS MATERIALIZED (SELECT profile_player() AS id)
 SELECT jsonb_build_object('gems', x.gems, 'items', (
  SELECT coalesce(jsonb_agg(item_json(s.item_id) || jsonb_build_object('price', s.price,
           'owned', EXISTS (SELECT 1 FROM player_item o WHERE o.player_id = me.id AND o.item_id = s.item_id))
          ORDER BY s.position, s.item_id), '[]'::jsonb)
  FROM gem_shop_item s WHERE s.status = 'active'))
 FROM me JOIN player_xp x ON x.player_id = me.id
$$;
REVOKE ALL ON FUNCTION gem_shop() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gem_shop() TO questify_app;

-- Gets one shop item for the price the caller saw, once per request key. Lock order: player KEY SHARE, then player_xp
-- FOR UPDATE (the sync's and the scan's order), then the checks on fresh reads, so two identical requests serialize
-- and the second replays. Refusals: PI401 (not an active player), GS404 (unknown or retired), GS409 with the reason in
-- DETAIL and the balance in HINT (owned, price_changed, too_few_gems; nothing written), GS422 (the key was used for
-- another item). A replay answers the original purchase with the current balance. XP is never read or written (FR-415).
CREATE FUNCTION gem_buy(chosen text, seen_price integer, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who     uuid;
 balance bigint;
 offer   gem_shop_item%ROWTYPE;
 earlier gem_purchase%ROWTYPE;
 made    bigint;
BEGIN
 IF request IS NULL THEN RAISE EXCEPTION 'a request key is required' USING ERRCODE = 'invalid_parameter_value'; END IF;
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR KEY SHARE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 SELECT x.gems INTO balance FROM player_xp x WHERE x.player_id = who FOR UPDATE;
 SELECT g.* INTO earlier FROM gem_purchase g WHERE g.player_id = who AND g.request_key = request;
 IF FOUND THEN
  IF earlier.item_id IS DISTINCT FROM chosen THEN
   RAISE EXCEPTION 'the request key was used for another item' USING ERRCODE = 'GS422', DETAIL = 'key_reused';
  END IF;
  RETURN jsonb_build_object('itemId', earlier.item_id, 'gems', balance, 'item', item_json(earlier.item_id),
                            'replayed', true);
 END IF;
 SELECT s.* INTO offer FROM gem_shop_item s WHERE s.item_id = chosen AND s.status = 'active';
 IF NOT FOUND THEN RAISE EXCEPTION 'no such item in the shop' USING ERRCODE = 'GS404'; END IF;
 IF EXISTS (SELECT 1 FROM player_item o WHERE o.player_id = who AND o.item_id = chosen) THEN
  RAISE EXCEPTION 'the item is owned already' USING ERRCODE = 'GS409', DETAIL = 'owned', HINT = balance::text;
 END IF;
 IF seen_price IS DISTINCT FROM offer.price THEN
  RAISE EXCEPTION 'the price changed' USING ERRCODE = 'GS409', DETAIL = 'price_changed', HINT = balance::text;
 END IF;
 IF balance < offer.price THEN
  RAISE EXCEPTION 'not enough gems' USING ERRCODE = 'GS409', DETAIL = 'too_few_gems', HINT = balance::text;
 END IF;
 INSERT INTO gem_purchase (player_id, item_id, price, request_key) VALUES (who, chosen, offer.price, request)
 RETURNING id INTO made;
 INSERT INTO gem_entry (player_id, delta, source, purchase_id) VALUES (who, -offer.price, 'purchase', made);
 INSERT INTO player_item (player_id, item_id, source, source_purchase_id, earned_at)
 VALUES (who, chosen, 'shop', made, now());
 UPDATE player_xp x SET gems = x.gems - offer.price WHERE x.player_id = who RETURNING x.gems INTO balance;
 RETURN jsonb_build_object('itemId', chosen, 'gems', balance, 'item', item_json(chosen), 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION gem_buy(text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gem_buy(text, integer, uuid) TO questify_app;

-- As 0064, plus `source` (level, souvenir or shop), so the locker names a shop item's origin.
DROP FUNCTION own_locker(timestamptz, text, integer);
CREATE FUNCTION own_locker(before_time timestamptz, before_item text, page_size integer)
 RETURNS TABLE(item jsonb, earned_at timestamptz, source_level smallint, source_event jsonb, seen boolean, source text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT item_json(o.item_id), o.earned_at, o.source_level,
  CASE WHEN o.source = 'souvenir' THEN jsonb_build_object('id', o.source_event_id, 'name', jsonb_build_object(
   'ar', coalesce(e.name_ar, e.name_en, 'فعالية سابقة'), 'en', coalesce(e.name_en, e.name_ar, 'Past event'))) END,
  o.seen_at IS NOT NULL, o.source
 FROM player_item o LEFT JOIN event e ON e.id = o.source_event_id
 WHERE o.player_id = profile_player() AND (before_time IS NULL OR (o.earned_at, o.item_id) < (before_time, before_item))
 ORDER BY o.earned_at DESC, o.item_id DESC LIMIT least(greatest(coalesce(page_size, 30), 1), 101)
$$;
REVOKE ALL ON FUNCTION own_locker(timestamptz, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_locker(timestamptz, text, integer) TO questify_app;

-- ================================================================ quest gems on the doors (ADR-286)
-- As 0066, plus `gems`.
CREATE OR REPLACE FUNCTION questify_quest_json(q questify_quest) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('id', q.id, 'campaignId', q.campaign_id, 'metric', q.metric, 'target', q.target,
  'title', jsonb_build_object('ar', q.title_ar, 'en', q.title_en), 'xp', q.xp, 'gems', q.gems, 'position', q.position,
  'status', q.status, 'createdAt', q.created_at, 'updatedAt', q.updated_at)
$$;
REVOKE ALL ON FUNCTION questify_quest_json(questify_quest) FROM PUBLIC;

-- A quest's gems from the console's fields: absent keeps `kept` (0 on create), anything but an integer 0 to 1000 is
-- refused with the field. Internal.
CREATE FUNCTION questify_gems_of(fields jsonb, kept integer) RETURNS integer
 LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
 IF NOT fields ? 'gems' THEN RETURN kept; END IF;
 IF jsonb_typeof(fields -> 'gems') <> 'number' OR (fields ->> 'gems') !~ '^(0|[1-9][0-9]{0,3})$'
    OR (fields ->> 'gems')::integer > 1000 THEN
  RAISE EXCEPTION 'a quest pays 0 to 1000 gems' USING ERRCODE = 'QY422', DETAIL = 'gems';
 END IF;
 RETURN (fields ->> 'gems')::integer;
END $$;
REVOKE ALL ON FUNCTION questify_gems_of(jsonb, integer) FROM PUBLIC;

-- As 0066, plus `gems` (0 to 1000; absent keeps the quest's value): frozen with the metric and target once the quest
-- can pay, so raising it can never pay earlier awardees after the fact.
CREATE OR REPLACE FUNCTION questify_quest_save(chosen uuid, fields jsonb, request uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 admin   uuid := questify_admin();
 wanted  text := fields ->> 'status';
 old     questify_quest%ROWTYPE;
 home    questify_campaign%ROWTYPE;
 made    questify_quest%ROWTYPE;
 reward  integer;
 changed text[] := ARRAY['metric', 'target', 'title', 'xp', 'gems', 'position', 'status'];
BEGIN
 IF wanted IS NULL OR wanted NOT IN ('draft', 'active') THEN
  RAISE EXCEPTION 'a quest is saved as a draft or active' USING ERRCODE = 'QY422', DETAIL = 'status';
 END IF;
 IF chosen IS NULL THEN
  reward := questify_gems_of(fields, 0);
  home := questify_home((fields ->> 'campaignId')::uuid);
  -- A new quest counts plays from its campaign's start, so one added to a running campaign would pay past plays.
  IF home.status = 'published' AND home.starts_at <= now() THEN
   RAISE EXCEPTION 'the campaign has started' USING ERRCODE = 'QY409', DETAIL = 'started';
  END IF;
  IF (SELECT count(*) FROM questify_quest q WHERE q.status <> 'retired'
       AND q.campaign_id IS NOT DISTINCT FROM home.id) >= (CASE WHEN home.id IS NULL THEN 50 ELSE 20 END) THEN
   RAISE EXCEPTION 'too many quests' USING ERRCODE = 'QY409', DETAIL = 'too_many';
  END IF;
  INSERT INTO questify_quest (campaign_id, metric, target, title_ar, title_en, xp, gems, position, status, created_by)
  VALUES (home.id, fields ->> 'metric', (fields ->> 'target')::integer, fields #>> '{title,ar}',
          fields #>> '{title,en}', (fields ->> 'xp')::integer, reward, (fields ->> 'position')::smallint, wanted, admin)
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
  reward := questify_gems_of(fields, old.gems);
  IF ((old.campaign_id IS NULL AND old.status = 'active') OR home.status = 'published')
     AND ((fields ->> 'metric', (fields ->> 'target')::integer, reward) IS DISTINCT FROM (old.metric, old.target, old.gems)) THEN
   RAISE EXCEPTION 'the quest can pay, so its condition and gems are fixed' USING ERRCODE = 'QY409', DETAIL = 'frozen';
  END IF;
  IF old.status = 'active' AND wanted = 'draft' THEN
   RAISE EXCEPTION 'an active quest stays active until retired' USING ERRCODE = 'QY409', DETAIL = 'frozen';
  END IF;
  UPDATE questify_quest q
  SET metric = fields ->> 'metric', target = (fields ->> 'target')::integer, title_ar = fields #>> '{title,ar}',
      title_en = fields #>> '{title,en}', xp = (fields ->> 'xp')::integer, gems = reward,
      position = (fields ->> 'position')::smallint, status = wanted, updated_at = now()
  WHERE q.id = old.id RETURNING * INTO made;
  changed := array_remove(ARRAY[
   CASE WHEN made.metric IS DISTINCT FROM old.metric THEN 'metric' END,
   CASE WHEN made.target IS DISTINCT FROM old.target THEN 'target' END,
   CASE WHEN (made.title_ar, made.title_en) IS DISTINCT FROM (old.title_ar, old.title_en) THEN 'title' END,
   CASE WHEN made.xp IS DISTINCT FROM old.xp THEN 'xp' END,
   CASE WHEN made.gems IS DISTINCT FROM old.gems THEN 'gems' END,
   CASE WHEN made.position IS DISTINCT FROM old.position THEN 'position' END,
   CASE WHEN made.status IS DISTINCT FROM old.status THEN 'status' END], NULL);
 END IF;
 PERFORM questify_audit(admin, CASE WHEN chosen IS NULL THEN 'quest_created' ELSE 'quest_updated' END,
                        'questify_quest', made.id, jsonb_build_object('fields', to_jsonb(changed)), request);
 RETURN questify_quest_json(made);
END $$;
REVOKE ALL ON FUNCTION questify_quest_save(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_quest_save(uuid, jsonb, uuid) TO questify_app;

-- As 0066, plus each card's `gems`.
CREATE OR REPLACE FUNCTION own_questify_quests() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH me AS MATERIALIZED (SELECT profile_player() AS id),
 shown AS MATERIALIZED (
  SELECT q.id, q.campaign_id, q.metric, q.target, q.title_ar, q.title_en, q.xp, q.gems, q.position,
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
   'progress', p.value, 'xp', s.xp, 'gems', s.gems,
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
