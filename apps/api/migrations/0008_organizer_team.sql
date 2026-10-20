-- Organizer sign-up, acceptances, the team, editor event limits, owner transfer (T-101).
-- Deny by default (docs/rules.md): forced row-level security, explicit grants, nothing for PUBLIC, and every
-- SECURITY DEFINER function validates its own inputs, pins its search_path and is executable by questify_app only.

-- ================================================================ the organizer context comes from the membership
-- No staff member, no tenant: the organizer setting counts only when the context's staff user is a member of that
-- organizer. A forged or stale app.organizer_id opens nothing. The functions read organizer_member as their owner (the
-- migration role, which bypasses row-level security), so the policies that call them cannot recurse.
CREATE OR REPLACE FUNCTION app_organizer_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.organizer_id FROM organizer_member m
  WHERE m.organizer_id = NULLIF(current_setting('app.organizer_id', true), '')::uuid
    AND m.staff_user_id = NULLIF(current_setting('app.staff_user_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION app_organizer_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizer_id() TO questify_app;

-- The caller's event limit in the organizer in context: NULL means every event (owners, unlimited editors).
CREATE FUNCTION app_event_scope() RETURNS uuid[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.event_scope FROM organizer_member m
  WHERE m.organizer_id = NULLIF(current_setting('app.organizer_id', true), '')::uuid
    AND m.staff_user_id = NULLIF(current_setting('app.staff_user_id', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION app_event_scope() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_event_scope() TO questify_app;

-- Plain and inlinable: policies pass the scope once per statement as `app_event_scope()`.
CREATE FUNCTION in_event_scope(event uuid, scope uuid[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT scope IS NULL OR event = ANY (scope) $$;
REVOKE ALL ON FUNCTION in_event_scope(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION in_event_scope(uuid, uuid[]) TO questify_app;

-- A limit always names at least one event (NULL is "all"; there is no "none"), and only this organizer's events.
ALTER TABLE organizer_member
  ADD CONSTRAINT organizer_member_scope_not_empty CHECK (event_scope IS NULL OR cardinality(event_scope) > 0);

CREATE FUNCTION organizer_member_scope_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.event_scope IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(NEW.event_scope) AS s(id)
    WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = s.id AND e.organizer_id = NEW.organizer_id)
  ) THEN
    RAISE EXCEPTION 'an event limit may name only this organizer''s events' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION organizer_member_scope_guard() FROM PUBLIC;
CREATE TRIGGER organizer_member_scope_guard BEFORE INSERT OR UPDATE OF event_scope ON organizer_member
  FOR EACH ROW EXECUTE FUNCTION organizer_member_scope_guard();

-- ================================================================ policies: the context from the membership, scoped
DROP POLICY event_read ON event;
DROP POLICY event_write ON event;
DROP POLICY event_update ON event;
DROP POLICY event_delete ON event;
CREATE POLICY event_read ON event FOR SELECT TO questify_app
  USING (
    (organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope()))
    OR app_is_admin()
    OR (access = 'public' AND status IN ('scheduled', 'live', 'ended'))
    OR EXISTS (SELECT 1 FROM enrollment e WHERE e.event_id = event.id AND e.player_id = app_player_id())
  );
-- A limited editor cannot create events: the new event would fall outside their own limit.
CREATE POLICY event_write ON event FOR INSERT TO questify_app
  WITH CHECK ((organizer_id = app_organizer_id() AND app_event_scope() IS NULL) OR app_is_admin());
CREATE POLICY event_update ON event FOR UPDATE TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope())) OR app_is_admin());
CREATE POLICY event_delete ON event FOR DELETE TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope())) OR app_is_admin());

