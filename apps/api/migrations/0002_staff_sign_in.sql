-- Staff sign-in (T-006): email codes, sessions, and the throttle.
-- Deny by default (docs/rules.md): every table has forced row-level security, explicit grants,
-- and nothing for PUBLIC. The three "pre-identity" settings let the sign-in code read exactly one row
-- before it knows who the caller is; the request itself can never set them.

-- ---------------------------------------------------------------- staff_user: narrow what the API may write
-- Policies filter rows, not columns, so a mass-assignment bug could otherwise promote a user to admin.
-- Accounts are created by the owner connection (CLI) for now; T-101 and T-701 add narrow grants.
REVOKE INSERT, UPDATE ON staff_user FROM questify_app;
GRANT UPDATE (password_hash) ON staff_user TO questify_app;

-- ---------------------------------------------------------------- pre-identity settings
CREATE FUNCTION app_auth_email() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.auth_email', true), '') $$;
CREATE FUNCTION app_session_token_hash() RETURNS bytea LANGUAGE sql STABLE
  AS $$ SELECT decode(NULLIF(current_setting('app.session_token_hash', true), ''), 'hex') $$;
CREATE FUNCTION app_challenge_token_hash() RETURNS bytea LANGUAGE sql STABLE
  AS $$ SELECT decode(NULLIF(current_setting('app.challenge_token_hash', true), ''), 'hex') $$;
REVOKE ALL ON FUNCTION app_auth_email(), app_session_token_hash(), app_challenge_token_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_auth_email(), app_session_token_hash(), app_challenge_token_hash() TO questify_app;

-- Sign-in looks the account up by its (normalized) email before the caller is known.
CREATE POLICY staff_user_signin ON staff_user FOR SELECT TO questify_app
  USING (email = app_auth_email());

-- ---------------------------------------------------------------- email-code challenges
CREATE TABLE staff_login_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  code_hash     bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  expires_at    timestamptz NOT NULL,
  attempts      smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  resends       smallint NOT NULL DEFAULT 0 CHECK (resends BETWEEN 0 AND 3),
  last_sent_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_login_challenge_user_idx ON staff_login_challenge (staff_user_id);
ALTER TABLE staff_login_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_login_challenge FORCE ROW LEVEL SECURITY;

-- Found only by the secret token the browser holds; never listed by user, so code_hash is not browsable.
CREATE POLICY challenge_by_token ON staff_login_challenge FOR SELECT TO questify_app
  USING (token_hash = app_challenge_token_hash());
CREATE POLICY challenge_update_by_token ON staff_login_challenge FOR UPDATE TO questify_app
  USING (token_hash = app_challenge_token_hash()) WITH CHECK (token_hash = app_challenge_token_hash());
CREATE POLICY challenge_insert_own ON staff_login_challenge FOR INSERT TO questify_app
  WITH CHECK (staff_user_id = app_staff_user_id());
-- Own rows (a new challenge replaces the old), and any row past retention (the global sweep).
-- The API issues a bare `DELETE FROM staff_login_challenge` and lets this policy choose the rows: a
-- DELETE with a WHERE clause must also pass the SELECT policy above, which hides these rows on purpose.
CREATE POLICY challenge_delete ON staff_login_challenge FOR DELETE TO questify_app
  USING (staff_user_id = app_staff_user_id() OR created_at < now() - interval '1 day');

GRANT SELECT, INSERT, DELETE ON staff_login_challenge TO questify_app;
GRANT UPDATE (attempts, resends, code_hash, last_sent_at, consumed_at) ON staff_login_challenge TO questify_app;

-- ---------------------------------------------------------------- sessions
CREATE TABLE staff_session (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  user_agent    text CHECK (length(user_agent) <= 300),
  ip            text CHECK (length(ip) <= 64)
);
CREATE INDEX staff_session_user_idx ON staff_session (staff_user_id);
ALTER TABLE staff_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_session FORCE ROW LEVEL SECURITY;

CREATE POLICY session_read ON staff_session FOR SELECT TO questify_app
  USING (staff_user_id = app_staff_user_id() OR app_is_admin() OR token_hash = app_session_token_hash());
CREATE POLICY session_insert_own ON staff_session FOR INSERT TO questify_app
  WITH CHECK (staff_user_id = app_staff_user_id());
CREATE POLICY session_update ON staff_session FOR UPDATE TO questify_app
  USING (staff_user_id = app_staff_user_id() OR token_hash = app_session_token_hash())
  WITH CHECK (staff_user_id = app_staff_user_id() OR token_hash = app_session_token_hash());
-- Own rows, and any row 30 days past its end or last use (the global sweep removes IP and user agent).
-- As above, the API issues a bare `DELETE FROM staff_session` and lets this policy choose the rows.
CREATE POLICY session_delete ON staff_session FOR DELETE TO questify_app
  USING (staff_user_id = app_staff_user_id()
         OR COALESCE(revoked_at, last_seen_at) < now() - interval '30 days');

GRANT SELECT, INSERT, DELETE ON staff_session TO questify_app;
GRANT UPDATE (last_seen_at, revoked_at) ON staff_session TO questify_app;

-- A revoked session stays revoked, and the last-seen time never moves backwards.
CREATE FUNCTION staff_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked session cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'last_seen_at cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION staff_session_guard() FROM PUBLIC;
CREATE TRIGGER staff_session_guard BEFORE UPDATE ON staff_session
  FOR EACH ROW EXECUTE FUNCTION staff_session_guard();

-- ---------------------------------------------------------------- throttle (sliding window)
-- Keys are keyed hashes (HMAC) of an email, an address or a user id; no readable personal data.
CREATE TABLE auth_throttle (
  bucket text NOT NULL CHECK (bucket ~ '^[a-z_]{1,32}$'),
  key    bytea NOT NULL CHECK (octet_length(key) = 32),
  at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_throttle_window_idx ON auth_throttle (bucket, key, at);
ALTER TABLE auth_throttle ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_throttle FORCE ROW LEVEL SECURITY;
CREATE POLICY throttle_app ON auth_throttle FOR ALL TO questify_app USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, DELETE ON auth_throttle TO questify_app;
