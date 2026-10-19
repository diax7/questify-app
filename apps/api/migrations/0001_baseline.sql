-- Baseline: organizers, staff, players, events, enrollments.
-- Rules (docs/rules.md, docs/SECURITY.md): deny by default, row-level security on every table, no public access.
-- Written for PostgreSQL 15 or later. Requires the roles in db/roles.sql.

-- ---------------------------------------------------------------- deny by default
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO questify_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- ---------------------------------------------------------------- request context
-- The API sets these inside every transaction (SET LOCAL). Row-level security reads them.
-- This is a second wall behind the application checks, not a replacement for them.
CREATE FUNCTION app_organizer_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.organizer_id', true), '')::uuid $$;
CREATE FUNCTION app_player_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.player_id', true), '')::uuid $$;
CREATE FUNCTION app_staff_user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.staff_user_id', true), '')::uuid $$;
CREATE FUNCTION app_is_admin() RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(current_setting('app.is_admin', true), '') = 'on' $$;
REVOKE ALL ON FUNCTION app_organizer_id(), app_player_id(), app_staff_user_id(), app_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_organizer_id(), app_player_id(), app_staff_user_id(), app_is_admin() TO questify_app;

-- ---------------------------------------------------------------- organizer (a tenant)
CREATE TABLE organizer (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(btrim(name)) > 0),
  slug       text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'pending')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizer_slug_key ON organizer (lower(slug));

-- ---------------------------------------------------------------- staff accounts (owners, editors, Questify admins)
CREATE TABLE staff_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  password_hash text NOT NULL,
  platform_role text NOT NULL DEFAULT 'none' CHECK (platform_role IN ('none', 'admin')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staff_user_email_key ON staff_user (email);

CREATE TABLE organizer_member (
  organizer_id  uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'editor')),
  event_scope   uuid[],
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organizer_id, staff_user_id)
);
CREATE UNIQUE INDEX organizer_one_owner ON organizer_member (organizer_id) WHERE role = 'owner';

-- ---------------------------------------------------------------- players (not tenant data: one profile across events)
CREATE TABLE player (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username   text NOT NULL CHECK (length(btrim(username)) BETWEEN 3 AND 30),
  phone_e164 text CHECK (phone_e164 ~ '^\+966[0-9]{9}$'),
  email      text CHECK (email = lower(email) AND position('@' IN email) > 1),
  birth_year smallint CHECK (birth_year BETWEEN 1900 AND 2100),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL OR status = 'deleted')
);
CREATE UNIQUE INDEX player_username_key ON player (lower(username));
CREATE UNIQUE INDEX player_phone_key ON player (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE UNIQUE INDEX player_email_key ON player (email) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------- events (tenant data)
CREATE TABLE event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL REFERENCES organizer (id),
  join_code      text NOT NULL CHECK (join_code ~ '^[A-Za-z0-9]{4,12}$'),
  name_ar        text,
  name_en        text,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'live', 'ended', 'archived')),
  access         text NOT NULL DEFAULT 'public' CHECK (access IN ('public', 'unlisted', 'private')),
  timezone       text NOT NULL DEFAULT 'Asia/Riyadh',
  day_start_hour smallint NOT NULL DEFAULT 4 CHECK (day_start_hour BETWEEN 0 AND 23),
  starts_at      timestamptz,
  ends_at        timestamptz,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  config_version integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organizer_id),
  CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
);
CREATE UNIQUE INDEX event_join_code_key ON event (lower(join_code));
CREATE INDEX event_organizer_idx ON event (organizer_id, status);

CREATE TABLE enrollment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  player_id    uuid NOT NULL REFERENCES player (id),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'left', 'removed', 'banned')),
  score        bigint NOT NULL DEFAULT 0 CHECK (score >= 0),
  balance      bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, player_id),
  -- the tenant key on an enrollment must always match its event's tenant key
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id)
);
CREATE INDEX enrollment_ranking_idx ON enrollment (event_id, score DESC) WHERE status = 'active';
CREATE INDEX enrollment_player_idx ON enrollment (player_id);

