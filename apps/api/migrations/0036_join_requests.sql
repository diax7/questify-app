-- Join requests and the waiting list (T-218, ADR-167 to ADR-169; FR-1818 to FR-1821). A Private event's join without
-- an invitation is a pending request (0018); the owner or an editor now accepts or declines it. A declined request is
-- a status of its own. Seats under the player limit count accepted players only (amends ADR-141): a request already
-- made is never dropped for being over the limit, its acceptance is checked. A full hard-limited event answers 'full';
-- the player may then join the waiting list, a pending enrollment flagged `waitlisted`, released by an acceptance.
-- Lock order everywhere: the event's seat lock, then the enrollment row.

ALTER TABLE enrollment DROP CONSTRAINT enrollment_status_check;
ALTER TABLE enrollment ADD CONSTRAINT enrollment_status_check
  CHECK (status IN ('pending', 'active', 'left', 'removed', 'banned', 'declined'));
-- Written by the definers only: questify_app keeps its column grants (INSERT of four columns, UPDATE of status).
ALTER TABLE enrollment ADD COLUMN waitlisted boolean NOT NULL DEFAULT false;
-- Only a pending row is on the waiting list: any move out of pending (an acceptance, a decline, leaving) clears it.
CREATE FUNCTION enrollment_waitlist_clear() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.waitlisted := NEW.waitlisted AND NEW.status = 'pending';
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enrollment_waitlist_clear() FROM PUBLIC;
CREATE TRIGGER enrollment_waitlist_clear BEFORE INSERT OR UPDATE ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_waitlist_clear();
CREATE INDEX enrollment_requests_idx ON enrollment (event_id, joined_at, id) WHERE status = 'pending';

-- ================================================================ seats (ADR-168)
-- A seat is an accepted player: active or banned. Pending and declined take none.
CREATE OR REPLACE FUNCTION event_seats(target uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM enrollment
  WHERE event_id = target AND status IN ('active', 'banned') AND joined_via IS DISTINCT FROM 'rehearsal'
$$;

-- The last guard: only a move into 'active' takes a seat. The definers decide before writing (free_seats), so this
-- raises only for a direct write by the owner connection.
CREATE OR REPLACE FUNCTION enrollment_player_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mode text;
  cap integer;
  seats integer;
BEGIN
  IF NEW.status <> 'active' OR NEW.joined_via = 'rehearsal' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('active', 'banned') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM enrollment WHERE event_id = NEW.event_id AND player_id = NEW.player_id)
  THEN
    RETURN NEW;
  END IF;
  SELECT player_limit_mode, player_limit INTO mode, cap FROM event WHERE id = NEW.event_id FOR KEY SHARE;
  IF mode IS NULL OR mode = 'none' THEN
    RETURN NEW;
  END IF;
  PERFORM lock_event_seats(NEW.event_id);
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM enrollment WHERE event_id = NEW.event_id AND player_id = NEW.player_id)
  THEN
    RETURN NEW;
  END IF;
  SELECT player_limit_mode, player_limit INTO mode, cap FROM event WHERE id = NEW.event_id;
  seats := event_seats(NEW.event_id);
  IF mode = 'hard' AND seats >= cap THEN
    RAISE EXCEPTION 'the event is full' USING ERRCODE = 'QL409', DETAIL = cap::text;
  END IF;
  IF mode <> 'none' THEN
    PERFORM record_limit_alerts(NEW.event_id, NEW.organizer_id, cap, seats + 1);
  END IF;
  RETURN NEW;
END $$;

