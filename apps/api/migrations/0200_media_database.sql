-- Photos in a second PostgreSQL database (T-814 phase 1, ADR-839; plan docs/plans/2026-11-15-photos-in-postgres.md
-- section 3.2, plan review 86). The bytes move to the media database (its own series, m0001); `media_object` and
-- `media_delete` stay here as the source of truth. This file adds the reconcile's two doors and closes CONNECT.
--
-- 1. `media_keys_known(keys)`: for the daily reconcile, one row `(key, known)` for every distinct key asked, so the
--    worker can tell a short or odd answer from a real "unknown" and stop (review 86 MAJOR 1). System seat only.
-- 2. `media_reconcile_run` and `media_reconcile_claim()`: the daily run's lease, so one replica runs it in 23 hours.
-- 3. CONNECT on this database is revoked from PUBLIC and granted to `questify_app` and the migration owner (review 86
--    MINOR 5): the media role, and any other role on a shared server, cannot connect here.
--
-- Lock order: `media_keys_known` reads media_object only; the claim updates its one row and nothing else.
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION media_keys_known(keys text[]) RETURNS TABLE (key text, known boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM media_system();
  IF keys IS NULL OR cardinality(keys) > 500 THEN
    RAISE EXCEPTION 'one to 500 keys a call' USING ERRCODE = 'MD422';
  END IF;
  RETURN QUERY
  SELECT asked.k, EXISTS (SELECT 1 FROM media_object m WHERE m.key = asked.k)
  FROM (SELECT DISTINCT k FROM unnest(keys) AS k WHERE k IS NOT NULL) AS asked
  ORDER BY asked.k;
END $$;
REVOKE ALL ON FUNCTION media_keys_known(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_keys_known(text[]) TO questify_app;

CREATE TABLE media_reconcile_run (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  started_at timestamptz NOT NULL
);
INSERT INTO media_reconcile_run (id, started_at) VALUES (true, '-infinity');
ALTER TABLE media_reconcile_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_reconcile_run FORCE ROW LEVEL SECURITY;
REVOKE ALL ON media_reconcile_run FROM PUBLIC;

-- True for the one caller that starts today's reconcile: the last start was more than 23 hours ago.
CREATE FUNCTION media_reconcile_claim() RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM media_system();
  UPDATE media_reconcile_run r SET started_at = now()
  WHERE r.id AND r.started_at < now() - interval '23 hours';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION media_reconcile_claim() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_reconcile_claim() TO questify_app;

-- Who connects today keeps it: the API's role (its pool and the push pool) and the owner (migrations; on CranL `admin`,
-- also its console and managed pg_dump, which owns the database anyway).
DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO questify_app, %I', current_database(), current_user);
END $$;
