-- Vote and quiz quests (T-302, ADR-190 to ADR-195; plan docs/plans/2026-10-24-t-302-vote-quiz.md). A vote pays as an
-- ordinary completion and keeps the player's choice; a quiz serves its questions one at a time from the server, times
-- each one on the server's clock, shows the right answer only once the question is answered or closed, and pays the
-- right answers once, at the end, as one completion (no right answers: no completion). Deny by default: no table is
-- granted to the API role; the definers below are its only doors. Lock order in every writer: the event first (FOR KEY
-- SHARE in the sweep, FOR UPDATE in confirm_results), then the enrollment FOR NO KEY UPDATE, then the attempt FOR
-- UPDATE.

-- ================================================================ the types
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known
  CHECK (type IN ('scan_qr', 'enter_code', 'submission', 'vote', 'quiz'));
-- One vote and one attempt per player (ADR-191). The full shape is checked by the shared registry; these hold the
-- counts the definers rely on.
ALTER TABLE quest ADD CONSTRAINT quest_vote_quiz_once CHECK (type NOT IN ('vote', 'quiz') OR repeat_cap = 1);
ALTER TABLE quest ADD CONSTRAINT quest_vote_shape CHECK (
  type <> 'vote' OR CASE WHEN jsonb_typeof(type_config -> 'options') = 'array'
                         THEN jsonb_array_length(type_config -> 'options') BETWEEN 2 AND 10 ELSE false END);
ALTER TABLE quest ADD CONSTRAINT quest_quiz_shape CHECK (
  type <> 'quiz' OR (
    CASE WHEN jsonb_typeof(type_config -> 'questions') = 'array'
         THEN jsonb_array_length(type_config -> 'questions') BETWEEN 1 AND 20 ELSE false END
    AND CASE jsonb_typeof(type_config -> 'timerSeconds')
          WHEN 'null' THEN true
          WHEN 'number' THEN (type_config ->> 'timerSeconds')::numeric BETWEEN 5 AND 300
                             AND (type_config ->> 'timerSeconds')::numeric % 1 = 0
          ELSE type_config -> 'timerSeconds' IS NULL END));

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz'));

