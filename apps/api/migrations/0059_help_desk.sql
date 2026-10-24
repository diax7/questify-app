-- The help desk (T-310, F-118, F-180, ADR-246 to ADR-248; plan docs/plans/2026-10-24-t-310-help-desk.md). A player
-- sends the event team a question or a problem report, from the event or from a quest; operators with `help_desk`
-- answer it from staff mode's Inbox, owners and editors from the dashboard. One reply closes a ticket (ADR-105), or the
-- team closes it as solved with no reply. A ticket is visible only to the player who sent it and the event team.
-- Deny by default: `ticket` has row-level security forced, PUBLIC revoked and no grant; every new function is closed
-- to PUBLIC here, and only the entry points below are granted to the API role.

-- ================================================================ the tickets (ADR-246)
CREATE TABLE ticket (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The sender: the player's reads and erasure key on it (T-312's non-event tickets have no enrollment).
  player_id            uuid NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  organizer_id         uuid,
  event_id             uuid,
  enrollment_id        uuid,
  -- A deleted quest keeps its tickets: only this column is cleared (they become event-wide).
  quest_id             uuid,
  kind                 text NOT NULL CHECK (kind IN ('question', 'problem')),
  -- Where the ticket waits; T-312 adds 'questify'.
  queue                text NOT NULL DEFAULT 'event' CHECK (queue IN ('event')),
  -- Personal data the player wrote: never in logs, audit rows or push text.
  body                 text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  -- A word-list hit (FR-1628): marked for the team, never blocked.
  marked               boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  outcome              text CHECK (outcome IN ('answered', 'solved')),
  reply                text CHECK (reply IS NULL OR char_length(reply) BETWEEN 1 AND 1000),
  -- Who answered: shown to the team, never to the player (who sees "The event team").
  answered_by_staff    uuid REFERENCES staff_user (id),
  answered_by_operator uuid REFERENCES player (id),
  answer_key           text CHECK (answer_key IS NULL OR length(answer_key) BETWEEN 1 AND 255),
  closed_at            timestamptz,
  player_seen_at       timestamptz,
  idempotency_key      text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, idempotency_key),
  CHECK (queue <> 'event' OR (event_id IS NOT NULL AND organizer_id IS NOT NULL AND enrollment_id IS NOT NULL)),
  CHECK ((status = 'closed') = (outcome IS NOT NULL)),
  CHECK ((coalesce(outcome, '') = 'answered') = (reply IS NOT NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((status = 'closed') = (answer_key IS NOT NULL)),
  CHECK (answered_by_staff IS NULL OR answered_by_operator IS NULL),
  CHECK ((status = 'closed') = (answered_by_staff IS NOT NULL OR answered_by_operator IS NOT NULL)),
  CHECK (player_seen_at IS NULL OR status = 'closed'),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE SET NULL (quest_id)
);
-- The inbox and its count; the dashboard's tabs; the player's list and the caps; the quest FK.
CREATE INDEX ticket_open_idx ON ticket (event_id, created_at, id) WHERE status = 'open' AND queue = 'event';
CREATE INDEX ticket_event_idx ON ticket (event_id, status, id);
CREATE INDEX ticket_player_idx ON ticket (player_id, event_id, created_at DESC);
CREATE INDEX ticket_quest_idx ON ticket (quest_id);
-- An answerer's key answers their first outcome; unique per answerer and event (as submission.review_key).
CREATE UNIQUE INDEX ticket_answer_key_staff ON ticket (event_id, answered_by_staff, answer_key)
  WHERE answered_by_staff IS NOT NULL;
CREATE UNIQUE INDEX ticket_answer_key_operator ON ticket (event_id, answered_by_operator, answer_key)
  WHERE answered_by_operator IS NOT NULL;
ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ticket FROM PUBLIC;

-- ================================================================ the rules (ADR-247, ADR-248)
-- The event's own switch (`config.features.helpDesk`), on unless set false. The platform's is the API's. Internal.
CREATE FUNCTION help_desk_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> 'helpDesk' <> 'false'::jsonb, true)
$$;
REVOKE ALL ON FUNCTION help_desk_on(event) FROM PUBLIC;

