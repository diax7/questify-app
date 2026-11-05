-- T-804e (plan docs/plans/2026-11-05-t-804e-completion-profile.md, review 84; ADR-731 to ADR-733; Q-697 to Q-699):
-- the completion's database work, made cheaper without changing any answer, refusal, lock or grant.
--
-- 1. A fresh XP credit names its board month (ADR-731): xp_credit takes `questify_month(created_at)` from the row it
--    inserts (RETURNING), so xp_apply no longer reads that row back. xp_apply gains a defaulted `known_month`; when it
--    is NULL (xp_reverse and every other caller) the month is still looked up by xp_month_of, as before.
-- 2. One ranking eligibility check a completion (ADR-732): complete_quest_answer hands the overall entry's `ranked` to
--    the new internal ranking_day_entry_for, which keeps ranking_day_entry_of's player filter. With no overall entry
--    it is not called, so the day entry is empty, as ranking_day_entry_of's would be. ranking_day_entry_of stays for
--    the API's other reads.
-- 3. The flag trigger's tuning (ADR-733): flag_tuning reads the `tuning` setting row once instead of twice.
-- 4. The enrollment's BEFORE UPDATE row triggers (ADR-733 part E) fire only when what they act on changed: the status
--    guard when the status changed, the waiting-list clear when the status or `waitlisted` changed. A score write
--    changes neither. The waiting-list clear is idempotent on a row that already holds its rule, which every write so
--    far made true; the assertion at the end proves it on the deployed rows before this commits.
--
-- Rollback: apps/api/db/rollback/0158_completion_profile.sql restores the 0157 bodies and triggers (the equivalence test
-- runs it). Deny by default: the new and the re-created functions are revoked from PUBLIC; none is granted.
SET LOCAL lock_timeout = '10s';

-- ================================================================ 1. the XP credit's month
DROP FUNCTION xp_apply(uuid, bigint, integer);