-- ---------------------------------------------------------------- row-level security (every table, forced)
ALTER TABLE organizer        ENABLE ROW LEVEL SECURITY; ALTER TABLE organizer        FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_user       ENABLE ROW LEVEL SECURITY; ALTER TABLE staff_user       FORCE ROW LEVEL SECURITY;
ALTER TABLE organizer_member ENABLE ROW LEVEL SECURITY; ALTER TABLE organizer_member FORCE ROW LEVEL SECURITY;
ALTER TABLE player           ENABLE ROW LEVEL SECURITY; ALTER TABLE player           FORCE ROW LEVEL SECURITY;
ALTER TABLE event            ENABLE ROW LEVEL SECURITY; ALTER TABLE event            FORCE ROW LEVEL SECURITY;
ALTER TABLE enrollment       ENABLE ROW LEVEL SECURITY; ALTER TABLE enrollment       FORCE ROW LEVEL SECURITY;

-- organizer: the name and slug appear on public event pages, so anyone using the app may read; only the tenant writes.
CREATE POLICY organizer_read   ON organizer FOR SELECT TO questify_app USING (true);
CREATE POLICY organizer_insert ON organizer FOR INSERT TO questify_app WITH CHECK (app_is_admin() OR app_staff_user_id() IS NOT NULL);
CREATE POLICY organizer_update ON organizer FOR UPDATE TO questify_app
  USING (id = app_organizer_id() OR app_is_admin()) WITH CHECK (id = app_organizer_id() OR app_is_admin());

-- staff_user: a person sees themselves; Questify admins see all. Sign-in lookup arrives with T-006.
CREATE POLICY staff_user_own ON staff_user FOR ALL TO questify_app
  USING (id = app_staff_user_id() OR app_is_admin()) WITH CHECK (id = app_staff_user_id() OR app_is_admin());

-- organizer_member: the tenant's team.
CREATE POLICY member_tenant ON organizer_member FOR ALL TO questify_app
  USING (organizer_id = app_organizer_id() OR staff_user_id = app_staff_user_id() OR app_is_admin())
  WITH CHECK (organizer_id = app_organizer_id() OR app_is_admin());

-- player: a player sees themselves; staff see players enrolled in their own events; admins see all.
CREATE POLICY player_own ON player FOR ALL TO questify_app
  USING (id = app_player_id() OR app_is_admin()
         OR EXISTS (SELECT 1 FROM enrollment e WHERE e.player_id = player.id AND e.organizer_id = app_organizer_id()))
  WITH CHECK (id = app_player_id() OR app_is_admin());

-- event: the tenant reads and writes its own; players read events they joined and public events that are not drafts.
CREATE POLICY event_read ON event FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() OR app_is_admin()
         OR (access = 'public' AND status IN ('scheduled', 'live', 'ended'))
         OR EXISTS (SELECT 1 FROM enrollment e WHERE e.event_id = event.id AND e.player_id = app_player_id()));
CREATE POLICY event_write ON event FOR INSERT TO questify_app
  WITH CHECK (organizer_id = app_organizer_id() OR app_is_admin());
CREATE POLICY event_update ON event FOR UPDATE TO questify_app
  USING (organizer_id = app_organizer_id() OR app_is_admin()) WITH CHECK (organizer_id = app_organizer_id() OR app_is_admin());
CREATE POLICY event_delete ON event FOR DELETE TO questify_app
  USING (organizer_id = app_organizer_id() OR app_is_admin());

-- enrollment: the tenant sees its event's players; a player sees their own enrollments across organizers.
CREATE POLICY enrollment_read ON enrollment FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() OR player_id = app_player_id() OR app_is_admin());
CREATE POLICY enrollment_insert ON enrollment FOR INSERT TO questify_app
  WITH CHECK (player_id = app_player_id() OR organizer_id = app_organizer_id() OR app_is_admin());
CREATE POLICY enrollment_update ON enrollment FOR UPDATE TO questify_app
  USING (organizer_id = app_organizer_id() OR player_id = app_player_id() OR app_is_admin())
  WITH CHECK (organizer_id = app_organizer_id() OR player_id = app_player_id() OR app_is_admin());

-- ---------------------------------------------------------------- grants (explicit, minimal)
GRANT SELECT, INSERT, UPDATE         ON organizer        TO questify_app;
GRANT SELECT, INSERT, UPDATE         ON staff_user       TO questify_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organizer_member TO questify_app;
GRANT SELECT, INSERT, UPDATE         ON player           TO questify_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON event            TO questify_app;
GRANT SELECT, INSERT, UPDATE         ON enrollment       TO questify_app;
