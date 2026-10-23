-- Challenge, survey and share quests (T-303, ADR-196 to ADR-199; plan docs/plans/2026-10-24-t-303-challenge-survey-share.md).
-- A challenge is completed only by staff: an operator's station scan of the player's My QR, or a manual award. A survey
-- pays on its answers, which reach the event's team with names not shown. A share quest pays when the player completes
-- the phone's share sheet, once. Every payment goes through record_completion. Deny by default: the new table has no
-- grant; the definers below are its only doors. Lock order: the enrollment FOR NO KEY UPDATE (record_completion).

-- ================================================================ the types
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known
  CHECK (type IN ('scan_qr', 'enter_code', 'submission', 'vote', 'quiz', 'challenge', 'survey', 'share'));
-- One vote, attempt, response and share per player (ADR-191, ADR-198, ADR-199).
ALTER TABLE quest DROP CONSTRAINT quest_vote_quiz_once;
ALTER TABLE quest ADD CONSTRAINT quest_played_once
  CHECK (type NOT IN ('vote', 'quiz', 'survey', 'share') OR repeat_cap = 1);
ALTER TABLE quest ADD CONSTRAINT quest_survey_shape CHECK (
  type <> 'survey' OR CASE WHEN jsonb_typeof(type_config -> 'questions') = 'array'
                           THEN jsonb_array_length(type_config -> 'questions') BETWEEN 1 AND 20 ELSE false END);
-- The link, when present, is https (ADR-199); the API checks its length and the rest of the shape.
ALTER TABLE quest ADD CONSTRAINT quest_share_shape CHECK (
  type <> 'share' OR (coalesce(jsonb_typeof(type_config -> 'message') = 'object', false)
                      AND (type_config -> 'link' IS NULL OR coalesce(type_config ->> 'link' LIKE 'https://%', false))));

-- A challenge's one method is staff scanning the player's My QR (ADR-197); the player has no quest QR to scan.
ALTER TABLE quest DROP CONSTRAINT quest_verification_known;
ALTER TABLE quest ADD CONSTRAINT quest_verification_known CHECK (
  verification <@ ARRAY['quest_qr', 'my_qr']
  AND (type <> 'scan_qr' OR cardinality(verification) >= 1)
  AND (type <> 'challenge' OR verification = ARRAY['my_qr'])
  AND (type IN ('scan_qr', 'challenge') OR cardinality(verification) = 0));

CREATE OR REPLACE FUNCTION quest_verification_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification IS NULL THEN
    NEW.verification := CASE NEW.type WHEN 'scan_qr' THEN ARRAY['quest_qr']
                                      WHEN 'challenge' THEN ARRAY['my_qr']
                                      ELSE ARRAY[]::text[] END;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share'));

