-- The media database's role (T-814, ADR-839). Run once per media database server by its owner before its first
-- migration (`node migrate.cjs --media --roles`). Idempotent. The password is set from MEDIA_ROLE_PASSWORD and never
-- kept in this repository.
--
--   questify_media_app  what the API's media pool connects as: CONNECT on the media database and EXECUTE on its four
--                       definers only (m0001). Not the owner, no BYPASSRLS, no right in the main database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questify_media_app') THEN
    CREATE ROLE questify_media_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
