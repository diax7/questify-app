-- Live polls (T-306, ADR-220, ADR-221; plan docs/plans/2026-10-24-t-306-live-polls.md). A live poll is a vote quest
-- with a `live` block: one or several choices, results after voting, at close or never, open `minutes` once sent. Its
-- window is the quest's own visible/opens_at/closes_at, written only by send_poll and close_poll (the API's seat keeps
-- a draft poll hidden, and a sent one's window as sent). Several choices are one completion and one payment. Live
-- polls stay out of every category rule. Deny by default: no new table; every new function is closed to PUBLIC here,
-- and only the player and team doors are granted to the API role.

-- ================================================================ the poll's shape and state
-- When the poll was sent; NULL for a draft. No column grant: only send_poll and the rehearsal wipe write it.
ALTER TABLE quest ADD COLUMN poll_sent_at timestamptz;
ALTER TABLE quest ADD CONSTRAINT quest_poll_sent_live
  CHECK (poll_sent_at IS NULL OR (type = 'vote' AND type_config ? 'live'));

-- As 0041, with the `live` block (FR-239 to FR-242): choices one | several, results after_vote | at_close | never,
-- minutes a whole number from 1 to 1,440. `several` exists only inside `live`, so a plain vote stays one choice. Each
-- test reads as false, never NULL, so a missing field fails the check.
ALTER TABLE quest DROP CONSTRAINT quest_vote_shape;
ALTER TABLE quest ADD CONSTRAINT quest_vote_shape CHECK (
  type <> 'vote' OR (
    CASE WHEN jsonb_typeof(type_config -> 'options') = 'array'
         THEN jsonb_array_length(type_config -> 'options') BETWEEN 2 AND 10 ELSE false END
    AND CASE
          WHEN NOT type_config ? 'live' THEN true
          WHEN jsonb_typeof(type_config -> 'live') <> 'object' THEN false
          ELSE coalesce(type_config -> 'live' ->> 'choices' IN ('one', 'several'), false)
               AND coalesce(type_config -> 'live' ->> 'results' IN ('after_vote', 'at_close', 'never'), false)
               AND CASE WHEN jsonb_typeof(type_config -> 'live' -> 'minutes') = 'number'
                        THEN (type_config -> 'live' ->> 'minutes')::numeric BETWEEN 1 AND 1440
                             AND (type_config -> 'live' ->> 'minutes')::numeric % 1 = 0
                        ELSE false END
        END));

-- The event's live polls, for live_state (a handful per event).
CREATE INDEX quest_live_idx ON quest (event_id) WHERE type = 'vote' AND type_config ? 'live';

-- ================================================================ several choices (FR-240)
-- One row per chosen option; the rows of one vote share its completion.
ALTER TABLE quest_vote DROP CONSTRAINT quest_vote_pkey;
ALTER TABLE quest_vote ADD PRIMARY KEY (enrollment_id, quest_id, option_id);
ALTER TABLE quest_vote DROP CONSTRAINT quest_vote_completion_id_key;
CREATE INDEX quest_vote_completion_idx ON quest_vote (completion_id);

-- Whether the event's sent polls may be shown to players now: before go-live (only rehearsal accounts play then), or
-- once the go-live wipe ran. A rehearsal poll still open when the event goes live stays hidden until the wipe puts it
-- back to draft (CTO code review 1). STABLE, so readers may call it; the writers run the wipe first. Internal.
CREATE FUNCTION polls_shown(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('draft', 'scheduled')
      OR NOT EXISTS (SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL)
$$;
REVOKE ALL ON FUNCTION polls_shown(event) FROM PUBLIC;

-- Whether a quest is a live poll. Internal.
CREATE FUNCTION is_live_poll(kind text, config jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT kind = 'vote' AND coalesce(config ? 'live', false)
$$;
REVOKE ALL ON FUNCTION is_live_poll(text, jsonb) FROM PUBLIC;

-- ================================================================ live polls stay out of the category rules (ADR-220)
-- As 0044, without live polls: a category of only live polls has nothing to finish, so it is never done (no bonus).
CREATE OR REPLACE FUNCTION category_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.category_id = target AND q.visible AND NOT is_live_poll(q.type, q.type_config))
     AND NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND NOT is_live_poll(q.type, q.type_config)
                       AND NOT quest_done(member, q.id))