-- ================================================================ the tables
CREATE TABLE quest_vote (
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  quest_id      uuid NOT NULL,
  -- Personal data in the store forms: account deletion deletes the row (ADR-195).
  option_id     text NOT NULL CHECK (length(option_id) BETWEEN 1 AND 40),
  completion_id bigint NOT NULL UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, quest_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX quest_vote_quest_idx ON quest_vote (quest_id, option_id);
ALTER TABLE quest_vote ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_vote FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_vote FROM PUBLIC;

CREATE TABLE quiz_attempt (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id   uuid NOT NULL,
  event_id       uuid NOT NULL,
  enrollment_id  uuid NOT NULL,
  quest_id       uuid NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'finished', 'void')),
  -- Frozen at start (ADR-191): an edit of the quest changes nothing already started.
  points_each    integer NOT NULL CHECK (points_each BETWEEN 0 AND 100000),
  question_count integer NOT NULL CHECK (question_count BETWEEN 1 AND 20),
  timer_seconds  integer CHECK (timer_seconds BETWEEN 5 AND 300),
  right_count    integer NOT NULL DEFAULT 0 CHECK (right_count BETWEEN 0 AND question_count),
  -- Finished by the lifecycle sweep, not by the player: its completion is not the player's pace (burst flags).
  swept          boolean NOT NULL DEFAULT false,
  completion_id  bigint UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (enrollment_id, quest_id),
  CHECK ((status = 'open') = (finished_at IS NULL)),
  CHECK (completion_id IS NULL OR status = 'finished'),
  CHECK (status <> 'finished' OR (right_count > 0) = (completion_id IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX quiz_attempt_quest_idx ON quiz_attempt (quest_id);
CREATE INDEX quiz_attempt_open_idx ON quiz_attempt (event_id) WHERE status = 'open';
ALTER TABLE quiz_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_attempt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quiz_attempt FROM PUBLIC;

-- One row per question served: `served_at` is written once (the deadline never moves); answered, or closed when its
-- time ran out (no points). Account deletion deletes the rows (ADR-195).
CREATE TABLE quiz_answer (
  attempt_id  bigint NOT NULL REFERENCES quiz_attempt (id) ON DELETE RESTRICT,
  position    integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  question_id text NOT NULL CHECK (length(question_id) BETWEEN 1 AND 40),
  choice_id   text CHECK (length(choice_id) BETWEEN 1 AND 40),
  correct     boolean NOT NULL DEFAULT false,
  closed      boolean NOT NULL DEFAULT false,
  served_at   timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  PRIMARY KEY (attempt_id, position),
  UNIQUE (attempt_id, question_id),
  CHECK ((answered_at IS NULL) = (choice_id IS NULL)),
  CHECK (NOT (closed AND answered_at IS NOT NULL)),
  CHECK (NOT correct OR answered_at IS NOT NULL)
);
ALTER TABLE quiz_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE quiz_answer FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quiz_answer FROM PUBLIC;

-- ================================================================ small helpers (internal)
-- The network grace after a question's time (ADR-192, Q-157). The app reads the same number (QUIZ_GRACE_SECONDS).
CREATE FUNCTION quiz_grace() RETURNS interval
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT interval '2 seconds' $$;
REVOKE ALL ON FUNCTION quiz_grace() FROM PUBLIC;

-- A served question whose time and grace have passed. Never overdue without a timer.
CREATE FUNCTION quiz_overdue(served timestamptz, timer integer) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT timer IS NOT NULL AND now() > served + make_interval(secs => timer) + quiz_grace()
$$;
REVOKE ALL ON FUNCTION quiz_overdue(timestamptz, integer) FROM PUBLIC;

-- The question at a 1-based position of a quiz quest's config.
CREATE FUNCTION quiz_question(config jsonb, at integer) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT config -> 'questions' -> (at - 1) $$;
REVOKE ALL ON FUNCTION quiz_question(jsonb, integer) FROM PUBLIC;

-- What may not change once anyone voted or started the quiz (ADR-194): ids, counts and order, right answers, timer.
CREATE FUNCTION quest_structure(kind text, config jsonb) RETURNS jsonb
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
  END
$$;
REVOKE ALL ON FUNCTION quest_structure(text, jsonb) FROM PUBLIC;

CREATE FUNCTION quest_lock_played() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF quest_structure(OLD.type, OLD.type_config) IS DISTINCT FROM quest_structure(NEW.type, NEW.type_config)
     AND (EXISTS (SELECT 1 FROM quest_vote v WHERE v.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM quiz_attempt a WHERE a.quest_id = OLD.id)) THEN
    RAISE EXCEPTION 'players have answered this quest: only its text may change' USING ERRCODE = 'QL409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_lock_played() FROM PUBLIC;
CREATE TRIGGER quest_lock_played BEFORE UPDATE OF type, type_config ON quest
  FOR EACH ROW WHEN (OLD.type IN ('vote', 'quiz')) EXECUTE FUNCTION quest_lock_played();

-- ================================================================ one payment path
-- T-301's pay_submission made general: a completion and its quest entry for points fixed earlier (a submission's, or a
-- quiz's right answers × its frozen points). The balance moves only while the shop is open (FR-1710). Internal.
CREATE FUNCTION pay_completion(enrolled enrollment, quest uuid, points bigint, method text, completion_key text,
                               operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  done_count integer;
  made       bigint;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = quest;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, quest, done_count + 1, method, completion_key)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', points,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE points END,
          made, quest,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION pay_completion(enrollment, uuid, bigint, text, text, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION pay_submission(sub submission, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
BEGIN
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = sub.enrollment_id;
  RETURN pay_completion(enrolled, sub.quest_id, sub.points, 'submission', 'sub:' || sub.id, operator, staff);
END $$;

-- ================================================================ entering a play (internal)
-- The calling player's enrollment in the quest's event, locked FOR NO KEY UPDATE, after the quest's own checks: a
-- member with an active account (QC404 otherwise), the quest of the wanted type (QT422, DETAIL the type), every open
-- check (quest_open_check: QC403, QN403), and an operator who may play (QP403).
CREATE FUNCTION play_enter(quest_row quest, wanted text) RETURNS enrollment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := app_player_id();
  enrolled enrollment%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.type <> wanted THEN
    RAISE EXCEPTION 'not this kind of quest' USING ERRCODE = 'QT422', DETAIL = wanted;
  END IF;
  PERFORM quest_open_check(quest_row, enrolled);
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN enrolled;
END $$;
REVOKE ALL ON FUNCTION play_enter(quest, text) FROM PUBLIC;

-- ================================================================ voting (FR-207, FR-1629)
-- The player's vote: an option of the quest's own config (VO422 otherwise), one vote per player (QD409, the cap), paid
-- as an ordinary completion with method 'vote'. A replayed key answers the first result; the same key with another
-- option or for anything else is QK422, as for a completion.
CREATE FUNCTION vote_quest(target uuid, option text, request_key text)
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
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE n.event_id = quest_row.event_id AND n.player_id = me) THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.type <> 'vote' THEN
    RAISE EXCEPTION 'not a vote quest' USING ERRCODE = 'QT422', DETAIL = 'vote';
  END IF;
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
GRANT EXECUTE ON FUNCTION vote_quest(uuid, text, text) TO questify_app;

-- The options of a vote quest the caller may play (an active member, the quest visible and in their audience), in
-- order, with their own choice. Only the organizer's text: nothing here reads a submission (FR-1629).
CREATE FUNCTION member_vote(target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, mine boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, q.type_config FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'vote' AND q.visible
      AND in_audience(n.id, c.audience_kind, c.audience_field_id, c.audience_values)
  )
  SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
         EXISTS (SELECT 1 FROM quest_vote v WHERE v.enrollment_id = me.id AND v.quest_id = target
                   AND v.option_id = o ->> 'id')
  FROM me, jsonb_array_elements(me.type_config -> 'options') WITH ORDINALITY AS t(o, i)
  ORDER BY i
$$;
REVOKE ALL ON FUNCTION member_vote(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_vote(uuid) TO questify_app;

-- Each option's votes, for the event's owners and editors (AN404 otherwise; ADR-195). Players never see counts here.
CREATE FUNCTION quest_vote_counts(target_event uuid, target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, votes bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  config jsonb;
BEGIN
  SELECT q.type_config INTO config FROM quest q WHERE q.id = target AND q.event_id = ev.id AND q.type = 'vote';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such vote quest in this event' USING ERRCODE = 'AN404';
  END IF;
  RETURN QUERY
    SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
           (SELECT count(*) FROM quest_vote v WHERE v.quest_id = target AND v.option_id = o ->> 'id')
    FROM jsonb_array_elements(config -> 'options') WITH ORDINALITY AS t(o, i)
    ORDER BY i;
END $$;
REVOKE ALL ON FUNCTION quest_vote_counts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_vote_counts(uuid, uuid) TO questify_app;

-- ================================================================ finishing a quiz (internal)
-- Closes whatever is still served, then pays right answers × the frozen points as one completion (key 'quiz:<id>'),
-- with an approval's re-checks (ADR-184): the player and the enrollment active, an operator allowed to play, the event
-- live or ended (draft or scheduled for a rehearsal account), the results not final. A check that fails voids the
-- attempt; it never raises. No right answers: finished, no completion. The caller holds the enrollment and the attempt.
CREATE FUNCTION finish_quiz(attempt quiz_attempt) RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  st       text;
  paid     bigint;
BEGIN
  UPDATE quiz_answer a SET closed = true
  WHERE a.attempt_id = attempt.id AND a.answered_at IS NULL AND NOT a.closed;
  IF attempt.right_count = 0 THEN
    UPDATE quiz_attempt a SET status = 'finished', finished_at = now() WHERE a.id = attempt.id;
    RETURN 'finished';
  END IF;
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = attempt.enrollment_id;
  SELECT * INTO ev FROM event e WHERE e.id = attempt.event_id;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  IF enrolled.status <> 'active'
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = enrolled.player_id AND p.status = 'active')
     OR (CASE WHEN enrolled.joined_via = 'rehearsal' THEN st NOT IN ('draft', 'scheduled')
              ELSE st NOT IN ('live', 'ended') END)
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id)
     OR (enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
           SELECT 1 FROM staff_assignment sa
           WHERE sa.event_id = ev.id AND sa.player_id = enrolled.player_id AND NOT sa.can_play)) THEN
    UPDATE quiz_attempt a SET status = 'void', finished_at = now() WHERE a.id = attempt.id;
    RETURN 'void';
  END IF;
  paid := pay_completion(enrolled, attempt.quest_id, attempt.right_count::bigint * attempt.points_each, 'quiz',
                         'quiz:' || attempt.id, NULL, NULL);
  UPDATE quiz_attempt a SET status = 'finished', completion_id = paid, finished_at = now() WHERE a.id = attempt.id;
  RETURN 'paid';
END $$;
REVOKE ALL ON FUNCTION finish_quiz(quiz_attempt) FROM PUBLIC;

-- ================================================================ playing a quiz (FR-208 to FR-210)
-- Starts the caller's one attempt, or answers the one they have (resuming is allowed; a finished one is answered as
-- it is). Refusals: play_enter's, and QD409 (the cap, when the quest was already completed, by a manual award).
CREATE FUNCTION quiz_start(target uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  made      bigint;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  enrolled := play_enter(quest_row, 'quiz');
  SELECT a.id INTO made FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target;
  IF FOUND THEN
    RETURN made;
  END IF;
  IF EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = enrolled.id AND c.quest_id = target) THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  INSERT INTO quiz_attempt (organizer_id, event_id, enrollment_id, quest_id, points_each, question_count,
                            timer_seconds)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, quest_row.points,
          jsonb_array_length(quest_row.type_config -> 'questions'),
          (quest_row.type_config ->> 'timerSeconds')::integer)
  RETURNING id INTO made;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION quiz_start(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_start(uuid) TO questify_app;

-- The caller's open attempt, after play_enter and under its lock: QA404 when there is none.
CREATE FUNCTION quiz_locked(quest_row quest) RETURNS quiz_attempt
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  attempt  quiz_attempt%ROWTYPE;
BEGIN
  enrolled := play_enter(quest_row, 'quiz');
  SELECT * INTO attempt FROM quiz_attempt a
  WHERE a.enrollment_id = enrolled.id AND a.quest_id = quest_row.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'start the quiz first' USING ERRCODE = 'QA404';
  END IF;
  RETURN attempt;
END $$;
REVOKE ALL ON FUNCTION quiz_locked(quest) FROM PUBLIC;

-- Serves the next question. A question still open is served again with the same deadline (served_at is written
-- once); an overdue one is closed first (no points), then the next is served; after the last, the attempt finishes
-- and pays. Nothing happens on an attempt that is no longer open. Answers the attempt's status.
CREATE FUNCTION quiz_next(target uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  locked    quiz_attempt%ROWTYPE;
  served    quiz_answer%ROWTYPE;
  next_at   integer;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  locked := quiz_locked(quest_row);
  IF locked.status <> 'open' THEN
    RETURN locked.status;
  END IF;
  SELECT * INTO served FROM quiz_answer a
  WHERE a.attempt_id = locked.id AND a.answered_at IS NULL AND NOT a.closed;
  IF FOUND THEN
    IF NOT quiz_overdue(served.served_at, locked.timer_seconds) THEN
      RETURN 'open';
    END IF;
    UPDATE quiz_answer a SET closed = true WHERE a.attempt_id = served.attempt_id AND a.position = served.position;
  END IF;
  SELECT count(*) + 1 INTO next_at FROM quiz_answer a WHERE a.attempt_id = locked.id;
  IF next_at > locked.question_count THEN
    RETURN finish_quiz(locked);
  END IF;
  INSERT INTO quiz_answer (attempt_id, position, question_id)
  VALUES (locked.id, next_at, quiz_question(quest_row.type_config, next_at) ->> 'id');
  RETURN 'open';
END $$;
REVOKE ALL ON FUNCTION quiz_next(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_next(uuid) TO questify_app;

-- One try at the served question (FR-209). The same choice again replays (true); another choice for an answered
-- question is QA409 'answered'; past its time and grace QA409 'closed' (nothing written: quiz_next closes it); a
-- question not served yet QA409 'not_served'; an unknown question or choice QO422. The last answer finishes the
-- attempt and pays. Answers whether it was a replay.
CREATE FUNCTION quiz_answer(target uuid, question text, choice text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  locked    quiz_attempt%ROWTYPE;
  row_now   quiz_answer%ROWTYPE;
  asked     jsonb;
  is_right  boolean;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  locked := quiz_locked(quest_row);
  SELECT * INTO row_now FROM quiz_answer a WHERE a.attempt_id = locked.id AND a.question_id = question;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(quest_row.type_config -> 'questions') q WHERE q ->> 'id' = question)
    THEN
      RAISE EXCEPTION 'this question is not open' USING ERRCODE = 'QA409', DETAIL = 'not_served';
    END IF;
    RAISE EXCEPTION 'no such question' USING ERRCODE = 'QO422';
  END IF;
  IF row_now.answered_at IS NOT NULL THEN
    IF row_now.choice_id = choice THEN
      RETURN true;
    END IF;
    RAISE EXCEPTION 'already answered' USING ERRCODE = 'QA409', DETAIL = 'answered';
  END IF;
  IF row_now.closed OR locked.status <> 'open'
     OR quiz_overdue(row_now.served_at, locked.timer_seconds) THEN
    RAISE EXCEPTION 'this question has closed' USING ERRCODE = 'QA409', DETAIL = 'closed';
  END IF;
  asked := quiz_question(quest_row.type_config, row_now.position);
  IF choice IS NULL OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(asked -> 'choices') c WHERE c ->> 'id' = choice) THEN
    RAISE EXCEPTION 'no such choice' USING ERRCODE = 'QO422';
  END IF;
  is_right := choice = asked ->> 'right';
  UPDATE quiz_answer a SET choice_id = choice, correct = is_right, answered_at = now()
  WHERE a.attempt_id = row_now.attempt_id AND a.position = row_now.position;
  UPDATE quiz_attempt a SET right_count = a.right_count + CASE WHEN is_right THEN 1 ELSE 0 END
  WHERE a.id = locked.id;
  IF row_now.position = locked.question_count THEN
    SELECT * INTO locked FROM quiz_attempt a WHERE a.id = locked.id;
    PERFORM finish_quiz(locked);
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION quiz_answer(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quiz_answer(uuid, text, text) TO questify_app;

-- The caller's quiz as the app shows it, writing nothing: `none` before a start. The served question comes without its
-- right answer; an overdue one is reported closed, with its right answer, as quiz_next will record it. Only for an
-- active member who may see the quest (visible, in their audience); no row otherwise.
CREATE FUNCTION member_quiz(target uuid)
  RETURNS TABLE (status text, total integer, points_each integer, timer_seconds integer, right_count integer,
                 earned bigint, completion_id bigint, server_now timestamptz, current jsonb, answered jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id AS enrollment_id, q.id AS quest_id, q.points, q.type_config
    FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'quiz' AND q.visible
      AND in_audience(n.id, c.audience_kind, c.audience_field_id, c.audience_values)
  ), served AS (
    SELECT a.*, t.timer_seconds, quiz_question(me.type_config, a.position) AS asked,
           a.answered_at IS NULL AND NOT a.closed AND NOT quiz_overdue(a.served_at, t.timer_seconds) AS open_now
    FROM me
    JOIN quiz_attempt t ON t.enrollment_id = me.enrollment_id AND t.quest_id = me.quest_id
    JOIN quiz_answer a ON a.attempt_id = t.id
  )
  SELECT coalesce(t.status, 'none'),
         jsonb_array_length(me.type_config -> 'questions'),
         coalesce(t.points_each, me.points),
         coalesce(t.timer_seconds, (me.type_config ->> 'timerSeconds')::integer),
         coalesce(t.right_count, 0),
         coalesce(t.right_count::bigint * t.points_each, 0),
         t.completion_id,
         now(),
         (SELECT jsonb_build_object(
                   'position', r.position, 'id', r.question_id, 'text', r.asked -> 'text',
                   'choices', (SELECT jsonb_agg(jsonb_build_object('id', c -> 'id', 'text', c -> 'text') ORDER BY j)
                               FROM jsonb_array_elements(r.asked -> 'choices') WITH ORDINALITY AS u(c, j)),
                   'servedAt', r.served_at,
                   'closesAt', CASE WHEN r.timer_seconds IS NOT NULL
                                    THEN r.served_at + make_interval(secs => r.timer_seconds) END)
          FROM served r WHERE r.open_now),
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'position', r.position, 'id', r.question_id, 'text', r.asked -> 'text',
                     'choices', (SELECT jsonb_agg(jsonb_build_object('id', c -> 'id', 'text', c -> 'text') ORDER BY j)
                                 FROM jsonb_array_elements(r.asked -> 'choices') WITH ORDINALITY AS u(c, j)),
                     'choiceId', r.choice_id, 'rightChoiceId', r.asked -> 'right', 'right', r.correct,
                     'closed', r.answered_at IS NULL) ORDER BY r.position)
                   FROM served r WHERE NOT r.open_now), '[]'::jsonb)
  FROM me
  LEFT JOIN quiz_attempt t ON t.enrollment_id = me.enrollment_id AND t.quest_id = me.quest_id
