-- Console tuning numbers the database reads (T-703, FR-1770, ADR-450): the rehearsal cap (0032, Q-122), the flag burst
-- numbers (0031, Q-120) and the readiness look-ahead (0112, Q-370) stop being constants and follow
-- `platform_setting` key `tuning`, the block a Questify admin edits in the console. A missing, non-whole or out-of-range
-- stored number gives the shipped one, so a bad edit never changes how a scan or a join behaves.
--
-- Deny by default: the new function is internal like the three it serves. PUBLIC and the API role hold no right on it;
-- the definers that call it run as their owner. The ranges below equal the registry's (`TUNING` in
-- packages/shared/src/config/registry.ts); `test/db/platform-tuning.int.test.ts` compares the two.

CREATE FUNCTION platform_tuning_int(key_name text, fallback integer, low integer, high integer)
  RETURNS integer LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((
    SELECT CASE WHEN jsonb_typeof(s.value -> key_name) = 'number' AND (s.value ->> key_name) ~ '^[0-9]{1,9}$'
                THEN CASE WHEN (s.value ->> key_name)::integer BETWEEN low AND high
                          THEN (s.value ->> key_name)::integer END
           END
    FROM platform_setting s WHERE s.key = 'tuning'), fallback)
$$;
REVOKE ALL ON FUNCTION platform_tuning_int(text, integer, integer, integer) FROM PUBLIC;

-- The most rehearsal accounts an event may have: 25 until the console says otherwise (1 to 100).
CREATE OR REPLACE FUNCTION rehearsal_cap() RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$ SELECT platform_tuning_int('rehearsalCap', 25, 1, 100) $$;

-- The burst flag: 10 scans in 5 minutes until the console says otherwise (3 to 100 scans, 1 to 60 minutes).
CREATE OR REPLACE FUNCTION flag_tuning(OUT burst_count integer, OUT burst_window interval)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT platform_tuning_int('flagBurstCount', 10, 3, 100),
         platform_tuning_int('flagBurstMinutes', 5, 1, 60) * interval '1 minute'
$$;

-- The console's readiness list: the events that start within `readinessDays` (14 until the console says otherwise, 1 to
-- 60). The body is 0112's with the look-ahead read from the number.
CREATE OR REPLACE FUNCTION readiness_soon() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_admin_id() IS NULL THEN
    RAISE EXCEPTION 'only a Questify admin can read readiness' USING ERRCODE = 'RD404';
  END IF;
  RETURN jsonb_build_object('events', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'name', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
      'organizer', jsonb_build_object('id', o.id, 'name', o.name),
      'timezone', e.timezone,
      'startsAt', e.starts_at,
      'endsAt', e.ends_at,
      'facts', readiness_facts(e.id)) ORDER BY e.starts_at, e.id)
    FROM (SELECT x.* FROM event x
          WHERE x.status IN ('draft', 'scheduled') AND x.starts_at IS NOT NULL AND x.ends_at IS NOT NULL
            AND x.starts_at <= now() + platform_tuning_int('readinessDays', 14, 1, 60) * interval '1 day'
            AND x.ends_at > now()
          ORDER BY x.starts_at, x.id LIMIT 100) e
    JOIN organizer o ON o.id = e.organizer_id), '[]'::jsonb));
END $$;
