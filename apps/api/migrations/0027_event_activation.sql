-- Event activation and limits (T-210, ADR-076, ADR-140 to ADR-142). The owner requests activation; a Questify admin
-- activates a draft with a player limit (none, soft or hard) and the add-ons it bought, rejects a request with a note,
-- or changes the limit later. The hard limit is a wall at the enrollment itself, so every way of joining meets it.
-- Deny by default (docs/rules.md): no write grant on the new tables or columns; definers only, each audited.

-- ================================================================ the event's limit and activation
ALTER TABLE event
  ADD COLUMN player_limit_mode text NOT NULL DEFAULT 'none' CHECK (player_limit_mode IN ('none', 'soft', 'hard')),
  ADD COLUMN player_limit integer CHECK (player_limit BETWEEN 1 AND 1000000),
  ADD COLUMN activated_at timestamptz,
  ADD COLUMN activated_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  ADD CONSTRAINT event_player_limit_shape CHECK ((player_limit_mode = 'none') = (player_limit IS NULL));
-- The API role's INSERT and UPDATE grants on event name their columns (0009); these four are not among them.

-- ================================================================ who may act as a Questify admin
-- The request context's admin flag, confirmed against the account itself: an active platform admin. NULL otherwise.
CREATE FUNCTION app_admin_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id FROM staff_user s
  WHERE app_is_admin() AND s.id = app_staff_user_id() AND s.platform_role = 'admin' AND s.status = 'active'
$$;
REVOKE ALL ON FUNCTION app_admin_id() FROM PUBLIC;

