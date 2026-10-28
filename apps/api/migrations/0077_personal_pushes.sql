-- T-501d: the owed personal pushes (FR-1101, FR-1718, FR-1819; plan docs/plans/2026-10-28-t-501d-personal-pushes.md on
-- the T-501 plan's "Owed pushes" rows 1 to 6; ADR-353). Each kind is a `notice_kind` row; each producer calls only
-- notice_create (one insert, nothing else: an unknown kind inserts nothing and raises nothing, so a broken kind can
-- never roll a door back): a row trigger with a WHEN on enrollment (join decisions), ticket (the answer) and submission
-- (a reviewer's decision), a statement trigger with transition tables on event_result (the reveal's prizes), and a
-- due-scan door the push worker calls every minute (a reservation ready at the desk, a reservation ending). No EXCEPTION
-- block anywhere. Deny by default: every function is closed to PUBLIC in the group that creates it; only push_due is
-- granted to the API role; the trigger functions are definers (the API's role may update enrollment.status itself, and
-- a trigger that could not insert its notice would undo the door). Migrations 0076 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- Four tables gain a trigger (SHARE ROW EXCLUSIVE), taken up front in the doors' order (event_result before the
-- enrollments the reveal locks; the enrollment before the submission a review locks).
LOCK TABLE event_result IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE enrollment IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE submission IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ticket IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the kinds (ADR-353)
-- All personal (priority 0) and without a topic: decisions, answers and prizes cannot be muted in the app (ADR-347 (4)).
-- `decided`: an active or declined enrollment; `none`: the player's own request; `active`: an active member.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('join_accepted', 'personal', NULL, 'decided', false, 0, interval '24 hours'),
  ('join_declined', 'personal', NULL, 'decided', false, 0, interval '24 hours'),
  ('help_answered', 'personal', NULL, 'none', false, 0, interval '7 days'),
  ('help_answered_questify', 'personal', NULL, 'none', false, 0, interval '7 days'),
  ('help_solved', 'personal', NULL, 'none', false, 0, interval '7 days'),
  ('rank_prize', 'personal', NULL, 'active', false, 0, interval '7 days'),
  ('submission_approved', 'personal', NULL, 'active', false, 0, interval '24 hours'),
  ('submission_rejected', 'personal', NULL, 'active', false, 0, interval '24 hours'),
  ('reward_ready', 'personal', NULL, 'active', false, 0, interval '2 hours'),
  ('reward_ending', 'personal', NULL, 'active', false, 0, interval '1 hour');

-- notice_create (0076) restated in PL/pgSQL with the same one INSERT and the same answers (ADR-353 (5)): PostgreSQL 17
-- plans a SQL function's body again at every call from a trigger (a new call site each firing), which cost accept-all
-- of 5,000 requests about 2 s more; a PL/pgSQL function keeps its plan for the session.
CREATE OR REPLACE FUNCTION notice_create(new_kind text, org uuid, ev uuid, who uuid, new_refs jsonb, new_params jsonb,
                                         marker text, until timestamptz) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  made bigint;
BEGIN
  INSERT INTO notice (kind, organizer_id, event_id, player_id, audience, refs, params, dedupe, expires_at)
  SELECT k.kind, CASE WHEN ev IS NOT NULL THEN org END, ev, who, CASE WHEN who IS NULL THEN 'event' ELSE 'player' END,
         coalesce(new_refs, '{}'::jsonb), coalesce(new_params, '{}'::jsonb), marker,
         least(coalesce(until, now() + k.ttl), now() + k.ttl)
  FROM notice_kind k
  WHERE k.kind = new_kind AND marker IS NOT NULL
    AND CASE k.class WHEN 'event' THEN who IS NULL AND ev IS NOT NULL ELSE who IS NOT NULL END
    AND (ev IS NULL OR EXISTS (SELECT 1 FROM event e WHERE e.id = ev AND e.organizer_id = org))
  ON CONFLICT (dedupe) DO NOTHING
  RETURNING id INTO made;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION notice_create(text, uuid, uuid, uuid, jsonb, jsonb, text, timestamptz) FROM PUBLIC;

-- A public name frozen on a notice: both languages, each cut to 40 characters (ADR-346; the renderer cuts again).
-- Plain SQL with no SET clause and only pg_catalog functions, schema-qualified, so the planner inlines it into each
-- producer instead of planning it at every call (the push_live_devices precedent); STABLE as jsonb_build_object is.
CREATE FUNCTION push_names(ar text, en text) RETURNS jsonb
  LANGUAGE sql STABLE AS $$
  SELECT pg_catalog.jsonb_build_object('ar', pg_catalog.left(ar, 40), 'en', pg_catalog.left(en, 40))
$$;
REVOKE ALL ON FUNCTION push_names(text, text) FROM PUBLIC;