-- ================================================================ the table
CREATE TABLE survey_response (
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  quest_id      uuid NOT NULL,
  -- {questionId: choice id | rating | text}, the answered questions only. Personal data: deleted with the account.
  answers       jsonb NOT NULL CHECK (jsonb_typeof(answers) = 'object'),
  completion_id bigint NOT NULL UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, quest_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX survey_response_quest_idx ON survey_response (quest_id, created_at DESC);
ALTER TABLE survey_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE survey_response FORCE ROW LEVEL SECURITY;
REVOKE ALL ON survey_response FROM PUBLIC;

-- ================================================================ locks on a played quest (ADR-194, ADR-198)
-- As 0041, with a survey's structure: its question ids, order, kinds, required marks and choice ids.
CREATE OR REPLACE FUNCTION quest_structure(kind text, config jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE kind
    WHEN 'vote' THEN (SELECT jsonb_agg(o -> 'id' ORDER BY i) FROM jsonb_array_elements(config -> 'options')
                        WITH ORDINALITY AS t(o, i))
    WHEN 'quiz' THEN jsonb_build_object(
      'timer', config -> 'timerSeconds',
      'questions', (SELECT jsonb_agg(jsonb_build_object(
                       'id', q -> 'id', 'right', q -> 'right',
                       'choices', (SELECT jsonb_agg(c -> 'id' ORDER BY j)
                                   FROM jsonb_array_elements(q -> 'choices') WITH ORDINALITY AS u(c, j)))
                     ORDER BY i)
                    FROM jsonb_array_elements(config -> 'questions') WITH ORDINALITY AS t(q, i)))
    WHEN 'survey' THEN (SELECT jsonb_agg(jsonb_build_object(
                          'id', q -> 'id', 'kind', q -> 'kind', 'required', q -> 'required',
                          'choices', (SELECT jsonb_agg(c -> 'id' ORDER BY j)
                                      FROM jsonb_array_elements(
                                        CASE WHEN jsonb_typeof(q -> 'choices') = 'array' THEN q -> 'choices'
                                             ELSE '[]'::jsonb END) WITH ORDINALITY AS u(c, j)))
                        ORDER BY i)
                        FROM jsonb_array_elements(config -> 'questions') WITH ORDINALITY AS t(q, i))
  END
$$;

CREATE OR REPLACE FUNCTION quest_lock_played() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF quest_structure(OLD.type, OLD.type_config) IS DISTINCT FROM quest_structure(NEW.type, NEW.type_config)
     AND (EXISTS (SELECT 1 FROM quest_vote v WHERE v.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM quiz_attempt a WHERE a.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM survey_response r WHERE r.quest_id = OLD.id)) THEN
    RAISE EXCEPTION 'players have answered this quest: only its text may change' USING ERRCODE = 'QL409';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER quest_lock_played ON quest;
CREATE TRIGGER quest_lock_played BEFORE UPDATE OF type, type_config ON quest
  FOR EACH ROW WHEN (OLD.type IN ('vote', 'quiz', 'survey')) EXECUTE FUNCTION quest_lock_played();

-- ================================================================ the completion engine knows the three types
-- As 0041, with a challenge paid only through My QR (the station) or by hand, and a survey's and a share's own proofs.
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row     quest%ROWTYPE;
  enrolled      enrollment%ROWTYPE;
  earlier       quest_completion%ROWTYPE;
  earlier_by    uuid;
  earlier_staff uuid;
  done_count    integer;
  made          bigint;
  entry         bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' THEN
    RAISE EXCEPTION 'this key is reserved' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.event_id IS DISTINCT FROM expected_event THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment WHERE event_id = quest_row.event_id AND player_id = who FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;

  SELECT * INTO earlier FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.idempotency_key = request_key;
  IF FOUND THEN
    SELECT l.operator_id, l.staff_user_id INTO earlier_by, earlier_staff
    FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    IF earlier.quest_id <> target OR earlier.method <> proof_method OR earlier_by IS DISTINCT FROM operator
       OR earlier_staff IS DISTINCT FROM staff THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, l.score_delta, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled);
  -- A quiz in play pays itself at its end; a manual award now would pay the quest twice (T-302).
  IF proof_method = 'manual' AND quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target AND a.status = 'open') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr' AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'enter_code' AND proof_method = 'code')
            OR (quest_row.type = 'vote' AND proof_method = 'vote')
            OR (quest_row.type = 'survey' AND proof_method = 'survey')
            OR (quest_row.type = 'share' AND proof_method = 'share')) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
    END IF;
    IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
    END IF;
    IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
    END IF;
  END IF;

  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, done_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff)
  RETURNING id INTO entry;
  IF proof_method = 'manual' THEN
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason)
    VALUES (entry, enrolled.organizer_id, enrolled.event_id, clean_reason(reason));
  END IF;

  RETURN QUERY SELECT made, quest_row.points::bigint, done_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- ================================================================ entering a play by quest id (internal)