-- The one writer of player_xp's total and of xp_board (ADR-308). `known_month` is the entry's board month when the
-- caller has it; NULL looks it up.
CREATE FUNCTION xp_apply(who uuid, made bigint, delta integer, known_month text DEFAULT NULL)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
  month text := coalesce(known_month, xp_month_of(made));
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
END $$;
REVOKE ALL ON FUNCTION xp_apply(uuid, bigint, integer, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION xp_credit(entry ledger_entry)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who    uuid;
  amount integer := quest_xp();
  made   bigint;
  month  text;
BEGIN
  SELECT n.player_id INTO STRICT who FROM enrollment n WHERE n.id = entry.enrollment_id;
  INSERT INTO xp_entry (player_id, delta, source, ledger_entry_id, quest_id)
  VALUES (who, amount, 'quest', entry.id, entry.quest_id)
  ON CONFLICT DO NOTHING
  RETURNING id, questify_month(created_at) INTO made, month;
  IF made IS NOT NULL THEN
    PERFORM xp_apply(who, made, amount, month);
  END IF;
END $$;
REVOKE ALL ON FUNCTION xp_credit(ledger_entry) FROM PUBLIC;

-- ================================================================ 2. one ranking eligibility check a completion
-- ranking_day_entry_of's answer, with the enrollment's eligibility given by the caller (complete_quest_answer, which
-- has just read it from ranking_entry_of on the same row). Internal: only definers call it.
CREATE FUNCTION ranking_day_entry_for(completion bigint, eligible boolean)
  RETURNS TABLE (event_id uuid, day date, enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH mine AS (
    SELECT e, ev, event_day(c.created_at, ev) AS day
    FROM quest_completion c
    JOIN enrollment e ON e.id = c.enrollment_id
    JOIN event ev ON ev.id = e.event_id
    WHERE c.id = completion AND e.player_id = app_player_id() AND event_multi_day(ev)
  )
  SELECT (m.e).event_id, m.day, (m.e).id, t.score, t.version, eligible AND t.score > 0
  FROM mine m,
  LATERAL (SELECT coalesce(sum(l.score_delta), 0)::bigint AS score, max(l.id) AS version
           FROM ledger_entry l
           WHERE l.enrollment_id = (m.e).id AND l.score_delta <> 0
             AND l.created_at >= event_day_start(m.ev, m.day)
             AND l.created_at < event_day_start(m.ev, m.day + 1)) t
  WHERE t.version IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION ranking_day_entry_for(bigint, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION complete_quest_answer(target uuid, proof_method text, proof_version integer,
                                                 typed_code text, request_key text, device uuid,
                                                 reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean, event_id uuid, level_up smallint, level_title_ar text, level_title_en text,
                 level_items jsonb, bonus_category_id uuid, bonus_points bigint, bonus_name_ar text,
                 bonus_name_en text, bonus_item_ar text, bonus_item_en text, bonus_item_outcome text,
                 bonus_item_until timestamptz, bonus_item_time_zone text, item_name_ar text, item_name_en text,
                 item_outcome text, item_until timestamptz, item_time_zone text, boost_multiplier integer,
                 first_bonus jsonb, streak_bonus jsonb, rank_enrollment_id uuid, rank_score bigint,
                 rank_score_version bigint, rank_ranked boolean, day_day text, day_enrollment_id uuid,
                 day_score bigint, day_score_version bigint, day_ranked boolean, ranking_failed boolean,
                 ranking_sqlstate text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
  -- and answers rank null. The day entry reuses the overall entry's eligibility (one ranking_eligible a completion,
  -- ADR-732); with no overall entry there is no day entry either.
  BEGIN
    SELECT r.enrollment_id, r.score, r.score_version, r.ranked
      INTO rank_enrollment_id, rank_score, rank_score_version, rank_ranked
    FROM ranking_entry_of(done.completion_id) r LIMIT 1;
    IF rank_enrollment_id IS NOT NULL THEN
      SELECT d.day::text, d.enrollment_id, d.score, d.score_version, d.ranked
        INTO day_day, day_enrollment_id, day_score, day_score_version, day_ranked
      FROM ranking_day_entry_for(done.completion_id, rank_ranked) d LIMIT 1;
    END IF;
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
END $$;

-- ================================================================ 3. the flag tuning, one read
CREATE OR REPLACE FUNCTION flag_tuning(OUT burst_count integer, OUT burst_window interval)
  RETURNS record LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  stored jsonb;
  minutes integer;
BEGIN
  -- platform_tuning_int's rule, on one read of the row: a stored whole number in range, else the shipped one.
  SELECT s.value INTO stored FROM platform_setting s WHERE s.key = 'tuning';
  -- Nested as platform_tuning_int's is, so the cast runs only on a value the pattern accepted.
  burst_count := coalesce(
    CASE WHEN jsonb_typeof(stored -> 'flagBurstCount') = 'number' AND (stored ->> 'flagBurstCount') ~ '^[0-9]{1,9}$'
         THEN CASE WHEN (stored ->> 'flagBurstCount')::integer BETWEEN 3 AND 100
                   THEN (stored ->> 'flagBurstCount')::integer END
    END, 10);
  minutes := coalesce(
    CASE WHEN jsonb_typeof(stored -> 'flagBurstMinutes') = 'number' AND (stored ->> 'flagBurstMinutes') ~ '^[0-9]{1,9}$'
         THEN CASE WHEN (stored ->> 'flagBurstMinutes')::integer BETWEEN 1 AND 60
                   THEN (stored ->> 'flagBurstMinutes')::integer END
    END, 5);
  burst_window := minutes * interval '1 minute';
END $$;

-- ================================================================ 4. the enrollment's row triggers
-- Each condition must name every column its function reads from OLD or NEW to decide (ADR-733): the guard reads the
-- status only, the clear `waitlisted` and the status. A body that starts reading another column widens its WHEN.
DROP TRIGGER enrollment_status_guard ON enrollment;
CREATE TRIGGER enrollment_status_guard BEFORE UPDATE ON enrollment
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION enrollment_status_guard();

DROP TRIGGER enrollment_waitlist_clear ON enrollment;
CREATE TRIGGER enrollment_waitlist_clear BEFORE UPDATE ON enrollment
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.waitlisted IS DISTINCT FROM NEW.waitlisted)
  EXECUTE FUNCTION enrollment_waitlist_clear();
CREATE TRIGGER enrollment_waitlist_clear_insert BEFORE INSERT ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_waitlist_clear();

-- After the DROP TRIGGER above (an ACCESS EXCLUSIVE lock held to COMMIT), no write can slip between this check and
-- the commit: a row on the waiting list outside 'pending' would no longer be cleared by a score write.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM enrollment WHERE waitlisted AND status <> 'pending') THEN
    RAISE EXCEPTION 'an enrollment is waitlisted outside pending'
      USING ERRCODE = 'check_violation',
            HINT = 'UPDATE enrollment SET waitlisted = false WHERE waitlisted AND status <> ''pending'', then migrate again.';
  END IF;
END $$;