DROP POLICY enrollment_read ON enrollment;
DROP POLICY enrollment_insert ON enrollment;
DROP POLICY enrollment_update ON enrollment;
CREATE POLICY enrollment_read ON enrollment FOR SELECT TO questify_app
  USING (
    (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
    OR player_id = app_player_id() OR app_is_admin()
  );
CREATE POLICY enrollment_insert ON enrollment FOR INSERT TO questify_app
  WITH CHECK (
    app_is_admin()
    OR (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
    OR (player_id = app_player_id()
        AND status IN ('pending', 'active')
        AND EXISTS (SELECT 1 FROM event e WHERE e.id = event_id AND e.organizer_id = enrollment.organizer_id))
  );
CREATE POLICY enrollment_update ON enrollment FOR UPDATE TO questify_app
  USING (
    (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
    OR player_id = app_player_id() OR app_is_admin()
  )
  WITH CHECK (
    (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
    OR player_id = app_player_id() OR app_is_admin()
  );

DROP POLICY player_own ON player;
CREATE POLICY player_own ON player FOR ALL TO questify_app
  USING (
    id = app_player_id() OR app_is_admin()
    OR EXISTS (SELECT 1 FROM enrollment e
               WHERE e.player_id = player.id AND e.organizer_id = app_organizer_id()
                 AND in_event_scope(e.event_id, app_event_scope()))
  )
  WITH CHECK (id = app_player_id() OR app_is_admin());

-- Organizer-level entries (no event: team changes) stay readable by every member; event entries follow the limit.
DROP POLICY audit_read ON audit_log;
CREATE POLICY audit_read ON audit_log FOR SELECT TO questify_app
  USING (
    (organizer_id = app_organizer_id()
     AND (event_id IS NULL OR in_event_scope(event_id, app_event_scope())))
    OR app_is_admin()
  );

-- Members join only through an invite (apply_invite) or by creating the organizer (insert_organizer), never by a bare
-- insert: an owner could otherwise add anyone to their team without that person's consent.
DROP POLICY member_insert ON organizer_member;
REVOKE INSERT ON organizer_member FROM questify_app;

-- An editor may leave an organizer; the owner never removes their own row (FR-1011).
DROP POLICY member_delete ON organizer_member;
CREATE POLICY member_delete ON organizer_member FOR DELETE TO questify_app
  USING (
    app_is_admin()
    OR (app_is_owner(organizer_id) AND staff_user_id <> app_staff_user_id())
    OR (staff_user_id = app_staff_user_id() AND role = 'editor')
  );

-- ================================================================ acceptances (FR-1726), append-only
CREATE TABLE organizer_acceptance (
  organizer_id uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  document     text NOT NULL CHECK (document IN ('organizer_terms', 'organizer_dpa', 'organizer_content_rules')),
  version      text NOT NULL CHECK (version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  accepted_by  uuid NOT NULL REFERENCES staff_user (id),
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_id, document, version)
);
ALTER TABLE organizer_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_acceptance FORCE ROW LEVEL SECURITY;
CREATE POLICY acceptance_read ON organizer_acceptance FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() OR app_is_admin());
-- Written only by the definer functions below; no INSERT, UPDATE or DELETE for the API's role.
GRANT SELECT ON organizer_acceptance TO questify_app;

-- ================================================================ creating an organizer (one door, FR-1401, FR-1726)
DROP FUNCTION create_organizer(text, text);
DROP FUNCTION transfer_ownership(uuid, uuid);

-- Internal: the organizer, its first owner, the three acceptances and the audit entry. No EXECUTE for the API.
CREATE FUNCTION insert_organizer(
  creator uuid, organizer_name text, organizer_slug text,
  terms text, dpa text, content_rules text, request uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  created uuid;
BEGIN
  INSERT INTO organizer (name, slug) VALUES (organizer_name, organizer_slug) RETURNING id INTO created;
  INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES (created, creator, 'owner');
  INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by) VALUES
    (created, 'organizer_terms', terms, creator),
    (created, 'organizer_dpa', dpa, creator),
    (created, 'organizer_content_rules', content_rules, creator);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', creator, created, 'organizer.create', 'organizer', created::text,
          jsonb_build_object('terms', terms, 'dpa', dpa, 'contentRules', content_rules), request);
  RETURN created;
END $$;
REVOKE ALL ON FUNCTION insert_organizer(uuid, text, text, text, text, text, uuid) FROM PUBLIC;

-- A signed-in staff user creates an organizer and becomes its owner, accepting the three documents.
CREATE FUNCTION create_organizer(
  organizer_name text, organizer_slug text, terms text, dpa text, content_rules text, request uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  creator uuid := app_staff_user_id();
BEGIN
  IF creator IS NULL OR NOT EXISTS (SELECT 1 FROM staff_user WHERE id = creator AND status = 'active') THEN
    RAISE EXCEPTION 'only a signed-in staff user can create an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN insert_organizer(creator, organizer_name, organizer_slug, terms, dpa, content_rules, request);
END $$;
REVOKE ALL ON FUNCTION create_organizer(text, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_organizer(text, text, text, text, text, uuid) TO questify_app;

-- ================================================================ pending sign-ups, found only by their token
CREATE FUNCTION app_signup_token_hash() RETURNS bytea LANGUAGE sql STABLE
  AS $$ SELECT decode(NULLIF(current_setting('app.signup_token_hash', true), ''), 'hex') $$;
REVOKE ALL ON FUNCTION app_signup_token_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_signup_token_hash() TO questify_app;

CREATE TABLE staff_signup (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash       bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  code_hash        bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  email            text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1 AND length(email) <= 254),
  -- NULL when the email already had an account: such a sign-up can never complete.
  password_hash    text,
  organizer_name   text NOT NULL CHECK (length(btrim(organizer_name)) BETWEEN 2 AND 80),
  accepted_terms   text NOT NULL,
  accepted_dpa     text NOT NULL,
  accepted_content text NOT NULL,
  attempts         smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  resends          smallint NOT NULL DEFAULT 0 CHECK (resends BETWEEN 0 AND 3),
  last_sent_at     timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE staff_signup ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_signup FORCE ROW LEVEL SECURITY;
CREATE POLICY signup_by_token ON staff_signup FOR SELECT TO questify_app
  USING (token_hash = app_signup_token_hash());
CREATE POLICY signup_insert_by_token ON staff_signup FOR INSERT TO questify_app
  WITH CHECK (token_hash = app_signup_token_hash());
CREATE POLICY signup_update_by_token ON staff_signup FOR UPDATE TO questify_app
  USING (token_hash = app_signup_token_hash()) WITH CHECK (token_hash = app_signup_token_hash());
CREATE POLICY signup_delete ON staff_signup FOR DELETE TO questify_app
  USING (token_hash = app_signup_token_hash() OR created_at < now() - interval '1 day');
GRANT SELECT, INSERT, DELETE ON staff_signup TO questify_app;
GRANT UPDATE (attempts, resends, code_hash, last_sent_at) ON staff_signup TO questify_app;

-- Completes the sign-up the token opens, after the API has checked the emailed code: the account, the organizer with
-- its owner and acceptances, the audit entries; the pending row goes. Returns the new account and organizer.
-- The API passes the HMAC of the code the person typed; the function refuses unless it is the stored one, so the
-- database itself demands proof of the mailbox.
CREATE FUNCTION complete_signup(
  organizer_slug text, typed_code_hash bytea, request uuid, OUT staff_user_id uuid, OUT organizer_id uuid
)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  pending staff_signup%ROWTYPE;
BEGIN
  SELECT * INTO pending FROM staff_signup WHERE token_hash = app_signup_token_hash() FOR UPDATE;
  IF NOT FOUND OR pending.expires_at <= now() OR pending.attempts >= 5 OR pending.password_hash IS NULL
     OR typed_code_hash IS DISTINCT FROM pending.code_hash THEN
    RAISE EXCEPTION 'this sign-up cannot be completed' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO staff_user (email, password_hash) VALUES (pending.email, pending.password_hash)
    RETURNING id INTO staff_user_id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('staff', staff_user_id, 'staff.signup', 'staff_user', staff_user_id::text, request);
  organizer_id := insert_organizer(staff_user_id, pending.organizer_name, organizer_slug,
                                   pending.accepted_terms, pending.accepted_dpa, pending.accepted_content, request);
  DELETE FROM staff_signup WHERE id = pending.id;
END $$;
REVOKE ALL ON FUNCTION complete_signup(text, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_signup(text, bytea, uuid) TO questify_app;

-- ================================================================ invites (editors) and owner invites (transfer)
CREATE FUNCTION app_invite_token_hash() RETURNS bytea LANGUAGE sql STABLE
  AS $$ SELECT decode(NULLIF(current_setting('app.invite_token_hash', true), ''), 'hex') $$;
REVOKE ALL ON FUNCTION app_invite_token_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_invite_token_hash() TO questify_app;

CREATE TABLE organizer_invite (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  email        text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1 AND length(email) <= 254),
  role         text NOT NULL CHECK (role IN ('editor', 'owner')),
  event_scope  uuid[] CHECK (event_scope IS NULL OR cardinality(event_scope) > 0),
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by   uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (role = 'editor' OR event_scope IS NULL),
  UNIQUE (organizer_id, email)
);
CREATE UNIQUE INDEX organizer_invite_one_owner ON organizer_invite (organizer_id) WHERE role = 'owner';
ALTER TABLE organizer_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_invite FORCE ROW LEVEL SECURITY;
-- Members see their organizer's pending invites; the token's holder sees that one invite.
CREATE POLICY invite_read ON organizer_invite FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() OR token_hash = app_invite_token_hash() OR app_is_admin());
CREATE POLICY invite_insert ON organizer_invite FOR INSERT TO questify_app
  WITH CHECK (app_is_owner(organizer_id) AND invited_by = app_staff_user_id());
-- The owner cancels; the sweep removes invites 30 days past their expiry.
CREATE POLICY invite_delete ON organizer_invite FOR DELETE TO questify_app
  USING (app_is_owner(organizer_id) OR expires_at < now() - interval '30 days');
GRANT SELECT, INSERT, DELETE ON organizer_invite TO questify_app;

-- Internal: the owner becomes an editor and the named member becomes the owner, in one step. No EXECUTE for the API.
CREATE FUNCTION swap_owner(org uuid, new_owner uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  old_owner uuid;
BEGIN
  SELECT staff_user_id INTO old_owner FROM organizer_member WHERE organizer_id = org AND role = 'owner' FOR UPDATE;
  UPDATE organizer_member SET role = 'editor', event_scope = NULL WHERE organizer_id = org AND role = 'owner';
  UPDATE organizer_member SET role = 'owner', event_scope = NULL WHERE organizer_id = org AND staff_user_id = new_owner;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, before, after, request_id)
  VALUES ('staff', new_owner, org, 'organizer.owner.transfer', 'organizer', org::text,
          jsonb_build_object('owner', old_owner), jsonb_build_object('owner', new_owner), request);
END $$;
REVOKE ALL ON FUNCTION swap_owner(uuid, uuid, uuid) FROM PUBLIC;

-- Internal: adds the invited person to the team (or swaps the owner for an owner invite), audits, removes the invite.
CREATE FUNCTION apply_invite(invite organizer_invite, member uuid, request uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  limit_now uuid[];
BEGIN
  IF invite.role = 'owner' AND NOT EXISTS (
    SELECT 1 FROM organizer_member WHERE organizer_id = invite.organizer_id AND staff_user_id = invite.invited_by AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'the person who sent this owner invite no longer owns the organizer' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM organizer_member WHERE organizer_id = invite.organizer_id AND staff_user_id = member) THEN
    -- An owner invite may go to a current editor; an editor invite to a current member would change nothing.
    IF invite.role = 'editor' THEN
      RAISE EXCEPTION 'this person is already a member of the organizer' USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    -- Events deleted since the invite was sent leave its limit; if none is left the invite is refused rather than
    -- widened to every event.
    limit_now := ARRAY(SELECT s.id FROM unnest(invite.event_scope) AS s(id)
                       WHERE EXISTS (SELECT 1 FROM event e WHERE e.id = s.id AND e.organizer_id = invite.organizer_id));
    IF invite.event_scope IS NOT NULL AND cardinality(limit_now) = 0 THEN
      RAISE EXCEPTION 'the events this invite was limited to no longer exist' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope)
    VALUES (invite.organizer_id, member, 'editor', CASE WHEN invite.event_scope IS NULL THEN NULL ELSE limit_now END);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', member, invite.organizer_id, 'organizer.member.join', 'staff_user', member::text,
          jsonb_build_object('role', invite.role, 'invitedBy', invite.invited_by), request);
  IF invite.role = 'owner' THEN
    PERFORM swap_owner(invite.organizer_id, member, request);
  END IF;
  DELETE FROM organizer_invite WHERE id = invite.id;
  RETURN invite.organizer_id;
END $$;
REVOKE ALL ON FUNCTION apply_invite(organizer_invite, uuid, uuid) FROM PUBLIC;

-- The signed-in person accepts the invite the token opens; it must have been sent to their own email.
CREATE FUNCTION accept_invite(request uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  invite organizer_invite%ROWTYPE;
  member uuid := app_staff_user_id();
BEGIN
  SELECT * INTO invite FROM organizer_invite WHERE token_hash = app_invite_token_hash() FOR UPDATE;
  IF NOT FOUND OR invite.expires_at <= now() THEN
    RAISE EXCEPTION 'this invite has expired or was already used' USING ERRCODE = 'check_violation';
  END IF;
  IF member IS NULL OR NOT EXISTS (
    SELECT 1 FROM staff_user WHERE id = member AND email = invite.email AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'this invite was sent to another email address' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN apply_invite(invite, member, request);
END $$;
REVOKE ALL ON FUNCTION accept_invite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invite(uuid) TO questify_app;

-- Someone without an account accepts the invite the token opens: the link proved the mailbox, so the account is
-- created with the invite's email and the password the API has already checked and hashed.
CREATE FUNCTION accept_invite_new(new_password_hash text, request uuid, OUT staff_user_id uuid, OUT organizer_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  invite organizer_invite%ROWTYPE;
BEGIN
  SELECT * INTO invite FROM organizer_invite WHERE token_hash = app_invite_token_hash() FOR UPDATE;
  IF NOT FOUND OR invite.expires_at <= now() THEN
    RAISE EXCEPTION 'this invite has expired or was already used' USING ERRCODE = 'check_violation';
  END IF;
  IF new_password_hash IS NULL OR new_password_hash !~ '^\$argon2id\$' THEN
    RAISE EXCEPTION 'a new account needs an argon2id password hash' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO staff_user (email, password_hash) VALUES (invite.email, new_password_hash) RETURNING id INTO staff_user_id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('staff', staff_user_id, 'staff.signup', 'staff_user', staff_user_id::text, request);
  organizer_id := apply_invite(invite, staff_user_id, request);
END $$;
REVOKE ALL ON FUNCTION accept_invite_new(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_invite_new(text, uuid) TO questify_app;

-- Roles change only inside the functions above (owner invites); the API's role may change an editor's event limit.
REVOKE UPDATE ON organizer_member FROM questify_app;
GRANT UPDATE (event_scope) ON organizer_member TO questify_app;

-- The team of the organizer in context, with each member's email. A function, so a colleague's email is readable
-- while the staff_user row (password hash included) stays visible to its own user only.
CREATE FUNCTION team_members()
  RETURNS TABLE (staff_user_id uuid, email text, role text, event_scope uuid[], joined_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.staff_user_id, u.email, m.role, m.event_scope, m.created_at
  FROM organizer_member m JOIN staff_user u ON u.id = m.staff_user_id
  WHERE m.organizer_id = app_organizer_id()
  ORDER BY m.role DESC, m.created_at
$$;
REVOKE ALL ON FUNCTION team_members() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_members() TO questify_app;
