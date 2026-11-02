-- Console foundation (T-701, plan docs/plans/2026-11-02-t-701-console-foundation.md): organizer rows definer-only, the
-- admin UPDATE branch on staff_user dropped (ADR-405), suspension as an overlay (ADR-406), 15-minute support grants
-- through the organizer's own doors (ADR-407, ADR-409), support entries stamped and shown as "Questify support"
-- (ADR-408). Deny by default: every new function is revoked from PUBLIC; only the doors, own_support_grants,
-- event_support_grants and suspended_ids are granted to questify_app; helpers and trigger functions hold no grant.

-- ================================================================ organizer rows are definer-only (review BLOCKER 1)
-- The API role held table-wide INSERT and UPDATE (0001) and organizer_update admitted a member, so a member could have
-- written `status` and lifted a suspension. Organizers are made by create_organizer (a definer); nothing updates one.
REVOKE INSERT, UPDATE ON organizer FROM questify_app;
DROP POLICY organizer_insert ON organizer;
DROP POLICY organizer_update ON organizer;

-- ================================================================ staff_user: a person updates only their own row
-- The admin branch let an admin overwrite another person's password hash; no shipped path used it (both password
-- paths run as the user). Reading stays: own row or an admin.
DROP POLICY staff_user_own ON staff_user;
CREATE POLICY staff_user_own ON staff_user FOR SELECT TO questify_app
  USING (id = app_staff_user_id() OR app_is_admin());
CREATE POLICY staff_user_update ON staff_user FOR UPDATE TO questify_app
  USING (id = app_staff_user_id()) WITH CHECK (id = app_staff_user_id());

-- ================================================================ suspension state (ADR-406)
-- An overlay: nothing else changes while it is on, and lifting it restores exactly what was there. The reason is the
-- one Questify wrote; the organizer reads it (Q-372), players never do. No API write grant on any of these columns.
ALTER TABLE organizer
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  ADD COLUMN suspension_reason text CHECK (char_length(suspension_reason) BETWEEN 10 AND 300),
  ADD CONSTRAINT organizer_suspension_shape
    CHECK ((status = 'paused') = (suspended_at IS NOT NULL) AND (suspended_at IS NULL) = (suspension_reason IS NULL));
ALTER TABLE event
  ADD COLUMN suspended_at timestamptz,
  ADD COLUMN suspended_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  ADD COLUMN suspension_reason text CHECK (char_length(suspension_reason) BETWEEN 10 AND 300),
  ADD CONSTRAINT event_suspension_shape CHECK ((suspended_at IS NULL) = (suspension_reason IS NULL));
CREATE INDEX event_suspended_idx ON event (id) WHERE suspended_at IS NOT NULL;
CREATE INDEX organizer_paused_idx ON organizer (id) WHERE status = 'paused';

-- True while the event or its organizer is suspended. Two primary-key reads; internal (no grant).
CREATE FUNCTION event_suspended(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM event e JOIN organizer o ON o.id = e.organizer_id
                 WHERE e.id = target AND (e.suspended_at IS NOT NULL OR o.status = 'paused'))
$$;
REVOKE ALL ON FUNCTION event_suspended(uuid) FROM PUBLIC;

-- The ids of every suspended event (its own suspension or its organizer's), for the API's player wall. Ids only; the
-- API reads it with no request context, every 10 s.
CREATE FUNCTION suspended_ids() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(x.id ORDER BY x.id), '{}'::uuid[])
  FROM (SELECT e.id FROM event e WHERE e.suspended_at IS NOT NULL
        UNION
        SELECT e.id FROM organizer o JOIN event e ON e.organizer_id = o.id WHERE o.status = 'paused') x
$$;
REVOKE ALL ON FUNCTION suspended_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION suspended_ids() TO questify_app;