-- ================================================================ the join decision (FR-1819, T-218)
-- decide_join_request, accept_all_join_requests and a waiting-list release (the acceptance of a waitlisted request)
-- move a request from pending or declined to active or declined. One notice per decision, marked by the enrollment, the
-- new status and the transaction's time (a later decision is a new notice; a retried door changes nothing). The
-- trigger's WHEN leaves out a member made an operator (enroll_operator), a rehearsal account and the player's own
-- re-join (join_write, an invited player whose request was declined or pending: answered on screen, not a decision).
CREATE FUNCTION push_on_join_decision() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create(CASE NEW.status WHEN 'active' THEN 'join_accepted' ELSE 'join_declined' END,
                        NEW.organizer_id, NEW.event_id, NEW.player_id, '{}'::jsonb,
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en)),
                        'join:' || NEW.id || ':' || NEW.status || ':'
                          || (extract(epoch FROM now()) * 1000000)::bigint,
                        NULL)
  FROM event e WHERE e.id = NEW.event_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_join_decision() FROM PUBLIC;
CREATE TRIGGER enrollment_push_decision AFTER UPDATE OF status ON enrollment
  FOR EACH ROW
  WHEN (OLD.status IN ('pending', 'declined') AND NEW.status IN ('active', 'declined') AND NEW.status <> OLD.status
        AND coalesce(NEW.joined_via, '') NOT IN ('operator', 'rehearsal')
        AND app_player_id() IS DISTINCT FROM NEW.player_id)
  EXECUTE FUNCTION push_on_join_decision();

-- ================================================================ the help-desk answer (FR-1101, T-310, T-312)
-- One notice per closed ticket (answer_core for the event team and its operators, admin_answer_ticket for Questify),
-- with fixed text by team and outcome and never the question or the reply: `help_solved` for a request marked solved by
-- either team, `help_answered_questify` for Questify's answer, `help_answered` for the event team's. An escalation or a
-- send-back moves only the queue; erasure deletes the tickets, so an erased account never gets one.
CREATE FUNCTION push_on_ticket_closed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create(CASE WHEN NEW.outcome = 'solved' THEN 'help_solved'
                             WHEN NEW.answered_by_admin IS NOT NULL THEN 'help_answered_questify'
                             ELSE 'help_answered' END,
                        NEW.organizer_id, NEW.event_id, NEW.player_id, jsonb_build_object('ticket', NEW.id),
                        coalesce((SELECT jsonb_build_object('event', push_names(e.name_ar, e.name_en))
                                  FROM event e WHERE e.id = NEW.event_id), '{}'::jsonb),
                        'ticket:' || NEW.id, NULL);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_ticket_closed() FROM PUBLIC;
CREATE TRIGGER ticket_push_answer AFTER UPDATE OF status ON ticket
  FOR EACH ROW WHEN (OLD.status = 'open' AND NEW.status = 'closed')
  EXECUTE FUNCTION push_on_ticket_closed();

-- ================================================================ the prize at the reveal (FR-1718, T-214)
-- One statement for every place the reveal gave a prize, once per place (marked by the event and the rank): the prize's
-- name and the claim deadline, until that deadline; never a winner who left, was removed or banned, or a deleted player.
CREATE FUNCTION push_on_reveal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create('rank_prize', a.organizer_id, a.event_id, n.player_id,
                        jsonb_build_object('redemption', x.redemption_id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                           'reward', push_names(k.name_ar, k.name_en),
                                           'date', a.claim_until, 'time', a.claim_until),
                        'rank_prize:' || x.event_id || ':' || x.rank, a.claim_until)
  FROM after_rows a
  JOIN before_rows b ON b.event_id = a.event_id
  JOIN event e ON e.id = a.event_id
  JOIN result_place x ON x.event_id = a.event_id AND x.redemption_id IS NOT NULL
  JOIN rank_prize k ON k.id = x.rank_prize_id
  JOIN enrollment n ON n.id = x.enrollment_id AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE b.revealed_at IS NULL AND a.revealed_at IS NOT NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_reveal() FROM PUBLIC;
CREATE TRIGGER event_result_push_reveal AFTER UPDATE ON event_result
  REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows
  FOR EACH STATEMENT EXECUTE FUNCTION push_on_reveal();

-- ================================================================ the submission decision (FR-1101, T-301)
-- A reviewer's approval or rejection (staff or operator): one notice per decision naming the quest, never the reason,
-- the answer or the points. An auto-approval (the player is on the screen) and the system's rejection when a member
-- leaves have no reviewer and give none.
CREATE FUNCTION push_on_submission_reviewed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create(CASE NEW.status WHEN 'approved' THEN 'submission_approved' ELSE 'submission_rejected' END,
                        NEW.organizer_id, NEW.event_id, n.player_id,
                        jsonb_build_object('quest', NEW.quest_id, 'submission', NEW.id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                           'quest', push_names(q.title_ar, q.title_en)),
                        'submission:' || NEW.id || ':' || NEW.status, NULL)
  FROM enrollment n
  JOIN event e ON e.id = NEW.event_id
  JOIN quest q ON q.id = NEW.quest_id
  WHERE n.id = NEW.enrollment_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_submission_reviewed() FROM PUBLIC;