-- The free seats of a hard-limited event, taken under its seat lock (held to the end of the transaction); NULL when
-- the event has no hard limit. KEY SHARE waits for an admin changing the limit. Internal.
CREATE FUNCTION free_seats(target uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mode text;
  cap integer;
BEGIN
  SELECT player_limit_mode, player_limit INTO mode, cap FROM event WHERE id = target FOR KEY SHARE;
  IF mode IS DISTINCT FROM 'hard' THEN
    RETURN NULL;
  END IF;
  PERFORM lock_event_seats(target);
  RETURN greatest(cap - event_seats(target), 0);
END $$;
REVOKE ALL ON FUNCTION free_seats(uuid) FROM PUBLIC;

-- ================================================================ joining
-- As 0032, plus: the seat lock before the row; 'declined' (unless the player is now invited); 'full' at a hard limit
-- unless `waitlist`, which makes a waitlisted pending enrollment. A private request is never refused for being full.
-- An invited player already pending on a full event answers 'already' (their request stands).
DROP FUNCTION join_event(text, text, text, jsonb);
DROP FUNCTION join_invited(uuid, text, jsonb);
DROP FUNCTION join_core(event, uuid, text, text, jsonb);
CREATE FUNCTION join_core(target event, me uuid, via text, card text, answers jsonb, waitlist boolean)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  row_found enrollment;
  invited boolean;
  free integer;
  joined_status text;
  on_list boolean := false;
BEGIN
  PERFORM ensure_rehearsal_wiped(target.id);
  IF event_status_now(target.status, target.starts_at, target.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  IF via <> 'invite' AND NOT (via = ANY (target.join_methods)) THEN
    RETURN QUERY SELECT 'method_off'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  free := free_seats(target.id);
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me FOR UPDATE;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  invited := player_invited(target.id, me);
  IF row_found.status = 'active' OR (row_found.status = 'pending' AND NOT invited) THEN
    RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status, 0, row_found.waitlisted;
    RETURN;
  END IF;
  IF row_found.status IN ('banned', 'removed') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  IF row_found.status = 'declined' AND NOT invited THEN
    RETURN QUERY SELECT 'declined'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  IF target.guest_list_only AND NOT invited THEN
    RETURN QUERY SELECT 'invite_only'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  IF cardinality(target.email_domains) > 0 AND NOT invited AND NOT EXISTS (
       SELECT 1 FROM player_contact pc
       WHERE pc.player_id = me AND split_part(pc.email, '@', 2) = ANY (target.email_domains)) THEN
    RETURN QUERY SELECT 'domain_required'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  PERFORM check_join_answers(target.id, coalesce(answers, '{}'::jsonb));
  IF target.access = 'private' AND NOT invited THEN
    joined_status := 'pending';
  ELSIF free IS NULL OR free > 0 THEN
    joined_status := 'active';
  ELSIF row_found.status = 'pending' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status, 0, row_found.waitlisted;
    RETURN;
  ELSIF NOT coalesce(waitlist, false) THEN
    RETURN QUERY SELECT 'full'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  ELSE
    joined_status := 'pending';
    on_list := true;
  END IF;
  RETURN QUERY SELECT * FROM join_write(target, me, row_found, joined_status, on_list, via, card, answers);
END $$;
REVOKE ALL ON FUNCTION join_core(event, uuid, text, text, jsonb, boolean) FROM PUBLIC;

-- The write of a join decided by join_core: a new enrollment, or the return of one who left (or was declined and is
-- now invited), with the answers given now. Internal.
CREATE FUNCTION join_write(target event, me uuid, row_found enrollment, joined_status text, on_list boolean, via text,
                           card text, answers jsonb)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  made uuid;
  existing enrollment;
  had_welcome boolean := false;
  granted integer;
BEGIN
  IF row_found.id IS NULL THEN
    INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via, waitlisted)
    VALUES (target.organizer_id, target.id, me, joined_status, card, via, on_list)
    ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
    RETURNING en.id INTO made;
    IF made IS NULL THEN
      SELECT en.* INTO existing FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me;
      IF existing.joined_via = 'rehearsal' THEN
        RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid, target.id, NULL::text, 0, false;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'already'::text, existing.id, target.id, existing.status, 0, existing.waitlisted;
      RETURN;
    END IF;
  ELSE
    had_welcome := EXISTS (SELECT 1 FROM ledger_entry l WHERE l.enrollment_id = row_found.id AND l.kind = 'welcome');
    UPDATE enrollment en SET status = joined_status, waitlisted = on_list, card_version = card, joined_via = via,
                             joined_at = now()
    WHERE en.id = row_found.id;
    made := row_found.id;
    DELETE FROM join_answer a WHERE a.enrollment_id = made;
  END IF;
  INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
  SELECT made, a.key::uuid, target.organizer_id, target.id, a.value #>> '{}'
  FROM jsonb_each(coalesce(answers, '{}'::jsonb)) a;
  granted := 0;
  IF NOT had_welcome THEN
    SELECT l.score_delta::integer INTO granted FROM ledger_entry l WHERE l.enrollment_id = made AND l.kind = 'welcome';
  END IF;
  RETURN QUERY SELECT 'joined'::text, made, target.id, joined_status, coalesce(granted, 0), on_list;
END $$;
REVOKE ALL ON FUNCTION join_write(event, uuid, enrollment, text, boolean, text, text, jsonb) FROM PUBLIC;

CREATE FUNCTION join_event(code text, via text, card text, answers jsonb DEFAULT '{}'::jsonb,
                           waitlist boolean DEFAULT false)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  target event;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF via IS NULL OR via NOT IN ('code', 'qr', 'link', 'public_list') THEN
    RAISE EXCEPTION 'unknown way of joining' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO target FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
  FOR SHARE;
  IF target.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM join_core(target, me, via, card, answers, waitlist);
END $$;
REVOKE ALL ON FUNCTION join_event(text, text, text, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_event(text, text, text, jsonb, boolean) TO questify_app;

CREATE FUNCTION join_invited(target uuid, card text, answers jsonb DEFAULT '{}'::jsonb,
                             waitlist boolean DEFAULT false)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  found_event event;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO found_event FROM event e WHERE e.id = target AND e.status NOT IN ('draft', 'archived') FOR SHARE;
  IF found_event.id IS NULL OR NOT player_invited(found_event.id, me) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM join_core(found_event, me, 'invite', card, answers, waitlist);
END $$;
REVOKE ALL ON FUNCTION join_invited(uuid, text, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_invited(uuid, text, jsonb, boolean) TO questify_app;

-- As 0032, plus the seat lock before the row, 'full' as an answer (never a raised error), and a declined or
-- waitlisted operator let in like a pending one.
CREATE OR REPLACE FUNCTION enroll_operator(target_event uuid, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  ev event;
  assignment staff_assignment%ROWTYPE;
  row_found enrollment;
  free integer;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event FOR SHARE;
  PERFORM ensure_rehearsal_wiped(target_event);
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me FOR SHARE;
  IF NOT FOUND OR NOT assignment.can_play THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
    RETURN;
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid;
    RETURN;
  END IF;
  free := free_seats(ev.id);
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me FOR UPDATE;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid;
    RETURN;
  END IF;
  IF row_found.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id;
    RETURN;
  END IF;
  IF row_found.id IS NOT NULL AND row_found.status NOT IN ('left', 'pending', 'declined') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
    RETURN;
  END IF;
  IF free IS NOT NULL AND free < 1 THEN
    RETURN QUERY SELECT 'full'::text, NULL::uuid;
    RETURN;
  END IF;
  IF row_found.id IS NOT NULL THEN
    UPDATE enrollment en SET status = 'active', waitlisted = false, card_version = card, joined_via = 'operator',
                             joined_at = now()
    WHERE en.id = row_found.id;
    RETURN QUERY SELECT 'joined'::text, row_found.id;
    RETURN;
  END IF;
  INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (ev.organizer_id, ev.id, me, 'active', card, 'operator')
  ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
  RETURNING en.* INTO row_found;
  IF row_found.id IS NOT NULL THEN
    RETURN QUERY SELECT 'joined'::text, row_found.id;
    RETURN;
  END IF;
  -- The same player's other join committed meanwhile (an event without a hard limit takes no seat lock).
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid;
  ELSIF row_found.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id;
  ELSE
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
  END IF;
END $$;

-- ================================================================ readers that list statuses
-- As 0028: a declined person who is on the guest list is invited again (the list overrides a decline, ADR-167).
CREATE OR REPLACE FUNCTION my_invitations()
  RETURNS TABLE (id uuid, name_ar text, name_en text, venue_ar text, venue_en text, kind text, timezone text,
                 starts_at timestamptz, ends_at timestamptz, status_now text, access text, email_domains text[],
                 welcome_points integer, fields jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT pc.phone_e164, pc.email, p.id FROM player p JOIN player_contact pc ON pc.player_id = p.id
    WHERE p.id = app_player_id() AND p.status = 'active'
  )
  SELECT e.id, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at), e.access, e.email_domains, e.welcome_points,
         event_join_fields_json(e.id)
  FROM me
  JOIN event e ON e.id IN (
    SELECT g.event_id FROM event_guest g
    WHERE (g.kind = 'phone' AND g.value = me.phone_e164) OR (g.kind = 'email' AND g.value = me.email))
  WHERE event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = e.id AND n.player_id = me.id
                    AND n.status NOT IN ('left', 'pending', 'declined'))
  ORDER BY e.starts_at, e.id
  LIMIT 20
$$;

-- As 0031, plus 'declined' (no hold: the status check answers them).
CREATE OR REPLACE FUNCTION desk_hold(enrolled enrollment, ev event) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN enrolled.status IN ('pending', 'left', 'removed', 'declined') THEN NULL
    WHEN enrolled.redeem_paused_at IS NOT NULL THEN 'paused'
    WHEN enrolled.status = 'banned' THEN 'held'
    WHEN ev.flag_hold AND EXISTS (SELECT 1 FROM flag f WHERE f.enrollment_id = enrolled.id AND f.status = 'open')
      THEN 'held'
  END
$$;

-- As 0031, plus: a pending or declined row is not_allowed (a ban would take a seat the limit never checked, and a lift
-- would let a request in without acceptance). Requests are accepted or declined instead.
CREATE OR REPLACE FUNCTION set_enrollment_ban(target_event uuid, target uuid, banned boolean, request uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := app_organizer_id();
  row_found enrollment;
  wanted text;
BEGIN
  IF banned IS NULL THEN
    RAISE EXCEPTION 'banned must be true or false' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT n.* INTO row_found FROM enrollment n JOIN event ev ON ev.id = n.event_id
  WHERE n.id = target AND n.event_id = target_event
    AND ev.organizer_id = org AND in_event_scope(ev.id, app_event_scope())
  FOR UPDATE OF n;
  IF row_found.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT app_is_owner(org) THEN
    RETURN 'not_owner';
  END IF;
  IF row_found.status IN ('removed', 'pending', 'declined') THEN
    RETURN 'not_allowed';
  END IF;
  wanted := CASE WHEN banned THEN 'banned' ELSE 'active' END;
  IF row_found.status = wanted OR (NOT banned AND row_found.status <> 'banned') THEN
    RETURN 'unchanged';
  END IF;
  UPDATE enrollment SET status = wanted WHERE id = row_found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), org, target_event,
          CASE WHEN banned THEN 'event.player_ban' ELSE 'event.player_unban' END, 'enrollment', target::text,
          jsonb_build_object('status', row_found.status), jsonb_build_object('status', wanted), request);
  IF banned THEN
    WITH closed AS (
      UPDATE flag f SET status = 'confirmed', resolution = 'banned', resolved_at = now(),
                        resolved_by = app_staff_user_id()
      WHERE f.enrollment_id = row_found.id AND f.status = 'open'
      RETURNING f.id
    )
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                           after, request_id)
    SELECT 'staff', app_staff_user_id(), org, target_event, 'event.flag_confirmed', 'flag', closed.id::text,
           jsonb_build_object('status', 'open'), jsonb_build_object('status', 'confirmed', 'resolution', 'banned'),
           request
    FROM closed;
  END IF;
  RETURN 'changed';
