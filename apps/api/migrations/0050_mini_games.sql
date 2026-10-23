-- Mini-games (T-305, ADR-212 to ADR-215; plan docs/plans/2026-10-24-t-305-mini-games.md). The database issues every
-- round: a 32-bit seed, its own clock, the level's numbers from its own copy of the level table, the quest's points and
-- the engine version, all frozen on the round. The API replays the phone's inputs with the shared engine of that version
-- and hands this database the verdict; the database checks the clock and the window itself and pays once, on the first
-- pass. Attempts are used at issue. Deny by default: game_round has no grant and no policy; the definers below are its
-- only doors.

-- ================================================================ the type (FR-1804 to FR-1807)
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known
  CHECK (type IN ('scan_qr', 'enter_code', 'submission', 'vote', 'quiz', 'challenge', 'survey', 'share', 'passport',
                  'location', 'meet', 'game'));
-- A game quest's config (ADR-213): a game and a level from the lists, and attempts from 1 to 10 with no cooldown, or
-- unlimited (null) with a cooldown of 1 to 1,440 minutes. T-305c widens the games. Its verification list stays empty.
ALTER TABLE quest ADD CONSTRAINT quest_game_shape CHECK (
  CASE WHEN type <> 'game' THEN true
       WHEN NOT (jsonb_typeof(type_config) = 'object'
                 AND coalesce(type_config ->> 'game', '') IN ('memory_match', 'slide_puzzle')
                 AND coalesce(type_config ->> 'level', '') IN ('easy', 'medium', 'hard')) THEN false
       WHEN jsonb_typeof(type_config -> 'attempts') = 'null'
         THEN jsonb_typeof(type_config -> 'cooldownMinutes') = 'number'
              AND (type_config ->> 'cooldownMinutes') ~ '^[0-9]{1,4}$'
              AND (type_config ->> 'cooldownMinutes')::integer BETWEEN 1 AND 1440
       WHEN jsonb_typeof(type_config -> 'attempts') = 'number' AND (type_config ->> 'attempts') ~ '^[0-9]{1,2}$'
         THEN (type_config ->> 'attempts')::integer BETWEEN 1 AND 10
              AND coalesce(jsonb_typeof(type_config -> 'cooldownMinutes'), 'null') = 'null'
       ELSE false END);
ALTER TABLE quest ADD CONSTRAINT quest_game_once CHECK (type <> 'game' OR repeat_cap = 1);

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport',
                    'location', 'meet_scan', 'meet_shown', 'game'));

ALTER TABLE flag DROP CONSTRAINT flag_kind_check;
ALTER TABLE flag ADD CONSTRAINT flag_kind_check
  CHECK (kind IN ('shared_device', 'burst', 'far_from_venue', 'impossible_speed', 'minigame'));
-- One open mini-game case per account; evidence {"rounds": [{round, game, level, reason, at}]}, the newest 50.
CREATE UNIQUE INDEX flag_minigame_open ON flag (enrollment_id, kind) WHERE kind = 'minigame' AND status = 'open';

-- ================================================================ the round (ADR-212)
-- One issued round: everything a replay needs, frozen at issue. Open until a result, the window's end (the sweep), a
-- new round of the same quest (abandoned) or the player leaving (abandoned). The inputs are never kept; `result` holds
-- the replayed numbers only.
CREATE TABLE game_round (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id   uuid NOT NULL,
  event_id       uuid NOT NULL,
  enrollment_id  uuid NOT NULL,
  quest_id       uuid NOT NULL,
  game           text NOT NULL CHECK (game IN ('memory_match', 'slide_puzzle')),
  level          text NOT NULL CHECK (level IN ('easy', 'medium', 'hard')),
  seed           integer NOT NULL,
  params         jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  points         integer NOT NULL CHECK (points BETWEEN 0 AND 100000),
  device_id      uuid,
  issue_key      text NOT NULL CHECK (length(issue_key) BETWEEN 1 AND 255),
  engine_version integer NOT NULL CHECK (engine_version >= 1),
  status         text NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'passed', 'short', 'refused', 'abandoned', 'expired')),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  deadline_at    timestamptz NOT NULL,
  finished_at    timestamptz,
  result_key     text CHECK (length(result_key) BETWEEN 1 AND 255),
  result         jsonb CHECK (result IS NULL OR pg_column_size(result) < 4096),
  reason         text CHECK (reason IN ('malformed', 'order', 'too_fast', 'late', 'cap', 'illegal', 'claimed', 'clock')),
  unlikely       boolean NOT NULL DEFAULT false,
  completion_id  bigint UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  CHECK ((status = 'open') = (finished_at IS NULL)),
  CHECK (completion_id IS NULL OR status = 'passed'),
  CHECK ((reason IS NOT NULL) = (status = 'refused')),
  CHECK ((result_key IS NOT NULL) = (status IN ('passed', 'short', 'refused'))),
  CHECK (deadline_at > issued_at),
  UNIQUE (enrollment_id, issue_key),
  UNIQUE (enrollment_id, result_key),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