$$;
REVOKE ALL ON FUNCTION member_quiz(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_quiz(uuid) TO questify_app;

-- ================================================================ the sweep and leaving
-- An open attempt is due when its player can no longer play (play_phase null), the quest has closed, or its last
-- question was served and its time ran out. Internal.
CREATE FUNCTION quiz_due(attempt quiz_attempt) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT attempt.status = 'open' AND (
    (SELECT play_phase(e, n) FROM event e, enrollment n
     WHERE e.id = attempt.event_id AND n.id = attempt.enrollment_id) IS NULL
    OR EXISTS (SELECT 1 FROM quest q WHERE q.id = attempt.quest_id AND q.closes_at <= now())
    OR EXISTS (SELECT 1 FROM quiz_answer a
               WHERE a.attempt_id = attempt.id AND a.position = attempt.question_count AND a.answered_at IS NULL
                 AND (a.closed OR quiz_overdue(a.served_at, attempt.timer_seconds))))
$$;
REVOKE ALL ON FUNCTION quiz_due(quiz_attempt) FROM PUBLIC;

-- Finishes one due attempt, under the event, the enrollment then the attempt lock (the event first, as confirm_results
-- takes it, so the two never wait on each other in a circle), as the lifecycle tick's system call (nothing for any
-- other caller). Its completion is marked swept, so it raises no burst flag, and the ranking is marked for repair. An
-- attempt whose finishing fails is voided with an audit entry (its error code only), so one bad attempt never stalls
-- the sweep. Answers 'paid', 'finished' or 'void', or NULL when nothing is due. Each call walks the open attempts
-- until the first due one; the cost of that walk at scale is Q-157.
CREATE FUNCTION finish_one_due_quiz() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due     quiz_attempt%ROWTYPE;
  outcome text;