-- An operator sees a ticket of their event that is not their own, event-wide or for a quest inside their limit
-- (operator_reviews_quest answers false for a NULL quest to a limited operator, so NULL is let through here). Internal.
CREATE FUNCTION operator_sees_ticket(t ticket, me uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT t.queue = 'event' AND t.player_id <> me
     AND (t.quest_id IS NULL OR operator_reviews_quest(t.event_id, me, t.quest_id))
$$;
REVOKE ALL ON FUNCTION operator_sees_ticket(ticket, uuid) FROM PUBLIC;

-- The calling operator of this event with the help-desk ability: OP403 not an operator, OA403 the ability is off.
CREATE FUNCTION help_operator(target_event uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('help_desk' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'the help desk is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  RETURN me;
END $$;
REVOKE ALL ON FUNCTION help_operator(uuid) FROM PUBLIC;

-- ================================================================ sending (FR-337, ADR-248)
-- The calling player's question or problem report in an event, optionally about one of its quests. In submit_quest's
-- order: the enrollment FOR NO KEY UPDATE, then the replay by key (two sends with one key serialize here, so the second
-- is a replay), then the rules. Refusals: QK422 (the key: missing, or used for another ticket), HK422 (the kind),
-- HT403 not_member (no enrollment, not active, or the account not active), HT403 feature_off (`helpDesk` off),
-- HT403 sending_closed (a draft or archived event, or 30 days after its end), HQ404 (not a quest of this event),
-- SV422 (the text), HT409 too_many_open (3 open), HT429 (10 in 24 hours; DETAIL is the seconds to wait).
CREATE FUNCTION open_ticket(target_event uuid, ticket_kind text, target_quest uuid, body text, request_key text)
  RETURNS TABLE (ticket_id bigint, status text, created_at timestamptz, marked boolean, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me       uuid := app_player_id();
  enrolled enrollment%ROWTYPE;
  earlier  ticket%ROWTYPE;
  ev       event%ROWTYPE;
  made     ticket%ROWTYPE;
  cleaned  text;
  tenth    timestamptz;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF ticket_kind IS NULL OR ticket_kind NOT IN ('question', 'problem') THEN
    RAISE EXCEPTION 'a question or a problem' USING ERRCODE = 'HK422';
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
       OR earlier.quest_id IS DISTINCT FROM target_quest THEN
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
  IF target_quest IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = target_event) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'HQ404';
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

  INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, quest_id, kind, body, marked, idempotency_key)
  VALUES (me, enrolled.organizer_id, target_event, enrolled.id, target_quest, ticket_kind, cleaned,
          text_marked(cleaned), request_key)
  RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.status, made.created_at, made.marked, false;
END $$;
REVOKE ALL ON FUNCTION open_ticket(uuid, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_ticket(uuid, text, uuid, text, text) TO questify_app;

-- ================================================================ the player's reads (FR-338, FR-339)
-- The calling player's own tickets: in one event (newest first, at most 50), or with NULL in every event (at most 100,
-- each with its event's name) for the profile's Your requests. In any enrollment status and whatever the switch, while
-- the account is active. Never who answered; never anyone else's ticket.
CREATE FUNCTION own_tickets(target_event uuid)
  RETURNS TABLE (id bigint, event_id uuid, event_name_ar text, event_name_en text, kind text, quest_id uuid,
                 quest_title_ar text, quest_title_en text, body text, status text, outcome text, reply text,
                 closed_at timestamptz, created_at timestamptz, unread boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.event_id, e.name_ar, e.name_en, t.kind, t.quest_id, q.title_ar, q.title_en, t.body, t.status,
         t.outcome, t.reply, t.closed_at, t.created_at, t.status = 'closed' AND t.player_seen_at IS NULL
  FROM ticket t
  JOIN player p ON p.id = t.player_id AND p.status = 'active'
  LEFT JOIN event e ON e.id = t.event_id
  LEFT JOIN quest q ON q.id = t.quest_id
  WHERE t.player_id = app_player_id() AND (target_event IS NULL OR t.event_id = target_event)
  ORDER BY t.created_at DESC, t.id DESC
  LIMIT CASE WHEN target_event IS NULL THEN 100 ELSE 50 END
$$;
REVOKE ALL ON FUNCTION own_tickets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_tickets(uuid) TO questify_app;

-- How many of the calling player's answers in an event they have not seen yet (Home's strip). 0 for anyone else.
CREATE FUNCTION own_unread_tickets(target_event uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer
  FROM ticket t
  JOIN player p ON p.id = t.player_id AND p.status = 'active'
  WHERE t.player_id = app_player_id() AND t.event_id = target_event AND t.status = 'closed'
    AND t.player_seen_at IS NULL
$$;
REVOKE ALL ON FUNCTION own_unread_tickets(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_unread_tickets(uuid) TO questify_app;

-- The calling player saw these answers: only their own closed tickets, in that event, or in any event with NULL (the
-- profile's Your requests lists every event's). Answers how many were newly marked.
CREATE FUNCTION mark_tickets_seen(target_event uuid, ids bigint[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := app_player_id();
  changed integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE ticket t SET player_seen_at = now()
  WHERE t.player_id = me AND (target_event IS NULL OR t.event_id = target_event)
    AND t.id = ANY (coalesce(ids, '{}')) AND t.status = 'closed' AND t.player_seen_at IS NULL
    AND EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active');
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION mark_tickets_seen(uuid, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_tickets_seen(uuid, bigint[]) TO questify_app;

-- ================================================================ answering (FR-338)
-- One answer by a staff member (`staff`) or an operator (`operator`), already checked by the entry points: a reply of
-- 1 to 1000 characters, or NULL to close it as solved. The ticket FOR UPDATE; only an open one moves. A replay of the
-- answerer's key on the same ticket answers the first outcome (also when it waited on the lock); on another ticket, or
-- for the other outcome, it is QK422. Refusals: HT404 (no such ticket here, or an operator's own is never theirs to
-- see), HT403 self_answer, HT403 outside_quests, HT409 already_closed, HT409 event_closed (archived), SV422 (the
-- reply). Staff answers are audited with ids and the outcome only; operators are recorded on the row.
CREATE FUNCTION answer_core(ev event, target bigint, reply text, request_key text, operator uuid, staff uuid,
                            request uuid)
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
  SELECT t.* INTO earlier FROM ticket t
  WHERE t.event_id = ev.id AND t.answer_key = request_key
    AND ((staff IS NOT NULL AND t.answered_by_staff = staff)
         OR (operator IS NOT NULL AND t.answered_by_operator = operator));
  IF FOUND AND earlier.id <> target THEN
    RAISE EXCEPTION 'this key was used for another answer' USING ERRCODE = 'QK422';
  END IF;

  SELECT t.* INTO item FROM ticket t WHERE t.id = target AND t.event_id = ev.id AND t.queue = 'event' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such ticket in this event' USING ERRCODE = 'HT404';
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
REVOKE ALL ON FUNCTION answer_core(event, bigint, text, text, uuid, uuid, uuid) FROM PUBLIC;

-- The dashboard's answer (owners and editors in the event's scope; AN404 otherwise). Audited.
CREATE FUNCTION staff_answer_ticket(target_event uuid, target bigint, reply text, request_key text, request uuid)
  RETURNS TABLE (ticket_id bigint, outcome text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM answer_core(award_event_of(target_event), target, reply, request_key, NULL,
                                         app_staff_user_id(), request);
END $$;
REVOKE ALL ON FUNCTION staff_answer_ticket(uuid, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_answer_ticket(uuid, bigint, text, text, uuid) TO questify_app;

-- The operator's answer in the app (OP403, OA403 first).
CREATE FUNCTION operator_answer_ticket(target_event uuid, target bigint, reply text, request_key text)
  RETURNS TABLE (ticket_id bigint, outcome text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := help_operator(target_event);
  ev event;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  RETURN QUERY SELECT * FROM answer_core(ev, target, reply, request_key, me, NULL, NULL);
END $$;
REVOKE ALL ON FUNCTION operator_answer_ticket(uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_answer_ticket(uuid, bigint, text, text) TO questify_app;

-- ================================================================ the team's reads (FR-339, FR-927)
-- The dashboard's tickets (owners and editors in the event's scope; AN404 otherwise): `open` oldest first, `closed`
-- newest first, keyset paged by id, optionally one kind. Each with the player's @username and avatar (never a contact,
-- name or birth year) and who answered: the operator's @username, or the staff member's email.
CREATE FUNCTION event_tickets(target_event uuid, wanted text, wanted_kind text, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, kind text, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, marked boolean, status text, outcome text, reply text,
                 answered_by text, answerer text, answerer_deleted boolean, created_at timestamptz,
                 closed_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT t.id, t.kind, t.quest_id, q.title_ar, q.title_en, t.enrollment_id, p.username, p.avatar, t.body, t.marked,
         t.status, t.outcome, t.reply,
         CASE WHEN t.answered_by_operator IS NOT NULL THEN 'operator'
              WHEN t.answered_by_staff IS NOT NULL THEN 'staff' END,
         coalesce(op.username, su.email), coalesce(op.status = 'deleted', false), t.created_at, t.closed_at
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN player op ON op.id = t.answered_by_operator
  LEFT JOIN staff_user su ON su.id = t.answered_by_staff
  WHERE t.event_id = ev.id AND t.queue = 'event'
    AND (wanted_kind IS NULL OR t.kind = wanted_kind)
    AND CASE wanted
          WHEN 'open' THEN t.status = 'open' AND (cursor_id IS NULL OR t.id > cursor_id)
          WHEN 'closed' THEN t.status = 'closed' AND (cursor_id IS NULL OR t.id < cursor_id)
          ELSE false
        END
  ORDER BY CASE WHEN wanted = 'closed' THEN -t.id ELSE t.id END
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION event_tickets(uuid, text, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_tickets(uuid, text, text, bigint, integer) TO questify_app;

-- The dashboard's tab counts and the event nav's open count (AN404 as above).
CREATE FUNCTION event_ticket_counts(target_event uuid) RETURNS TABLE (open integer, closed integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT (count(*) FILTER (WHERE t.status = 'open'))::integer, (count(*) FILTER (WHERE t.status = 'closed'))::integer
  FROM ticket t WHERE t.event_id = ev.id AND t.queue = 'event';
END $$;
REVOKE ALL ON FUNCTION event_ticket_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_ticket_counts(uuid) TO questify_app;

-- One ticket for the operator (OP403, OA403 first): an open one they may see, or a closed one only where they answered
-- it. Never who answered. HT404 otherwise (another's answer, their own ticket, outside their quests, another event).
CREATE FUNCTION operator_ticket(target_event uuid, target bigint)
  RETURNS TABLE (id bigint, kind text, quest_id uuid, quest_title_ar text, quest_title_en text, username text,
                 avatar text, body text, marked boolean, status text, outcome text, reply text,
                 created_at timestamptz, closed_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me uuid := help_operator(target_event);
BEGIN
  RETURN QUERY
  SELECT t.id, t.kind, t.quest_id, q.title_ar, q.title_en, p.username, p.avatar, t.body, t.marked, t.status,
         t.outcome, t.reply, t.created_at, t.closed_at
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  WHERE t.id = target AND t.event_id = target_event AND operator_sees_ticket(t, me)
    AND (t.status = 'open' OR t.answered_by_operator = me);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such ticket in this event' USING ERRCODE = 'HT404';
  END IF;
END $$;
REVOKE ALL ON FUNCTION operator_ticket(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_ticket(uuid, bigint) TO questify_app;

-- The calling operator's abilities in this event: OP403 not an operator, OA403 neither review nor help desk. Internal.
CREATE FUNCTION inbox_abilities(target_event uuid, OUT me uuid, OUT review boolean, OUT help boolean)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  assignment staff_assignment%ROWTYPE;
BEGIN
  me := app_player_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  review := 'review' = ANY (assignment.abilities);
  help := 'help_desk' = ANY (assignment.abilities);
  IF NOT (review OR help) THEN
    RAISE EXCEPTION 'the inbox is off for this operator' USING ERRCODE = 'OA403';
  END IF;
END $$;
REVOKE ALL ON FUNCTION inbox_abilities(uuid) FROM PUBLIC;

-- What waits for one operator (FR-927): pending submissions (with `review`, inside their limit, never their own) and
-- open tickets (with `help_desk`, by operator_sees_ticket), as one list, oldest first. Internal.
CREATE FUNCTION inbox_rows(target_event uuid, me uuid, review boolean, help boolean)
  RETURNS TABLE (kind text, id bigint, created_at timestamptz, quest_id uuid, quest_title_ar text, quest_title_en text,
                 username text, avatar text, preview text, marked boolean, ticket_kind text)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT 'submission', s.id, s.created_at, s.quest_id, q.title_ar, q.title_en, p.username, p.avatar, left(s.body, 120), s.marked,
         NULL::text
  FROM submission s
  JOIN quest q ON q.id = s.quest_id
  JOIN enrollment n ON n.id = s.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE review AND s.event_id = target_event AND s.status = 'pending' AND n.player_id <> me
    AND operator_reviews_quest(target_event, me, s.quest_id)
  UNION ALL
  SELECT 'ticket', t.id, t.created_at, t.quest_id, q.title_ar, q.title_en, p.username, p.avatar, left(t.body, 120), t.marked,
         t.kind
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  WHERE help AND t.event_id = target_event AND t.status = 'open' AND operator_sees_ticket(t, me)
$$;
REVOKE ALL ON FUNCTION inbox_rows(uuid, uuid, boolean, boolean) FROM PUBLIC;

-- The operator's Inbox (OP403, OA403 first), keyset paged by (created_at, kind, id). `position` is created_at in
-- microseconds since the epoch: the cursor keeps the database's full precision (a JavaScript Date keeps milliseconds).
CREATE FUNCTION operator_inbox(target_event uuid, cursor_position bigint, cursor_kind text, cursor_id bigint,
                               page integer)
  RETURNS TABLE (kind text, id bigint, created_at timestamptz, quest_id uuid, quest_title_ar text, quest_title_en text,
                 username text, avatar text, preview text, marked boolean, ticket_kind text, "position" bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  seat record;
BEGIN
  SELECT * INTO seat FROM inbox_abilities(target_event);
  RETURN QUERY
  SELECT x.*, (extract(epoch FROM x.created_at) * 1000000)::bigint
  FROM inbox_rows(target_event, seat.me, seat.review, seat.help) x
  WHERE cursor_position IS NULL
     OR ((extract(epoch FROM x.created_at) * 1000000)::bigint, x.kind, x.id)
        > (cursor_position, coalesce(cursor_kind, ''), coalesce(cursor_id, 0))
  ORDER BY x.created_at, x.kind, x.id
  LIMIT least(greatest(coalesce(page, 30), 1), 100);
END $$;
REVOKE ALL ON FUNCTION operator_inbox(uuid, bigint, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_inbox(uuid, bigint, text, bigint, integer) TO questify_app;

-- The Inbox badge: the same rules, counts only, with the operator's abilities.
CREATE FUNCTION operator_inbox_count(target_event uuid)
  RETURNS TABLE (submissions integer, tickets integer, review boolean, help boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  seat record;
BEGIN
  SELECT * INTO seat FROM inbox_abilities(target_event);
  RETURN QUERY
  SELECT (count(*) FILTER (WHERE x.kind = 'submission'))::integer, (count(*) FILTER (WHERE x.kind = 'ticket'))::integer,
         seat.review, seat.help
  FROM inbox_rows(target_event, seat.me, seat.review, seat.help) x;
END $$;
REVOKE ALL ON FUNCTION operator_inbox_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_inbox_count(uuid) TO questify_app;

-- ================================================================ retention (Q-210)
-- Deletes tickets 90 days after the later of their event's end and their sending, at most `batch` (1 to 1000) a run,
-- oldest first; a ticket an answer holds is skipped until the next run. Called by the lifecycle tick with no organizer
-- context, so it reads across organizers on purpose (rules.md allows this for retention sweeps). An event with no end
-- keeps its tickets. Answers how many were deleted.
CREATE FUNCTION purge_ended_tickets(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  WITH due AS (
    SELECT t.id FROM ticket t JOIN event e ON e.id = t.event_id
    WHERE e.ends_at IS NOT NULL AND greatest(e.ends_at, t.created_at) + interval '90 days' <= now()
    ORDER BY t.created_at, t.id
    LIMIT least(greatest(coalesce(batch, 1000), 1), 1000)
    FOR UPDATE OF t SKIP LOCKED)
  DELETE FROM ticket t USING due WHERE t.id = due.id;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION purge_ended_tickets(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_ended_tickets(integer) TO questify_app;

-- ================================================================ erasure and the rehearsal wipe
-- As 0050, plus every ticket the account sent, open or closed, in any event. Tickets the account answered as an
-- operator keep the answer (the dashboard shows "Deleted account").
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
  DELETE FROM ticket WHERE player_id = me;
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

-- As 0055, plus: the rehearsal accounts' tickets are deleted before their accounts and counted as `tickets`.
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
           'games', (SELECT count(*) FROM game_round g WHERE g.enrollment_id = ANY (accounts)),
           'tickets', (SELECT count(*) FROM ticket t WHERE t.enrollment_id = ANY (accounts)))
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
  DELETE FROM boost b WHERE b.event_id = target AND b.rehearsal;
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
  DELETE FROM ticket t WHERE t.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- The rehearsal's sent polls and launched flash quests go back to draft (no plays are left on them).
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, poll_sent_at = NULL
  WHERE q.event_id = target AND q.poll_sent_at IS NOT NULL;
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, flash_launched_at = NULL
  WHERE q.event_id = target AND q.flash_launched_at IS NOT NULL;
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
