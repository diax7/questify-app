-- T-712: view as organizer (FR-1837); plan docs/plans/2026-11-03-t-712-view-as-organizer.md, ADR-520 to ADR-525,
-- Q-480 to Q-483. A support grant gains a kind: `edit` (T-701, as before) or `view`. A view grant opens the organizer's
-- context only inside a read-only transaction, so a path that loses the API's read-only mark runs as nobody, never as
-- an editor. Every allowed read of a view is logged by `support_view_log` with the route pattern and path ids only,
-- coalesced per minute. Deny by default: every replaced or new function is revoked from PUBLIC in the group that creates
-- it; only the doors are granted to questify_app. No new table.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the kind (ADR-520)
-- Existing grants were opened as editors; afterwards every opener names the kind (no default).
ALTER TABLE support_grant ADD COLUMN kind text NOT NULL DEFAULT 'edit' CHECK (kind IN ('view', 'edit'));
ALTER TABLE support_grant ALTER COLUMN kind DROP DEFAULT;

-- Opens a grant of `kind` on one event for the calling admin: the rules of 0114 unchanged (SG409 for a member, 20 an hour
-- per admin for both kinds together, SG429), and opening again (either kind) replaces this admin's grant on the event.
DROP FUNCTION support_open(uuid, text, uuid);
CREATE FUNCTION support_open(target uuid, wanted text, reason text, request uuid)
  RETURNS TABLE (grant_id uuid, organizer_id uuid, event_id uuid, expires_at timestamptz, kind text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me    uuid := console_admin();
  clean text := suspension_reason_clean(reason);
  asked text := wanted;
  ev    event%ROWTYPE;
  made  support_grant%ROWTYPE;
BEGIN
  IF asked IS NULL OR asked NOT IN ('view', 'edit') THEN
    RAISE EXCEPTION 'kind must be view or edit' USING ERRCODE = 'SU400';
  END IF;
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
  INSERT INTO support_grant (admin_id, organizer_id, event_id, kind, reason, opened_at, expires_at)
  VALUES (me, ev.organizer_id, ev.id, asked, clean, now(), now() + interval '15 minutes')
  RETURNING * INTO made;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, ev.organizer_id, ev.id, 'support.opened', 'support_grant', made.id::text,
          jsonb_build_object('reason', clean, 'expiresAt', made.expires_at, 'kind', made.kind), request);
  RETURN QUERY SELECT made.id, made.organizer_id, made.event_id, made.expires_at, made.kind;
END $$;
REVOKE ALL ON FUNCTION support_open(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_open(uuid, text, text, uuid) TO questify_app;

-- The caller's own live grants with their kind (the dashboard's banner and the API's seat).
DROP FUNCTION own_support_grants();
CREATE FUNCTION own_support_grants()
  RETURNS TABLE (grant_id uuid, organizer_id uuid, organizer_name text, event_id uuid, expires_at timestamptz,
                 kind text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.id, g.organizer_id, o.name, g.event_id, g.expires_at, g.kind
  FROM support_grant g
  JOIN staff_user s ON s.id = g.admin_id AND s.platform_role = 'admin' AND s.status = 'active'
  JOIN organizer o ON o.id = g.organizer_id
  WHERE g.admin_id = app_staff_user_id() AND g.closed_at IS NULL AND g.expires_at > now()
  ORDER BY g.opened_at
$$;
REVOKE ALL ON FUNCTION own_support_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_support_grants() TO questify_app;

-- The live grants on one event with their kind, for the console's event page (admins only).
DROP FUNCTION event_support_grants(uuid);
CREATE FUNCTION event_support_grants(target uuid)
  RETURNS TABLE (id uuid, admin_id uuid, admin_email text, opened_at timestamptz, expires_at timestamptz, kind text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM console_admin();
  RETURN QUERY
  SELECT g.id, g.admin_id, s.email, g.opened_at, g.expires_at, g.kind
  FROM support_grant g JOIN staff_user s ON s.id = g.admin_id
  WHERE g.event_id = target AND g.closed_at IS NULL AND g.expires_at > now()
  ORDER BY g.opened_at;
END $$;
REVOKE ALL ON FUNCTION event_support_grants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_support_grants(uuid) TO questify_app;

-- ================================================================ a view grant needs a read-only transaction (ADR-521)
-- The support branch of 0114 honours a `view` grant only while `transaction_read_only` is on; a transaction cannot be
-- made read-write after its first statement, so no door can lift it. Membership branch and `edit` grants unchanged.
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
    AND (g.kind = 'edit' OR current_setting('transaction_read_only') = 'on')
  LIMIT 1;
  RETURN hit;
END $$;

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
    AND s.platform_role = 'admin' AND s.status = 'active'
    AND (g.kind = 'edit' OR current_setting('transaction_read_only') = 'on');
  RETURN scope;
END $$;

-- ================================================================ the read log (ADR-523)
-- One `support.viewed` row per grant, route pattern and path ids, unless the same three were logged in the last 60
-- seconds (a live page polls; Q-481). Only the grant's own admin, an active platform admin, on a live `view` grant.
-- `route` is the pattern below the organizer prefix (never the concrete URL or a query string); `ids` holds at most 4
-- UUID values. QA422 for anything else; SG404 when the grant is not this admin's live view.
CREATE INDEX audit_log_support_view_idx ON audit_log (target_id, at) WHERE action = 'support.viewed';

CREATE FUNCTION support_view_log(target uuid, route text, ids jsonb, request uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  staff uuid := app_staff_user_id();
  g     support_grant%ROWTYPE;
BEGIN
  IF route IS NULL OR route !~ '^(GET|HEAD) /[a-zA-Z0-9/:_-]{1,200}$' THEN
    RAISE EXCEPTION 'bad route' USING ERRCODE = 'QA422';
  END IF;
  IF ids IS NULL OR jsonb_typeof(ids) <> 'object'
     OR (SELECT count(*) FROM jsonb_each(ids)) > 4
     OR EXISTS (SELECT 1 FROM jsonb_each(ids) e
                WHERE e.key !~ '^[a-zA-Z]{1,40}$' OR jsonb_typeof(e.value) <> 'string'
                   OR (e.value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'bad ids' USING ERRCODE = 'QA422';
  END IF;
  SELECT gr.* INTO g
  FROM support_grant gr JOIN staff_user s ON s.id = gr.admin_id
  WHERE gr.id = target AND gr.admin_id = staff AND gr.kind = 'view' AND gr.closed_at IS NULL
    AND gr.expires_at > now() AND s.platform_role = 'admin' AND s.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live view grant of yours' USING ERRCODE = 'SG404';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(target::text || route || ids::text, 0));
  IF EXISTS (SELECT 1 FROM audit_log a
             WHERE a.action = 'support.viewed' AND a.target_id = target::text AND a.at > now() - interval '60 seconds'
               AND a.after = jsonb_build_object('route', route, 'ids', ids)) THEN
    RETURN false;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', staff, g.organizer_id, g.event_id, 'support.viewed', 'support_grant', target::text,
          jsonb_build_object('route', route, 'ids', ids), request);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION support_view_log(uuid, text, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_view_log(uuid, text, jsonb, uuid) TO questify_app;