BEGIN
  IF NOT ranking_system() THEN
    RETURN NULL;
  END IF;
  FOR due IN SELECT a.* FROM quiz_attempt a WHERE a.status = 'open' ORDER BY a.id LOOP
    CONTINUE WHEN NOT quiz_due(due);
    PERFORM ensure_rehearsal_wiped(due.event_id);
    PERFORM 1 FROM event e WHERE e.id = due.event_id FOR KEY SHARE;
    PERFORM 1 FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    SELECT * INTO due FROM quiz_attempt a WHERE a.id = due.id FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR NOT quiz_due(due);
    BEGIN
      UPDATE quiz_attempt a SET swept = true WHERE a.id = due.id RETURNING * INTO due;
      outcome := finish_quiz(due);
      IF outcome = 'paid' THEN
        PERFORM mark_ranking_repair(due.event_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE quiz_attempt a SET status = 'void', swept = true, finished_at = now() WHERE a.id = due.id;
      INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after)
      VALUES ('system', due.organizer_id, due.event_id, 'event.quiz_voided', 'quiz_attempt', due.id::text,
              jsonb_build_object('error', SQLSTATE));
      outcome := 'void';
    END;
    RETURN outcome;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION finish_one_due_quiz() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_one_due_quiz() TO questify_app;