-- The quest a player names, if they are an active member of its event with an active account (QC404 otherwise, the
-- same for a quest that does not exist), and of the wanted type (QT422, DETAIL the type).
CREATE FUNCTION play_quest(target uuid, wanted text) RETURNS quest
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  quest_row quest%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE n.event_id = quest_row.event_id AND n.player_id = me) THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.type <> wanted THEN
    RAISE EXCEPTION 'not this kind of quest' USING ERRCODE = 'QT422', DETAIL = wanted;
  END IF;
  RETURN quest_row;
END $$;
REVOKE ALL ON FUNCTION play_quest(uuid, text) FROM PUBLIC;

-- ================================================================ surveys (FR-214, ADR-198)
-- One answer checked against its question (SA422, DETAIL the question id; the answer itself is never in the error).
-- Returns the answer as stored, or NULL when it counts as unanswered: missing, null, or blank text.
CREATE FUNCTION survey_answer(question jsonb, given jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  id      text := question ->> 'id';
  kind    text := question ->> 'kind';
  cleaned text;
BEGIN
  IF given IS NULL OR jsonb_typeof(given) = 'null' THEN
    RETURN NULL;
  END IF;
  IF kind = 'choice' THEN
    IF jsonb_typeof(given) = 'string' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(question -> 'choices') c WHERE c ->> 'id' = given #>> '{}') THEN
      RETURN given;
    END IF;
  ELSIF kind = 'rating' THEN
    IF jsonb_typeof(given) = 'number' AND (given #>> '{}')::numeric IN (1, 2, 3, 4, 5) THEN
      RETURN to_jsonb((given #>> '{}')::numeric::integer);
    END IF;
  ELSIF kind = 'text' AND jsonb_typeof(given) = 'string' THEN
    BEGIN
      cleaned := clean_submission_text(given #>> '{}');
    EXCEPTION WHEN SQLSTATE 'SV422' THEN
      -- Blank is unanswered; anything else clean_submission_text refused is a bad answer.
      IF btrim(normalize(replace(given #>> '{}', E'\r\n', E'\n'), NFC), E' \n\t') = '' THEN
        RETURN NULL;
      END IF;
      cleaned := NULL;
    END;
    IF cleaned IS NOT NULL AND char_length(cleaned) <= 500 THEN
      RETURN to_jsonb(cleaned);
    END IF;
  END IF;
  RAISE EXCEPTION 'this answer is not one the question takes' USING ERRCODE = 'SA422', DETAIL = id;
END $$;
REVOKE ALL ON FUNCTION survey_answer(jsonb, jsonb) FROM PUBLIC;

-- Every answer of a response checked against the survey's config: an object naming only its questions (SA422 `shape`
-- otherwise), each answer valid, each required question answered (SA422, DETAIL its id; a question is required unless
-- its `required` is false). The answered ones, cleaned.
CREATE FUNCTION survey_answers(config jsonb, given jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  question jsonb;
  answer   jsonb;
  kept     jsonb := '{}'::jsonb;
BEGIN
  IF given IS NULL OR jsonb_typeof(given) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(given) k
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(config -> 'questions') q WHERE q ->> 'id' = k)) THEN
    RAISE EXCEPTION 'answers must name the survey''s questions' USING ERRCODE = 'SA422', DETAIL = 'shape';
  END IF;
  FOR question IN SELECT q FROM jsonb_array_elements(config -> 'questions') q LOOP
    answer := survey_answer(question, given -> (question ->> 'id'));
    IF answer IS NOT NULL THEN
      kept := kept || jsonb_build_object(question ->> 'id', answer);
    ELSIF question -> 'required' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'a required question has no answer' USING ERRCODE = 'SA422', DETAIL = question ->> 'id';
    END IF;
  END LOOP;
  RETURN kept;
END $$;
REVOKE ALL ON FUNCTION survey_answers(jsonb, jsonb) FROM PUBLIC;

-- The player answers a survey: one response, paid as an ordinary completion with method 'survey'. A replayed key
-- answers the first result when the answers are the same; other answers under that key are QK422 (as vote_quest).
CREATE FUNCTION submit_survey(target uuid, answers jsonb, request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  quest_row quest%ROWTYPE;
  kept      jsonb;
  paid      record;
  earlier   jsonb;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  quest_row := play_quest(target, 'survey');
  kept := survey_answers(quest_row.type_config, answers);
  SELECT * INTO paid FROM record_completion(target, me, 'survey', NULL, NULL, request_key, NULL, NULL, NULL, NULL,
                                            quest_row.event_id) r;
  IF paid.replayed THEN
    SELECT s.answers INTO earlier FROM survey_response s WHERE s.completion_id = paid.completion_id;
    IF earlier IS DISTINCT FROM kept THEN
      RAISE EXCEPTION 'this key was used for other answers' USING ERRCODE = 'QK422';
    END IF;
  ELSE
    INSERT INTO survey_response (organizer_id, event_id, enrollment_id, quest_id, answers, completion_id)
    SELECT n.organizer_id, n.event_id, n.id, target, kept, paid.completion_id
    FROM enrollment n WHERE n.event_id = quest_row.event_id AND n.player_id = me;
  END IF;
  RETURN QUERY SELECT paid.completion_id, paid.points, paid.occurrence, paid.score, paid.balance, paid.replayed;
END $$;
REVOKE ALL ON FUNCTION submit_survey(uuid, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_survey(uuid, jsonb, text) TO questify_app;

-- A survey quest the caller may play (an active member, the quest visible and in their audience): its questions and
-- whether they answered. NULL otherwise. Never anyone's answers.
CREATE FUNCTION member_survey(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'questions', q.type_config -> 'questions',
           'answered', EXISTS (SELECT 1 FROM survey_response r WHERE r.enrollment_id = n.id AND r.quest_id = q.id))
  FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type = 'survey' AND q.visible
    AND in_audience(n.id, c.audience_kind, c.audience_field_id, c.audience_values)
$$;
REVOKE ALL ON FUNCTION member_survey(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_survey(uuid) TO questify_app;

-- A survey's results for the event's owners and editors (AN404 otherwise; operators and players never): the total of
-- responses, and per question the full choice counts, the rating count and average, and the newest 50 text answers.
-- Names not shown (ADR-198): nothing here says who answered.
CREATE FUNCTION survey_summary(target_event uuid, target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  config jsonb;
BEGIN
  SELECT q.type_config INTO config FROM quest q WHERE q.id = target AND q.event_id = ev.id AND q.type = 'survey';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such survey quest in this event' USING ERRCODE = 'AN404';
  END IF;
  RETURN jsonb_build_object(
    'total', (SELECT count(*) FROM survey_response r WHERE r.quest_id = target),
    'questions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', q ->> 'id', 'kind', q ->> 'kind', 'text', q -> 'text',
               'answered', (SELECT count(*) FROM survey_response r WHERE r.quest_id = target AND r.answers ? (q ->> 'id')),
               'choices', CASE WHEN q ->> 'kind' = 'choice' THEN (
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', c ->> 'id', 'text', c -> 'text',
                          'count', (SELECT count(*) FROM survey_response r
                                    WHERE r.quest_id = target AND r.answers ->> (q ->> 'id') = c ->> 'id'))
                        ORDER BY j)
                 FROM jsonb_array_elements(q -> 'choices') WITH ORDINALITY AS u(c, j)) END,
               'average', CASE WHEN q ->> 'kind' = 'rating' THEN (
                 SELECT round(avg((r.answers ->> (q ->> 'id'))::numeric), 2) FROM survey_response r
                 WHERE r.quest_id = target AND r.answers ? (q ->> 'id')) END,
               'texts', CASE WHEN q ->> 'kind' = 'text' THEN coalesce((
                 SELECT jsonb_agg(newest.body ORDER BY newest.at DESC)
                 FROM (SELECT r.answers ->> (q ->> 'id') AS body, r.created_at AS at FROM survey_response r
                       WHERE r.quest_id = target AND r.answers ? (q ->> 'id')
                       ORDER BY r.created_at DESC, r.enrollment_id LIMIT 50) newest), '[]'::jsonb) END)
             ORDER BY i)
      FROM jsonb_array_elements(config -> 'questions') WITH ORDINALITY AS t(q, i)), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION survey_summary(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION survey_summary(uuid, uuid) TO questify_app;

-- ================================================================ share quests (FR-219, FR-220, ADR-034, ADR-199)
-- The event's own switch (`config.features.shareQuests`). The platform's switch is composed by the API (T-007).
CREATE FUNCTION share_quests_on(target_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT e.config -> 'features' -> 'shareQuests' <> 'false'::jsonb FROM event e WHERE e.id = target_event),
                  true)
$$;
REVOKE ALL ON FUNCTION share_quests_on(uuid) FROM PUBLIC;

-- The player completed the phone's share sheet: paid once as an ordinary completion with method 'share' (QF403 while
-- the event's switch is off). A replayed key answers the first result.
CREATE FUNCTION share_quest(target uuid, request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  quest_row := play_quest(target, 'share');
  IF NOT share_quests_on(quest_row.event_id) THEN
    RAISE EXCEPTION 'share quests are off for this event' USING ERRCODE = 'QF403';
  END IF;
  RETURN QUERY SELECT * FROM record_completion(target, app_player_id(), 'share', NULL, NULL, request_key, NULL, NULL,
                                               NULL, NULL, quest_row.event_id);
END $$;
REVOKE ALL ON FUNCTION share_quest(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION share_quest(uuid, text) TO questify_app;

-- A share quest the caller may play: its event (for the API's composed switch), the organizer's message and link, and
-- whether they shared it. No row otherwise, or while the event's switch is off.
CREATE FUNCTION member_share(target uuid)
  RETURNS TABLE (event_id uuid, message_ar text, message_en text, link text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.event_id, q.type_config -> 'message' ->> 'ar', q.type_config -> 'message' ->> 'en', q.type_config ->> 'link',
         EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = n.id AND qc.quest_id = q.id)
  FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type = 'share' AND q.visible AND share_quests_on(q.event_id)
    AND in_audience(n.id, c.audience_kind, c.audience_field_id, c.audience_values)
$$;
REVOKE ALL ON FUNCTION member_share(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_share(uuid) TO questify_app;

-- ================================================================ the station lists challenges (ADR-197)
-- As 0026, with challenge quests beside scan quests that take My QR, and each one's type. The output changed: DROP and
-- CREATE, with the REVOKE and GRANT repeated.
DROP FUNCTION operator_stations(uuid);
CREATE FUNCTION operator_stations(target_event uuid)
  RETURNS TABLE (quest_id uuid, title_ar text, title_en text, points integer, visible boolean, done_today bigint,
                 done_total bigint, type text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
  ev event;
  day_offset interval;
BEGIN
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event;
  day_offset := make_interval(hours => ev.day_start_hour);
  RETURN QUERY
  SELECT q.id, q.title_ar, q.title_en, q.points, q.visible,
         count(l.id) FILTER (WHERE ((l.created_at AT TIME ZONE ev.timezone) - day_offset)::date
                                   = ((now() AT TIME ZONE ev.timezone) - day_offset)::date),
         count(l.id),
         q.type
  FROM quest q
  LEFT JOIN category c ON c.id = q.category_id
  LEFT JOIN ledger_entry l ON l.operator_id = me AND l.quest_id = q.id AND l.kind = 'quest'
  WHERE q.event_id = target_event AND q.type IN ('scan_qr', 'challenge') AND 'my_qr' = ANY (q.verification)
    AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
         OR q.id IN (SELECT s.quest_id FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id))
  GROUP BY q.id, c.position
  ORDER BY c.position NULLS LAST, q.position, q.id;
END $$;
REVOKE ALL ON FUNCTION operator_stations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_stations(uuid) TO questify_app;

-- ================================================================ erasure and the rehearsal wipe
-- As 0041, with survey responses deleted before the completions, and counted.
CREATE OR REPLACE FUNCTION wipe_rehearsal(target uuid, reason text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row event_rehearsal%ROWTYPE;
  accounts  uuid[];
  counts    jsonb;
  first_at  timestamptz;
  entries   integer;
BEGIN
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target FOR UPDATE;
  IF NOT FOUND OR found_row.live_wiped_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  accounts := ARRAY(
    WITH locked AS (
      SELECT n.id FROM enrollment n WHERE n.event_id = target AND n.joined_via = 'rehearsal' ORDER BY n.id FOR UPDATE
    )
    SELECT locked.id FROM locked ORDER BY locked.id);
  SELECT min(l.created_at) FILTER (WHERE l.kind = 'quest'),
         jsonb_build_object(
           'accounts', cardinality(accounts),
           'completions', count(*) FILTER (WHERE l.kind = 'quest'),
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)),
           'submissions', (SELECT count(*) FROM submission s WHERE s.enrollment_id = ANY (accounts)),
           'votes', (SELECT count(*) FROM quest_vote v WHERE v.enrollment_id = ANY (accounts)),
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)),
           'surveys', (SELECT count(*) FROM survey_response r WHERE r.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  PERFORM set_config('questify.rehearsal_wipe', target::text, true);
  DELETE FROM ledger_note t WHERE t.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM manual_award_key k
  WHERE k.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal AND l.reverses IS NOT NULL;
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;
  GET DIAGNOSTICS entries = ROW_COUNT;
  PERFORM set_config('questify.rehearsal_wipe', '', true);
  IF EXISTS (SELECT 1 FROM reward_code c JOIN redemption d ON d.id = c.redemption_id
             WHERE d.enrollment_id = ANY (accounts)) THEN
    RAISE EXCEPTION 'a rehearsal reservation holds a real code' USING ERRCODE = 'RX500';
  END IF;
  DELETE FROM redemption d WHERE d.enrollment_id = ANY (accounts);
  DELETE FROM submission s WHERE s.enrollment_id = ANY (accounts);
  DELETE FROM quest_vote v WHERE v.enrollment_id = ANY (accounts);
  DELETE FROM survey_response r WHERE r.enrollment_id = ANY (accounts);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (accounts);
  DELETE FROM quiz_attempt t WHERE t.enrollment_id = ANY (accounts);
  DELETE FROM quest_completion c WHERE c.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- Stock from what remains (FR-1722): every reservation still holding a unit.
  UPDATE reward r SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.reward_id = r.id AND d.status IN ('reserved', 'handed_over', 'delivered'))
  WHERE r.event_id = target;

  UPDATE event_rehearsal r
  SET erased_at = now(), erase_counts = counts, first_play_at = coalesce(r.first_play_at, first_at),
      live_wiped_at = CASE WHEN reason = 'go_live' THEN now() END
  WHERE r.event_id = target;
  INSERT INTO ranking_repair (event_id) VALUES (target) ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES (CASE WHEN reason = 'go_live' THEN 'system' ELSE 'staff' END,
          CASE WHEN reason = 'go_live' THEN NULL ELSE app_staff_user_id() END,
          found_row.organizer_id, target, 'event.rehearsal_erased', 'event', target::text,
          counts || jsonb_build_object('reason', reason, 'entries', entries), request);
  RETURN counts;
END $$;

-- As 0041, plus: the account's survey responses are deleted (ADR-198); the completions stay for the ledger.
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM player_fingerprint WHERE player_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