END $$;

-- ================================================================ the team's requests queue (FR-1819, FR-1821)
-- The event's pending and declined requests for its owner and editors in scope, oldest first, by a cursor over
-- (joined_at, id). Public profile only.
CREATE FUNCTION join_requests(target uuid, after_id uuid, page integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, status text, waitlisted boolean,
                 requested_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT n.id, p.username, p.avatar, n.status, n.waitlisted, n.joined_at
  FROM event ev
  JOIN enrollment n ON n.event_id = ev.id
  JOIN player p ON p.id = n.player_id
  WHERE ev.id = target
    AND ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope())
    AND n.status IN ('pending', 'declined') AND n.joined_via IS DISTINCT FROM 'rehearsal'
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM enrollment c WHERE c.id = after_id AND c.event_id = target)
         OR (n.joined_at, n.id) > (SELECT c.joined_at, c.id FROM enrollment c WHERE c.id = after_id AND c.event_id = target))
  ORDER BY n.joined_at, n.id
  LIMIT least(greatest(page, 1), 100)
$$;
REVOKE ALL ON FUNCTION join_requests(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_requests(uuid, uuid, integer) TO questify_app;

-- The event of the caller's organizer and scope, read FOR SHARE (a change of its limit or status waits). Internal.
CREATE FUNCTION team_event(target uuid) RETURNS event
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT e.* FROM event e
  WHERE e.id = target AND e.organizer_id = app_organizer_id() AND in_event_scope(e.id, app_event_scope())
  FOR SHARE
$$;
REVOKE ALL ON FUNCTION team_event(uuid) FROM PUBLIC;

-- Accept or decline one request (ADR-167): the owner or an editor in scope. Outcomes: accepted, declined, unchanged
-- (already so), not_found, not_allowed (not a request: use a ban or a removal), ended (the event is not scheduled or
-- live), full (no free seat for an acceptance). Declining a waitlisted player bars them, as on a Private event. An
-- acceptance takes the seat lock before the row and checks the seat itself; the welcome reward follows (trigger).
CREATE FUNCTION decide_join_request(target_event uuid, target uuid, accept boolean, request uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
  free integer;
  row_found enrollment;
  wanted text;
BEGIN
  IF accept IS NULL THEN
    RAISE EXCEPTION 'accept must be true or false' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  ev := team_event(target_event);
  IF ev.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN 'ended';
  END IF;
  IF accept THEN
    free := free_seats(ev.id);
  END IF;
  SELECT n.* INTO row_found FROM enrollment n
  WHERE n.id = target AND n.event_id = ev.id AND n.joined_via IS DISTINCT FROM 'rehearsal'
  FOR UPDATE;
  IF row_found.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  wanted := CASE WHEN accept THEN 'active' ELSE 'declined' END;
  IF row_found.status = wanted THEN
    RETURN 'unchanged';
  END IF;
  IF row_found.status NOT IN ('pending', 'declined') THEN
    RETURN 'not_allowed';
  END IF;
  IF accept AND free IS NOT NULL AND free < 1 THEN
    RETURN 'full';
  END IF;
  UPDATE enrollment SET status = wanted, waitlisted = false WHERE id = row_found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id,
          CASE WHEN accept THEN 'event.join_accept' ELSE 'event.join_decline' END, 'enrollment', target::text,
          jsonb_build_object('status', row_found.status, 'waitlisted', row_found.waitlisted),
          jsonb_build_object('status', wanted), request);
  RETURN CASE WHEN accept THEN 'accepted' ELSE 'declined' END;
END $$;
REVOKE ALL ON FUNCTION decide_join_request(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decide_join_request(uuid, uuid, boolean, uuid) TO questify_app;

-- Accept every pending request, oldest first, while seats are free (FR-1825's Accept all; a release from the waiting
-- list). Declined rows stay declined. One audit entry each under the same request id. Outcomes: done (with how many
-- were accepted and how many are still pending), not_found, ended.
CREATE FUNCTION accept_all_join_requests(target_event uuid, request uuid)
  RETURNS TABLE (outcome text, accepted integer, remaining integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
  free integer;
  taken integer;
BEGIN
  ev := team_event(target_event);
  IF ev.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, 0, 0;
    RETURN;
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, 0, 0;
    RETURN;
  END IF;
  free := free_seats(ev.id);
  WITH picked AS (
    SELECT n.id, n.waitlisted FROM enrollment n
    WHERE n.event_id = ev.id AND n.status = 'pending' AND n.joined_via IS DISTINCT FROM 'rehearsal'
    ORDER BY n.joined_at, n.id
    LIMIT free
    FOR UPDATE SKIP LOCKED
  ), moved AS (
    UPDATE enrollment n SET status = 'active', waitlisted = false
    FROM picked WHERE n.id = picked.id
    RETURNING n.id, picked.waitlisted
  ), logged AS (
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                           after, request_id)
    SELECT 'staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.join_accept', 'enrollment', moved.id::text,
           jsonb_build_object('status', 'pending', 'waitlisted', moved.waitlisted),
           jsonb_build_object('status', 'active'), request
    FROM moved
    RETURNING 1
  )
  SELECT count(*)::integer INTO taken FROM logged;
  RETURN QUERY SELECT 'done'::text, taken,
    (SELECT count(*)::integer FROM enrollment n
     WHERE n.event_id = ev.id AND n.status = 'pending' AND n.joined_via IS DISTINCT FROM 'rehearsal');
END $$;
REVOKE ALL ON FUNCTION accept_all_join_requests(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_all_join_requests(uuid, uuid) TO questify_app;
