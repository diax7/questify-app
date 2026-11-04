-- FOLLOWUPS (T-804c review): complete_quest_answer says why the ranking entries were not read. 0149 (deployed) put the
-- SQLSTATE of a failed ranking read only into a PostgreSQL WARNING, so the API's own log said "entries_unread" and
-- nothing more. The function now returns it as a column, ranking_sqlstate (NULL when the entries were read), and the
-- API logs it next to the reason. The WARNING is gone: the API's log is where this is read.
--
-- Same function as 0149 with one more output column, so it is dropped and created again (a function's result type
-- cannot be replaced in place); the old column list stays, in the same order, with the new column last, so an API of
-- the previous release that reads columns by name keeps working through the deploy. The body is 0149's, with one
-- reworded comment: the two ranking reads are STABLE functions that take no lock, so a lock_timeout cannot be what
-- fails them; what they can raise is an unexpected data or function error. A statement_timeout is not caught by
-- WHEN OTHERS: it cancels the whole statement, nothing is written and the app's retry with the same key replays.
--
-- Deny by default: the new function is revoked from PUBLIC by name and granted to questify_app only, next to its
-- create (outsider suite). Catalog only: no table, trigger, policy or other grant changes.
SET LOCAL lock_timeout = '10s';

DROP FUNCTION complete_quest_answer(uuid, text, integer, text, text, uuid, jsonb);

CREATE FUNCTION complete_quest_answer(target uuid, proof_method text, proof_version integer, typed_code text,
                                      request_key text, device uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean, event_id uuid,
                 level_up smallint, level_title_ar text, level_title_en text, level_items jsonb,
                 bonus_category_id uuid, bonus_points bigint, bonus_name_ar text, bonus_name_en text,
                 bonus_item_ar text, bonus_item_en text, bonus_item_outcome text,
                 bonus_item_until timestamptz, bonus_item_time_zone text,
                 item_name_ar text, item_name_en text, item_outcome text, item_until timestamptz,
                 item_time_zone text,
                 boost_multiplier integer, first_bonus jsonb, streak_bonus jsonb,
                 rank_enrollment_id uuid, rank_score bigint, rank_score_version bigint, rank_ranked boolean,
                 day_day text, day_enrollment_id uuid, day_score bigint, day_score_version bigint,
                 day_ranked boolean, ranking_failed boolean, ranking_sqlstate text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;
REVOKE ALL ON FUNCTION complete_quest_answer(uuid, text, integer, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_quest_answer(uuid, text, integer, text, text, uuid, jsonb) TO questify_app;
