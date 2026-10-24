-- The ticket center (T-312, F-324 to F-326, ADR-255 to ADR-259; plan docs/plans/2026-10-24-t-312-ticket-center.md).
-- Four ticket types; the kind decides who receives it: question, problem, prize and report_player go to the event team
-- (reports to owners and editors only, never operators), app_problem and suggestion go to Questify and never carry an
-- event. The event team escalates a ticket to Questify with a note; Questify answers it, solves it or sends it back.
-- A platform admin reads exactly the rows with queue = 'questify', every read audited. No data moves.
-- Deny by default: `ticket` keeps row-level security forced and no grant; every function here is closed to PUBLIC, and
-- only the entry points are granted to the API role. 0059's functions are restated here, never edited there.

-- ================================================================ the shape (ADR-256)
ALTER TABLE ticket
  ADD COLUMN reported_enrollment_id uuid,
  ADD COLUMN app_version text CHECK (app_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
  ADD COLUMN platform text CHECK (platform IN ('ios', 'android')),
  ADD COLUMN os_version text CHECK (os_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
  ADD COLUMN device_model text CHECK (char_length(device_model) BETWEEN 1 AND 64),
  ADD COLUMN escalated_at timestamptz,
  ADD COLUMN escalated_by_staff uuid REFERENCES staff_user (id),
  ADD COLUMN escalation_note text CHECK (char_length(escalation_note) BETWEEN 1 AND 1000),
  ADD COLUMN returned_at timestamptz,
  ADD COLUMN returned_by_admin uuid REFERENCES staff_user (id),
  ADD COLUMN return_note text CHECK (char_length(return_note) BETWEEN 1 AND 1000),
  ADD COLUMN answered_by_admin uuid REFERENCES staff_user (id),
  -- A report names a member of the same event; a rehearsal wipe of that account clears only this link.
  ADD CONSTRAINT ticket_reported_fkey FOREIGN KEY (reported_enrollment_id, event_id)
    REFERENCES enrollment (id, event_id) ON DELETE SET NULL (reported_enrollment_id);

ALTER TABLE ticket DROP CONSTRAINT ticket_kind_check;
ALTER TABLE ticket DROP CONSTRAINT ticket_queue_check;
ALTER TABLE ticket DROP CONSTRAINT ticket_check;
ALTER TABLE ticket DROP CONSTRAINT ticket_check5;
ALTER TABLE ticket DROP CONSTRAINT ticket_check6;
ALTER TABLE ticket
  ADD CONSTRAINT ticket_kind_known CHECK (kind IN ('question', 'problem', 'prize', 'report_player', 'app_problem',
                                                   'suggestion')),
  ADD CONSTRAINT ticket_queue_known CHECK (queue IN ('event', 'questify')),
  -- The kind fixes the routing: Questify's kinds never carry an event, the event team's always do.
  ADD CONSTRAINT ticket_kind_event CHECK ((kind IN ('app_problem', 'suggestion')) = (event_id IS NULL)),
  ADD CONSTRAINT ticket_event_shape CHECK (
    (event_id IS NULL AND organizer_id IS NULL AND enrollment_id IS NULL AND quest_id IS NULL
     AND reported_enrollment_id IS NULL)
    OR (event_id IS NOT NULL AND organizer_id IS NOT NULL AND enrollment_id IS NOT NULL)),
  ADD CONSTRAINT ticket_platform_queue CHECK (kind NOT IN ('app_problem', 'suggestion') OR queue = 'questify'),
  -- An event ticket is in Questify's queue only while its latest hop is an escalation (CTO 3 and its re-review: a NULL
  -- escalated_at must not pass).
  ADD CONSTRAINT ticket_routing CHECK (
    kind IN ('app_problem', 'suggestion') OR queue = 'event'
    OR (escalated_at IS NOT NULL AND escalated_at > coalesce(returned_at, '-infinity'))),
  ADD CONSTRAINT ticket_escalation_shape CHECK (
    (escalated_at IS NULL) = (escalated_by_staff IS NULL) AND (escalated_at IS NULL) = (escalation_note IS NULL)),
  ADD CONSTRAINT ticket_return_shape CHECK (
    (returned_at IS NULL) = (returned_by_admin IS NULL) AND (returned_at IS NULL) = (return_note IS NULL)),
  -- A send-back only after an escalation; back in the event queue, the return is the latest hop.
  ADD CONSTRAINT ticket_return_after_escalation CHECK (
    returned_at IS NULL OR (escalated_at IS NOT NULL AND (queue = 'questify' OR returned_at >= escalated_at))),
  ADD CONSTRAINT ticket_platform_not_escalated CHECK (kind NOT IN ('app_problem', 'suggestion') OR escalated_at IS NULL),
  ADD CONSTRAINT ticket_one_answerer CHECK (num_nonnulls(answered_by_staff, answered_by_operator, answered_by_admin) <= 1),
  ADD CONSTRAINT ticket_closed_answerer CHECK (
    (status = 'closed') = (num_nonnulls(answered_by_staff, answered_by_operator, answered_by_admin) = 1)),
  -- Questify answers only in its queue; the event team only in the event's.
  ADD CONSTRAINT ticket_admin_answers_questify CHECK (answered_by_admin IS NULL OR queue = 'questify'),
  ADD CONSTRAINT ticket_team_answers_event CHECK (
    (answered_by_staff IS NULL AND answered_by_operator IS NULL) OR queue = 'event'),
  ADD CONSTRAINT ticket_reported_kind CHECK (reported_enrollment_id IS NULL OR kind = 'report_player'),
  ADD CONSTRAINT ticket_device_kind CHECK (
    CASE WHEN kind = 'app_problem'
      THEN app_version IS NOT NULL AND platform IS NOT NULL AND os_version IS NOT NULL
      ELSE app_version IS NULL AND platform IS NULL AND os_version IS NULL AND device_model IS NULL
    END);

-- Questify's queue, oldest open first and newest closed first; the admin's answer keys (no event to scope them by);
-- the report FK; the Questify caps per player; one open report per reporter and reported (CTO 4, the backstop).
CREATE INDEX ticket_questify_open_idx ON ticket (created_at, id) WHERE status = 'open' AND queue = 'questify';
CREATE INDEX ticket_questify_closed_idx ON ticket (closed_at DESC, id) WHERE status = 'closed' AND queue = 'questify';
CREATE UNIQUE INDEX ticket_answer_key_admin ON ticket (answered_by_admin, answer_key)
  WHERE answered_by_admin IS NOT NULL;
CREATE INDEX ticket_reported_idx ON ticket (reported_enrollment_id) WHERE reported_enrollment_id IS NOT NULL;
CREATE INDEX ticket_platform_player_idx ON ticket (player_id, created_at DESC) WHERE event_id IS NULL;
CREATE UNIQUE INDEX ticket_open_report_key ON ticket (player_id, reported_enrollment_id)
  WHERE kind = 'report_player' AND status = 'open';

-- ================================================================ who sees a ticket (ADR-257)
-- As 0059, and never a report: operators are often players and friends of players; owners and editors answer reports.
CREATE OR REPLACE FUNCTION operator_sees_ticket(t ticket, me uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT t.queue = 'event' AND t.kind <> 'report_player' AND t.player_id <> me
     AND (t.quest_id IS NULL OR operator_reviews_quest(t.event_id, me, t.quest_id))
$$;

-- ================================================================ sending (ADR-259)
-- The calling player's ticket to the event team: a question, a problem, a prize problem, or a report of another member
-- (by @username). In T-310's order: the enrollment FOR NO KEY UPDATE, the replay by key, then the rules. Adds to
-- 0059's refusals: HR422 username_required / username_unexpected, HQ422 (a quest on a report), HR404 unknown_player
-- (no active member of this event with that username: nothing about accounts outside it), HR403 self_report, HT409
-- already_reported (one open report per reporter and reported). The caps cover all four kinds together.
DROP FUNCTION open_ticket(uuid, text, uuid, text, text);
CREATE FUNCTION open_ticket(target_event uuid, ticket_kind text, target_quest uuid, reported_username text, body text,
                            request_key text)
  RETURNS TABLE (ticket_id bigint, status text, created_at timestamptz, marked boolean, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me       uuid := app_player_id();
  enrolled enrollment%ROWTYPE;
  earlier  ticket%ROWTYPE;
  ev       event%ROWTYPE;
  made     ticket%ROWTYPE;
  reported uuid;
  cleaned  text;
  tenth    timestamptz;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF ticket_kind IS NULL OR ticket_kind NOT IN ('question', 'problem', 'prize', 'report_player') THEN
    RAISE EXCEPTION 'a kind the event team receives' USING ERRCODE = 'HK422';
  END IF;
  IF ticket_kind = 'report_player' AND reported_username IS NULL THEN
    RAISE EXCEPTION 'a report names a username' USING ERRCODE = 'HR422', DETAIL = 'username_required';
  END IF;
  IF ticket_kind <> 'report_player' AND reported_username IS NOT NULL THEN
    RAISE EXCEPTION 'only a report names a username' USING ERRCODE = 'HR422', DETAIL = 'username_unexpected';
  END IF;
  PERFORM ensure_rehearsal_wiped(target_event);
  IF NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = target_event AND n.player_id = me)
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'not a member of this event' USING ERRCODE = 'HT403', DETAIL = 'not_member';
  END IF;
  SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = target_event AND n.player_id = me FOR NO KEY UPDATE;

  SELECT * INTO earlier FROM ticket t WHERE t.player_id = me AND t.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.event_id IS DISTINCT FROM target_event OR earlier.kind <> ticket_kind
       OR earlier.quest_id IS DISTINCT FROM target_quest
       OR (ticket_kind = 'report_player' AND NOT EXISTS (
             SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id
             WHERE n.id = earlier.reported_enrollment_id
               AND username_fold(p.username) = username_fold(reported_username))) THEN
      RAISE EXCEPTION 'this key was used for another ticket' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.created_at, earlier.marked, true;
    RETURN;
  END IF;

  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  IF NOT help_desk_on(ev) THEN
    RAISE EXCEPTION 'the help desk is off for this event' USING ERRCODE = 'HT403', DETAIL = 'feature_off';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live', 'ended')
     OR (ev.ends_at IS NOT NULL AND ev.ends_at + interval '30 days' <= now()) THEN
    RAISE EXCEPTION 'sending is closed for this event' USING ERRCODE = 'HT403', DETAIL = 'sending_closed';
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'not an active member of this event' USING ERRCODE = 'HT403', DETAIL = 'not_member';
  END IF;
  IF target_quest IS NOT NULL AND ticket_kind = 'report_player' THEN
    RAISE EXCEPTION 'a report is about a player, not a quest' USING ERRCODE = 'HQ422';
  END IF;
  IF target_quest IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = target_event) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'HQ404';
  END IF;
  IF ticket_kind = 'report_player' THEN
    SELECT n.id INTO reported FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target_event AND n.status = 'active' AND p.status = 'active'
      AND username_fold(p.username) = username_fold(reported_username);
    IF reported IS NULL THEN
      RAISE EXCEPTION 'no such player in this event' USING ERRCODE = 'HR404', DETAIL = 'unknown_player';
    END IF;
    IF reported = enrolled.id THEN
      RAISE EXCEPTION 'not yourself' USING ERRCODE = 'HR403', DETAIL = 'self_report';
    END IF;
    IF EXISTS (SELECT 1 FROM ticket t
               WHERE t.player_id = me AND t.kind = 'report_player' AND t.reported_enrollment_id = reported
                 AND t.status = 'open') THEN
      RAISE EXCEPTION 'this player is already reported' USING ERRCODE = 'HT409', DETAIL = 'already_reported';
    END IF;
  END IF;
  cleaned := clean_submission_text(body);
  IF (SELECT count(*) FROM ticket t
      WHERE t.player_id = me AND t.event_id = target_event AND t.status = 'open') >= 3 THEN
    RAISE EXCEPTION 'three requests are waiting' USING ERRCODE = 'HT409', DETAIL = 'too_many_open';
  END IF;
  SELECT t.created_at INTO tenth FROM ticket t
  WHERE t.player_id = me AND t.event_id = target_event AND t.created_at > now() - interval '24 hours'
  ORDER BY t.created_at DESC OFFSET 9 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ten requests in a day' USING ERRCODE = 'HT429',
      DETAIL = greatest(1, ceil(extract(epoch FROM tenth + interval '24 hours' - now())))::bigint::text;
  END IF;

  INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, quest_id, reported_enrollment_id, kind, body,
                      marked, idempotency_key)
  VALUES (me, enrolled.organizer_id, target_event, enrolled.id, target_quest, reported, ticket_kind, cleaned,
          text_marked(cleaned), request_key)
  RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.status, made.created_at, made.marked, false;
