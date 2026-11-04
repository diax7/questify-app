-- T-804c: one statement answers a completion and one call checks a player (ADR-671, ADR-672; plan
-- docs/plans/2026-11-04-t-804a-completion-hot-path.md sections 0 and 2 B, C; ADR-680). Before, a QR completion made 20
-- PostgreSQL round trips: two for the player guard, ten for the engine's transaction (complete_quest, then one call per
-- part of the answer), eight for the ranking's two transactions. After, five: the gate, then BEGIN, set_config, this
-- door and COMMIT.
--
-- complete_quest_answer calls complete_quest and then, for the completion it returned, each existing part function
-- (own_level and own_level_items on a level-up, own_bonus, own_quest_item, completion_boost, own_first_bonus,
-- own_streak_bonus, ranking_entry_of, ranking_day_entry_of): every part is that function's own answer, read in the
-- transaction that wrote the completion, so nothing is copied and each keeps its own "only the caller's completion"
-- check. complete_quest's refusals (QC404, QC403, QP403, QN403, QD409, QV422, QK422) pass through unchanged. The two
-- ranking reads run in their own BEGIN ... EXCEPTION block: an error there (a lock_timeout among them) returns NULL
-- entries and ranking_failed, never rolls the completion back; the API then logs, marks the event for repair and
-- answers rank null, as it did when its own ranking transaction failed. (A statement_timeout cancels the whole
-- statement, as before: nothing is written and the app's retry with the same key replays.) The part doors stay: other
-- routes (NFC tap, games, kiosk, operator scan) and an API of the previous release call them.
--
-- player_request_gate answers the player guard in one call: player_session_owner(hash) and, for a write by that player,
-- player_legal_held(owner). It calls both, so the session and hold rules stay in one place each.
--
-- Deny by default: both functions are revoked from PUBLIC by name and granted to questify_app only, next to each
-- create (outsider suite). Catalog only: two new functions, no table, trigger, policy or grant change elsewhere; the
-- running API works before and after.
SET LOCAL lock_timeout = '10s';

-- ================================================================ one statement answers a completion (ADR-671)
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
                 day_ranked boolean, ranking_failed boolean)
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
    RAISE WARNING 'complete_quest_answer: ranking entries not read (SQLSTATE %)', SQLSTATE;
  END;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION complete_quest_answer(uuid, text, integer, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_quest_answer(uuid, text, integer, text, text, uuid, jsonb) TO questify_app;

-- ================================================================ one player check (ADR-672)
-- The live session's player (NULL for an unknown, expired, revoked or reset token, or a player who is not active), and
-- for a write whether that player is held by a new terms or privacy version (ADR-446).
CREATE FUNCTION player_request_gate(hash bytea, is_write boolean)
  RETURNS TABLE (player_id uuid, held boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  player_id := player_session_owner(hash);
  held := player_id IS NOT NULL AND is_write IS TRUE AND player_legal_held(player_id) IS TRUE;
  RETURN NEXT;
END $$;
REVOKE ALL ON FUNCTION player_request_gate(bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_request_gate(bytea, boolean) TO questify_app;