-- A suspension reason: 10 to 300 characters once trimmed (SU400).
CREATE FUNCTION suspension_reason_clean(reason text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF reason IS NULL OR char_length(btrim(reason)) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'a reason of 10 to 300 characters is required' USING ERRCODE = 'SU400';
  END IF;
  RETURN btrim(reason);
END $$;
REVOKE ALL ON FUNCTION suspension_reason_clean(text) FROM PUBLIC;

CREATE FUNCTION console_admin() RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_admin_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'not a Questify admin' USING ERRCODE = 'QE403';
  END IF;
  RETURN me;
END $$;
REVOKE ALL ON FUNCTION console_admin() FROM PUBLIC;

-- ================================================================ the four suspension doors (admins only)
-- Row lock FOR NO KEY UPDATE: it waits for a running change of the same row but never for the scans holding the event
-- FOR KEY SHARE (a ledger insert's foreign key), so a suspension never stalls the scanners. SU409 when already so.
CREATE FUNCTION admin_suspend_event(target uuid, reason text, request uuid) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := suspension_reason_clean(reason);
  ev    event%ROWTYPE;
BEGIN
  SELECT e.* INTO ev FROM event e WHERE e.id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'QA404';
  END IF;
  IF ev.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'the event is already suspended' USING ERRCODE = 'SU409';
  END IF;
  UPDATE event SET suspended_at = now(), suspended_by = me, suspension_reason = clean WHERE id = ev.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, ev.organizer_id, ev.id, 'event.suspend', 'event', ev.id::text,
          jsonb_build_object('reason', clean), request);
  RETURN now();
END $$;
REVOKE ALL ON FUNCTION admin_suspend_event(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_suspend_event(uuid, text, uuid) TO questify_app;

-- Lifting takes an optional reason (10 to 300 characters when given), recorded in the audit entry's `after`.
CREATE FUNCTION admin_reactivate_event(target uuid, request uuid, lift_reason text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := CASE WHEN lift_reason IS NULL THEN NULL ELSE suspension_reason_clean(lift_reason) END;
  ev    event%ROWTYPE;
BEGIN
  SELECT e.* INTO ev FROM event e WHERE e.id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'QA404';
  END IF;
  IF ev.suspended_at IS NULL THEN
    RAISE EXCEPTION 'the event is not suspended' USING ERRCODE = 'SU409';
  END IF;
  UPDATE event SET suspended_at = NULL, suspended_by = NULL, suspension_reason = NULL WHERE id = ev.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('admin', me, ev.organizer_id, ev.id, 'event.reactivate', 'event', ev.id::text,
          jsonb_build_object('reason', ev.suspension_reason, 'suspendedAt', ev.suspended_at),
          CASE WHEN clean IS NOT NULL THEN jsonb_build_object('reason', clean) END, request);
END $$;
REVOKE ALL ON FUNCTION admin_reactivate_event(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_reactivate_event(uuid, uuid, text) TO questify_app;

CREATE FUNCTION admin_suspend_organizer(target uuid, reason text, request uuid) RETURNS timestamptz
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := suspension_reason_clean(reason);
  org   organizer%ROWTYPE;
BEGIN
  SELECT o.* INTO org FROM organizer o WHERE o.id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such organizer' USING ERRCODE = 'QA404';
  END IF;
  IF org.status = 'paused' THEN
    RAISE EXCEPTION 'the organizer is already suspended' USING ERRCODE = 'SU409';
  END IF;
  UPDATE organizer SET status = 'paused', suspended_at = now(), suspended_by = me, suspension_reason = clean
  WHERE id = org.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, before, after, request_id)
  VALUES ('admin', me, org.id, 'organizer.suspend', 'organizer', org.id::text, jsonb_build_object('status', org.status),
          jsonb_build_object('reason', clean), request);
  RETURN now();
END $$;
REVOKE ALL ON FUNCTION admin_suspend_organizer(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_suspend_organizer(uuid, text, uuid) TO questify_app;

-- Lifting restores 'active': 'paused' is set only by the door above, from 'active' or 'pending'; a pending organizer
-- has no event that could run, so 'active' loses nothing a player could see.
CREATE FUNCTION admin_reactivate_organizer(target uuid, request uuid, lift_reason text DEFAULT NULL) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := CASE WHEN lift_reason IS NULL THEN NULL ELSE suspension_reason_clean(lift_reason) END;
  org   organizer%ROWTYPE;
BEGIN
  SELECT o.* INTO org FROM organizer o WHERE o.id = target FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such organizer' USING ERRCODE = 'QA404';
  END IF;
  IF org.status <> 'paused' THEN
    RAISE EXCEPTION 'the organizer is not suspended' USING ERRCODE = 'SU409';
  END IF;
  UPDATE organizer SET status = 'active', suspended_at = NULL, suspended_by = NULL, suspension_reason = NULL
  WHERE id = org.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('admin', me, org.id, 'organizer.reactivate', 'organizer', org.id::text,
          jsonb_build_object('reason', org.suspension_reason, 'suspendedAt', org.suspended_at),
          CASE WHEN clean IS NOT NULL THEN jsonb_build_object('reason', clean) END, request);
END $$;
REVOKE ALL ON FUNCTION admin_reactivate_organizer(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_reactivate_organizer(uuid, uuid, text) TO questify_app;

-- ================================================================ the database walls
-- The ledger, by the entry's kind (review MAJOR 2): while the event or its organizer is suspended only refunds of
-- reservations (`redeem_return`) and removals (staff removals, erasure) are written. Everything else (scans, spends,
-- hand-overs, awards, settlements) raises ES423, whoever writes it, including the hand-over doors (desk_hand_over and
-- accept_handover write a `handover` entry) and the desk sale (a `redeem` entry). READ COMMITTED: every statement that
-- starts after the suspension commits sees it.
CREATE FUNCTION ledger_suspension_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind NOT IN ('redeem_return', 'removal') AND event_suspended(NEW.event_id) THEN
    RAISE EXCEPTION 'this event is suspended' USING ERRCODE = 'ES423';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_suspension_guard() FROM PUBLIC;
CREATE TRIGGER ledger_suspension_guard BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_suspension_guard();

-- Joining (FR-1607): no enrollment becomes pending or active while the event is suspended.
CREATE FUNCTION enrollment_suspension_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status IN ('pending', 'active') AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)
     AND event_suspended(NEW.event_id) THEN
    RAISE EXCEPTION 'this event is suspended' USING ERRCODE = 'ES423';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enrollment_suspension_guard() FROM PUBLIC;
CREATE TRIGGER enrollment_suspension_guard BEFORE INSERT OR UPDATE OF status ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_suspension_guard();

-- ================================================================ support grants (ADR-407, Q-373)
-- 15 minutes, fixed; one event; a reason. Silent to the organizer: no banner, no read, no alert; the record is the
-- audit log. Definers only: forced row-level security and no grant at all.
CREATE TABLE support_grant (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  reason       text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 300),
  opened_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  closed_at    timestamptz,
  closed_by    uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  close_kind   text CHECK (close_kind IN ('admin', 'revoked', 'expired')),
  CHECK (expires_at = opened_at + interval '15 minutes'),
  CHECK ((closed_at IS NULL) = (close_kind IS NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX support_grant_one_open ON support_grant (admin_id, event_id) WHERE closed_at IS NULL;
CREATE INDEX support_grant_admin_idx ON support_grant (admin_id, organizer_id) WHERE closed_at IS NULL;
CREATE INDEX support_grant_opened_idx ON support_grant (admin_id, opened_at);
CREATE INDEX support_grant_event_idx ON support_grant (event_id) WHERE closed_at IS NULL;
CREATE INDEX support_grant_organizer_idx ON support_grant (organizer_id, admin_id);
ALTER TABLE support_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_grant FORCE ROW LEVEL SECURITY;

-- Opens a grant on one event for the calling admin. A member of the organizer uses the membership (SG409); 20 grants an
-- hour per admin (SG429). An earlier grant of this admin on this event is closed first, so opening again is how a
-- grant is extended; two opens at once leave one (the unique index refuses the second, 23505).
CREATE FUNCTION support_open(target uuid, reason text, request uuid)
  RETURNS TABLE (grant_id uuid, organizer_id uuid, event_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me    uuid := console_admin();
  clean text := suspension_reason_clean(reason);
  ev    event%ROWTYPE;
  made  support_grant%ROWTYPE;
BEGIN
  SELECT e.* INTO ev FROM event e WHERE e.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'QA404';
  END IF;
  IF EXISTS (SELECT 1 FROM organizer_member m WHERE m.organizer_id = ev.organizer_id AND m.staff_user_id = me) THEN
    RAISE EXCEPTION 'you are a member of this organizer: use your membership' USING ERRCODE = 'SG409';
  END IF;
  IF (SELECT count(*) FROM support_grant g WHERE g.admin_id = me AND g.opened_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'too many support grants this hour' USING ERRCODE = 'SG429';
  END IF;
  UPDATE support_grant g
  SET closed_at = now(), closed_by = CASE WHEN g.expires_at > now() THEN me END,
      close_kind = CASE WHEN g.expires_at > now() THEN 'admin' ELSE 'expired' END
  WHERE g.admin_id = me AND g.event_id = ev.id AND g.closed_at IS NULL;
  INSERT INTO support_grant (admin_id, organizer_id, event_id, reason, opened_at, expires_at)
  VALUES (me, ev.organizer_id, ev.id, clean, now(), now() + interval '15 minutes')
  RETURNING * INTO made;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, ev.organizer_id, ev.id, 'support.opened', 'support_grant', made.id::text,
          jsonb_build_object('reason', clean, 'expiresAt', made.expires_at), request);
  RETURN QUERY SELECT made.id, made.organizer_id, made.event_id, made.expires_at;
END $$;
REVOKE ALL ON FUNCTION support_open(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_open(uuid, text, uuid) TO questify_app;

-- Closes a live grant from the admin side: any active admin may close any live grant (SG404 when none is live).
CREATE FUNCTION support_close(target uuid, request uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  done support_grant%ROWTYPE;
BEGIN
  UPDATE support_grant g SET closed_at = now(), closed_by = me, close_kind = 'admin'
  WHERE g.id = target AND g.closed_at IS NULL AND g.expires_at > now()
  RETURNING g.* INTO done;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live support grant' USING ERRCODE = 'SG404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, done.organizer_id, done.event_id, 'support.closed', 'support_grant', done.id::text,
          jsonb_build_object('grantedTo', CASE WHEN done.admin_id = me THEN 'self' ELSE 'other' END), request);
END $$;
REVOKE ALL ON FUNCTION support_close(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_close(uuid, uuid) TO questify_app;

-- The caller's own live grants, while their account is an active platform admin (no request flag needed: the
-- dashboard lists them beside the memberships).
CREATE FUNCTION own_support_grants()
  RETURNS TABLE (grant_id uuid, organizer_id uuid, organizer_name text, event_id uuid, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.id, g.organizer_id, o.name, g.event_id, g.expires_at
  FROM support_grant g
  JOIN staff_user s ON s.id = g.admin_id AND s.platform_role = 'admin' AND s.status = 'active'
  JOIN organizer o ON o.id = g.organizer_id
  WHERE g.admin_id = app_staff_user_id() AND g.closed_at IS NULL AND g.expires_at > now()
  ORDER BY g.opened_at
$$;
REVOKE ALL ON FUNCTION own_support_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_support_grants() TO questify_app;

-- The live grants on one event, for the console's event page (admins only).
CREATE FUNCTION event_support_grants(target uuid)
  RETURNS TABLE (id uuid, admin_id uuid, admin_email text, opened_at timestamptz, expires_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM console_admin();
  RETURN QUERY
  SELECT g.id, g.admin_id, s.email, g.opened_at, g.expires_at
  FROM support_grant g JOIN staff_user s ON s.id = g.admin_id
  WHERE g.event_id = target AND g.closed_at IS NULL AND g.expires_at > now()
  ORDER BY g.opened_at;
END $$;
REVOKE ALL ON FUNCTION event_support_grants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_support_grants(uuid) TO questify_app;

-- ================================================================ the organizer context learns support (ADR-407)
-- A second branch, used only when no membership matches and a staff id is set (player and device contexts return at
-- once): a live grant of that staff member in that organizer, while the account is an active platform admin.
-- app.is_admin is never set on these requests, so support holds exactly an editor's rights in the granted event.
-- PL/pgSQL keeps its plans for the session, so the two lookups cost no more than 0008's one (measured, plan section 8).
CREATE OR REPLACE FUNCTION app_organizer_id() RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org   uuid := NULLIF(current_setting('app.organizer_id', true), '')::uuid;
  staff uuid := NULLIF(current_setting('app.staff_user_id', true), '')::uuid;
  hit   uuid;
BEGIN
  IF org IS NULL OR staff IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.organizer_id INTO hit FROM organizer_member m WHERE m.organizer_id = org AND m.staff_user_id = staff;
  IF FOUND THEN
    RETURN hit;
  END IF;
  SELECT g.organizer_id INTO hit
  FROM support_grant g JOIN staff_user s ON s.id = g.admin_id
  WHERE g.admin_id = staff AND g.organizer_id = org AND g.closed_at IS NULL AND g.expires_at > now()
    AND s.platform_role = 'admin' AND s.status = 'active'
  LIMIT 1;
  RETURN hit;
END $$;

-- The member's limit (NULL: every event), else the granted events, never NULL for support (an empty array opens
-- nothing). With no organizer or no staff id in context it stays NULL, as before; app_organizer_id is NULL there.
CREATE OR REPLACE FUNCTION app_event_scope() RETURNS uuid[]
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org   uuid := NULLIF(current_setting('app.organizer_id', true), '')::uuid;
  staff uuid := NULLIF(current_setting('app.staff_user_id', true), '')::uuid;
  scope uuid[];
BEGIN
  IF org IS NULL OR staff IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT m.event_scope INTO scope FROM organizer_member m WHERE m.organizer_id = org AND m.staff_user_id = staff;
  IF FOUND THEN
    RETURN scope;
  END IF;
  SELECT coalesce(array_agg(g.event_id ORDER BY g.event_id), '{}'::uuid[]) INTO scope
  FROM support_grant g JOIN staff_user s ON s.id = g.admin_id
  WHERE g.admin_id = staff AND g.organizer_id = org AND g.closed_at IS NULL AND g.expires_at > now()
    AND s.platform_role = 'admin' AND s.status = 'active';
  RETURN scope;
END $$;

-- ================================================================ stamping support entries (ADR-408)
-- The trigger always assigns the column itself, ignoring any value a definer passed: the live grant of the entry's
-- staff actor in that organizer when the actor is not a member, else NULL. The API's INSERT column grant omits it.
ALTER TABLE audit_log ADD COLUMN support_grant_id uuid;
CREATE INDEX audit_log_support_idx ON audit_log (support_grant_id) WHERE support_grant_id IS NOT NULL;

CREATE FUNCTION audit_stamp_support() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.support_grant_id := NULL;
  IF NEW.actor_type = 'staff' AND NEW.organizer_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM organizer_member m WHERE m.organizer_id = NEW.organizer_id AND m.staff_user_id = NEW.actor_id) THEN
    NEW.support_grant_id := (
      SELECT g.id FROM support_grant g
      WHERE g.admin_id = NEW.actor_id AND g.organizer_id = NEW.organizer_id AND g.closed_at IS NULL
        AND g.expires_at > now()
      ORDER BY g.opened_at DESC LIMIT 1);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION audit_stamp_support() FROM PUBLIC;
CREATE TRIGGER audit_a_stamp_support BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_stamp_support();
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_a_stamp_support;

-- "Questify support" in the dashboard (Q-374): a staff member who is not a member of the organizer and has held a
-- support grant in it is shown as the marker `questify-support` (the dashboard translates it); anyone else by email.
CREATE FUNCTION staff_shown(staff uuid, org uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM organizer_member m WHERE m.organizer_id = org AND m.staff_user_id = s.id)
                   AND EXISTS (SELECT 1 FROM support_grant g WHERE g.organizer_id = org AND g.admin_id = s.id)
              THEN 'questify-support' ELSE s.email END
  FROM staff_user s WHERE s.id = staff
$$;
REVOKE ALL ON FUNCTION staff_shown(uuid, uuid) FROM PUBLIC;

-- ================================================================ public reads leave a suspended event out
CREATE OR REPLACE FUNCTION public_events(after_id uuid, page integer)
  RETURNS TABLE (id uuid, join_code text, name_ar text, name_en text, venue_ar text, venue_en text, kind text,
                 timezone text, starts_at timestamptz, ends_at timestamptz, status_now text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.join_code, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at)
  FROM event e
  WHERE e.access = 'public' AND 'public_list' = ANY (e.join_methods)
    AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    AND NOT event_suspended(e.id)
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM event c WHERE c.id = after_id)
         OR (e.starts_at, e.id) > (SELECT c.starts_at, c.id FROM event c WHERE c.id = after_id))
  ORDER BY e.starts_at, e.id
  LIMIT least(greatest(page, 1), 100)
$$;

CREATE OR REPLACE FUNCTION public_event(code text)
  RETURNS TABLE (id uuid, join_code text, name_ar text, name_en text, venue_ar text, venue_en text, kind text,
                 timezone text, starts_at timestamptz, ends_at timestamptz, status_now text, access text,
                 join_methods text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.join_code, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at), e.access, e.join_methods
  FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND NOT event_suspended(e.id)
$$;

CREATE OR REPLACE FUNCTION public_event_quests(code text)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, opens_at timestamptz, closes_at timestamptz, quest_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.opens_at, q.closes_at, q.position
  FROM event e
  JOIN category c ON c.event_id = e.id AND c.audience_kind IS NULL AND NOT c.hidden
  JOIN quest q ON q.category_id = c.id AND q.event_id = e.id AND q.visible AND NOT q.flash
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND e.access <> 'private'
    AND NOT event_suspended(e.id)
    AND quest_community_lock(q) IS NULL
  ORDER BY c.position, c.id, q.position, q.id
$$;

CREATE OR REPLACE FUNCTION public_event_join_rules(code text)
  RETURNS TABLE (guest_list_only boolean, email_domains text[], welcome_points integer, fields jsonb,
                 name_display text, name_audience text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.guest_list_only, e.email_domains, e.welcome_points, event_join_fields_json(e.id), e.name_display,
         e.name_audience
  FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND NOT event_suspended(e.id)
$$;

CREATE OR REPLACE FUNCTION public_event_rules(code text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rules_of(e) FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND NOT event_suspended(e.id)
$$;

-- The speaker's survey link (0089) answers like an unknown link while the event is suspended, as the other public reads.
CREATE OR REPLACE FUNCTION survey_shared_results(link_hash text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  share survey_share;
  results jsonb;
BEGIN
  SELECT s.* INTO share FROM survey_share s WHERE s.token_hash = link_hash;
  IF NOT FOUND OR event_suspended(share.event_id) THEN
    RETURN NULL;
  END IF;
  results := survey_results_core(share.event_id, share.quest_id);
  IF results IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN results || jsonb_build_object(
    'quest', (SELECT jsonb_build_object('ar', coalesce(q.title_ar, q.title_en), 'en', coalesce(q.title_en, q.title_ar))
              FROM quest q WHERE q.id = share.quest_id),
    'event', (SELECT jsonb_build_object('ar', coalesce(e.name_ar, e.name_en), 'en', coalesce(e.name_en, e.name_ar))
              FROM event e WHERE e.id = share.event_id));
END $$;

-- ================================================================ the big screen: nothing while suspended
CREATE OR REPLACE FUNCTION screen_event() RETURNS event
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  d  paired_device := current_device();
  ev event%ROWTYPE;
BEGIN
  IF d.kind <> 'screen' THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DV401';
  END IF;
  IF event_suspended(d.event_id) THEN
    RAISE EXCEPTION 'this event is suspended' USING ERRCODE = 'ES423';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = d.event_id;
  RETURN ev;
END $$;

-- ================================================================ batches skip a suspended event, never fail
-- Push: a notice of a suspended event is skipped at the claim (`suspended`), so nothing queued before the suspension
-- reaches players. As 0091 plus that one line.
CREATE OR REPLACE FUNCTION push_skip_reason(send bigint) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  SELECT p.status AS player_status, c.player_id AS recipient, e.status AS event_status, d AS device, k.class,
         k.topic, nt AS note, n AS member
  INTO r
  FROM push_send s
  JOIN notification c ON c.id = s.notification_id
  JOIN notice nt ON nt.id = c.notice_id
  JOIN notice_kind k ON k.kind = nt.kind
  JOIN push_device d ON d.id = s.device_id
  LEFT JOIN player p ON p.id = c.player_id
  LEFT JOIN event e ON e.id = nt.event_id
  LEFT JOIN enrollment n ON n.event_id = nt.event_id AND n.player_id = c.player_id
  WHERE s.id = send;
  RETURN CASE
    WHEN r.player_status IS DISTINCT FROM 'active' THEN 'player'
    WHEN r.event_status = 'archived' THEN 'archived'
    WHEN (r.note).event_id IS NOT NULL AND event_suspended((r.note).event_id) THEN 'suspended'
    WHEN (r.device).player_id <> r.recipient OR NOT push_pushable(r.device) THEN 'device'
    WHEN r.class = 'promo' AND NOT push_consented(r.recipient) THEN 'consent'
    WHEN push_muted(r.recipient, r.topic, (r.note).event_id) THEN 'muted'
    WHEN NOT notice_membership_ok(r.note, r.member) THEN 'not_member'
    WHEN (r.note).event_id IS NOT NULL AND NOT notice_visible(r.note, r.member) THEN 'not_visible'
    WHEN NOT notice_audience_ok(r.note, r.member) THEN 'not_member'
  END;
END $$;

-- Invitations: a sending campaign of a suspended event is held (not claimed, its queue untouched) until it is lifted.
CREATE OR REPLACE FUNCTION invitation_claim_campaigns(camps uuid[]) RETURNS uuid[]
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  over    uuid[];
  changed uuid[];
BEGIN
  SELECT coalesce(array_agg(x.id) FILTER (WHERE e.ends_at <= now()), '{}'::uuid[]),
         coalesce(array_agg(x.id) FILTER (WHERE e.ends_at > now() AND invitation_event_ok(e, true) IS NOT NULL),
                  '{}'::uuid[])
  INTO over, changed
  FROM invitation_campaign x JOIN event e ON e.id = x.event_id
  WHERE x.id = ANY (camps) AND x.state = 'sending';
  PERFORM invitation_skip_queued(over, 'event_over', 1000);
  PERFORM invitation_skip_queued(changed, 'event_changed', 1000);
  RETURN ARRAY(SELECT x.id FROM invitation_campaign x
               WHERE x.id = ANY (camps) AND x.state = 'sending' AND NOT (x.id = ANY (over || changed))
                 AND NOT event_suspended(x.event_id));
END $$;

-- Community: settling a goal of a suspended event answers 'busy' (the tick moves on; the settle point catches up after
-- the suspension is lifted).
CREATE OR REPLACE FUNCTION settle_goal(target_goal uuid, may_start boolean) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  goal community_goal%ROWTYPE;
  ev   event%ROWTYPE;
BEGIN
  PERFORM community_system_only();
  PERFORM community_read_committed();
  IF EXISTS (SELECT 1 FROM community_goal g WHERE g.id = target_goal AND event_suspended(g.event_id)) THEN
    RETURN 'busy';
  END IF;
  PERFORM ensure_rehearsal_wiped(g.event_id) FROM community_goal g WHERE g.id = target_goal;
  SELECT g.* INTO goal FROM community_goal g WHERE g.id = target_goal AND g.final_at IS NULL FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 'busy';
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = goal.event_id;
  RETURN settle_goal_at(goal, ev, interval '30 seconds', may_start);
END $$;

-- Community payer: the due rows of a suspended event wait (they are paid once it is lifted). As 0053 plus that line.
CREATE OR REPLACE FUNCTION pay_community_batch(size integer, only_event uuid)
  RETURNS TABLE (step_id uuid, paid integer, skipped integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  picked     community_payout%ROWTYPE;
  ev         event%ROWTYPE;
  amount     integer;
  ids        uuid[];
  balance_on boolean;
  final      boolean;
  n_paid     integer;
  n_skipped  integer;
BEGIN
  PERFORM community_system_only();
  IF only_event IS NOT NULL THEN
    PERFORM ensure_rehearsal_wiped(only_event);
  END IF;
  SELECT p.* INTO picked FROM community_payout p
  WHERE p.status = 'due' AND (only_event IS NULL OR p.event_id = only_event) AND NOT event_suspended(p.event_id)
  ORDER BY p.created_at, p.step_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF only_event IS NULL THEN
    PERFORM ensure_rehearsal_wiped(picked.event_id);
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = picked.event_id FOR KEY SHARE;
  ids := ARRAY(
    WITH taken AS (
      SELECT p.enrollment_id FROM community_payout p
      WHERE p.step_id = picked.step_id AND p.status = 'due'
      ORDER BY p.enrollment_id LIMIT least(greatest(coalesce(size, 500), 1), 1000)
      FOR UPDATE SKIP LOCKED
    )
    SELECT taken.enrollment_id FROM taken ORDER BY taken.enrollment_id);
  IF cardinality(ids) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = ANY (ids) ORDER BY n.id FOR NO KEY UPDATE;
  SELECT s.points INTO amount FROM community_step s WHERE s.id = picked.step_id;
  final := EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id);
  balance_on := shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) <> 'closed';

  WITH verdict AS (
    SELECT n.id,
           CASE WHEN final THEN 'results_final'
                WHEN n.status <> 'active' OR pl.status <> 'active' THEN 'inactive'
                WHEN EXISTS (SELECT 1 FROM staff_assignment sa
                             WHERE sa.event_id = n.event_id AND sa.player_id = n.player_id AND NOT sa.can_play)
                  THEN 'no_play' END AS why
    FROM enrollment n JOIN player pl ON pl.id = n.player_id
    WHERE n.id = ANY (ids)
  ), made AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              community_step_id)
    SELECT ev.organizer_id, ev.id, v.id, 'community', amount, CASE WHEN balance_on THEN amount ELSE 0 END, 'system',
           picked.step_id
    FROM verdict v WHERE v.why IS NULL ORDER BY v.id
    RETURNING id, enrollment_id
  ), paid_rows AS (
    UPDATE community_payout p SET status = 'paid', entry_id = m.id, done_at = now()
    FROM made m WHERE p.step_id = picked.step_id AND p.enrollment_id = m.enrollment_id
    RETURNING 1
  ), skipped_rows AS (
    UPDATE community_payout p SET status = 'skipped', skip_reason = v.why, done_at = now()
    FROM verdict v WHERE v.why IS NOT NULL AND p.step_id = picked.step_id AND p.enrollment_id = v.id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM paid_rows), (SELECT count(*) FROM skipped_rows) INTO n_paid, n_skipped;
  IF n_paid > 0 THEN
    PERFORM mark_ranking_repair(ev.id);
  END IF;
  RETURN QUERY SELECT picked.step_id, n_paid, n_skipped;
END $$;

-- ================================================================ "Questify support" where the dashboard shows an actor
-- Q-374: a points entry's "by", a flag's "resolved by", a ticket's answerer and escalator, a device's "paired by".
-- Each as its last restatement with the email read through staff_shown.
CREATE OR REPLACE FUNCTION public.member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
 RETURNS TABLE(id bigint, at timestamp with time zone, kind text, score_delta bigint, balance_delta bigint, quest_id uuid, title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint, removable boolean, removed boolean, multiplier integer, bonus_slots integer, bonus_place integer, streak_days integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar, es.title_ar, es.title_en),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en, cg.title_en, es.title_en, es.title_ar),
         coalesce(n.reason, b.reason, pc.from_points || ' → ' || pc.to_points),
         op.username, staff_shown(su.id, ev.organizer_id), l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus', 'streak', 'session')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus'
                   OR (l.kind = 'quest' AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = fs.entry_id))
              THEN fb.slots END,
         CASE WHEN l.kind = 'first_bonus' THEN first_bonus_place(fs) END,
         sd.days
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest_points_change pc ON pc.id = l.points_change_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN event_session es ON es.id = l.session_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_bonus_slot fs ON fs.completion_id = l.completion_id AND l.kind IN ('quest', 'first_bonus')
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = fs.quest_id
  LEFT JOIN event_streak_day sd ON sd.entry_id = l.id AND l.kind = 'streak'
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$
;

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
  SELECT f.id, f.kind, f.status, f.resolution, f.note, f.raised_at, f.last_seen_at, f.resolved_at, staff_shown(su.id, ev.organizer_id),
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

CREATE OR REPLACE FUNCTION event_tickets(target_event uuid, wanted text, wanted_kind text, cursor_id bigint, page integer)
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
         coalesce(op.username, staff_shown(su.id, ev.organizer_id)), coalesce(op.status = 'deleted', false), t.created_at, t.closed_at,
         t.reported_enrollment_id, rp.username, t.escalated_at, t.escalation_note, staff_shown(es.id, ev.organizer_id), t.returned_at,
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

-- As 0058 (a kiosk's scans in the last 24 hours), with the staff pairer through staff_shown.
CREATE OR REPLACE FUNCTION device_json(d paired_device) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'label', d.label, 'questId', d.quest_id,
    'questTitleAr', q.title_ar, 'questTitleEn', q.title_en, 'client', d.client,
    'pairedBy', CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('type', 'operator', 'name', p.username)
                     WHEN s.id IS NOT NULL
                       THEN jsonb_build_object('type', 'staff', 'name', staff_shown(s.id, d.organizer_id)) END,
    'pairedAt', d.paired_at, 'lastSeenAt', d.last_seen_at, 'activated', d.activated_at IS NOT NULL,
    'status', CASE WHEN d.status = 'active' AND NOT device_alive(d) THEN 'ended' ELSE d.status END,
    'paused', d.status = 'active' AND device_paused(d), 'revokedAt', d.revoked_at,
    'scans', CASE WHEN d.kind = 'kiosk' THEN
                    (SELECT count(*) FROM kiosk_scan k
                     WHERE k.device_id = d.id AND k.created_at > now() - interval '24 hours') END)
  FROM (SELECT 1) one
  LEFT JOIN quest q ON q.id = d.quest_id
  LEFT JOIN staff_assignment sa ON sa.id = d.paired_by_operator
  LEFT JOIN player p ON p.id = sa.player_id
  LEFT JOIN staff_user s ON s.id = d.paired_by_staff
$$;