END $$;
REVOKE ALL ON FUNCTION open_ticket(uuid, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_ticket(uuid, text, uuid, text, text, text) TO questify_app;

-- A device fact as sent by the app: NULL stays NULL; otherwise it must match, or HD422 with the field. Internal.
CREATE FUNCTION ticket_device_fact(fact text, field text, pattern text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF fact IS NOT NULL AND fact !~ pattern THEN
    RAISE EXCEPTION 'a device fact is not usable' USING ERRCODE = 'HD422', DETAIL = field;
  END IF;
  RETURN fact;
END $$;
REVOKE ALL ON FUNCTION ticket_device_fact(text, text, text) FROM PUBLIC;

-- The calling player's app problem or suggestion to Questify, with no event (a player in no event can write). Under a
-- per-player advisory lock, then the player row FOR KEY SHARE while active (CTO 1: erasure takes that row FOR UPDATE,
-- so a send waits for an erasure in flight and finds the account gone, and an erasure waits for a send in flight and
-- then deletes its ticket), then the replay by key, the text, the device facts (an app problem needs the version, the
-- platform and the OS; the model may be NULL; a suggestion keeps none), and the caps: 3 open and 5 in 24 hours of
-- these per player. Refusals: QK422, HK422, HT403 not_member, SV422, HD422 {field}, HT409 too_many_open, HT429.
CREATE FUNCTION open_platform_ticket(ticket_kind text, body text, app_version text, platform text, os_version text,
                                     device_model text, request_key text)
  RETURNS TABLE (ticket_id bigint, status text, created_at timestamptz, marked boolean, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me      uuid := app_player_id();
  earlier ticket%ROWTYPE;
  made    ticket%ROWTYPE;
  cleaned text;
  model   text;
  fifth   timestamptz;
  problem boolean := ticket_kind = 'app_problem';
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF ticket_kind IS NULL OR ticket_kind NOT IN ('app_problem', 'suggestion') THEN
    RAISE EXCEPTION 'an app problem or a suggestion' USING ERRCODE = 'HK422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket-send:' || me, 0));
  PERFORM 1 FROM player p WHERE p.id = me AND p.status = 'active' FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the account is not active' USING ERRCODE = 'HT403', DETAIL = 'not_member';
  END IF;

  SELECT * INTO earlier FROM ticket t WHERE t.player_id = me AND t.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.event_id IS NOT NULL OR earlier.kind <> ticket_kind THEN
      RAISE EXCEPTION 'this key was used for another ticket' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.created_at, earlier.marked, true;
    RETURN;
  END IF;

  cleaned := clean_submission_text(body);
  IF problem THEN
    IF app_version IS NULL THEN
      RAISE EXCEPTION 'the app version is required' USING ERRCODE = 'HD422', DETAIL = 'app_version';
    END IF;
    IF platform IS NULL OR platform NOT IN ('ios', 'android') THEN
      RAISE EXCEPTION 'the platform is required' USING ERRCODE = 'HD422', DETAIL = 'platform';
    END IF;
    IF os_version IS NULL THEN
      RAISE EXCEPTION 'the OS version is required' USING ERRCODE = 'HD422', DETAIL = 'os_version';
    END IF;
    PERFORM ticket_device_fact(app_version, 'app_version', '^[0-9A-Za-z.+-]{1,32}$');
    PERFORM ticket_device_fact(os_version, 'os_version', '^[0-9A-Za-z.+-]{1,32}$');
    model := btrim(normalize(device_model, NFC));
    PERFORM ticket_device_fact(model, 'device_model', '^.{1,64}$');
    IF model ~ '[\x01-\x1F\x7F‪-‮⁦-⁩]' THEN
      RAISE EXCEPTION 'a device fact is not usable' USING ERRCODE = 'HD422', DETAIL = 'device_model';
    END IF;
  END IF;
  IF (SELECT count(*) FROM ticket t
      WHERE t.player_id = me AND t.event_id IS NULL AND t.status = 'open') >= 3 THEN
    RAISE EXCEPTION 'three requests are waiting' USING ERRCODE = 'HT409', DETAIL = 'too_many_open';
  END IF;
  SELECT t.created_at INTO fifth FROM ticket t
  WHERE t.player_id = me AND t.event_id IS NULL AND t.created_at > now() - interval '24 hours'
  ORDER BY t.created_at DESC OFFSET 4 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'five requests in a day' USING ERRCODE = 'HT429',
      DETAIL = greatest(1, ceil(extract(epoch FROM fifth + interval '24 hours' - now())))::bigint::text;
  END IF;

  INSERT INTO ticket (player_id, kind, queue, body, marked, idempotency_key, app_version, platform, os_version,
                      device_model)
  VALUES (me, ticket_kind, 'questify', cleaned, text_marked(cleaned), request_key,
          CASE WHEN problem THEN app_version END, CASE WHEN problem THEN platform END,
          CASE WHEN problem THEN os_version END, CASE WHEN problem THEN model END)
  RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.status, made.created_at, made.marked, false;
END $$;
REVOKE ALL ON FUNCTION open_platform_ticket(text, text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_platform_ticket(text, text, text, text, text, text, text) TO questify_app;

-- ================================================================ the player's reads (FR-1824, partly)
-- As 0059, in every queue: plus whether it waits with Questify, which team answered (`event` or `questify`, never a
-- person, never a note), and the username the sender reported (NULL once that account is deleted). NULL lists every
-- event's tickets and the event-less ones (`event_id` NULL).
DROP FUNCTION own_tickets(uuid);
CREATE FUNCTION own_tickets(target_event uuid)
  RETURNS TABLE (id bigint, event_id uuid, event_name_ar text, event_name_en text, kind text, quest_id uuid,
                 quest_title_ar text, quest_title_en text, body text, status text, outcome text, reply text,
                 closed_at timestamptz, created_at timestamptz, unread boolean, with_questify boolean,
                 answered_by_team text, reported_username text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.event_id, e.name_ar, e.name_en, t.kind, t.quest_id, q.title_ar, q.title_en, t.body, t.status,
         t.outcome, t.reply, t.closed_at, t.created_at, t.status = 'closed' AND t.player_seen_at IS NULL,
         t.status = 'open' AND t.queue = 'questify',
         CASE WHEN t.answered_by_admin IS NOT NULL THEN 'questify'
              WHEN t.answered_by_staff IS NOT NULL OR t.answered_by_operator IS NOT NULL THEN 'event' END,
         rp.username
  FROM ticket t
  JOIN player p ON p.id = t.player_id AND p.status = 'active'
  LEFT JOIN event e ON e.id = t.event_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN enrollment rn ON rn.id = t.reported_enrollment_id
  LEFT JOIN player rp ON rp.id = rn.player_id
  WHERE t.player_id = app_player_id() AND (target_event IS NULL OR t.event_id = target_event)
  ORDER BY t.created_at DESC, t.id DESC
  LIMIT CASE WHEN target_event IS NULL THEN 100 ELSE 50 END
$$;
REVOKE ALL ON FUNCTION own_tickets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_tickets(uuid) TO questify_app;

-- As 0059; NULL counts every unseen answer in every queue (the profile tab's dot).
CREATE OR REPLACE FUNCTION own_unread_tickets(target_event uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer
  FROM ticket t
  JOIN player p ON p.id = t.player_id AND p.status = 'active'
  WHERE t.player_id = app_player_id() AND (target_event IS NULL OR t.event_id = target_event)
    AND t.status = 'closed' AND t.player_seen_at IS NULL
$$;

-- ================================================================ answering
-- As 0059, and an operator never learns a report exists: a report is HT404 to them, as a missing ticket. A ticket
-- that moved to Questify's queue is HT404 to an operator (it left their inbox) and HT409 moved to the team (a stale
-- page: they can still read it under With Questify), as the console answers a ticket sent back (CTO code review 2).
CREATE OR REPLACE FUNCTION answer_core(ev event, target bigint, reply text, request_key text, operator uuid,
                                       staff uuid, request uuid)
  RETURNS TABLE (ticket_id bigint, outcome text, replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  earlier ticket%ROWTYPE;
  item    ticket%ROWTYPE;
  cleaned text;
  result  text;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'ticket-answer:' || ev.id || ':' || coalesce('s' || staff, 'o' || operator) || ':' || request_key, 0));
  SELECT t.* INTO earlier FROM ticket t
  WHERE t.event_id = ev.id AND t.answer_key = request_key
    AND ((staff IS NOT NULL AND t.answered_by_staff = staff)
         OR (operator IS NOT NULL AND t.answered_by_operator = operator));
  IF FOUND AND earlier.id <> target THEN
    RAISE EXCEPTION 'this key was used for another answer' USING ERRCODE = 'QK422';
  END IF;

  SELECT t.* INTO item FROM ticket t WHERE t.id = target AND t.event_id = ev.id FOR UPDATE;
  IF NOT FOUND
     OR (operator IS NOT NULL AND (item.kind = 'report_player' OR item.queue <> 'event')) THEN
    RAISE EXCEPTION 'no such ticket in this event' USING ERRCODE = 'HT404';
  END IF;
  IF item.queue <> 'event' THEN
    RAISE EXCEPTION 'the ticket is with Questify' USING ERRCODE = 'HT409', DETAIL = 'moved';
  END IF;
  IF operator IS NOT NULL THEN
    IF item.player_id = operator THEN
      RAISE EXCEPTION 'not your own request' USING ERRCODE = 'HT403', DETAIL = 'self_answer';
    END IF;
    IF NOT operator_sees_ticket(item, operator) THEN
      RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'HT403', DETAIL = 'outside_quests';
    END IF;
  END IF;
  IF item.status <> 'open' THEN
    IF item.answer_key = request_key AND (item.answered_by_staff IS NOT DISTINCT FROM staff)
       AND (item.answered_by_operator IS NOT DISTINCT FROM operator) THEN
      IF (reply IS NULL) <> (item.outcome = 'solved') THEN
        RAISE EXCEPTION 'this key was used for another answer' USING ERRCODE = 'QK422';
      END IF;
      RETURN QUERY SELECT item.id, item.outcome, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'already answered' USING ERRCODE = 'HT409', DETAIL = 'already_closed';
  END IF;
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'HT409', DETAIL = 'event_closed';
  END IF;

  IF reply IS NOT NULL THEN
    cleaned := clean_submission_text(reply);
  END IF;
  result := CASE WHEN cleaned IS NULL THEN 'solved' ELSE 'answered' END;
  UPDATE ticket t
  SET status = 'closed', outcome = result, reply = cleaned, answered_by_staff = staff,
      answered_by_operator = operator, answer_key = request_key, closed_at = now()
  WHERE t.id = item.id;
  IF staff IS NOT NULL THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('staff', staff, ev.organizer_id, ev.id,
            CASE WHEN result = 'answered' THEN 'event.ticket_answered' ELSE 'event.ticket_solved' END,
            'ticket', item.id::text, jsonb_build_object('outcome', result), request);
  END IF;
  RETURN QUERY SELECT item.id, result, false;
END $$;

-- ================================================================ the team's reads (FR-339)
-- The dashboard's tickets (owners and editors in the event's scope; AN404 otherwise), by tab: `open` (waiting in the
-- event queue, oldest first), `with_questify` (escalated and open, read-only, oldest first), `closed` (from either
-- queue, newest first); keyset paged by id, optionally one kind. As 0059, plus the reported member, the escalation (its
-- note and who escalated), Questify's send-back note, and `admin` as the answerer with no name (never an admin's email).
DROP FUNCTION event_tickets(uuid, text, text, bigint, integer);
CREATE FUNCTION event_tickets(target_event uuid, wanted text, wanted_kind text, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, kind text, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, marked boolean, status text, queue text, outcome text,
                 reply text, answered_by text, answerer text, answerer_deleted boolean, created_at timestamptz,
                 closed_at timestamptz, reported_enrollment_id uuid, reported_username text,
                 escalated_at timestamptz, escalation_note text, escalated_by text, returned_at timestamptz,
                 return_note text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT t.id, t.kind, t.quest_id, q.title_ar, q.title_en, t.enrollment_id, p.username, p.avatar, t.body, t.marked,
         t.status, t.queue, t.outcome, t.reply,
         CASE WHEN t.answered_by_operator IS NOT NULL THEN 'operator'
              WHEN t.answered_by_staff IS NOT NULL THEN 'staff'
              WHEN t.answered_by_admin IS NOT NULL THEN 'admin' END,
         coalesce(op.username, su.email), coalesce(op.status = 'deleted', false), t.created_at, t.closed_at,
         t.reported_enrollment_id, rp.username, t.escalated_at, t.escalation_note, es.email, t.returned_at,
         t.return_note
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN player op ON op.id = t.answered_by_operator
  LEFT JOIN staff_user su ON su.id = t.answered_by_staff
  LEFT JOIN staff_user es ON es.id = t.escalated_by_staff
  LEFT JOIN enrollment rn ON rn.id = t.reported_enrollment_id
  LEFT JOIN player rp ON rp.id = rn.player_id
  WHERE t.event_id = ev.id
    AND (wanted_kind IS NULL OR t.kind = wanted_kind)
    AND CASE wanted
          WHEN 'open' THEN t.status = 'open' AND t.queue = 'event' AND (cursor_id IS NULL OR t.id > cursor_id)
          WHEN 'with_questify' THEN t.status = 'open' AND t.queue = 'questify'
                                    AND (cursor_id IS NULL OR t.id > cursor_id)
          WHEN 'closed' THEN t.status = 'closed' AND (cursor_id IS NULL OR t.id < cursor_id)
          ELSE false
        END
  ORDER BY CASE WHEN wanted = 'closed' THEN -t.id ELSE t.id END
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION event_tickets(uuid, text, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_tickets(uuid, text, text, bigint, integer) TO questify_app;

-- The dashboard's tab counts, the event nav's open count, and the waiting tickets (open, in either queue) by kind,
-- the start T-616 builds on (AN404 as above).
DROP FUNCTION event_ticket_counts(uuid);
CREATE FUNCTION event_ticket_counts(target_event uuid)
  RETURNS TABLE (open integer, with_questify integer, closed integer, waiting_by_kind jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT (count(*) FILTER (WHERE t.status = 'open' AND t.queue = 'event'))::integer,
         (count(*) FILTER (WHERE t.status = 'open' AND t.queue = 'questify'))::integer,
         (count(*) FILTER (WHERE t.status = 'closed'))::integer,
         coalesce((SELECT jsonb_object_agg(w.kind, w.n)
                   FROM (SELECT x.kind, count(*)::integer AS n FROM ticket x
                         WHERE x.event_id = ev.id AND x.status = 'open' GROUP BY x.kind) w), '{}'::jsonb)
  FROM ticket t WHERE t.event_id = ev.id;
END $$;
REVOKE ALL ON FUNCTION event_ticket_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_ticket_counts(uuid) TO questify_app;

-- ================================================================ escalation (ADR-258)
-- An owner's or editor's escalation of an open ticket in the event queue to Questify (AN404 out of scope), with a note
-- of what the team tried (SV422). The ticket keeps its event, quest, sender and caps; it leaves operators and the
-- team's answer doors at once. The same staff member's same note on a ticket already with Questify (and not sent back
-- since) is a replay. Refusals: HT404 (not a ticket of this event), HT409 not_open, HT409 moved (with Questify
-- already), HT409 event_closed (archived). Audited with ids only, never the note.
CREATE FUNCTION staff_escalate_ticket(target_event uuid, target bigint, note text, request uuid)
  RETURNS TABLE (ticket_id bigint, queue text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  ev      event := award_event_of(target_event);
  staff   uuid := app_staff_user_id();
  item    ticket%ROWTYPE;
  cleaned text := clean_submission_text(note);
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT t.* INTO item FROM ticket t WHERE t.id = target AND t.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such ticket in this event' USING ERRCODE = 'HT404';
  END IF;
  IF item.status <> 'open' THEN
    RAISE EXCEPTION 'the ticket is closed' USING ERRCODE = 'HT409', DETAIL = 'not_open';
  END IF;
  IF item.queue = 'questify' THEN
    IF item.escalated_by_staff = staff AND item.escalation_note = cleaned THEN
      RETURN QUERY SELECT item.id, item.queue, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'the ticket is with Questify already' USING ERRCODE = 'HT409', DETAIL = 'moved';
  END IF;
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'HT409', DETAIL = 'event_closed';
  END IF;
  UPDATE ticket t
  SET queue = 'questify', escalated_at = now(), escalated_by_staff = staff, escalation_note = cleaned
  WHERE t.id = item.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', staff, ev.organizer_id, ev.id, 'event.ticket_escalated', 'ticket', item.id::text,
          jsonb_build_object('queue', 'questify'), request);
  RETURN QUERY SELECT item.id, 'questify'::text, false;
END $$;
REVOKE ALL ON FUNCTION staff_escalate_ticket(uuid, bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_escalate_ticket(uuid, bigint, text, uuid) TO questify_app;

-- ================================================================ the Questify queue (ADR-257, ADR-258)
-- The calling active platform admin, re-read from the account (the request flag alone opens nothing). Internal.
CREATE FUNCTION ticket_admin() RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := app_admin_id();
BEGIN
  IF admin IS NULL THEN
    RAISE EXCEPTION 'only a Questify admin can do this' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN admin;
END $$;
REVOKE ALL ON FUNCTION ticket_admin() FROM PUBLIC;

-- Questify's queue, for an active platform admin only: exactly the rows with queue = 'questify' (app problems,
-- suggestions, and event tickets while escalated and after Questify closed them). `open` oldest first, `closed` newest
-- first, keyset by id, at most 100; optionally one kind and one source (`direct`: no event; `escalated`). Each row has
-- the first 120 characters, never the full text; the sender's @username (no avatar, contact, name or birth year).
-- Audited: one `console.tickets_read` row per distinct (organizer, event) among the rows shown, with their ids (CTO 2),
-- and one with no organizer for the event-less ones.
CREATE FUNCTION console_tickets(wanted text, wanted_kind text, wanted_source text, cursor_id bigint, page integer,
                                request uuid)
  RETURNS TABLE (id bigint, kind text, preview text, marked boolean, status text, outcome text,
                 created_at timestamptz, closed_at timestamptz, username text, organizer_id uuid,
                 organizer_name text, event_id uuid, event_name_ar text, event_name_en text, quest_title_ar text,
                 quest_title_en text, reported_username text, escalated_at timestamptz, escalated_by text,
                 app_version text, platform text, os_version text, device_model text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  admin uuid := ticket_admin();
  shown bigint[];
BEGIN
  shown := ARRAY(
    SELECT t.id FROM ticket t
    WHERE t.queue = 'questify'
      AND (wanted_kind IS NULL OR t.kind = wanted_kind)
      AND CASE wanted_source
            WHEN 'direct' THEN t.event_id IS NULL
            WHEN 'escalated' THEN t.event_id IS NOT NULL
            ELSE wanted_source IS NULL
          END
      AND CASE wanted
            WHEN 'open' THEN t.status = 'open' AND (cursor_id IS NULL OR t.id > cursor_id)
            WHEN 'closed' THEN t.status = 'closed' AND (cursor_id IS NULL OR t.id < cursor_id)
            ELSE false
          END
    ORDER BY CASE WHEN wanted = 'closed' THEN -t.id ELSE t.id END
    LIMIT least(greatest(coalesce(page, 50), 1), 100));
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, after, request_id)
  SELECT 'admin', admin, t.organizer_id, t.event_id, 'console.tickets_read', 'ticket',
         jsonb_build_object('status', wanted, 'ids', jsonb_agg(t.id::text ORDER BY t.id)), request
  FROM ticket t WHERE t.id = ANY (shown)
  GROUP BY t.organizer_id, t.event_id;
  RETURN QUERY
  SELECT t.id, t.kind, left(t.body, 120), t.marked, t.status, t.outcome, t.created_at, t.closed_at, p.username,
         t.organizer_id, o.name, t.event_id, e.name_ar, e.name_en, q.title_ar, q.title_en, rp.username,
         t.escalated_at, es.email, t.app_version, t.platform, t.os_version, t.device_model
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN organizer o ON o.id = t.organizer_id
  LEFT JOIN event e ON e.id = t.event_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN staff_user es ON es.id = t.escalated_by_staff
  LEFT JOIN enrollment rn ON rn.id = t.reported_enrollment_id
  LEFT JOIN player rp ON rp.id = rn.player_id
  WHERE t.id = ANY (shown)
  ORDER BY CASE WHEN wanted = 'closed' THEN -t.id ELSE t.id END;
END $$;
REVOKE ALL ON FUNCTION console_tickets(text, text, text, bigint, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_tickets(text, text, text, bigint, integer, uuid) TO questify_app;

-- The console's counts of Questify's queue (numbers only, so not audited): open, closed, and the open by source.
CREATE FUNCTION console_ticket_counts()
  RETURNS TABLE (open integer, closed integer, open_direct integer, open_escalated integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM ticket_admin();
  RETURN QUERY
  SELECT (count(*) FILTER (WHERE t.status = 'open'))::integer, (count(*) FILTER (WHERE t.status = 'closed'))::integer,
         (count(*) FILTER (WHERE t.status = 'open' AND t.event_id IS NULL))::integer,
         (count(*) FILTER (WHERE t.status = 'open' AND t.event_id IS NOT NULL))::integer
  FROM ticket t WHERE t.queue = 'questify';
END $$;
REVOKE ALL ON FUNCTION console_ticket_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_ticket_counts() TO questify_app;

-- One ticket of Questify's queue with its full text, the reply, the notes and who escalated (an email, for follow-up);
-- HT404 for anything else (an event ticket never escalated, one sent back, a missing id: one answer). Audited as
-- `console.ticket_read` with the event's ids, so the event's log shows every support look at its tickets.
CREATE FUNCTION console_ticket(target bigint, request uuid)
  RETURNS TABLE (id bigint, kind text, body text, marked boolean, status text, outcome text, reply text,
                 created_at timestamptz, closed_at timestamptz, username text, organizer_id uuid,
                 organizer_name text, event_id uuid, event_name_ar text, event_name_en text, event_status text,
                 quest_title_ar text, quest_title_en text, reported_username text, escalated_at timestamptz,
                 escalated_by text, escalation_note text, returned_at timestamptz, return_note text,
                 answered_by text, app_version text, platform text, os_version text, device_model text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  admin uuid := ticket_admin();
  item  ticket%ROWTYPE;
BEGIN
  SELECT t.* INTO item FROM ticket t WHERE t.id = target AND t.queue = 'questify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such ticket in the queue' USING ERRCODE = 'HT404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('admin', admin, item.organizer_id, item.event_id, 'console.ticket_read', 'ticket', item.id::text, request);
  RETURN QUERY
  SELECT t.id, t.kind, t.body, t.marked, t.status, t.outcome, t.reply, t.created_at, t.closed_at, p.username,
         t.organizer_id, o.name, t.event_id, e.name_ar, e.name_en,
         CASE WHEN e.id IS NOT NULL THEN event_status_now(e.status, e.starts_at, e.ends_at) END,
         q.title_ar, q.title_en, rp.username, t.escalated_at, es.email, t.escalation_note, t.returned_at,
         t.return_note, ad.email, t.app_version, t.platform, t.os_version, t.device_model
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN organizer o ON o.id = t.organizer_id
  LEFT JOIN event e ON e.id = t.event_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN staff_user es ON es.id = t.escalated_by_staff
  LEFT JOIN staff_user ad ON ad.id = t.answered_by_admin
  LEFT JOIN enrollment rn ON rn.id = t.reported_enrollment_id
  LEFT JOIN player rp ON rp.id = rn.player_id
  WHERE t.id = item.id;
END $$;
REVOKE ALL ON FUNCTION console_ticket(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_ticket(bigint, uuid) TO questify_app;

-- Questify's answer (a reply of 1 to 1000 characters) or solve (NULL) of a ticket in its queue, whatever the event's
-- state. T-310's replay rules with the admin's own key index: the key under an advisory lock, a replay on the same
-- ticket answers the first outcome, on another ticket or for the other outcome QK422. Refusals: HT404 (never in the
-- queue), HT409 moved (sent back since), HT409 already_closed, SV422. Audited with the event's ids, never the text.
CREATE FUNCTION admin_answer_ticket(target bigint, reply text, request_key text, request uuid)
  RETURNS TABLE (ticket_id bigint, outcome text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  admin   uuid := ticket_admin();
  earlier ticket%ROWTYPE;
  item    ticket%ROWTYPE;
  cleaned text;
  result  text;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket-answer-admin:' || admin || ':' || request_key, 0));
  SELECT t.* INTO earlier FROM ticket t WHERE t.answered_by_admin = admin AND t.answer_key = request_key;
  IF FOUND AND earlier.id <> target THEN
    RAISE EXCEPTION 'this key was used for another answer' USING ERRCODE = 'QK422';
  END IF;

  SELECT t.* INTO item FROM ticket t WHERE t.id = target FOR UPDATE;
  IF NOT FOUND OR (item.queue <> 'questify' AND item.escalated_at IS NULL) THEN
    RAISE EXCEPTION 'no such ticket in the queue' USING ERRCODE = 'HT404';
  END IF;
  IF item.queue <> 'questify' THEN
    RAISE EXCEPTION 'the ticket went back to the event team' USING ERRCODE = 'HT409', DETAIL = 'moved';
  END IF;
  IF item.status <> 'open' THEN
    IF item.answer_key = request_key AND item.answered_by_admin = admin THEN
      IF (reply IS NULL) <> (item.outcome = 'solved') THEN
        RAISE EXCEPTION 'this key was used for another answer' USING ERRCODE = 'QK422';
      END IF;
      RETURN QUERY SELECT item.id, item.outcome, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'already answered' USING ERRCODE = 'HT409', DETAIL = 'already_closed';
  END IF;

  IF reply IS NOT NULL THEN
    cleaned := clean_submission_text(reply);
  END IF;
  result := CASE WHEN cleaned IS NULL THEN 'solved' ELSE 'answered' END;
  UPDATE ticket t
  SET status = 'closed', outcome = result, reply = cleaned, answered_by_admin = admin, answer_key = request_key,
      closed_at = now()
  WHERE t.id = item.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('admin', admin, item.organizer_id, item.event_id,
          CASE WHEN result = 'answered' THEN 'console.ticket_answered' ELSE 'console.ticket_solved' END,
          'ticket', item.id::text, jsonb_build_object('outcome', result), request);
  RETURN QUERY SELECT item.id, result, false;
END $$;
REVOKE ALL ON FUNCTION admin_answer_ticket(bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_answer_ticket(bigint, text, text, uuid) TO questify_app;

-- Questify sends an escalated event ticket back to the event team with a note (SV422): queue → event, the return
-- columns set (the escalation's stay for the history); operators see it again by T-310's rule. The same admin's same
-- note on a ticket already back is a replay. Refusals: HT404 (never in the queue), HT409 not_escalated (an app problem
-- or a suggestion), HT409 moved (back already), HT409 already_closed, HT409 event_closed (archived: the team can no
-- longer answer). Audited with the event's ids, never the note.
CREATE FUNCTION admin_return_ticket(target bigint, note text, request uuid)
  RETURNS TABLE (ticket_id bigint, queue text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  admin   uuid := ticket_admin();
  item    ticket%ROWTYPE;
  cleaned text := clean_submission_text(note);
  ev      event%ROWTYPE;
BEGIN
  SELECT t.* INTO item FROM ticket t WHERE t.id = target FOR UPDATE;
  IF NOT FOUND OR (item.queue <> 'questify' AND item.escalated_at IS NULL) THEN
    RAISE EXCEPTION 'no such ticket in the queue' USING ERRCODE = 'HT404';
  END IF;
  IF item.event_id IS NULL THEN
    RAISE EXCEPTION 'only an escalated ticket goes back' USING ERRCODE = 'HT409', DETAIL = 'not_escalated';
  END IF;
  IF item.queue <> 'questify' THEN
    IF item.returned_by_admin = admin AND item.return_note = cleaned THEN
      RETURN QUERY SELECT item.id, item.queue, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'the ticket went back to the event team' USING ERRCODE = 'HT409', DETAIL = 'moved';
  END IF;
  IF item.status <> 'open' THEN
    RAISE EXCEPTION 'already answered' USING ERRCODE = 'HT409', DETAIL = 'already_closed';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = item.event_id;
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'HT409', DETAIL = 'event_closed';
  END IF;
  UPDATE ticket t SET queue = 'event', returned_at = now(), returned_by_admin = admin, return_note = cleaned
  WHERE t.id = item.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('admin', admin, item.organizer_id, item.event_id, 'console.ticket_returned', 'ticket', item.id::text,
          jsonb_build_object('queue', 'event'), request);
  RETURN QUERY SELECT item.id, 'event'::text, false;
END $$;
REVOKE ALL ON FUNCTION admin_return_ticket(bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_return_ticket(bigint, text, uuid) TO questify_app;

-- ================================================================ retention (Q-210, Q-220)
-- As 0059, and every hop restarts the clock: a ticket goes 90 days after the latest of its event's end, its sending,
-- its escalation, its send-back and its closing (CTO 5). A ticket with no event goes 90 days after its closing and is
-- never purged by age while open (it waits in the console). Reads across organizers on purpose (rules.md allows this
-- for retention sweeps).
CREATE OR REPLACE FUNCTION purge_ended_tickets(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  WITH due AS (
    SELECT t.id FROM ticket t LEFT JOIN event e ON e.id = t.event_id
    WHERE (t.event_id IS NOT NULL OR t.status = 'closed')
      AND greatest(coalesce(e.ends_at, t.created_at), t.created_at, t.escalated_at, t.returned_at, t.closed_at)
          + interval '90 days' <= now()
    ORDER BY t.created_at, t.id
    LIMIT least(greatest(coalesce(batch, 1000), 1), 1000)
    FOR UPDATE OF t SKIP LOCKED)
  DELETE FROM ticket t USING due WHERE t.id = due.id;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
