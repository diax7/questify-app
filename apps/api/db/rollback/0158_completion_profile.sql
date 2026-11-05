-- Rollback of migration 0158 (T-804e): puts back the bodies and triggers migration 0157 left, taken from
-- pg_get_functiondef on a database migrated to 0157. Run it as the migration owner in one transaction, then delete the
-- `0158_completion_profile.sql` row from schema_migration (and the file from the image) so a later deploy does not
-- re-apply it. test/db/completion-profile.int.test.ts runs this file to compare the two versions.
SET LOCAL lock_timeout = '10s';

DROP FUNCTION ranking_day_entry_for(bigint, boolean);
DROP FUNCTION xp_apply(uuid, bigint, integer, text);

CREATE FUNCTION public.xp_apply(who uuid, made bigint, delta integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  IF is_review_demo_player(who) THEN
    RETURN;
  END IF;
  FOREACH target IN ARRAY ARRAY['all', month] LOOP
    UPDATE xp_board b SET xp = b.xp + delta, xp_version = greatest(b.xp_version, made)
    WHERE b.board = target AND b.player_id = who;
    IF NOT FOUND THEN
      INSERT INTO xp_board (board, player_id, xp, xp_version) VALUES (target, who, delta, made);
    END IF;
  END LOOP;
END $function$;
REVOKE ALL ON FUNCTION xp_apply(uuid, bigint, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.xp_credit(entry ledger_entry)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  who    uuid;
  amount integer := quest_xp();
  made   bigint;
BEGIN
  SELECT n.player_id INTO STRICT who FROM enrollment n WHERE n.id = entry.enrollment_id;
  INSERT INTO xp_entry (player_id, delta, source, ledger_entry_id, quest_id)
  VALUES (who, amount, 'quest', entry.id, entry.quest_id)
  ON CONFLICT DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    PERFORM xp_apply(who, made, amount);
  END IF;
END $function$;
CREATE OR REPLACE FUNCTION public.complete_quest_answer(target uuid, proof_method text, proof_version integer, typed_code text, request_key text, device uuid, reading jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean, event_id uuid, level_up smallint, level_title_ar text, level_title_en text, level_items jsonb, bonus_category_id uuid, bonus_points bigint, bonus_name_ar text, bonus_name_en text, bonus_item_ar text, bonus_item_en text, bonus_item_outcome text, bonus_item_until timestamp with time zone, bonus_item_time_zone text, item_name_ar text, item_name_en text, item_outcome text, item_until timestamp with time zone, item_time_zone text, boost_multiplier integer, first_bonus jsonb, streak_bonus jsonb, rank_enrollment_id uuid, rank_score bigint, rank_score_version bigint, rank_ranked boolean, day_day text, day_enrollment_id uuid, day_score bigint, day_score_version bigint, day_ranked boolean, ranking_failed boolean, ranking_sqlstate text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  done record;
BEGIN
  SELECT * INTO STRICT done
  FROM complete_quest(target, proof_method, proof_version, typed_code, request_key, device, reading);
  completion_id := done.completion_id;
  points := done.points;
  occurrence := done.occurrence;
  score := done.score;
  balance := done.balance;
  replayed := done.replayed;
  SELECT c.event_id INTO event_id FROM quest_completion c WHERE c.id = done.completion_id;

  SELECT o.level_up, o.up_title_ar, o.up_title_en INTO level_up, level_title_ar, level_title_en
  FROM own_level(done.completion_id) o LIMIT 1;
  IF level_up IS NOT NULL THEN
    level_items := own_level_items(done.completion_id);
  END IF;
  SELECT b.category_id, b.points, b.name_ar, b.name_en, b.item_ar, b.item_en, b.item_outcome, b.item_until,
         b.item_time_zone
    INTO bonus_category_id, bonus_points, bonus_name_ar, bonus_name_en, bonus_item_ar, bonus_item_en,
         bonus_item_outcome, bonus_item_until, bonus_item_time_zone
  FROM own_bonus(done.completion_id) b LIMIT 1;
  SELECT i.name_ar, i.name_en, i.outcome, i.until, i.time_zone
    INTO item_name_ar, item_name_en, item_outcome, item_until, item_time_zone
  FROM own_quest_item(done.completion_id) i LIMIT 1;
  boost_multiplier := completion_boost(done.completion_id);
  first_bonus := (SELECT to_jsonb(f) FROM own_first_bonus(done.completion_id) f LIMIT 1);
  streak_bonus := (SELECT to_jsonb(s) FROM own_streak_bonus(done.completion_id) s LIMIT 1);

  -- The two ranking reads run in their own BEGIN ... EXCEPTION block: an error there returns NULL entries,
  -- ranking_failed and its SQLSTATE, and never rolls the completion back. The API logs it, marks the event for repair
  -- and answers rank null.
  BEGIN
    SELECT r.enrollment_id, r.score, r.score_version, r.ranked
      INTO rank_enrollment_id, rank_score, rank_score_version, rank_ranked
    FROM ranking_entry_of(done.completion_id) r LIMIT 1;
    SELECT d.day::text, d.enrollment_id, d.score, d.score_version, d.ranked
      INTO day_day, day_enrollment_id, day_score, day_score_version, day_ranked
    FROM ranking_day_entry_of(done.completion_id) d LIMIT 1;
    ranking_failed := false;
  EXCEPTION WHEN OTHERS THEN
    -- Variables keep what was assigned before the error, so every entry is cleared here.
    rank_enrollment_id := NULL;
    rank_score := NULL;
    rank_score_version := NULL;
    rank_ranked := NULL;
    day_day := NULL;
    day_enrollment_id := NULL;
    day_score := NULL;
    day_score_version := NULL;
    day_ranked := NULL;
    ranking_failed := true;
    ranking_sqlstate := SQLSTATE;
  END;
  RETURN NEXT;
END $function$;
CREATE OR REPLACE FUNCTION public.flag_tuning(OUT burst_count integer, OUT burst_window interval)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  SELECT platform_tuning_int('flagBurstCount', 10, 3, 100),
         platform_tuning_int('flagBurstMinutes', 5, 1, 60) * interval '1 minute'
  INTO burst_count, burst_window;
END
$function$;

DROP TRIGGER enrollment_status_guard ON enrollment;
CREATE TRIGGER enrollment_status_guard BEFORE UPDATE ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_status_guard();
DROP TRIGGER enrollment_waitlist_clear ON enrollment;
DROP TRIGGER enrollment_waitlist_clear_insert ON enrollment;
CREATE TRIGGER enrollment_waitlist_clear BEFORE INSERT OR UPDATE ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_waitlist_clear();