$$;

-- As 0044, without live polls: a category of only live polls counts as empty, so it is cleared (no dead end) and the
-- category that unlocks after it opens at once; a poll the player missed never holds the next category shut.
CREATE OR REPLACE FUNCTION category_cleared(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND (q.closes_at IS NULL OR q.closes_at > now())
                       AND NOT is_live_poll(q.type, q.type_config) AND NOT quest_done(member, q.id))
$$;

-- As 0046, with the in-order rule skipping live polls both ways: a live poll is never the earlier quest that blocks,
-- and never itself blocked by an unfinished earlier quest. The category's opening time and unlock still apply.
CREATE OR REPLACE FUNCTION category_lock(quest_row quest, member uuid) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  group_row category%ROWTYPE;
  first_row category%ROWTYPE;
BEGIN
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF group_row.opens_at IS NOT NULL AND group_row.opens_at > now() THEN
    RETURN 'category_not_started';
  END IF;
  IF group_row.unlock_after IS NOT NULL THEN
    SELECT * INTO first_row FROM category c WHERE c.id = group_row.unlock_after;
    IF sees_category(member, first_row) AND NOT category_cleared(member, first_row.id) THEN
      RETURN 'category_locked';
    END IF;
  END IF;
  IF group_row.order_mode = 'in_order' AND NOT is_live_poll(quest_row.type, quest_row.type_config) AND EXISTS (
    SELECT 1 FROM quest q
    WHERE q.category_id = group_row.id AND q.visible AND (q.position, q.id) < (quest_row.position, quest_row.id)
      AND (q.closes_at IS NULL OR q.closes_at > now()) AND NOT is_live_poll(q.type, q.type_config)
      AND NOT quest_done(member, q.id)) THEN
    RETURN 'order_locked';
  END IF;
  RETURN NULL;
END $$;