-- At most one open round per player and quest.
CREATE UNIQUE INDEX game_round_one_open ON game_round (enrollment_id, quest_id) WHERE status = 'open';
CREATE INDEX game_round_attempts ON game_round (enrollment_id, quest_id, issued_at);
CREATE INDEX game_round_due ON game_round (deadline_at) WHERE status = 'open';
CREATE INDEX game_round_quest ON game_round (quest_id);
ALTER TABLE game_round ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_round FORCE ROW LEVEL SECURITY;
REVOKE ALL ON game_round FROM PUBLIC;

-- ================================================================ internal helpers (no grant)
-- The event's own switch (`config.features.miniGames`, FR-1009), on unless set false. The platform's is the API's.
CREATE FUNCTION games_on(target_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT e.config -> 'features' -> 'miniGames' <> 'false'::jsonb FROM event e WHERE e.id = target_event),
                  true)
$$;
REVOKE ALL ON FUNCTION games_on(uuid) FROM PUBLIC;

-- Each level's numbers (ADR-215, Q-178): the same table as packages/shared/src/games/levels.ts (a database test keeps
-- them equal). No caller chooses the numbers a round is played with.
CREATE FUNCTION game_level(game text, level text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE game || ':' || level
    WHEN 'memory_match:easy' THEN
      '{"pairs": 6, "columns": 3, "rows": 4, "timeLimitSeconds": 120, "maxMoves": null, "unlikelyLucky": 3}'::jsonb
    WHEN 'memory_match:medium' THEN
      '{"pairs": 8, "columns": 4, "rows": 4, "timeLimitSeconds": 120, "maxMoves": 20, "unlikelyLucky": 4}'::jsonb
    WHEN 'memory_match:hard' THEN
      '{"pairs": 10, "columns": 4, "rows": 5, "timeLimitSeconds": 120, "maxMoves": 22, "unlikelyLucky": 4}'::jsonb
    WHEN 'slide_puzzle:easy' THEN '{"size": 3, "walk": 20, "timeLimitSeconds": 180}'::jsonb
    WHEN 'slide_puzzle:medium' THEN '{"size": 3, "walk": 60, "timeLimitSeconds": 180}'::jsonb
    WHEN 'slide_puzzle:hard' THEN '{"size": 4, "walk": 120, "timeLimitSeconds": 300}'::jsonb
  END
$$;
REVOKE ALL ON FUNCTION game_level(text, text) FROM PUBLIC;

-- The member's rounds of a game quest: how many were issued (attempts used), whether one passed, the last issue (for
-- the cooldown) and the open round still inside its window (one past its deadline counts as closed, CTO 5).
CREATE FUNCTION game_attempts(enrolled uuid, quest_row quest)
  RETURNS TABLE (used integer, passed boolean, last_issue timestamptz, open_round bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer,
         coalesce(bool_or(r.status = 'passed'), false),
         max(r.issued_at),
         max(r.id) FILTER (WHERE r.status = 'open' AND r.deadline_at > now())
  FROM game_round r WHERE r.enrollment_id = enrolled AND r.quest_id = quest_row.id
$$;
REVOKE ALL ON FUNCTION game_attempts(uuid, quest) FROM PUBLIC;

-- The attempts a game quest still allows the member, or NULL when they are unlimited.
CREATE FUNCTION game_left(enrolled uuid, quest_row quest) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(quest_row.type_config -> 'attempts') = 'number'
              THEN greatest((quest_row.type_config ->> 'attempts')::integer - a.used, 0) END
  FROM game_attempts(enrolled, quest_row) a
$$;
REVOKE ALL ON FUNCTION game_left(uuid, quest) FROM PUBLIC;

-- Every attempt used, none passed, none still inside its window: the quest counts as done (ADR-213, as a quiz with no
-- right answers), so an in-order category never dead-ends behind a game nobody passes. Never with unlimited attempts.
CREATE FUNCTION game_spent(enrolled uuid, quest_row quest) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT quest_row.type = 'game' AND coalesce(game_left(enrolled, quest_row) = 0, false) AND NOT a.passed
         AND a.open_round IS NULL
  FROM game_attempts(enrolled, quest_row) a
$$;
REVOKE ALL ON FUNCTION game_spent(uuid, quest) FROM PUBLIC;

-- finish_quiz's payable rule (0044) for a round closed without a pass: the player and the enrollment active, an
-- operator allowed to play, the event live or ended (draft or scheduled for a rehearsal account), the results not final.
CREATE FUNCTION game_payable(enrolled enrollment) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT enrolled.status = 'active'
     AND EXISTS (SELECT 1 FROM player p WHERE p.id = enrolled.player_id AND p.status = 'active')
     AND (CASE WHEN enrolled.joined_via = 'rehearsal' THEN st IN ('draft', 'scheduled') ELSE st IN ('live', 'ended') END)
     AND NOT EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = enrolled.event_id)
     AND (coalesce(enrolled.joined_via = 'rehearsal', false) OR NOT EXISTS (
           SELECT 1 FROM staff_assignment sa
           WHERE sa.event_id = enrolled.event_id AND sa.player_id = enrolled.player_id AND NOT sa.can_play))
  FROM (SELECT event_status_now(e.status, e.starts_at, e.ends_at) AS st FROM event e WHERE e.id = enrolled.event_id) s