-- ================================================================ activation requests (FR-1019)
-- One row per event: pending, or rejected with the admin's note for the owner. The history is the audit log.
CREATE TABLE event_activation_request (
  event_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  state        text NOT NULL CHECK (state IN ('pending', 'rejected')),
  requested_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  note         text CHECK (length(note) BETWEEN 1 AND 500),
  decided_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  decided_at   timestamptz,
  CHECK ((state = 'rejected') = (note IS NOT NULL AND decided_at IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX event_activation_queue ON event_activation_request (requested_at) WHERE state = 'pending';
ALTER TABLE event_activation_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_activation_request FORCE ROW LEVEL SECURITY;
CREATE POLICY activation_request_read ON event_activation_request FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
GRANT SELECT ON event_activation_request TO questify_app;

-- ================================================================ limit alerts (FR-1021)
-- The 80% and 100% marks, each recorded once per limit; the dashboard shows them. Written by the limit trigger and
-- set_event_player_limit only.
CREATE TABLE event_limit_alert (
  event_id     uuid NOT NULL,
  organizer_id uuid NOT NULL,
  level        smallint NOT NULL CHECK (level IN (80, 100)),
  players      integer NOT NULL CHECK (players >= 0),
  reached_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, level),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE event_limit_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_limit_alert FORCE ROW LEVEL SECURITY;
CREATE POLICY limit_alert_read ON event_limit_alert FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
GRANT SELECT ON event_limit_alert TO questify_app;

-- ================================================================ seats (ADR-141)
-- A seat is an enrollment that is pending, active or banned; leaving or being removed frees it. Only a move into
-- pending or active takes a seat: a ban of a player who left is never refused for being over the limit.
CREATE FUNCTION event_seats(target uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM enrollment WHERE event_id = target AND status IN ('pending', 'active', 'banned')
$$;
REVOKE ALL ON FUNCTION event_seats(uuid) FROM PUBLIC;

-- The marks reached by this many seats under a limit: 80 from ceil(0.8 × limit) (240 of 300), 100 at the limit.
CREATE FUNCTION record_limit_alerts(target uuid, org uuid, cap integer, seats integer) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO event_limit_alert (event_id, organizer_id, level, players)
  SELECT target, org, mark.level, seats
  FROM (VALUES (80::smallint, ceil(cap * 0.8)::integer), (100::smallint, cap)) AS mark(level, threshold)
  WHERE cap IS NOT NULL AND seats >= mark.threshold
  ON CONFLICT (event_id, level) DO NOTHING
$$;
REVOKE ALL ON FUNCTION record_limit_alerts(uuid, uuid, integer, integer) FROM PUBLIC;

-- Seat-taking on one event waits its turn (a transaction lock in this migration's own namespace), so two joins at the
-- last seat cannot both pass the count.
CREATE FUNCTION lock_event_seats(target uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(270027, hashtext(target::text))
$$;
REVOKE ALL ON FUNCTION lock_event_seats(uuid) FROM PUBLIC;

CREATE FUNCTION enrollment_player_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mode text;
  cap integer;
  seats integer;
BEGIN
  IF NEW.status NOT IN ('pending', 'active') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('pending', 'active', 'banned') THEN
    RETURN NEW;
  END IF;
  -- An insert for a player already in the event changes nothing: join_event's ON CONFLICT takes it from here.
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM enrollment WHERE event_id = NEW.event_id AND player_id = NEW.player_id)
  THEN
    RETURN NEW;
  END IF;
  -- KEY SHARE waits for an admin changing the limit (FOR UPDATE), so a join never slips in under the old mode; it does
  -- not wait for ordinary edits of the event.
  SELECT player_limit_mode, player_limit INTO mode, cap FROM event WHERE id = NEW.event_id FOR KEY SHARE;
  IF mode IS NULL OR mode = 'none' THEN
    RETURN NEW;
  END IF;
  PERFORM lock_event_seats(NEW.event_id);
  -- Read again under the lock: an admin may have changed the limit meanwhile.
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
REVOKE ALL ON FUNCTION enrollment_player_limit() FROM PUBLIC;
CREATE TRIGGER enrollment_player_limit BEFORE INSERT OR UPDATE OF status ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_player_limit();

-- ================================================================ the owner's request (FR-1019, FR-1020)
-- Outcomes: requested (new, or again after a rejection) or already (a pending request stays as it is, unaudited).
-- Nothing is charged: the platform holds no prices (FR-1020).
CREATE FUNCTION request_event_activation(target uuid, request uuid)
  RETURNS TABLE (outcome text, requested_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event;
  existing event_activation_request;
BEGIN
  SELECT * INTO found_event FROM event WHERE id = target FOR UPDATE;
  IF found_event.id IS NULL OR found_event.organizer_id IS DISTINCT FROM app_organizer_id()
     OR NOT app_is_owner(found_event.organizer_id) THEN
    RAISE EXCEPTION 'only the owner of this event''s organizer can request activation' USING ERRCODE = 'QE403';
  END IF;
  IF found_event.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be activated' USING ERRCODE = 'QE409';
  END IF;
  SELECT * INTO existing FROM event_activation_request r WHERE r.event_id = target;
  IF existing.state = 'pending' THEN
    RETURN QUERY SELECT 'already'::text, existing.requested_at;
    RETURN;
  END IF;
  INSERT INTO event_activation_request AS r (event_id, organizer_id, state, requested_by)
  VALUES (target, found_event.organizer_id, 'pending', app_staff_user_id())
  ON CONFLICT (event_id) DO UPDATE
    SET state = 'pending', requested_by = EXCLUDED.requested_by, requested_at = now(), note = NULL,
        decided_by = NULL, decided_at = NULL;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), found_event.organizer_id, target, 'event.activation.request', 'event',
          target::text, jsonb_build_object('state', 'pending'), request);
  RETURN QUERY SELECT 'requested'::text, now();
END $$;
REVOKE ALL ON FUNCTION request_event_activation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_event_activation(uuid, uuid) TO questify_app;

-- The owner withdraws a pending request; false when there was none.
CREATE FUNCTION withdraw_event_activation(target uuid, request uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event;
BEGIN
  SELECT * INTO found_event FROM event WHERE id = target FOR UPDATE;
  IF found_event.id IS NULL OR found_event.organizer_id IS DISTINCT FROM app_organizer_id()
     OR NOT app_is_owner(found_event.organizer_id) THEN
    RAISE EXCEPTION 'only the owner of this event''s organizer can withdraw the request' USING ERRCODE = 'QE403';
  END IF;
  DELETE FROM event_activation_request WHERE event_id = target AND state = 'pending';
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES ('staff', app_staff_user_id(), found_event.organizer_id, target, 'event.activation.withdraw', 'event',
          target::text, jsonb_build_object('state', 'pending'), request);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION withdraw_event_activation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION withdraw_event_activation(uuid, uuid) TO questify_app;

-- ================================================================ the console (FR-1021, FR-1402)
-- The event, locked, for an active platform admin; raises otherwise. QA404: no such event.
CREATE FUNCTION admin_lock_event(target uuid) RETURNS event
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event;
BEGIN
  IF app_admin_id() IS NULL THEN
    RAISE EXCEPTION 'only a Questify admin can do this' USING ERRCODE = 'QE403';
  END IF;
  SELECT * INTO found_event FROM event WHERE id = target FOR UPDATE;
  IF found_event.id IS NULL THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'QA404';
  END IF;
  RETURN found_event;
END $$;
REVOKE ALL ON FUNCTION admin_lock_event(uuid) FROM PUBLIC;

-- Activates a draft (ADR-142): its start and end are set, the end is still ahead, and a physical event has a venue
-- (QA422 with the field). The event becomes scheduled; event_status_now and the tick make it live when its start has
-- passed. The add-ons become exactly the list (each a gated feature; the API checks the registry).
CREATE FUNCTION activate_event(target uuid, mode text, cap integer, addons text[], request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event := admin_lock_event(target);
  admin uuid := app_admin_id();
  wanted text[] := ARRAY(SELECT DISTINCT unnest(COALESCE(addons, ARRAY[]::text[])) ORDER BY 1);
BEGIN
  IF found_event.status <> 'draft' THEN
    RAISE EXCEPTION 'only a draft can be activated' USING ERRCODE = 'QA409';
  END IF;
  IF found_event.starts_at IS NULL OR found_event.ends_at IS NULL OR found_event.ends_at <= now() THEN
    RAISE EXCEPTION 'the event needs a start and an end still ahead' USING ERRCODE = 'QA422', DETAIL = 'times';
  END IF;
  IF found_event.kind = 'physical'
     AND COALESCE(btrim(found_event.venue_ar), '') = '' AND COALESCE(btrim(found_event.venue_en), '') = '' THEN
    RAISE EXCEPTION 'a physical event needs a venue' USING ERRCODE = 'QA422', DETAIL = 'venue';
  END IF;
  PERFORM lock_event_seats(target);
  UPDATE event SET status = 'scheduled', player_limit_mode = mode, player_limit = cap, activated_at = now(),
                   activated_by = admin
  WHERE id = target;
  DELETE FROM event_entitlement WHERE event_id = target AND NOT (feature = ANY (wanted));
  INSERT INTO event_entitlement (event_id, organizer_id, feature, granted_by)
  SELECT target, found_event.organizer_id, feature, admin FROM unnest(wanted) AS feature
  ON CONFLICT (event_id, feature) DO NOTHING;
  DELETE FROM event_activation_request WHERE event_id = target;
  DELETE FROM event_limit_alert WHERE event_id = target;
  PERFORM record_limit_alerts(target, found_event.organizer_id, cap, event_seats(target));
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('admin', admin, found_event.organizer_id, target, 'event.activate', 'event', target::text,
          jsonb_build_object('status', 'draft'),
          jsonb_build_object('status', 'scheduled', 'limitMode', mode, 'limit', cap, 'addons', to_jsonb(wanted)),
          request);
END $$;
REVOKE ALL ON FUNCTION activate_event(uuid, text, integer, text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_event(uuid, text, integer, text[], uuid) TO questify_app;

-- Rejects a pending request with a note the owner reads; the event stays a draft and keeps everything.
CREATE FUNCTION reject_event_activation(target uuid, reason text, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event := admin_lock_event(target);
  admin uuid := app_admin_id();
BEGIN
  UPDATE event_activation_request SET state = 'rejected', note = reason, decided_by = admin, decided_at = now()
  WHERE event_id = target AND state = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no pending request for this event' USING ERRCODE = 'QA409';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('admin', admin, found_event.organizer_id, target, 'event.activation.reject', 'event', target::text,
          jsonb_build_object('state', 'pending'), jsonb_build_object('state', 'rejected'), request);
END $$;
REVOKE ALL ON FUNCTION reject_event_activation(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_event_activation(uuid, text, uuid) TO questify_app;

-- Changes the limit of an activated event. A limit below the players already in keeps them all and closes joining
-- (hard). The marks are recomputed from the seats now.
CREATE FUNCTION set_event_player_limit(target uuid, mode text, cap integer, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event := admin_lock_event(target);
  admin uuid := app_admin_id();
BEGIN
  IF found_event.status IN ('draft', 'archived') THEN
    RAISE EXCEPTION 'only an activated event has a limit to change' USING ERRCODE = 'QA409';
  END IF;
  PERFORM lock_event_seats(target);
  UPDATE event SET player_limit_mode = mode, player_limit = cap WHERE id = target;
  DELETE FROM event_limit_alert WHERE event_id = target;
  PERFORM record_limit_alerts(target, found_event.organizer_id, cap, event_seats(target));
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('admin', admin, found_event.organizer_id, target, 'event.limit', 'event', target::text,
          jsonb_build_object('limitMode', found_event.player_limit_mode, 'limit', found_event.player_limit),
          jsonb_build_object('limitMode', mode, 'limit', cap), request);
END $$;
REVOKE ALL ON FUNCTION set_event_player_limit(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_event_player_limit(uuid, text, integer, uuid) TO questify_app;

-- What the team sees of its event's seats: the count only, for a member within their event limit or an admin.
CREATE FUNCTION event_seat_count(target uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT event_seats(e.id) FROM event e
  WHERE e.id = target
    AND ((e.organizer_id = app_organizer_id() AND in_event_scope(e.id, app_event_scope())) OR app_admin_id() IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION event_seat_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_seat_count(uuid) TO questify_app;