CREATE TRIGGER submission_push_review AFTER UPDATE OF status ON submission
  FOR EACH ROW
  WHEN (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
        AND (NEW.reviewed_by_staff IS NOT NULL OR NEW.reviewed_by_operator IS NOT NULL))
  EXECUTE FUNCTION push_on_submission_reviewed();

-- ================================================================ reservations: the due scans (ADR-353 (2), (3))
-- The open reservations a scan may name (redemption_due), for an active member and player, never a rehearsal account
-- (its reservations ignore the desk's hours), never an archived event, never while the player is collecting or was
-- offered at the desk: the reward's name in both languages (a shop reward, a rank prize or a quest item). Only those
-- ending by `ending_by` (the ending scan reads a 15-minute range of the index, the ready scan every open one).
CREATE FUNCTION push_due_reservations(ending_by timestamptz)
  RETURNS TABLE (id uuid, organizer_id uuid, event_id uuid, player_id uuid, created_at timestamptz,
                 reserved_until timestamptz, desk_hours tstzmultirange, names jsonb)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT d.id, d.organizer_id, d.event_id, n.player_id, d.created_at, d.reserved_until, e.desk_hours,
         jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                            'reward', push_names(coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                 coalesce(r.name_en, k.name_en, i.name_en)))
  FROM redemption d
  JOIN event e ON e.id = d.event_id AND e.status <> 'archived'
  JOIN enrollment n ON n.id = d.enrollment_id AND n.status = 'active' AND n.joined_via IS DISTINCT FROM 'rehearsal'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  WHERE d.status = 'reserved' AND d.reserved_until > now() AND d.reserved_until <= ending_by
    AND coalesce(d.collect_until, '-infinity') <= now() AND coalesce(d.offer_until, '-infinity') <= now()
$$;
REVOKE ALL ON FUNCTION push_due_reservations(timestamptz) FROM PUBLIC;

-- Ready at the desk: the desk keeps hours, is open now, and the window open now began after the reservation was made
-- (it waited for this opening). Once per reservation, until it ends. At most `lim`; answers the notices written.
CREATE FUNCTION push_due_ready(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT x.* FROM push_due_reservations('infinity') x
    WHERE EXISTS (SELECT 1 FROM unnest(x.desk_hours) w WHERE w @> now() AND lower(w) > x.created_at)
      AND NOT EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = 'reward_ready:' || x.id)
    ORDER BY x.reserved_until, x.id
    LIMIT lim)
  SELECT count(notice_create('reward_ready', due.organizer_id, due.event_id, due.player_id,
                             jsonb_build_object('redemption', due.id), due.names, 'reward_ready:' || due.id,
                             due.reserved_until))::integer
  FROM due
$$;
REVOKE ALL ON FUNCTION push_due_ready(integer) FROM PUBLIC;

-- Ending: 15 minutes before reserved_until, for a hold longer than 30 minutes counted from when it became collectable
-- (the later of the reservation and the last desk opening at or before its end), and only while the desk is open at
-- some moment before the end (no "held until" it cannot be collected in). Names the time. At most `lim`.
CREATE FUNCTION push_due_ending(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT x.* FROM push_due_reservations(now() + interval '15 minutes') x
    WHERE x.reserved_until - greatest(x.created_at,
                                      coalesce((SELECT max(lower(w)) FROM unnest(x.desk_hours) w
                                                WHERE lower(w) <= x.reserved_until), x.created_at))
          > interval '30 minutes'
      AND (x.desk_hours IS NULL OR x.desk_hours && tstzmultirange(tstzrange(now(), x.reserved_until)))
      AND NOT EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = 'reward_ending:' || x.id)
    ORDER BY x.reserved_until, x.id
    LIMIT lim)
  SELECT count(notice_create('reward_ending', due.organizer_id, due.event_id, due.player_id,
                             jsonb_build_object('redemption', due.id),
                             due.names || jsonb_build_object('time', due.reserved_until),
                             'reward_ending:' || due.id, due.reserved_until))::integer
  FROM due
$$;
REVOKE ALL ON FUNCTION push_due_ending(integer) FROM PUBLIC;

-- The due-scan door (system context only), called by the push worker every minute, switch on or off: both scans, 500
-- notices each at most; `more` when a bound was reached, so the worker calls again. Reads without locks and writes only
-- notices; a second run writes nothing new (the markers).
CREATE FUNCTION push_due() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_ready  integer;
  n_ending integer;
BEGIN
  PERFORM push_system_only();
  n_ready := push_due_ready(500);
  n_ending := push_due_ending(500);
  RETURN jsonb_build_object('ready', n_ready, 'ending', n_ending, 'more', n_ready >= 500 OR n_ending >= 500);
END $$;
REVOKE ALL ON FUNCTION push_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_due() TO questify_app;