$$;
REVOKE ALL ON FUNCTION game_payable(enrollment) FROM PUBLIC;

-- After a round closed without a pass: when that was the member's last attempt the quest is now done, so the category
-- bonus may pay (the 0044 quiz rule) and the ranking is marked for repair. The caller holds the enrollment.
CREATE FUNCTION game_last_attempt(enrolled enrollment, quest_row quest) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF game_spent(enrolled.id, quest_row) AND game_payable(enrolled)
     AND pay_category_bonus(enrolled, quest_row.category_id, NULL) IS NOT NULL THEN
    PERFORM mark_ranking_repair(enrolled.event_id);
  END IF;
END $$;
REVOKE ALL ON FUNCTION game_last_attempt(enrollment, quest) FROM PUBLIC;

-- Opens the member's mini-game case, or adds this round to its open one (the newest 50 kept). The reason is the
-- replay's (or 'clock', or 'unlikely' for a paid round); the organizer sees it, the player never does.
CREATE FUNCTION raise_game_flag(played game_round, why text) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
  VALUES (played.organizer_id, played.event_id, played.enrollment_id, 'minigame',
          jsonb_build_object('rounds', jsonb_build_array(jsonb_build_object(
            'round', played.id, 'game', played.game, 'level', played.level, 'reason', why, 'at', now()))))
  ON CONFLICT (enrollment_id, kind) WHERE kind = 'minigame' AND status = 'open' DO UPDATE
  SET last_seen_at = now(),
      evidence = jsonb_build_object('rounds', (
        SELECT jsonb_agg(x ORDER BY (x ->> 'round')::bigint) FROM (
          SELECT x FROM jsonb_array_elements((flag.evidence -> 'rounds') || (EXCLUDED.evidence -> 'rounds')) x
          ORDER BY (x ->> 'round')::bigint DESC LIMIT 50) newest));
END $$;
REVOKE ALL ON FUNCTION raise_game_flag(game_round, text) FROM PUBLIC;

-- What a result is answered: the verdict (`done` for a pass on a quest already completed, which pays nothing), the
-- completion and its points, the member's score and balance, the attempts left, the replay mark, the replayed result,
-- and the refusal's reason (for the API's log only: never sent to the player).
CREATE FUNCTION game_answer(played game_round, replay boolean)
  RETURNS TABLE (verdict text, completion_id bigint, points bigint, score bigint, balance bigint,
                 attempts_left integer, replayed boolean, result jsonb, reason text)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN played.status = 'passed' AND played.completion_id IS NULL THEN 'done' ELSE played.status END,
         played.completion_id, l.score_delta, n.score, n.balance,
         game_left(n.id, q), replay, played.result, played.reason
  FROM enrollment n
  JOIN quest q ON q.id = played.quest_id
  LEFT JOIN ledger_entry l ON l.completion_id = played.completion_id AND l.kind = 'quest'
  WHERE n.id = played.enrollment_id
$$;
REVOKE ALL ON FUNCTION game_answer(game_round, boolean) FROM PUBLIC;

-- The member's earlier round under this issue key: the same open round answers again; a key on a round now closed or
-- past its window answers expired or finished, never a second round (CTO 7); a key used for another quest is QK422.
CREATE FUNCTION game_issue_replay(enrolled uuid, key text, target uuid) RETURNS game_round
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  earlier game_round%ROWTYPE;
BEGIN
  SELECT * INTO earlier FROM game_round r WHERE r.enrollment_id = enrolled AND r.issue_key = key;
  IF NOT FOUND THEN
    RETURN earlier;
  END IF;
  IF earlier.quest_id <> target THEN
    RAISE EXCEPTION 'this key was used for another round' USING ERRCODE = 'QK422';
  END IF;
  IF earlier.status = 'expired' OR (earlier.status = 'open' AND earlier.deadline_at <= now()) THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'expired';
  END IF;
  IF earlier.status <> 'open' THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'finished';
  END IF;
  RETURN earlier;
END $$;
REVOKE ALL ON FUNCTION game_issue_replay(uuid, text, uuid) FROM PUBLIC;

-- Why the member may not start a round now, raised: passed or completed (QD409), attempts used (QG409 attempts_used),
-- or the cooldown of unlimited attempts (QG409 cooldown, HINT the retry time in UTC). The caller holds the enrollment.
CREATE FUNCTION game_issue_check(enrolled enrollment, quest_row quest) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  tried    record;
  retry_at timestamptz;