-- ================================================================ the window is Send's and Close's (ADR-220)
-- The API's seat only (the definers below, the wipe and the migration owner pass): a draft live poll is hidden with
-- no window, so an insert that leaves `visible` at its default true is refused; a sent poll's visible, opens_at and
-- closes_at stay as Send and Close wrote them; `live` is not added to a vote quest players could already see. Reads
-- the new row's values, not the columns named. PL409, DETAIL the field.
CREATE FUNCTION quest_live_poll_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  live boolean := NEW.type = 'vote' AND coalesce(NEW.type_config ? 'live', false);
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF live AND NOT coalesce(OLD.type_config ? 'live', false) AND OLD.visible THEN
      RAISE EXCEPTION 'hide the vote before making it a live poll' USING ERRCODE = 'PL409', DETAIL = 'live';
    END IF;
    IF OLD.poll_sent_at IS NOT NULL
       AND (NEW.visible, NEW.opens_at, NEW.closes_at) IS DISTINCT FROM (OLD.visible, OLD.opens_at, OLD.closes_at) THEN
      RAISE EXCEPTION 'a sent poll''s window is set by Send and Close' USING ERRCODE = 'PL409', DETAIL = 'window';
    END IF;
  END IF;
  IF live AND NEW.poll_sent_at IS NULL AND (NEW.visible OR NEW.opens_at IS NOT NULL OR NEW.closes_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a live poll stays hidden until it is sent' USING ERRCODE = 'PL409', DETAIL = 'window';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_live_poll_guard() FROM PUBLIC;
CREATE TRIGGER quest_live_poll_guard BEFORE INSERT OR UPDATE ON quest
  FOR EACH ROW WHEN (NEW.type = 'vote') EXECUTE FUNCTION quest_live_poll_guard();

-- As 0050, with a vote's structure locked once it is sent as well as once voted (ADR-194 extended), and the `live`
-- block guarded for everyone: not added to or removed from a vote that was sent or voted on, and its choices and
-- minutes fixed once sent (PL409, DETAIL the field). Its results policy and every text may still change.
CREATE OR REPLACE FUNCTION quest_lock_played() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  sent  boolean := OLD.type = 'vote' AND OLD.poll_sent_at IS NOT NULL;
  voted boolean := EXISTS (SELECT 1 FROM quest_vote v WHERE v.quest_id = OLD.id);
BEGIN
  IF OLD.type = 'vote' THEN
    IF (sent OR voted) AND coalesce(OLD.type_config ? 'live', false) <> coalesce(NEW.type_config ? 'live', false) THEN
      RAISE EXCEPTION 'a sent or answered vote keeps its live setting' USING ERRCODE = 'PL409', DETAIL = 'live';
    END IF;
    IF sent AND OLD.type_config -> 'live' -> 'choices' IS DISTINCT FROM NEW.type_config -> 'live' -> 'choices' THEN
      RAISE EXCEPTION 'a sent poll keeps its choices' USING ERRCODE = 'PL409', DETAIL = 'choices';
    END IF;
    IF sent AND OLD.type_config -> 'live' -> 'minutes' IS DISTINCT FROM NEW.type_config -> 'live' -> 'minutes' THEN
      RAISE EXCEPTION 'a sent poll keeps its minutes' USING ERRCODE = 'PL409', DETAIL = 'minutes';
    END IF;
  END IF;
  IF quest_structure(OLD.type, OLD.type_config) IS DISTINCT FROM quest_structure(NEW.type, NEW.type_config)
     AND (sent OR voted
          OR EXISTS (SELECT 1 FROM quiz_attempt a WHERE a.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM survey_response r WHERE r.quest_id = OLD.id)
          OR EXISTS (SELECT 1 FROM game_round g WHERE g.quest_id = OLD.id)) THEN
    RAISE EXCEPTION 'players have answered this quest: only its text may change' USING ERRCODE = 'QL409';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ voting (FR-207, FR-240)
-- As 0043, with a set of options: non-empty, distinct and each the quest's own (VO422), exactly one unless the poll
-- takes several (VC422 too_many_choices). One completion and one payment whatever the number chosen. A replayed key
-- answers the first result when the set is the same (in any order), QK422 otherwise. The go-live wipe runs before the
-- quest is read, so a rehearsal poll open across go-live is read back as the draft the wipe made of it (CTO code
-- review 1); record_completion's own call then finds nothing to do.
DROP FUNCTION vote_quest(uuid, text, text);
CREATE FUNCTION vote_quest(target uuid, options text[], request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  quest_row quest%ROWTYPE;
  paid      record;
  chosen    text[];
  earlier   text[];
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(q.event_id) FROM quest q WHERE q.id = target;
  quest_row := play_quest(target, 'vote');
  chosen := ARRAY(SELECT DISTINCT o FROM unnest(options) o WHERE o IS NOT NULL ORDER BY o);
  IF coalesce(cardinality(options), 0) = 0 OR cardinality(chosen) <> cardinality(options) OR EXISTS (
    SELECT 1 FROM unnest(chosen) o
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(quest_row.type_config -> 'options') x WHERE x ->> 'id' = o)) THEN
    RAISE EXCEPTION 'no such option' USING ERRCODE = 'VO422';
  END IF;
  IF cardinality(chosen) > 1 AND quest_row.type_config -> 'live' ->> 'choices' IS DISTINCT FROM 'several' THEN
    RAISE EXCEPTION 'this vote takes one choice' USING ERRCODE = 'VC422', DETAIL = 'too_many_choices';
  END IF;
  SELECT * INTO paid FROM record_completion(target, me, 'vote', NULL, NULL, request_key, NULL, NULL, NULL, NULL,
                                            quest_row.event_id) r;
  IF paid.replayed THEN
    earlier := ARRAY(SELECT v.option_id FROM quest_vote v WHERE v.completion_id = paid.completion_id ORDER BY 1);
    IF earlier IS DISTINCT FROM chosen THEN
      RAISE EXCEPTION 'this key was used for another vote' USING ERRCODE = 'QK422';
    END IF;
  ELSE
    INSERT INTO quest_vote (organizer_id, event_id, enrollment_id, quest_id, option_id, completion_id)
    SELECT n.organizer_id, n.event_id, n.id, target, o, paid.completion_id
    FROM enrollment n, unnest(chosen) o WHERE n.event_id = quest_row.event_id AND n.player_id = me;
  END IF;
  RETURN QUERY SELECT paid.completion_id, paid.points, paid.occurrence, paid.score, paid.balance, paid.replayed;
END $$;
REVOKE ALL ON FUNCTION vote_quest(uuid, text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION vote_quest(uuid, text[], text) TO questify_app;

-- As 0041, plus `voters` (the distinct players who voted, the same on every row), so a share is out of voters and not
-- out of rows when several choices are allowed. For the event's owners and editors (AN404 otherwise; ADR-195).
DROP FUNCTION quest_vote_counts(uuid, uuid);
CREATE FUNCTION quest_vote_counts(target_event uuid, target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, votes bigint, voters bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  config jsonb;
  people bigint;
BEGIN
  SELECT q.type_config INTO config FROM quest q WHERE q.id = target AND q.event_id = ev.id AND q.type = 'vote';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such vote quest in this event' USING ERRCODE = 'AN404';
  END IF;
  SELECT count(DISTINCT v.enrollment_id) INTO people FROM quest_vote v WHERE v.quest_id = target;
  RETURN QUERY
    SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
           (SELECT count(*) FROM quest_vote v WHERE v.quest_id = target AND v.option_id = o ->> 'id'), people
    FROM jsonb_array_elements(config -> 'options') WITH ORDINALITY AS t(o, i)
    ORDER BY i;
END $$;
REVOKE ALL ON FUNCTION quest_vote_counts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_vote_counts(uuid, uuid) TO questify_app;

-- ================================================================ the player's poll (FR-242)
-- A live poll the caller may see (an active member and account, the quest visible, its category seen), with its title
-- and points for the pop-up card, its rules,
-- its window (never past the event's end), whether it closed and the caller's own choices. No row otherwise.
CREATE FUNCTION member_poll(target uuid)
  RETURNS TABLE (title_ar text, title_en text, points integer, choices text, results text, closes_at timestamptz,
                 closed boolean, mine text[], server_now timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.title_ar, q.title_en, q.points, q.type_config -> 'live' ->> 'choices', q.type_config -> 'live' ->> 'results',
         least(q.closes_at, e.ends_at), least(q.closes_at, e.ends_at) <= now(),
         ARRAY(SELECT v.option_id FROM quest_vote v WHERE v.enrollment_id = n.id AND v.quest_id = q.id ORDER BY 1),
         now()
  FROM quest q
  JOIN event e ON e.id = q.event_id
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND is_live_poll(q.type, q.type_config) AND q.visible AND sees_category(n.id, c)
    AND polls_shown(e)
$$;
REVOKE ALL ON FUNCTION member_poll(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_poll(uuid) TO questify_app;

-- A live poll's counts for a player who may see it (as member_poll; QC404 otherwise), only when its policy allows:
-- after_vote once the caller voted, at_close once it closed, never never (PR403, DETAIL the policy). Counts only, never
-- who voted; `voters` is the number of distinct players, the same on every row.
CREATE FUNCTION poll_results(target uuid) RETURNS TABLE (option_id text, votes bigint, voters bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  poll   record;
  config jsonb;
  people bigint;
BEGIN
  SELECT * INTO poll FROM member_poll(target);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF poll.results = 'never' OR (poll.results = 'at_close' AND NOT poll.closed)
     OR (poll.results = 'after_vote' AND cardinality(poll.mine) = 0) THEN
    RAISE EXCEPTION 'results are not shown yet' USING ERRCODE = 'PR403', DETAIL = poll.results;
  END IF;
  SELECT q.type_config INTO config FROM quest q WHERE q.id = target;
  SELECT count(DISTINCT v.enrollment_id) INTO people FROM quest_vote v WHERE v.quest_id = target;
  RETURN QUERY
    SELECT o ->> 'id', (SELECT count(*) FROM quest_vote v WHERE v.quest_id = target AND v.option_id = o ->> 'id'),
           people
    FROM jsonb_array_elements(config -> 'options') WITH ORDINALITY AS t(o, i)
    ORDER BY i;
END $$;
REVOKE ALL ON FUNCTION poll_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION poll_results(uuid) TO questify_app;

-- ================================================================ Send and Close (owners and editors)
-- The live poll of this event to send or close, locked, or AN404 (another organizer's, outside the caller's event
-- limit, or no such quest) and PN422 (not a live poll). Internal.
CREATE FUNCTION team_poll(target_event uuid, target_quest uuid) RETURNS quest
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  quest_row quest%ROWTYPE;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AN404';
  END IF;
  IF NOT is_live_poll(quest_row.type, quest_row.type_config) THEN
    RAISE EXCEPTION 'not a live poll' USING ERRCODE = 'PN422';
  END IF;
  RETURN quest_row;
END $$;
REVOKE ALL ON FUNCTION team_poll(uuid, uuid) FROM PUBLIC;

-- Sends a draft poll (FR-239): visible now, open `minutes`, never past the event's end. In a live event, after the
-- go-live wipe (so a send never lands before it and gets reset); before go-live only while a rehearsal runs (a test
-- send the go-live wipe puts back to draft); PE409 event_not_live otherwise. A second send while open answers the
-- first (`replayed`); once closed, PS409 already_sent. Audited `quest.poll_send`.
CREATE FUNCTION send_poll(target_event uuid, target_quest uuid, request uuid)
  RETURNS TABLE (opens_at timestamptz, closes_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  phase     text := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  -- Milliseconds, so the builder's read and write back of a sent poll leaves its window exactly as it was.
  at        timestamptz := date_trunc('milliseconds', now());
  quest_row quest%ROWTYPE;
  ends      timestamptz;
BEGIN
  IF phase = 'live' THEN
    PERFORM ensure_rehearsal_wiped(ev.id);
  ELSIF phase NOT IN ('draft', 'scheduled') OR NOT EXISTS (
    SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL) THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'PE409', DETAIL = 'event_not_live';
  END IF;
  quest_row := team_poll(target_event, target_quest);
  IF quest_row.poll_sent_at IS NOT NULL THEN
    IF quest_row.closes_at > now() THEN
      RETURN QUERY SELECT quest_row.opens_at, quest_row.closes_at, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'this poll was sent and has closed' USING ERRCODE = 'PS409', DETAIL = 'already_sent';
  END IF;
  ends := date_trunc('milliseconds',
                     least(at + make_interval(mins => (quest_row.type_config -> 'live' ->> 'minutes')::integer),
                           ev.ends_at));
  UPDATE quest q SET visible = true, opens_at = at, closes_at = ends, poll_sent_at = at WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'quest.poll_send', 'quest', quest_row.id::text,
          jsonb_build_object('opensAt', at, 'closesAt', ends, 'rehearsal', phase <> 'live'), request);
  RETURN QUERY SELECT at, ends, false;
END $$;
REVOKE ALL ON FUNCTION send_poll(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_poll(uuid, uuid, uuid) TO questify_app;

-- Closes a sent poll now (FR-239). PS409 not_sent before it was sent; closing a closed poll changes nothing
-- (`replayed`). Audited `quest.poll_close`.
CREATE FUNCTION close_poll(target_event uuid, target_quest uuid, request uuid)
  RETURNS TABLE (opens_at timestamptz, closes_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE := team_poll(target_event, target_quest);
  at        timestamptz := date_trunc('milliseconds', now());
BEGIN
  IF quest_row.poll_sent_at IS NULL THEN
    RAISE EXCEPTION 'this poll was not sent' USING ERRCODE = 'PS409', DETAIL = 'not_sent';
  END IF;
  IF quest_row.closes_at <= at THEN
    RETURN QUERY SELECT quest_row.opens_at, quest_row.closes_at, true;
    RETURN;
  END IF;
  UPDATE quest q SET closes_at = at WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         after, request_id)
  VALUES ('staff', app_staff_user_id(), quest_row.organizer_id, quest_row.event_id, 'quest.poll_close', 'quest',
          quest_row.id::text, jsonb_build_object('closesAt', quest_row.closes_at),
          jsonb_build_object('closesAt', at), request);
  RETURN QUERY SELECT quest_row.opens_at, at, false;
END $$;
REVOKE ALL ON FUNCTION close_poll(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION close_poll(uuid, uuid, uuid) TO questify_app;

-- ================================================================ what is live now (ADR-221)
-- For the calling active member (anyone else gets the same empty answer, so it names no event): `polls`, the live polls open now that they may play and have not
-- voted in, by quest_open_check's predicates (the event in play for them, the quest's window, the category seen, its
-- opening time and unlock; an operator who may not play gets none), each `closesAt` never past the event's end; and
-- `closed`, the at_close polls that closed in the last 15 minutes in a category they see. `community` is T-306b's.
CREATE FUNCTION live_state(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  playing  boolean;
BEGIN
  SELECT n.* INTO enrolled FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL);
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target;
  IF NOT polls_shown(ev) THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL);
  END IF;
  playing := play_phase(ev, enrolled) IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target AND sa.player_id = enrolled.player_id AND NOT sa.can_play);
  RETURN jsonb_build_object(
    'polls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id, 'closesAt', least(q.closes_at, ev.ends_at))
                       ORDER BY q.opens_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE playing AND q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.opens_at <= now() AND q.closes_at > now() AND (ev.ends_at IS NULL OR ev.ends_at > now())
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = enrolled.id AND qc.quest_id = q.id)),
      '[]'::jsonb),
    'closed', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id) ORDER BY q.closes_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.type_config -> 'live' ->> 'results' = 'at_close'
        AND least(q.closes_at, ev.ends_at) <= now() AND least(q.closes_at, ev.ends_at) > now() - interval '15 minutes'
        AND sees_category(enrolled.id, c)),
      '[]'::jsonb),
    'community', NULL);
END $$;
REVOKE ALL ON FUNCTION live_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_state(uuid) TO questify_app;

-- Whether the event has a live poll open now or closed in the last 15 minutes, for the API's 3-second cache: when
-- false the API answers empty without the per-player query. Names nothing; granted.
CREATE FUNCTION event_has_open_poll(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
                   AND q.closes_at > now() - interval '15 minutes')
$$;
REVOKE ALL ON FUNCTION event_has_open_poll(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_has_open_poll(uuid) TO questify_app;

-- ================================================================ the rehearsal wipe
-- As 0050, with `votes` counted as votes (one per player and quest), not option rows, and the rehearsal's sent polls
-- put back to draft so they can be sent for real. Every send before the wipe is a rehearsal send: send_poll in a live
-- event runs the go-live wipe first.
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
           'votes', (SELECT count(DISTINCT (v.enrollment_id, v.quest_id)) FROM quest_vote v
                     WHERE v.enrollment_id = ANY (accounts)),
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
  -- The rehearsal's sent polls go back to draft (no votes are left on them).
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, poll_sent_at = NULL
  WHERE q.event_id = target AND q.poll_sent_at IS NOT NULL;
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
