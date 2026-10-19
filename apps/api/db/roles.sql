-- Database roles. Run once per database server by whoever administers it, before the first migration.
-- Idempotent. Passwords are set separately and never kept in this repository.
--
--   questify_app       what the running API connects as. Not the table owner, no BYPASSRLS: row-level security applies.
--   questify_outsider  has no rights at all. Used by the outsider test to prove nothing is open to the public.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questify_app') THEN
    CREATE ROLE questify_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'questify_outsider') THEN
    CREATE ROLE questify_outsider LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
