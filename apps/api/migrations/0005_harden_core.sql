-- Harden the core tables (foundation review, 2026-10-19). Row-level security decides which rows a request may touch;
-- it cannot decide which columns. This migration closes the columns that matter most: points, bans, roles and contact
-- details. Each rule is a second wall behind the application checks (docs/ARCHITECTURE.md), never the only one.

-- ---------------------------------------------------------------- player contact details apart (DATA_MODEL: Sensitive data)
-- An organizer may see the players in its events, but never their phone or email. Those move to a table only the
-- player and Questify admins can read.
CREATE TABLE player_contact (
  player_id  uuid PRIMARY KEY REFERENCES player (id) ON DELETE CASCADE,
  phone_e164 text CHECK (phone_e164 ~ '^\+966[0-9]{9}$'),
  email      text CHECK (email = lower(email) AND position('@' IN email) > 1),
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX player_contact_phone_key ON player_contact (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX player_contact_email_key ON player_contact (email) WHERE email IS NOT NULL;

INSERT INTO player_contact (player_id, phone_e164, email)
  SELECT id, phone_e164, email FROM player WHERE phone_e164 IS NOT NULL OR email IS NOT NULL;

ALTER TABLE player DROP COLUMN phone_e164, DROP COLUMN email;

ALTER TABLE player_contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_contact FORCE ROW LEVEL SECURITY;
CREATE POLICY player_contact_own ON player_contact FOR ALL TO questify_app
  USING (player_id = app_player_id() OR app_is_admin())
  WITH CHECK (player_id = app_player_id() OR app_is_admin());
GRANT SELECT, INSERT ON player_contact TO questify_app;
GRANT UPDATE (phone_e164, email) ON player_contact TO questify_app;

-- ---------------------------------------------------------------- player: a player edits their profile, not their standing
REVOKE INSERT, UPDATE ON player FROM questify_app;
GRANT INSERT (username, birth_year) ON player TO questify_app;
GRANT UPDATE (username, birth_year, status, deleted_at) ON player TO questify_app;

-- Only a Questify admin changes a player's status, except that a player may delete their own active account.
CREATE FUNCTION player_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A wall for the API's own role; the owner connection (migrations, the staff CLI, support work) is trusted.
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    IF app_is_admin() THEN
      RETURN NEW;
    END IF;
    IF OLD.id = app_player_id() AND OLD.status = 'active' AND NEW.status = 'deleted' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'only a Questify admin can change a player''s status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION player_status_guard() FROM PUBLIC;
CREATE TRIGGER player_status_guard BEFORE UPDATE ON player
  FOR EACH ROW EXECUTE FUNCTION player_status_guard();

-- ---------------------------------------------------------------- enrollment: points are never written by hand
-- score and balance are copies of the points ledger (DATA_MODEL). The API role gets no write right on them at all;
-- T-105 adds the ledger and a trigger that keeps both copies in step with it.
REVOKE INSERT, UPDATE ON enrollment FROM questify_app;
GRANT INSERT (organizer_id, event_id, player_id, status) ON enrollment TO questify_app;
GRANT UPDATE (status) ON enrollment TO questify_app;

-- A player may enroll only themselves, only in an event they can see, and only as pending or active.
DROP POLICY enrollment_insert ON enrollment;
CREATE POLICY enrollment_insert ON enrollment FOR INSERT TO questify_app
  WITH CHECK (
    app_is_admin()
    OR organizer_id = app_organizer_id()
    OR (player_id = app_player_id()
        AND status IN ('pending', 'active')
        AND EXISTS (SELECT 1 FROM event e WHERE e.id = event_id AND e.organizer_id = enrollment.organizer_id))
  );

-- The event's organizer and Questify admins change any status; a player may only leave.
CREATE FUNCTION enrollment_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A wall for the API's own role; the owner connection (migrations, the staff CLI, support work) is trusted.
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF app_is_admin() OR OLD.organizer_id = app_organizer_id() THEN
      RETURN NEW;
    END IF;
    IF OLD.player_id = app_player_id() AND OLD.status IN ('pending', 'active') AND NEW.status = 'left' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'this change of enrollment status is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enrollment_status_guard() FROM PUBLIC;
CREATE TRIGGER enrollment_status_guard BEFORE UPDATE ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_status_guard();

-- ---------------------------------------------------------------- organizer team: only an owner (or admin) changes it
-- The owner check reads organizer_member itself, so it runs as the table's owner (SECURITY DEFINER) to avoid a
-- policy that refers to its own table. That owner is the migration role, which bypasses row-level security.
CREATE FUNCTION app_is_owner(org uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM organizer_member m
                       WHERE m.organizer_id = org AND m.staff_user_id = app_staff_user_id() AND m.role = 'owner') $$;
REVOKE ALL ON FUNCTION app_is_owner(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_is_owner(uuid) TO questify_app;

-- An organizer is created together with its first owner, in one step, so no organizer is ever left without an owner
-- for someone else to claim. Only a signed-in staff user can call it, and only for themselves.
CREATE FUNCTION create_organizer(organizer_name text, organizer_slug text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  creator uuid := app_staff_user_id();
  created uuid;
BEGIN
  IF creator IS NULL THEN
    RAISE EXCEPTION 'only a signed-in staff user can create an organizer' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO organizer (name, slug) VALUES (organizer_name, organizer_slug) RETURNING id INTO created;
  INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES (created, creator, 'owner');
  RETURN created;
END $$;
REVOKE ALL ON FUNCTION create_organizer(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_organizer(text, text) TO questify_app;

-- Ownership moves only by a transfer: the current owner (or an admin) names another member, who becomes owner while
-- the old owner becomes an editor, in one step.
CREATE FUNCTION transfer_ownership(org uuid, new_owner uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (app_is_admin() OR app_is_owner(org)) THEN
    RAISE EXCEPTION 'only the owner or a Questify admin can transfer ownership' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizer_member WHERE organizer_id = org AND staff_user_id = new_owner AND role = 'editor') THEN
    RAISE EXCEPTION 'the new owner must already be an editor of this organizer' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE organizer_member SET role = 'editor', event_scope = NULL WHERE organizer_id = org AND role = 'owner';
  UPDATE organizer_member SET role = 'owner', event_scope = NULL WHERE organizer_id = org AND staff_user_id = new_owner;
END $$;
REVOKE ALL ON FUNCTION transfer_ownership(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transfer_ownership(uuid, uuid) TO questify_app;

-- Organizers are created through create_organizer (or by an admin), never as a bare row without an owner.
DROP POLICY organizer_insert ON organizer;
CREATE POLICY organizer_insert ON organizer FOR INSERT TO questify_app WITH CHECK (app_is_admin());

DROP POLICY member_tenant ON organizer_member;
-- Reading: the team of the organizer in context, your own memberships, or everything for an admin.
CREATE POLICY member_read ON organizer_member FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() OR staff_user_id = app_staff_user_id() OR app_is_admin());
-- Adding and changing: an owner manages the other members (only editors can be added this way); an owner never
-- changes or removes their own row, so an organizer cannot lose its owner except through transfer_ownership.
CREATE POLICY member_insert ON organizer_member FOR INSERT TO questify_app
  WITH CHECK (app_is_admin() OR (app_is_owner(organizer_id) AND role = 'editor'));
CREATE POLICY member_update ON organizer_member FOR UPDATE TO questify_app
  USING (app_is_admin() OR (app_is_owner(organizer_id) AND staff_user_id <> app_staff_user_id()))
  WITH CHECK (app_is_admin() OR (app_is_owner(organizer_id) AND role = 'editor'));
CREATE POLICY member_delete ON organizer_member FOR DELETE TO questify_app
  USING (app_is_admin() OR (app_is_owner(organizer_id) AND staff_user_id <> app_staff_user_id()));

REVOKE UPDATE ON organizer_member FROM questify_app;
GRANT UPDATE (role, event_scope) ON organizer_member TO questify_app;
