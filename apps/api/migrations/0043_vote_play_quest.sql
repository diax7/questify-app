-- vote_quest finds its quest through play_quest (migration 0042), as submit_survey and share_quest do (T-303 code review).
-- Same refusals as 0041: QK422 for a missing key first, then QC404 and QT422 (DETAIL 'vote') from play_quest. Grants are
-- kept by CREATE OR REPLACE (PUBLIC revoked, questify_app granted in 0041).
CREATE OR REPLACE FUNCTION vote_quest(target uuid, option text, request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  quest_row quest%ROWTYPE;
  paid      record;
  earlier   text;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  quest_row := play_quest(target, 'vote');
  IF option IS NULL OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(quest_row.type_config -> 'options') o WHERE o ->> 'id' = option) THEN
    RAISE EXCEPTION 'no such option' USING ERRCODE = 'VO422';
  END IF;
  SELECT * INTO paid FROM record_completion(target, me, 'vote', NULL, NULL, request_key, NULL, NULL, NULL, NULL,
                                            quest_row.event_id) r;
  IF paid.replayed THEN
    SELECT v.option_id INTO earlier FROM quest_vote v WHERE v.completion_id = paid.completion_id;
    IF earlier IS DISTINCT FROM option THEN
      RAISE EXCEPTION 'this key was used for another vote' USING ERRCODE = 'QK422';
    END IF;
  ELSE
    INSERT INTO quest_vote (organizer_id, event_id, enrollment_id, quest_id, option_id, completion_id)
    SELECT n.organizer_id, n.event_id, n.id, target, option, paid.completion_id
    FROM enrollment n WHERE n.event_id = quest_row.event_id AND n.player_id = me;
  END IF;
  RETURN QUERY SELECT paid.completion_id, paid.points, paid.occurrence, paid.score, paid.balance, paid.replayed;
END $$;
REVOKE ALL ON FUNCTION vote_quest(uuid, text, text) FROM PUBLIC;