BEGIN
  SELECT * INTO tried FROM game_attempts(enrolled.id, quest_row);
  IF tried.passed OR period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  IF game_left(enrolled.id, quest_row) = 0 THEN
    RAISE EXCEPTION 'no attempts left' USING ERRCODE = 'QG409', DETAIL = 'attempts_used';
  END IF;
  retry_at := tried.last_issue + make_interval(mins => (quest_row.type_config ->> 'cooldownMinutes')::integer);
  IF retry_at > now() THEN
    RAISE EXCEPTION 'cooling down' USING ERRCODE = 'QG409', DETAIL = 'cooldown',
      HINT = to_char(retry_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  END IF;
END $$;
REVOKE ALL ON FUNCTION game_issue_check(enrollment, quest) FROM PUBLIC;

-- ================================================================ the players' doors (granted)
-- Issues a round of a game quest for the calling player and uses an attempt (ADR-212, ADR-213). The API answered 426
-- to an app whose engine is too old before calling, and passes the server's engine version for the game. Refusals:
-- play_quest's and play_enter's (QC404, QT422, QC403, QN403, QP403), QF403 (the event's switch off), QK422 (no key, or a
-- key used for another quest), QG409 (expired, finished, attempts_used, cooldown with HINT), QD409 (passed).
CREATE FUNCTION start_game_round(target uuid, issue_key text, device uuid, engine integer)
  RETURNS TABLE (round_id bigint, game text, level text, seed integer, params jsonb, points integer,
                 engine_version integer, issued_at timestamptz, deadline_at timestamptz, server_now timestamptz,
                 attempts_left integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  played    game_round%ROWTYPE;
  level_row jsonb;
  fresh     boolean := false;
BEGIN
  IF start_game_round.issue_key IS NULL OR length(start_game_round.issue_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  quest_row := play_quest(target, 'game');
  IF NOT games_on(quest_row.event_id) THEN
    RAISE EXCEPTION 'mini-games are off for this event' USING ERRCODE = 'QF403';
  END IF;
  enrolled := play_enter(quest_row, 'game');
  played := game_issue_replay(enrolled.id, start_game_round.issue_key, target);
  IF played.id IS NULL THEN
    PERFORM game_issue_check(enrolled, quest_row);
    UPDATE game_round r
    SET status = CASE WHEN r.deadline_at <= now() THEN 'expired' ELSE 'abandoned' END, finished_at = now()
    WHERE r.enrollment_id = enrolled.id AND r.quest_id = target AND r.status = 'open';
    level_row := game_level(quest_row.type_config ->> 'game', quest_row.type_config ->> 'level');
    INSERT INTO game_round (organizer_id, event_id, enrollment_id, quest_id, game, level, seed, params, points,
                            device_id, issue_key, engine_version, deadline_at)
    VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, quest_row.type_config ->> 'game',
            quest_row.type_config ->> 'level',
            ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::integer,
            level_row, quest_row.points, device, start_game_round.issue_key, engine,
            now() + make_interval(secs => (level_row ->> 'timeLimitSeconds')::integer) + interval '10 minutes')
    RETURNING * INTO played;
    fresh := true;
  END IF;
  RETURN QUERY SELECT played.id, played.game, played.level, played.seed, played.params, played.points,
                      played.engine_version, played.issued_at, played.deadline_at, now(),
                      game_left(enrolled.id, quest_row), NOT fresh;
END $$;
REVOKE ALL ON FUNCTION start_game_round(uuid, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_game_round(uuid, text, uuid, integer) TO questify_app;

-- The frozen round the API replays, the calling player's own only (no row for anyone else's). Read without a lock: a
-- round's frozen fields never change, so the replay runs outside any transaction.
CREATE FUNCTION game_round_for_replay(target bigint)
  RETURNS TABLE (game text, level text, seed integer, params jsonb, engine_version integer, status text,
                 issued_at timestamptz, deadline_at timestamptz, server_now timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.game, r.level, r.seed, r.params, r.engine_version, r.status, r.issued_at, r.deadline_at, now()
  FROM game_round r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.player_id = app_player_id()
  WHERE r.id = target
$$;
REVOKE ALL ON FUNCTION game_round_for_replay(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION game_round_for_replay(bigint) TO questify_app;

-- Writes the verdict on the calling player's round (ADR-212). It never writes and then raises (CTO 2): every refusal
-- of the request raises before any write, and a verdict is written and answered as a row. Refusals: QC404 (not the
-- caller's round), QK422 (no key, or a key of another round), QG409 (finished, expired: the round stays open until the
-- sweep), and the player's own play refusals (QC404, QC403, QN403, QP403). The verdict, result and reason are the
-- API's replay; this checks only the clock (more play time than the server saw, plus 3 seconds, is `clock`) and its
-- own rows, then pays the frozen points once on a pass (`done` when the quest was already completed), or flags.
CREATE FUNCTION finish_game_round(target bigint, result_key text, given_verdict text, given_result jsonb,
                                  given_reason text, given_unlikely boolean, last_input_ms integer)
  RETURNS TABLE (verdict text, completion_id bigint, points bigint, score bigint, balance bigint,
                 attempts_left integer, replayed boolean, result jsonb, reason text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  played    game_round%ROWTYPE;
  earlier   game_round%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  quest_row quest%ROWTYPE;
  outcome   text := given_verdict;
  why       text := given_reason;
  paid      bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF finish_game_round.result_key IS NULL OR length(finish_game_round.result_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF outcome IS NULL OR outcome NOT IN ('passed', 'short', 'refused') OR (outcome = 'refused') <> (why IS NOT NULL)
     OR last_input_ms IS NULL OR last_input_ms < 0 THEN
    RAISE EXCEPTION 'not a verdict' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO played FROM game_round r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.player_id = me WHERE r.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO earlier FROM game_round r
  WHERE r.enrollment_id = played.enrollment_id AND r.result_key = finish_game_round.result_key;
  IF FOUND THEN
    IF earlier.id <> played.id THEN
      RAISE EXCEPTION 'this key was used for another round' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT * FROM game_answer(earlier, true);
    RETURN;
  END IF;

  PERFORM ensure_rehearsal_wiped(played.event_id);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = played.enrollment_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO played FROM game_round r WHERE r.id = played.id FOR UPDATE;
  -- The rehearsal wipe deleted it while this waited on the locks.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  -- A duplicate that waited on the first result's locks answers it, never `finished`.
  IF played.result_key IS NOT DISTINCT FROM finish_game_round.result_key THEN
    RETURN QUERY SELECT * FROM game_answer(played, true);
    RETURN;
  END IF;
  IF played.status = 'expired' OR (played.status = 'open' AND played.deadline_at <= now()) THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'expired';
  END IF;
  IF played.status <> 'open' THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'finished';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = played.quest_id;
  PERFORM meet_may_play(enrolled, quest_row);

  IF last_input_ms > floor(extract(epoch FROM now() - played.issued_at) * 1000) + 3000 THEN
    outcome := 'refused';
    why := 'clock';
  END IF;
  IF outcome = 'passed' AND period_count(enrolled.id, quest_row) = 0 THEN
    paid := pay_completion(enrolled, quest_row.id, played.points, 'game', 'game:' || played.id, NULL, NULL,
                           played.device_id);
  END IF;
  UPDATE game_round r
  SET status = outcome, finished_at = now(), result_key = finish_game_round.result_key,
      result = CASE WHEN outcome = 'refused' THEN NULL ELSE given_result END,
      reason = CASE WHEN outcome = 'refused' THEN why END,
      unlikely = outcome <> 'refused' AND coalesce(given_unlikely, false), completion_id = paid
  WHERE r.id = played.id
  RETURNING * INTO played;
  IF outcome = 'refused' THEN
    PERFORM raise_game_flag(played, why);
  ELSIF outcome = 'passed' AND played.unlikely THEN
    PERFORM raise_game_flag(played, 'unlikely');
  END IF;
  IF outcome <> 'passed' THEN
    PERFORM game_last_attempt(enrolled, quest_row);
  END IF;
  RETURN QUERY SELECT * FROM game_answer(played, false);
END $$;
REVOKE ALL ON FUNCTION finish_game_round(bigint, text, text, jsonb, text, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finish_game_round(bigint, text, text, jsonb, text, boolean, integer) TO questify_app;

-- A game quest's state for the calling player's quest sheet: the game, the level and its numbers, the attempts (NULL
-- when unlimited, with the cooldown), how many were used and are left, passed, done, when the next try opens, the open
-- round still inside its window, and the last finished round's verdict and result. QC404 or QT422 as play_quest.
CREATE FUNCTION member_game(target uuid)
  RETURNS TABLE (game text, level text, params jsonb, attempts integer, cooldown_minutes integer, used integer,
                 attempts_left integer, passed boolean, done boolean, retry_at timestamptz, open_round bigint,
                 open_deadline timestamptz, last_verdict text, last_result jsonb, server_now timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE := play_quest(target, 'game');
  member    uuid;
BEGIN
  SELECT n.id INTO member FROM enrollment n WHERE n.event_id = quest_row.event_id AND n.player_id = app_player_id();
  RETURN QUERY
  SELECT quest_row.type_config ->> 'game', quest_row.type_config ->> 'level',
         game_level(quest_row.type_config ->> 'game', quest_row.type_config ->> 'level'),
         (quest_row.type_config ->> 'attempts')::integer, (quest_row.type_config ->> 'cooldownMinutes')::integer,
         a.used, game_left(member, quest_row), a.passed, quest_done(member, quest_row.id),
         CASE WHEN jsonb_typeof(quest_row.type_config -> 'attempts') = 'null' AND a.last_issue IS NOT NULL
              THEN a.last_issue + make_interval(mins => (quest_row.type_config ->> 'cooldownMinutes')::integer) END,
         a.open_round, o.deadline_at,
         CASE WHEN f.status = 'passed' AND f.completion_id IS NULL THEN 'done' ELSE f.status END, f.result, now()
  FROM game_attempts(member, quest_row) a
  LEFT JOIN game_round o ON o.id = a.open_round
  LEFT JOIN LATERAL (SELECT r.status, r.completion_id, r.result FROM game_round r
                     WHERE r.enrollment_id = member AND r.quest_id = quest_row.id
                       AND r.status IN ('passed', 'short', 'refused')
                     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1) f ON true;
END $$;
REVOKE ALL ON FUNCTION member_game(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_game(uuid) TO questify_app;

-- ================================================================ the sweep and leaving
-- Closes one round past its window (`expired`), under the event, the enrollment then the round lock (the quiz sweep's
-- order), as the lifecycle tick's system call (nothing for any other caller). A round another caller closed (or the
-- rehearsal wipe deleted) while this waited on its locks is passed over. When that was the member's last attempt
-- the quest is now done and the category bonus may pay. A round whose closing fails is closed with an audit entry (its
-- error code only), so one bad round never stalls the sweep. Answers 'expired', or NULL when nothing is due.
CREATE FUNCTION close_one_due_round() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due       game_round%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  quest_row quest%ROWTYPE;
BEGIN
  IF NOT ranking_system() THEN
    RETURN NULL;
  END IF;
  FOR due IN SELECT r.* FROM game_round r WHERE r.status = 'open' AND r.deadline_at <= now()
             ORDER BY r.deadline_at, r.id LIMIT 20 LOOP
    PERFORM ensure_rehearsal_wiped(due.event_id);
    PERFORM 1 FROM event e WHERE e.id = due.event_id FOR KEY SHARE;
    SELECT * INTO enrolled FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    CONTINUE WHEN NOT FOUND;
    SELECT * INTO due FROM game_round r WHERE r.id = due.id FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR due.status <> 'open';
    UPDATE game_round r SET status = 'expired', finished_at = now() WHERE r.id = due.id;
    BEGIN
      SELECT * INTO quest_row FROM quest q WHERE q.id = due.quest_id;
      PERFORM game_last_attempt(enrolled, quest_row);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after)
      VALUES ('system', due.organizer_id, due.event_id, 'event.game_round_closed', 'game_round', due.id::text,
              jsonb_build_object('error', SQLSTATE));
    END;
    RETURN 'expired';
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION close_one_due_round() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_one_due_round() TO questify_app;

-- A member who stops being active can no longer play: their open rounds end abandoned (the void_open_quizzes pattern).
CREATE FUNCTION abandon_open_rounds() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE game_round r SET status = 'abandoned', finished_at = now()
  WHERE r.enrollment_id = NEW.id AND r.status = 'open';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION abandon_open_rounds() FROM PUBLIC;
CREATE TRIGGER enrollment_abandon_rounds AFTER UPDATE OF status ON enrollment
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION abandon_open_rounds();

-- ================================================================ done, locks and the builder's guard
-- As 0046, plus a game quest whose every attempt was used without a pass, none still inside its window (ADR-213).
CREATE OR REPLACE FUNCTION quest_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q WHERE q.id = target AND period_count(member, q) > 0)
      OR EXISTS (SELECT 1 FROM quiz_attempt a
                 WHERE a.enrollment_id = member AND a.quest_id = target AND a.status = 'finished'
                   AND a.completion_id IS NULL)
      OR EXISTS (SELECT 1 FROM quest q WHERE q.id = target AND q.type = 'game' AND game_spent(member, q))
$$;

-- As 0042, with a game's whole config: its game, level, attempts and cooldown are locked once a round exists (CTO 3).
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
    WHEN 'game' THEN config
  END
$$;

-- As 0042, with game rounds beside votes, quiz attempts and survey responses.
CREATE OR REPLACE FUNCTION quest_lock_played() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF quest_structure(OLD.type, OLD.type_config) IS DISTINCT FROM quest_structure(NEW.type, NEW.type_config)
     AND (EXISTS (SELECT 1 FROM quest_vote v WHERE v.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM quiz_attempt a WHERE a.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM survey_response r WHERE r.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM game_round g WHERE g.quest_id = OLD.id)) THEN
    RAISE EXCEPTION 'players have answered this quest: only its text may change' USING ERRCODE = 'QL409';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER quest_lock_played ON quest;
CREATE TRIGGER quest_lock_played BEFORE UPDATE OF type, type_config ON quest
  FOR EACH ROW WHEN (OLD.type IN ('vote', 'quiz', 'survey', 'game')) EXECUTE FUNCTION quest_lock_played();

-- As 0045, with game rounds: a quest someone played cannot be deleted from the builder.
CREATE OR REPLACE FUNCTION submitters_of(quests uuid[]) RETURNS TABLE (enrollment_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.enrollment_id FROM submission s WHERE s.quest_id = ANY (quests) AND s.organizer_id = app_organizer_id()
  UNION
  SELECT a.enrollment_id FROM quiz_attempt a WHERE a.quest_id = ANY (quests) AND a.organizer_id = app_organizer_id()
  UNION
  SELECT p.enrollment_id FROM passport_stamp p WHERE p.quest_id = ANY (quests) AND p.organizer_id = app_organizer_id()
  UNION
  SELECT g.enrollment_id FROM game_round g WHERE g.quest_id = ANY (quests) AND g.organizer_id = app_organizer_id()
$$;

-- ================================================================ the completion engine reserves `game:`
-- As 0049, with `game:` reserved beside the other system keys: a passing round's completion is keyed `game:<round id>`,
-- so no player's own key can take it first. A game quest has no proof method here: complete_quest and the operator's
-- My QR scan answer wrong_method; a manual award pays it as any quest (an open round's later pass is then `done`).
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row      quest%ROWTYPE;
  enrolled       enrollment%ROWTYPE;
  earlier        quest_completion%ROWTYPE;
  earlier_by     uuid;
  earlier_staff  uuid;
  lifetime_count integer;
  made           bigint;
  entry          bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%'
     OR request_key LIKE 'meet:%' OR request_key LIKE 'game:%' THEN
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

  PERFORM quest_open_check(quest_row, enrolled, proof_method = 'manual');
  -- A quiz in play pays itself at its end; a manual award now would pay the quest twice (T-302).
  IF proof_method = 'manual' AND quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target AND a.status = 'open') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type IN ('scan_qr', 'location') AND proof_method = 'qr'
             AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'location' AND proof_method = 'location')
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
    IF proof_method = 'location' THEN
      PERFORM check_in_check(quest_row, reading);
    END IF;
  END IF;

  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  -- Both counts are read under the enrollment lock taken above.
  IF period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  SELECT count(*) INTO lifetime_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  PERFORM lock_quest_items(quest_row);

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff)
  RETURNING id INTO entry;
  IF proof_method = 'manual' THEN
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason)
    VALUES (entry, enrolled.organizer_id, enrolled.event_id, clean_reason(reason));
    INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
    SELECT enrolled.organizer_id, enrolled.event_id, enrolled.id, c.id
    FROM category c WHERE c.id = quest_row.category_id AND c.hidden
    ON CONFLICT DO NOTHING;
  END IF;
  IF lifetime_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);

  RETURN QUERY SELECT made, quest_row.points::bigint, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- ================================================================ the player's quest list
-- As 0049, with a game quest's attempts left (NULL when unlimited) and whether a round passed, so the list shows
-- "Passed" or "No attempts left" without a second call; `done` counts a game whose attempts are spent (ADR-213). The
-- output changed: DROP and CREATE.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz,
                 item_ar text, item_en text, bonus_item_ar text, bonus_item_en text, place_lat numeric,
                 place_lng numeric, place_radius_m integer, daily_cap integer, met_today integer,
                 game_left integer, game_passed boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         period_count(me.id, q)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL)
           + CASE WHEN q.type = 'game' AND period_count(me.id, q) = 0 AND game_spent(me.id, q) THEN 1 ELSE 0 END,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification,
         c.order_mode, c.opens_at, c.unlock_after,
         CASE WHEN sees_category(me.id, u) THEN u.name_ar END,
         CASE WHEN sees_category(me.id, u) THEN u.name_en END,
         c.completion_bonus,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.category_id = c.id),
         EXISTS (SELECT 1 FROM category_bonus b
                 WHERE b.enrollment_id = me.id AND b.category_id = c.id
                   AND b.period_start >= category_period_start(c, e)),
         category_lock(q, me.id),
         CASE WHEN q.type = 'passport' THEN (SELECT count(*)::int FROM passport_stamp p
                                             WHERE p.enrollment_id = me.id AND p.quest_id = q.id) END,
         CASE WHEN q.type = 'passport' THEN (q.type_config ->> 'needed')::int END,
         c.refresh,
         category_resets_at(c, e),
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_ar END,
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_en END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_ar END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_en END,
         CASE WHEN q.type = 'location' THEN q.place_lat END,
         CASE WHEN q.type = 'location' THEN q.place_lng END,
         CASE WHEN q.type = 'location' THEN q.place_radius_m END,
         CASE WHEN q.type = 'meet' THEN (q.type_config ->> 'dailyCap')::int END,
         CASE WHEN q.type = 'meet' THEN meet_today(me.id, q) END,
         CASE WHEN q.type = 'game' THEN game_left(me.id, q) END,
         CASE WHEN q.type = 'game' THEN (SELECT a.passed FROM game_attempts(me.id, q) a) END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ the flags (ADR-212)
-- As 0048; a mini-game case counts its rounds.
CREATE OR REPLACE FUNCTION event_flags(target_event uuid, open_only boolean, before_id bigint, page integer)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, enrollment_id uuid, username text, avatar text,
                 accounts integer, scans integer, waiting integer, hold boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.raised_at, f.last_seen_at, f.resolved_at, f.enrollment_id,
         p.username, p.avatar,
         CASE WHEN f.kind = 'shared_device' THEN
           (SELECT count(DISTINCT c.enrollment_id)::integer FROM quest_completion c
            WHERE c.event_id = ev.id AND c.device_id = f.device_id) END,
         CASE WHEN f.kind = 'minigame' THEN jsonb_array_length(f.evidence -> 'rounds')
              WHEN f.kind <> 'shared_device' THEN jsonb_array_length(f.evidence -> 'completions') END,
         (SELECT count(*)::integer FROM redemption d WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         ev.flag_hold
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE f.event_id = ev.id AND (f.status = 'open') = coalesce(open_only, true)
    AND (before_id IS NULL OR f.id < before_id)
  ORDER BY f.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;

-- As 0048; a mini-game case lists its rounds: when, the game and level, the reason, the round's verdict and the quest.
-- Never the inputs (they are not kept).
CREATE OR REPLACE FUNCTION flag_detail(target_event uuid, target_flag bigint)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, note text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, resolved_by text, enrollment_id uuid,
                 username text, avatar text, enrollment_status text, paused boolean, hold boolean,
                 evidence jsonb, waiting jsonb, removals jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.note, f.raised_at, f.last_seen_at, f.resolved_at, su.email,
         f.enrollment_id, p.username, p.avatar, n.status, n.redeem_paused_at IS NOT NULL, ev.flag_hold,
         CASE WHEN f.kind = 'shared_device' THEN (
           SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId', a.enrollment_id, 'username', ap.username,
                                                        'lastScanAt', a.last_at) ORDER BY a.last_at DESC), '[]')
           FROM (SELECT c.enrollment_id, max(c.created_at) AS last_at FROM quest_completion c
                 WHERE c.event_id = ev.id AND c.device_id = f.device_id GROUP BY c.enrollment_id) a
           JOIN enrollment an ON an.id = a.enrollment_id JOIN player ap ON ap.id = an.player_id)
         WHEN f.kind = 'minigame' THEN (
           SELECT coalesce(jsonb_agg(jsonb_build_object('at', x.entry ->> 'at', 'roundId', x.entry -> 'round',
                                                        'game', x.entry ->> 'game', 'level', x.entry ->> 'level',
                                                        'reason', x.entry ->> 'reason', 'verdict', r.status,
                                                        'result', r.result,
                                                        'questAr', q.title_ar, 'questEn', q.title_en)
                                     ORDER BY x.n), '[]')
           FROM jsonb_array_elements(f.evidence -> 'rounds') WITH ORDINALITY AS x(entry, n)
           LEFT JOIN game_round r ON r.id = (x.entry ->> 'round')::bigint AND r.enrollment_id = f.enrollment_id
           LEFT JOIN quest q ON q.id = r.quest_id)
         ELSE (
           SELECT coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'method', c.method, 'questAr', q.title_ar,
                                                        'questEn', q.title_en, 'operator', op.username,
                                                        'distanceM', cp.venue_distance_m, 'accuracyM', cp.accuracy_m,
                                                        'mocked', cp.mocked,
                                                        'gapM', CASE WHEN q.place_lat IS NOT NULL AND pv.id IS NOT NULL THEN rounded_m(
                                                          place_gap_m(q.place_lat, q.place_lng, q.place_radius_m,
                                                                      pv.place_lat, pv.place_lng, pv.place_radius_m))
                                                          END,
                                                        'seconds', CASE WHEN q.place_lat IS NOT NULL AND pv.id IS NOT NULL THEN
                                                          round(extract(epoch FROM c.created_at - pv.created_at))::integer
                                                          END)
                                     ORDER BY c.id), '[]')
           FROM quest_completion c
           JOIN quest q ON q.id = c.quest_id
           LEFT JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
           LEFT JOIN player op ON op.id = l.operator_id
           LEFT JOIN completion_position cp ON cp.completion_id = c.id
           LEFT JOIN LATERAL previous_placed(c) pv ON true
           WHERE c.enrollment_id = f.enrollment_id
             AND c.id IN (SELECT (x #>> '{}')::bigint FROM jsonb_array_elements(f.evidence -> 'completions') x))
         END,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('nameAr', coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                       'nameEn', coalesce(r.name_en, k.name_en, i.name_en),
                                                       'reservedUntil', d.reserved_until) ORDER BY d.created_at), '[]')
          FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
          LEFT JOIN quest_item i ON i.id = d.quest_item_id
          WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('entryId', l.id, 'at', l.created_at, 'score', l.score_delta,
                                                       'balance', l.balance_delta, 'reason', ln.reason)
                                    ORDER BY l.id), '[]')
          FROM ledger_entry l LEFT JOIN ledger_note ln ON ln.entry_id = l.id
          WHERE l.enrollment_id = f.enrollment_id AND l.kind = 'removal' AND l.created_at >= f.raised_at)
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN staff_user su ON su.id = f.resolved_by
  WHERE f.id = target_flag AND f.event_id = ev.id;
