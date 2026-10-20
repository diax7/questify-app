-- Staff password reset links (T-020).
-- Deny by default (docs/rules.md): forced row-level security, explicit grants, nothing for PUBLIC.
-- A link is found only by the hash of the secret token the person holds, and is used up by deleting it,
-- so the table has no UPDATE grant at all.

-- ---------------------------------------------------------------- pre-identity setting
CREATE FUNCTION app_reset_token_hash() RETURNS bytea LANGUAGE sql STABLE
  AS $$ SELECT decode(NULLIF(current_setting('app.reset_token_hash', true), ''), 'hex') $$;
REVOKE ALL ON FUNCTION app_reset_token_hash() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_reset_token_hash() TO questify_app;

-- ---------------------------------------------------------------- reset links
CREATE TABLE staff_password_reset (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_password_reset_user_idx ON staff_password_reset (staff_user_id);
ALTER TABLE staff_password_reset ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_password_reset FORCE ROW LEVEL SECURITY;

-- Seen only through the token: never listed by user.
CREATE POLICY reset_by_token ON staff_password_reset FOR SELECT TO questify_app
  USING (token_hash = app_reset_token_hash());
CREATE POLICY reset_insert_own ON staff_password_reset FOR INSERT TO questify_app
  WITH CHECK (staff_user_id = app_staff_user_id());
-- The link being used (by token), the user's own other links (a new link or a password set replaces them), and any
-- link past retention (the global sweep). As in 0002, the API issues bare deletes for the last two and lets this policy
-- choose the rows: a DELETE with a WHERE clause must also pass the SELECT policy, which shows only the token's row.
CREATE POLICY reset_delete ON staff_password_reset FOR DELETE TO questify_app
  USING (
    staff_user_id = app_staff_user_id()
    OR token_hash = app_reset_token_hash()
    OR created_at < now() - interval '1 day'
  );

GRANT SELECT, INSERT, DELETE ON staff_password_reset TO questify_app;
