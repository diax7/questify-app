-- T-709c part 1: the console's achievement thresholds, the XP and gem amounts, and the revoke and restore of a banned
-- player's achievement tiers (FR-1403; plan docs/plans/2026-11-02-t-709c-xp-thresholds-items.md D1 to D3; ADR-437 to
-- ADR-439). T-709d (items, the XP table) is not here.
--
-- Money that cannot come back: a lower threshold pays gems to every player who now reaches the tier, at their next sync,
-- and the gem ledger is append-only (ADR-285). The threshold door refuses a lowering unless the admin confirmed it (CA428,
-- the detail names the gems per lowered tier); a revert never removes an earned tier or a gem entry. Payment once rests on
-- the keys that already exist: achievement_earned's primary key and gem_entry's unique (player, achievement, tier).
--
-- Locks: the threshold door takes the achievement row FOR NO KEY UPDATE (a sync's insert into achievement_earned takes FOR
-- KEY SHARE through the foreign key, which it does not block) and touches no player row. The amounts door makes sure both
-- rows exist with INSERT ... ON CONFLICT DO NOTHING (no table lock), then locks the two rows in key order; scans and syncs
-- read them without a lock. The tier doors lock the player FOR NO KEY UPDATE, then player_xp FOR UPDATE: the sync's own
-- order (player KEY SHARE, then player_xp), and erasure's (player, then player_xp).
--
-- Deny by default: the new table is closed to every role and append-only; every new function is revoked from PUBLIC in
-- the group that creates it; only the doors go to questify_app. The table's generic write policies are narrowed to the
-- `features` and `tuning` keys, so `xp`, `gems` and `moderation` change only through definer doors or a migration.
-- Earlier migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the amounts: bounds on write (ADR-438)
-- One field of a setting: present, a JSON number and a whole number from low to high. Used by the doors.
CREATE FUNCTION amount_field_ok(setting jsonb, field text, low integer, high integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(setting -> field) = 'number' AND (setting ->> field) ~ '^(0|[1-9][0-9]{0,5})$'
              THEN (setting ->> field)::integer BETWEEN low AND high
              ELSE false END
$$;
REVOKE ALL ON FUNCTION amount_field_ok(jsonb, text, integer, integer) FROM PUBLIC;

-- `xp`: the quest amount a number 1 to 99,999 (0039 checked only its digits); each daily field absent or in its range.
-- The CHECKs spell each field out instead of calling amount_field_ok: a CHECK runs with the writer's rights, and the
-- API's role holds EXECUTE on no internal function.
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_xp_daily_check CHECK (
  key <> 'xp' OR ((CASE WHEN jsonb_typeof(value -> 'questXp') = 'number' AND (value ->> 'questXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'questXp')::integer BETWEEN 1 AND 99999 ELSE false END)
    AND (NOT value ? 'dailyFinishXp' OR (CASE WHEN jsonb_typeof(value -> 'dailyFinishXp') = 'number' AND (value ->> 'dailyFinishXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'dailyFinishXp')::integer BETWEEN 0 AND 400 ELSE false END))
    AND (NOT value ? 'dailyRightXp' OR (CASE WHEN jsonb_typeof(value -> 'dailyRightXp') = 'number' AND (value ->> 'dailyRightXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'dailyRightXp')::integer BETWEEN 0 AND 200 ELSE false END))
    AND (NOT value ? 'dailyWordXp' OR (CASE WHEN jsonb_typeof(value -> 'dailyWordXp') = 'number' AND (value ->> 'dailyWordXp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'dailyWordXp')::integer BETWEEN 0 AND 1000 ELSE false END)))) NOT VALID;
ALTER TABLE platform_setting VALIDATE CONSTRAINT platform_setting_xp_daily_check;
-- `gems`: all four amounts present, each 1 to 1000.
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_gems_check CHECK (
  key <> 'gems' OR ((CASE WHEN jsonb_typeof(value -> 'levelUp') = 'number' AND (value ->> 'levelUp') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'levelUp')::integer BETWEEN 1 AND 1000 ELSE false END)
    AND (CASE WHEN jsonb_typeof(value -> 'bronze') = 'number' AND (value ->> 'bronze') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'bronze')::integer BETWEEN 1 AND 1000 ELSE false END)
    AND (CASE WHEN jsonb_typeof(value -> 'silver') = 'number' AND (value ->> 'silver') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'silver')::integer BETWEEN 1 AND 1000 ELSE false END)
    AND (CASE WHEN jsonb_typeof(value -> 'gold') = 'number' AND (value ->> 'gold') ~ '^(0|[1-9][0-9]{0,5})$'
        THEN (value ->> 'gold')::integer BETWEEN 1 AND 1000 ELSE false END))) NOT VALID;
ALTER TABLE platform_setting VALIDATE CONSTRAINT platform_setting_gems_check;

-- As 0067, without the range branch: the CHECK above makes a stored out-of-range value impossible, so the fallback is
-- only for a missing row.
CREATE OR REPLACE FUNCTION gem_amount(setting jsonb, field text, fallback integer) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((setting ->> field)::integer, fallback)
$$;
REVOKE ALL ON FUNCTION gem_amount(jsonb, text, integer) FROM PUBLIC;

-- The generic writer (the platform settings API) keeps `features` and `tuning`; the doors write the rest.
DROP POLICY platform_setting_insert ON platform_setting;
DROP POLICY platform_setting_update ON platform_setting;
CREATE POLICY platform_setting_insert ON platform_setting FOR INSERT TO questify_app
  WITH CHECK (app_admin_id() IS NOT NULL AND key IN ('features', 'tuning'));
CREATE POLICY platform_setting_update ON platform_setting FOR UPDATE TO questify_app
  USING (app_admin_id() IS NOT NULL AND key IN ('features', 'tuning'))
  WITH CHECK (app_admin_id() IS NOT NULL AND key IN ('features', 'tuning'));

-- ================================================================ the amounts editor
-- The amounts in force, fallbacks filled in: what the scans and the sync pay now. Internal.
CREATE FUNCTION admin_amounts_doc() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'xp', jsonb_build_object('questXp', quest_xp(), 'dailyFinishXp', d.finish, 'dailyRightXp', d.per_right,
                             'dailyWordXp', d.word),
    'gems', jsonb_build_object('levelUp', g.level_up, 'bronze', g.bronze, 'silver', g.silver, 'gold', g.gold))
  FROM daily_xp() d CROSS JOIN gem_amounts() g
$$;
REVOKE ALL ON FUNCTION admin_amounts_doc() FROM PUBLIC;

CREATE FUNCTION admin_amounts() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN admin_amounts_doc() || jsonb_build_object('stored', jsonb_build_object(
    'xp', EXISTS (SELECT 1 FROM platform_setting s WHERE s.key = 'xp'),
    'gems', EXISTS (SELECT 1 FROM platform_setting s WHERE s.key = 'gems')));
END $$;
REVOKE ALL ON FUNCTION admin_amounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_amounts() TO questify_app;

-- One group of the document: exactly `fields`, each a whole number in its range (CA400, the detail names the field).
CREATE FUNCTION amounts_group(doc jsonb, grp text, fields text[], lows integer[], highs integer[]) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  part jsonb := doc -> grp;
  made jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(part) IS DISTINCT FROM 'object' OR part - fields <> '{}'::jsonb THEN
    RAISE EXCEPTION 'give exactly the amounts of %', grp USING ERRCODE = 'CA400', DETAIL = grp;
  END IF;
  FOR i IN 1 .. cardinality(fields) LOOP
    IF NOT amount_field_ok(part, fields[i], lows[i], highs[i]) THEN
      RAISE EXCEPTION '%.% must be a whole number from % to %', grp, fields[i], lows[i], highs[i]
        USING ERRCODE = 'CA400', DETAIL = grp || '.' || fields[i];
    END IF;
    made := made || jsonb_build_object(fields[i], (part ->> fields[i])::integer);
  END LOOP;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION amounts_group(jsonb, text, text[], integer[], integer[]) FROM PUBLIC;

-- Saves the XP and gem amounts as one document (ADR-438). From the save on, every scan, daily play and sync pays the new
-- amounts, including levels and tiers reached but not yet paid; XP and gems already credited never change. A missing row
-- is first stored with the amounts in force, so the two rows can be locked in key order with no table lock. A save that
-- changes nothing writes nothing. `revert_of` is the audit entry a revert undoes. Answers admin_amounts().
CREATE FUNCTION admin_amounts_save(doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  old    jsonb;
  edited jsonb;
BEGIN
  INSERT INTO platform_setting (key, value, updated_by)
  SELECT k, admin_amounts_doc() -> k, me FROM unnest(ARRAY['gems', 'xp']) AS k
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM platform_setting s WHERE s.key IN ('gems', 'xp') ORDER BY s.key FOR UPDATE;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('platform_setting', 'amounts', revert_of);
  END IF;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['xp', 'gems'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'give the xp and gems amounts only' USING ERRCODE = 'CA400', DETAIL = 'amounts';
  END IF;
  edited := jsonb_build_object(
    'xp', amounts_group(doc, 'xp', ARRAY['questXp', 'dailyFinishXp', 'dailyRightXp', 'dailyWordXp'],
                        ARRAY[1, 0, 0, 0], ARRAY[99999, 400, 200, 1000]),
    'gems', amounts_group(doc, 'gems', ARRAY['levelUp', 'bronze', 'silver', 'gold'],
                          ARRAY[1, 1, 1, 1], ARRAY[1000, 1000, 1000, 1000]));
  old := admin_amounts_doc();
  IF old <> edited THEN
    UPDATE platform_setting s SET value = s.value || (edited -> s.key), updated_at = now(), updated_by = me
    WHERE s.key IN ('gems', 'xp');
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.amounts.revert' ELSE 'catalog.amounts.update' END,
                          'platform_setting', 'amounts', old, edited, request);
  END IF;
  RETURN admin_amounts();
END $$;
REVOKE ALL ON FUNCTION admin_amounts_save(jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_amounts_save(jsonb, bigint, uuid) TO questify_app;

-- ================================================================ achievement thresholds (ADR-437)
-- What an admin edits of an achievement, as the audit entry and a revert hold it: the name and the three thresholds.
-- Entries written by 0119 hold the name only.
CREATE OR REPLACE FUNCTION admin_achievement_doc(a achievement) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
                            'bronze', a.bronze, 'silver', a.silver, 'gold', a.gold)
$$;
REVOKE ALL ON FUNCTION admin_achievement_doc(achievement) FROM PUBLIC;

-- One threshold of a document: a whole JSON number 1 to 100,000 (CA400, detail `thresholds`).
CREATE FUNCTION achievement_threshold(doc jsonb, tier text) RETURNS integer
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT amount_field_ok(doc, tier, 1, 100000) THEN
    RAISE EXCEPTION 'the % threshold must be a whole number from 1 to 100000', tier
      USING ERRCODE = 'CA400', DETAIL = 'thresholds';
  END IF;
  RETURN (doc ->> tier)::integer;
END $$;
REVOKE ALL ON FUNCTION achievement_threshold(jsonb, text) FROM PUBLIC;

DROP FUNCTION admin_achievement_save(text, jsonb, bigint, uuid);

-- Changes the name and the thresholds of one achievement (CA404 for an unknown id). The thresholds are whole, 1 to
-- 100,000 and strictly rising; anything else in the document is CA400. A threshold below the stored one pays gems to
-- every player who then reaches the tier, at their next sync, and nothing takes them back: the door refuses it unless
-- `confirmed` (CA428; the detail is a JSON object of the gems each lowered tier pays now). A revert puts back the entry's
-- `before` over the current row (an 0119 entry holds the name only, so the thresholds stay) and needs `confirmed` when it
-- lowers. A save that changes nothing writes nothing.
CREATE FUNCTION admin_achievement_save(achievement_id text, doc jsonb, revert_of bigint, confirmed boolean,
                                       request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old     achievement;
  made    achievement;
  edited  jsonb;
  lowered jsonb;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM achievement a WHERE a.id = achievement_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such achievement' USING ERRCODE = 'CA404';
  END IF;
  IF revert_of IS NOT NULL THEN
    doc := admin_achievement_doc(old) || catalog_revert_doc('achievement', achievement_id, revert_of);
  END IF;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['name', 'bronze', 'silver', 'gold'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'an achievement has a name and three thresholds only' USING ERRCODE = 'CA400', DETAIL = 'doc';
  END IF;
  edited := jsonb_build_object('name', jsonb_build_object('ar', catalog_text(doc #>> '{name,ar}', 'name.ar', 60),
                                                          'en', catalog_text(doc #>> '{name,en}', 'name.en', 60)),
                               'bronze', achievement_threshold(doc, 'bronze'),
                               'silver', achievement_threshold(doc, 'silver'),
                               'gold', achievement_threshold(doc, 'gold'));
  IF NOT ((edited ->> 'bronze')::integer < (edited ->> 'silver')::integer
          AND (edited ->> 'silver')::integer < (edited ->> 'gold')::integer) THEN
    RAISE EXCEPTION 'the thresholds must rise from bronze to gold' USING ERRCODE = 'CA400', DETAIL = 'thresholds';
  END IF;
  IF admin_achievement_doc(old) = edited THEN
    RETURN edited || jsonb_build_object('id', old.id, 'metric', old.metric, 'visualKey', old.visual_key,
                                        'position', old.position);
  END IF;
  SELECT coalesce(jsonb_object_agg(t.tier, t.gems), '{}'::jsonb) INTO lowered
  FROM gem_amounts() g
  CROSS JOIN LATERAL (VALUES ('bronze', old.bronze, g.bronze), ('silver', old.silver, g.silver),
                             ('gold', old.gold, g.gold)) t (tier, was, gems)
  WHERE (edited ->> t.tier)::integer < t.was;
  IF lowered <> '{}'::jsonb AND confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'a lower threshold pays gems that cannot be taken back; confirm it'
      USING ERRCODE = 'CA428', DETAIL = lowered::text;
  END IF;
  UPDATE achievement a SET name_ar = edited #>> '{name,ar}', name_en = edited #>> '{name,en}',
         bronze = (edited ->> 'bronze')::integer, silver = (edited ->> 'silver')::integer,
         gold = (edited ->> 'gold')::integer
  WHERE a.id = achievement_id
  RETURNING * INTO made;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.achievement.revert' ELSE 'catalog.achievement.update' END,
                        'achievement', achievement_id, admin_achievement_doc(old), edited, request);
  RETURN edited || jsonb_build_object('id', made.id, 'metric', made.metric, 'visualKey', made.visual_key,
                                      'position', made.position);
END $$;
REVOKE ALL ON FUNCTION admin_achievement_save(text, jsonb, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_achievement_save(text, jsonb, bigint, boolean, uuid) TO questify_app;

-- ================================================================ revoking a banned player's tiers (ADR-439)
ALTER TABLE player_admin_action DROP CONSTRAINT player_admin_action_kind_check;
ALTER TABLE player_admin_action ADD CONSTRAINT player_admin_action_kind_check
  CHECK (kind IN ('rename', 'reset_sign_in', 'contact_reveal', 'ban', 'lift_ban', 'revoke_tiers', 'restore_tiers'));

-- As 0120, plus the codes of the tier revoke and restore (internal).
CREATE OR REPLACE FUNCTION player_action_note(action_kind text, code text, note text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF code IS NULL OR NOT (code = ANY (CASE action_kind
       WHEN 'contact_reveal' THEN ARRAY['support_request', 'legal_request']
       WHEN 'rename' THEN ARRAY['offensive', 'impersonation', 'personal_data', 'spam', 'other']
       WHEN 'reset_sign_in' THEN ARRAY['lost_access', 'compromised', 'locked_out', 'other']
       WHEN 'ban' THEN ARRAY['cheating', 'abuse', 'spam', 'prize_fraud', 'terms']
       WHEN 'lift_ban' THEN ARRAY['appeal_upheld', 'mistake', 'other']
       WHEN 'revoke_tiers' THEN ARRAY['cheating', 'prize_fraud', 'abuse', 'other']
       WHEN 'restore_tiers' THEN ARRAY['appeal_upheld', 'mistake', 'other']
       ELSE ARRAY[]::text[] END)) THEN
    RAISE EXCEPTION 'unknown reason code for %', action_kind USING ERRCODE = 'PA400';
  END IF;
  IF note IS NULL OR char_length(btrim(note)) NOT BETWEEN 10 AND 300
     OR note ~ '[[:cntrl:]  ‪-‮⁦-⁩]' THEN
    RAISE EXCEPTION 'a note of 10 to 300 characters is required' USING ERRCODE = 'PA400';
  END IF;
  RETURN btrim(note);
END $$;
REVOKE ALL ON FUNCTION player_action_note(text, text, text) FROM PUBLIC;

-- A mark on an earned tier: the tier is revoked while its latest row is `revoke`. The earned row and its gem entry are
-- never touched (both append-only). No personal data, so erasure keeps the rows as it keeps the earned ones; the action
-- row is erased with the player, which empties `action_id` (the one change the guard lets through, under erasure only).
CREATE TABLE achievement_revocation (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id      uuid NOT NULL,
  achievement_id text NOT NULL,
  tier           text NOT NULL,
  change         text NOT NULL CHECK (change IN ('revoke', 'restore')),
  action_id      uuid REFERENCES player_admin_action (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (player_id, achievement_id, tier) REFERENCES achievement_earned (player_id, achievement_id, tier)
);
CREATE INDEX achievement_revocation_tier_idx ON achievement_revocation (player_id, achievement_id, tier, id DESC);
CREATE INDEX achievement_revocation_action_idx ON achievement_revocation (action_id);
ALTER TABLE achievement_revocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE achievement_revocation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON achievement_revocation FROM PUBLIC, questify_app;

CREATE FUNCTION achievement_revocation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('app.erasure', true) = 'on' AND NEW.action_id IS NULL
     AND (NEW.id, NEW.player_id, NEW.achievement_id, NEW.tier, NEW.change, NEW.created_at)
         = (OLD.id, OLD.player_id, OLD.achievement_id, OLD.tier, OLD.change, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'tier revocations can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION achievement_revocation_guard() FROM PUBLIC;
CREATE TRIGGER achievement_revocation_no_change BEFORE UPDATE OR DELETE ON achievement_revocation
  FOR EACH ROW EXECUTE FUNCTION achievement_revocation_guard();
CREATE TRIGGER achievement_revocation_no_truncate BEFORE TRUNCATE ON achievement_revocation
  FOR EACH STATEMENT EXECUTE FUNCTION achievement_revocation_guard();
ALTER TABLE achievement_revocation ENABLE ALWAYS TRIGGER achievement_revocation_no_change;
ALTER TABLE achievement_revocation ENABLE ALWAYS TRIGGER achievement_revocation_no_truncate;

-- Whether one earned tier is revoked now. Internal.
CREATE FUNCTION tier_revoked(who uuid, target text, which text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT r.change = 'revoke' FROM achievement_revocation r
                   WHERE r.player_id = who AND r.achievement_id = target AND r.tier = which
                   ORDER BY r.id DESC LIMIT 1), false)
$$;
REVOKE ALL ON FUNCTION tier_revoked(uuid, text, text) FROM PUBLIC;

-- As 0065, skipping a revoked tier: the player's list and the public profile show the highest tier still held.
CREATE OR REPLACE FUNCTION earned_tier(who uuid, target text) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT e.tier FROM achievement_earned e
  WHERE e.player_id = who AND e.achievement_id = target AND NOT tier_revoked(who, target, e.tier)
  ORDER BY array_position(ARRAY['bronze', 'silver', 'gold'], e.tier) DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION earned_tier(uuid, text) FROM PUBLIC;

-- As 0065: an achievement with a revoked tier shows no next tier (a revoked tier is never earned again, so there is
-- nothing to reach).
CREATE OR REPLACE FUNCTION own_achievements() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
    'visualKey', a.visual_key, 'tier', t.tier, 'progress', m.value,
    'next', CASE WHEN t.revoked THEN NULL
                 WHEN t.tier = 'gold' THEN NULL
                 WHEN t.tier = 'silver' THEN jsonb_build_object('tier', 'gold', 'target', a.gold)
                 WHEN t.tier = 'bronze' THEN jsonb_build_object('tier', 'silver', 'target', a.silver)
                 ELSE jsonb_build_object('tier', 'bronze', 'target', a.bronze) END)
    ORDER BY a.position)
  FROM (SELECT profile_player() AS id) me
  CROSS JOIN LATERAL player_metrics(me.id) m JOIN achievement a ON a.metric = m.metric
  CROSS JOIN LATERAL (SELECT earned_tier(me.id, a.id) AS tier,
                             EXISTS (SELECT 1 FROM achievement_earned e
                                     WHERE e.player_id = me.id AND e.achievement_id = a.id
                                       AND tier_revoked(me.id, a.id, e.tier)) AS revoked) t
  WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_achievements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_achievements() TO questify_app;

-- As 0067, with a revoked tier never due: its gems are not paid while it is revoked, and are paid at the next sync
-- after a restore.
CREATE OR REPLACE FUNCTION gems_due(who uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM level_reached r WHERE r.player_id = who
                 AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.source_level = r.level))
    OR EXISTS (SELECT 1 FROM achievement_earned e WHERE e.player_id = who
               AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.achievement_id = e.achievement_id
                               AND g.tier = e.tier)
               AND NOT tier_revoked(who, e.achievement_id, e.tier))
    OR EXISTS (SELECT 1 FROM questify_award a JOIN questify_quest q ON q.id = a.quest_id
               WHERE a.player_id = who AND q.gems > 0
                 AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.questify_award_id = a.id))
$$;
REVOKE ALL ON FUNCTION gems_due(uuid) FROM PUBLIC;

-- As 0068, with one change: the gem due list skips a revoked tier (the same filter as gems_due).
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
 amount  record;
 earned  bigint;
 balance bigint;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) AND NOT EXISTS (SELECT 1 FROM questify_due(who))
    AND NOT gems_due(who) AND NOT streak_due(who) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb, 'quests', '[]'::jsonb, 'levelUp', NULL,
   'gems', jsonb_build_object('earned', 0, 'balance', (SELECT x.gems FROM player_xp x WHERE x.player_id = who)),
   'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', '[]'::jsonb) END);
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
 RETURN jsonb_build_object('achievements', tiers, 'quests', paid, 'levelUp', questify_level_up(who, entries),
  'gems', jsonb_build_object('earned', earned, 'balance', balance),
  'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', streaks) END);
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- The tiers of a request: 1 to 15 distinct {achievementId, tier} (PA400 otherwise). Internal.
CREATE FUNCTION tier_list(tiers jsonb) RETURNS TABLE (achievement_id text, tier text)
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(tiers) IS DISTINCT FROM 'array' OR jsonb_array_length(tiers) NOT BETWEEN 1 AND 15
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(tiers) AS x
                WHERE jsonb_typeof(x) IS DISTINCT FROM 'object' OR x - ARRAY['achievementId', 'tier'] <> '{}'::jsonb
                   OR jsonb_typeof(x -> 'achievementId') IS DISTINCT FROM 'string'
                   OR NOT coalesce(x ->> 'tier' IN ('bronze', 'silver', 'gold'), false))
     OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(tiers) AS x) <> jsonb_array_length(tiers) THEN
    RAISE EXCEPTION 'give 1 to 15 distinct tiers' USING ERRCODE = 'PA400';
  END IF;
  RETURN QUERY SELECT x ->> 'achievementId', x ->> 'tier' FROM jsonb_array_elements(tiers) AS x;
END $$;
REVOKE ALL ON FUNCTION tier_list(jsonb) FROM PUBLIC;

-- Revokes (`revoke`) or restores (`restore`) earned tiers of one player, with a reason and a note. Locks the player FOR
-- NO KEY UPDATE, then player_xp FOR UPDATE (the sync's order), so a sync of the player runs wholly before or after.
-- Outcomes, nothing written unless the first: changed; not_banned (a revoke needs a banned player; a restore does not);
-- not_earned (a tier the player never earned); already_revoked / not_revoked. PA404 for an unknown or erased player,
-- PA400 for a bad reason or tier list. Internal; the two doors below call it.
CREATE FUNCTION admin_tier_change(target uuid, tiers jsonb, kind text, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, action_id uuid)
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  clean  text := player_action_note(kind, reason_code, note);
  p      player := player_for_admin(target, true);
  revoking boolean := kind = 'revoke_tiers';
  action uuid;
BEGIN
  PERFORM tier_list(tiers);
  IF revoking AND p.status <> 'banned' THEN
    RETURN QUERY SELECT 'not_banned'::text, NULL::uuid;
    RETURN;
  END IF;
  PERFORM 1 FROM player_xp x WHERE x.player_id = p.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM tier_list(tiers) c
             WHERE NOT EXISTS (SELECT 1 FROM achievement_earned e WHERE e.player_id = p.id
                               AND e.achievement_id = c.achievement_id AND e.tier = c.tier)) THEN
    RETURN QUERY SELECT 'not_earned'::text, NULL::uuid;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM tier_list(tiers) c WHERE tier_revoked(p.id, c.achievement_id, c.tier) = revoking) THEN
    RETURN QUERY SELECT CASE WHEN revoking THEN 'already_revoked' ELSE 'not_revoked' END, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (p.id, me, kind, reason_code, clean) RETURNING id INTO action;
  INSERT INTO achievement_revocation (player_id, achievement_id, tier, change, action_id)
  SELECT p.id, c.achievement_id, c.tier, CASE WHEN revoking THEN 'revoke' ELSE 'restore' END, action
  FROM tier_list(tiers) c ORDER BY c.achievement_id, array_position(ARRAY['bronze', 'silver', 'gold'], c.tier);
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.' || kind, 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code,
                             'tiers', (SELECT jsonb_agg(jsonb_build_object('achievementId', c.achievement_id,
                                                                           'tier', c.tier)
                                                        ORDER BY c.achievement_id, c.tier)
                                       FROM tier_list(tiers) c)),
          request);
  RETURN QUERY SELECT 'changed'::text, action;
END $$;
REVOKE ALL ON FUNCTION admin_tier_change(uuid, jsonb, text, text, text, uuid) FROM PUBLIC;

CREATE FUNCTION admin_revoke_tiers(target uuid, tiers jsonb, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, action_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM admin_tier_change(target, tiers, 'revoke_tiers', reason_code, note, request)
$$;
REVOKE ALL ON FUNCTION admin_revoke_tiers(uuid, jsonb, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_revoke_tiers(uuid, jsonb, text, text, uuid) TO questify_app;

CREATE FUNCTION admin_restore_tiers(target uuid, tiers jsonb, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, action_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT * FROM admin_tier_change(target, tiers, 'restore_tiers', reason_code, note, request)
$$;
REVOKE ALL ON FUNCTION admin_restore_tiers(uuid, jsonb, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_restore_tiers(uuid, jsonb, text, text, uuid) TO questify_app;

-- A player's earned tiers for the console record, each with whether it is revoked now. Internal.
CREATE FUNCTION console_player_tiers(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.achievement_id,
                                               'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
                                               'tier', e.tier, 'revoked', tier_revoked(target, e.achievement_id, e.tier))
                            ORDER BY a.position, array_position(ARRAY['bronze', 'silver', 'gold'], e.tier)), '[]'::jsonb)
  FROM achievement_earned e JOIN achievement a ON a.id = e.achievement_id
  WHERE e.player_id = target
$$;
REVOKE ALL ON FUNCTION console_player_tiers(uuid) FROM PUBLIC;

-- As 0118, plus `achievements`: every earned tier and whether it is revoked.
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
        'level', coalesce((SELECT x.level FROM player_xp x WHERE x.player_id = p.id), 1),
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