END $$;

-- ================================================================ erasure and the rehearsal wipe
-- As 0049, plus the account's game rounds.
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
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
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
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;

-- As 0049, with the rehearsal accounts' game rounds deleted before their completions and counted as `games`.
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
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal', 'bonus')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)),
           'submissions', (SELECT count(*) FROM submission s WHERE s.enrollment_id = ANY (accounts)),
           'votes', (SELECT count(*) FROM quest_vote v WHERE v.enrollment_id = ANY (accounts)),
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)),
           'surveys', (SELECT count(*) FROM survey_response r WHERE r.enrollment_id = ANY (accounts)),
           'reveals', (SELECT count(*) FROM category_reveal r WHERE r.enrollment_id = ANY (accounts)),
           'item_misses', (SELECT count(*) FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts)),
           'games', (SELECT count(*) FROM game_round g WHERE g.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  DELETE FROM category_bonus b WHERE b.enrollment_id = ANY (accounts);
  DELETE FROM category_reveal r WHERE r.enrollment_id = ANY (accounts);
  DELETE FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts);
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
  DELETE FROM passport_stamp p WHERE p.enrollment_id = ANY (accounts);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (accounts);
  DELETE FROM quest_completion c WHERE c.enrollment_id = ANY (accounts);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- Stock from what remains (FR-1722): every reservation still holding a unit.
  UPDATE reward r SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.reward_id = r.id AND d.status IN ('reserved', 'handed_over', 'delivered'))
  WHERE r.event_id = target;
  UPDATE quest_item i SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.quest_item_id = i.id AND d.status IN ('reserved', 'handed_over'))
  WHERE i.event_id = target;

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