-- A member who stops being active can no longer play or be paid: their open attempts end void (as
-- close_pending_submissions closes pending submissions).
CREATE FUNCTION void_open_quizzes() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE quiz_attempt a SET status = 'void', finished_at = now()
  WHERE a.enrollment_id = NEW.id AND a.status = 'open';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION void_open_quizzes() FROM PUBLIC;
CREATE TRIGGER enrollment_void_quizzes AFTER UPDATE OF status ON enrollment
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION void_open_quizzes();

-- A completion that is not the player's own pace: a reviewer's approval (T-301) or a swept quiz. Internal.
CREATE FUNCTION system_paid(method text, completion_key text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT reviewer_paid(method, completion_key) OR (
    method = 'quiz' AND completion_key ~ '^quiz:[0-9]{1,18}$' AND EXISTS (
      SELECT 1 FROM quiz_attempt a WHERE a.id = substr(completion_key, 6)::bigint AND a.swept))
$$;
REVOKE ALL ON FUNCTION system_paid(text, text) FROM PUBLIC;

-- Who played any of these quests (a completion aside: a submission, or a quiz attempt), for the quest builder's delete
-- guard: the caller's own organizer's quests only. Enrollment ids only. As 0040, with quiz attempts.
CREATE OR REPLACE FUNCTION submitters_of(quests uuid[]) RETURNS TABLE (enrollment_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.enrollment_id FROM submission s WHERE s.quest_id = ANY (quests) AND s.organizer_id = app_organizer_id()
  UNION
  SELECT a.enrollment_id FROM quiz_attempt a WHERE a.quest_id = ANY (quests) AND a.organizer_id = app_organizer_id()
$$;

-- As 0037, with a finished quiz that paid nothing counted as done (FR-208: no right answers, no completion).
CREATE OR REPLACE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         (SELECT count(*)::int FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification
  FROM me
  JOIN category c ON c.event_id = target
    AND in_audience(me.id, c.audience_kind, c.audience_field_id, c.audience_values)
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;

-- ================================================================ the completion engine knows votes and quizzes
-- As 0040, with `quiz:` reserved beside `sub:`, a vote's own proof, and no manual award on a quiz in play (QD409).
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
            OR (quest_row.type = 'scan_qr' AND proof_method = 'my_qr' AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'enter_code' AND proof_method = 'code')
            OR (quest_row.type = 'vote' AND proof_method = 'vote')) THEN
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

-- As 0040, with `quiz:` reserved too.
CREATE OR REPLACE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text)
  RETURNS TABLE (submission_id bigint, status text, points integer, completion_id bigint, score bigint,
                 balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  earlier    submission%ROWTYPE;
  made       submission%ROWTYPE;
  cleaned    text;
  done_count integer;
  paid       bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key LIKE 'sub:%'
     OR request_key LIKE 'quiz:%' THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  cleaned := clean_submission_text(body);

  SELECT * INTO earlier FROM submission s WHERE s.enrollment_id = enrolled.id AND s.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.quest_id <> target OR earlier.body IS DISTINCT FROM cleaned THEN
      RAISE EXCEPTION 'this key was used for another submission' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.points, earlier.completion_id, n.score, n.balance, true
      FROM enrollment n WHERE n.id = enrolled.id;
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled);
  IF quest_row.type <> 'submission' THEN
    RAISE EXCEPTION 'not a submission quest' USING ERRCODE = 'SQ422';
  END IF;
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  IF guidelines IS NULL OR NOT EXISTS (
    SELECT 1 FROM player_acceptance a
    WHERE a.player_id = me AND a.document = 'community_guidelines' AND a.version = guidelines) THEN
    RAISE EXCEPTION 'accept the community guidelines first' USING ERRCODE = 'SG403';
  END IF;
  IF EXISTS (SELECT 1 FROM submission s
             WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'pending') THEN
    RAISE EXCEPTION 'a submission is already waiting' USING ERRCODE = 'SP409';
  END IF;
  IF coalesce((quest_row.type_config ->> 'resubmit')::boolean, false) IS FALSE AND EXISTS (
    SELECT 1 FROM submission s
    WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'rejected' AND NOT s.reason_system) THEN
    RAISE EXCEPTION 'closed after a rejection' USING ERRCODE = 'QD409', DETAIL = 'closed';
  END IF;
  SELECT (SELECT count(*) FROM quest_completion c WHERE c.enrollment_id = enrolled.id AND c.quest_id = target)
         + (SELECT count(*) FROM submission s
            WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'pending')
  INTO done_count;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, auto, marked,
                          idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, 'text', cleaned, quest_row.points, 'pending',
          coalesce((quest_row.type_config ->> 'autoApprove')::boolean, false), text_marked(cleaned), request_key)
  RETURNING * INTO made;
  IF made.auto THEN
    paid := pay_submission(made, NULL, NULL);
    UPDATE submission s SET status = 'approved', completion_id = paid, reviewed_at = now()
    WHERE s.id = made.id RETURNING * INTO made;
  END IF;
  RETURN QUERY SELECT made.id, made.status, made.points, made.completion_id, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;

