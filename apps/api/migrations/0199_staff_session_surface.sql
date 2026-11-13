-- T-810d (plan docs/plans/2026-11-13-console-host.md; ADR-720, ADR-721; ASVS V3.5.4, gap 12): a staff session belongs
-- to one surface. `console` is opened only by a platform admin's sign-in from the console's own origin and is the only
-- kind `/v1/admin/*` takes once `CONSOLE_ORIGIN` is set; `dashboard` is every other session (the public host). Existing
-- rows become `dashboard`. While `CONSOLE_ORIGIN` is unset the API opens only `dashboard` sessions and no door reads the
-- column, so nothing changes until the console host is configured (ADR-723).
--
-- The API role cannot set or change the surface itself: INSERT on staff_session was revoked in 0155 (the definer below
-- is the one way in), and its UPDATE is the column grant of 0002 (last_seen_at, revoked_at) only.
--
-- open_staff_session is replaced, not overloaded: an old API instance's three-argument call fails for the deploy's
-- minute and the person signs in again (as 0155, ADR-718). Rollback is fixing forward (RUNBOOK, "T-810d rollback").
SET LOCAL lock_timeout = '10s';

ALTER TABLE staff_session
  ADD COLUMN surface text NOT NULL DEFAULT 'dashboard' CHECK (surface IN ('dashboard', 'console'));

DROP FUNCTION open_staff_session(bytea, text, text);

-- 0155's body, plus the session's surface. A value outside the two raises 22023 before anything is written.
CREATE FUNCTION open_staff_session(token bytea, agent text, address text, surface text)
  RETURNS TABLE (session_id uuid, ended integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me  uuid := app_staff_user_id();
  sid uuid;
  n   integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'a staff user is required' USING ERRCODE = 'SS401';
  END IF;
  IF surface IS NULL OR surface NOT IN ('dashboard', 'console') THEN
    RAISE EXCEPTION 'a session surface is dashboard or console' USING ERRCODE = '22023';
  END IF;
  INSERT INTO staff_session (staff_user_id, token_hash, user_agent, ip, surface)
  VALUES (me, token, left(agent, 300), left(address, 64), open_staff_session.surface) RETURNING id INTO sid;
  UPDATE staff_session SET revoked_at = now()
  WHERE id IN (SELECT s.id FROM staff_session s WHERE s.staff_user_id = me AND s.revoked_at IS NULL
               ORDER BY s.created_at DESC, s.id = sid DESC, s.id OFFSET 10);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT sid, n;
END $$;
REVOKE ALL ON FUNCTION open_staff_session(bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_staff_session(bytea, text, text, text) TO questify_app;
