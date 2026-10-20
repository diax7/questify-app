-- Close temporary-table shadowing (T-107 review). PostgreSQL searches the session's temporary schema first for tables
-- when a function's search_path does not name `pg_temp`. A definer that reads `player`, `quest` or a challenge by name
-- could then be fed a temporary table of the same name by anyone holding the API's connection (an injection, a
-- compromised process), and act on fake rows with the owner's rights. Two walls:
--   1. nobody gets to create temporary tables here (the platform default grants it to PUBLIC: undo it);
--   2. every SECURITY DEFINER function, old and new, searches `public` first and `pg_temp` last.
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END
$$;

DO $$
DECLARE
  definer regprocedure;
BEGIN
  FOR definer IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', definer);
  END LOOP;
END
$$;