-- As 0040, with a swept quiz skipped like a reviewer's approval (system_paid).
CREATE OR REPLACE FUNCTION raise_completion_flags() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tuning  record;
  since   timestamptz;
  recent  jsonb;
BEGIN
  IF NEW.method = 'manual' OR system_paid(NEW.method, NEW.idempotency_key) THEN
    RETURN NULL;
  END IF;
  IF NEW.device_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('device:' || NEW.event_id || ':' || NEW.device_id, 0));
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, device_id)
    SELECT NEW.organizer_id, NEW.event_id, s.enrollment_id, 'shared_device', NEW.device_id
    FROM (SELECT DISTINCT c.enrollment_id FROM quest_completion c
          JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
          WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id) s
    WHERE EXISTS (SELECT 1 FROM quest_completion c
                  JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
                  WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id
                    AND c.enrollment_id <> NEW.enrollment_id)
    ORDER BY s.enrollment_id
    ON CONFLICT (enrollment_id, device_id) WHERE kind = 'shared_device' DO NOTHING;
  END IF;

  SELECT * INTO tuning FROM flag_tuning();
  SELECT max(f.resolved_at) INTO since FROM flag f
  WHERE f.enrollment_id = NEW.enrollment_id AND f.kind = 'burst' AND f.status <> 'open';
  SELECT jsonb_agg(c.id ORDER BY c.id) INTO recent FROM quest_completion c
  WHERE c.enrollment_id = NEW.enrollment_id AND c.method <> 'manual'
    AND NOT system_paid(c.method, c.idempotency_key)
    AND c.created_at > now() - tuning.burst_window AND c.created_at > coalesce(since, '-infinity');
  IF jsonb_array_length(coalesce(recent, '[]'::jsonb)) >= tuning.burst_count THEN
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
    VALUES (NEW.organizer_id, NEW.event_id, NEW.enrollment_id, 'burst', jsonb_build_object('completions', recent))
    ON CONFLICT (enrollment_id) WHERE kind = 'burst' AND status = 'open' DO UPDATE
    SET last_seen_at = now(),
        evidence = jsonb_build_object('completions', (
          SELECT jsonb_agg(x ORDER BY x) FROM (
            SELECT DISTINCT x FROM jsonb_array_elements((flag.evidence -> 'completions') || (EXCLUDED.evidence -> 'completions')) x
            ORDER BY x DESC LIMIT 50) newest));
  END IF;
  RETURN NULL;
END $$;

-- As 0040, with votes, quiz answers and attempts deleted before the completions, and counted.
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
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)))
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

-- As 0040, plus: the account's votes and quiz answers are deleted (ADR-195); attempts stay for the ledger.
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
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;

-- As 0034, with the event's open quizzes finished under the event lock first (T-302). Outcomes add
-- results_changed: a finished quiz moved the places; its payments commit and the owner reviews again.
CREATE OR REPLACE FUNCTION confirm_results(target_event uuid, expected uuid[], request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  now_places uuid[];
  due        quiz_attempt%ROWTYPE;
  finished   boolean := false;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  IF expected IS NULL OR array_position(expected, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'the places seen are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT * INTO ev FROM event e WHERE e.id = ev.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RETURN 'replayed';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'ended' THEN
    RAISE EXCEPTION 'results are confirmed after the event ends' USING ERRCODE = 'RF409', DETAIL = 'not_ended';
  END IF;
  -- Quizzes still open pay what they earned before the places freeze (T-302); a change commits and is reported.
  FOR due IN SELECT a.* FROM quiz_attempt a WHERE a.event_id = ev.id AND a.status = 'open' ORDER BY a.id LOOP
    PERFORM 1 FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    SELECT * INTO due FROM quiz_attempt a WHERE a.id = due.id FOR UPDATE;
    CONTINUE WHEN due.status <> 'open';
    UPDATE quiz_attempt a SET swept = true WHERE a.id = due.id RETURNING * INTO due;
    finished := finish_quiz(due) = 'paid' OR finished;
  END LOOP;
  now_places := ARRAY(SELECT c.enrollment_id FROM current_places(ev) c ORDER BY c.rank);
  IF finished AND now_places <> expected THEN
    PERFORM mark_ranking_repair(ev.id);
    RETURN 'results_changed';
  END IF;
  IF now_places <> expected THEN
    RAISE EXCEPTION 'the places changed' USING ERRCODE = 'RF409', DETAIL = 'results_changed';
  END IF;

  INSERT INTO event_result (event_id, organizer_id, confirmed_by) VALUES (ev.id, ev.organizer_id, app_staff_user_id());
  INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version, open_flags, rank_prize_id)
  SELECT ev.id, c.rank, c.enrollment_id, c.score, c.score_version,
         (SELECT count(*) FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'),
         prize_for_rank(ev, c.rank)
  FROM current_places(ev) c;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.results_confirmed', 'event', ev.id::text,
          jsonb_build_object('places', cardinality(now_places),
                             'flagged', (SELECT count(*) FROM result_place x WHERE x.event_id = ev.id AND x.open_flags > 0)),
          request);
  RETURN 'confirmed';
END $$;
