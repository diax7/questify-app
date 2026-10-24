-- Operator tools (T-311, F-181, F-182, ADR-249 to ADR-251; plan docs/plans/2026-10-24-t-311-operator-tools.md):
-- practice scans that show the real station result and write nothing, and My station today's counts.
-- No table, no grant on a table, no change to operator_complete_quest or record_completion. Deny by default: every
-- function here is closed to PUBLIC, and only these three are granted to the API role.

-- ================================================================ practice scans (ADR-249)
-- True when the quest's event owes its go-live rehearsal wipe (the event went live and nothing has wiped yet), asked
-- only for an operator of that event; anyone else gets false and the door's own refusal. A practice scan then answers
-- PW409 at once (CTO plan review, MINOR-3): the real door would run the whole wipe under the rehearsal row's lock and
-- the practice undo would throw it away, on every practice scan until the tick or a real write wipes. Volatile, as
-- rehearsal_over reads the clock; it writes nothing.
CREATE FUNCTION practice_wipe_owed(target uuid) RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
    FROM quest q
    JOIN event e ON e.id = q.event_id
    JOIN event_rehearsal r ON r.event_id = e.id
    WHERE q.id = target AND r.live_wiped_at IS NULL AND rehearsal_over(e)
      AND EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = e.id AND sa.player_id = app_player_id())
  )
$$;
REVOKE ALL ON FUNCTION practice_wipe_owed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION practice_wipe_owed(uuid) TO questify_app;

-- The station scan, undone (FR-929). It runs the real door, so the answer is exactly what a real scan would show
-- (every rule, boost, occurrence and refusal), inside a block whose exception handler is a subtransaction: everything
-- the door wrote, and every lock it took, is rolled back when the block raises. The RAISE must stay unconditional:
-- there is no path on which the door's writes survive, and any refusal lands in the same handler. Variables are not
-- transactional, so the would-be points and occurrence survive the undo. The key is fresh and marked `practice:`, so a
-- practice scan never replays, collides with or uses up a real scan's key.
-- SECURITY INVOKER on purpose: it runs as the API's role and gains no privilege; it can only call what the API could.
-- It writes nothing of its own, so even a transaction around it that commits changes nothing (the API's always rolls
-- back as well). Answers 'completed' with the points and occurrence, or 'refused' with the door's SQLSTATE and DETAIL;
-- PW409 when the event's go-live wipe is owed.
CREATE FUNCTION operator_practice_scan(target uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (outcome text, points bigint, occurrence integer, refusal text, refusal_detail text)
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  would_points     bigint;
  would_occurrence integer;
  done             text;
  code             text;
  detail           text;
BEGIN
  IF practice_wipe_owed(target) THEN
    RETURN QUERY SELECT 'refused'::text, NULL::bigint, NULL::integer, 'PW409'::text, NULL::text;
    RETURN;
  END IF;
  BEGIN
    SELECT c.points, c.occurrence INTO would_points, would_occurrence
    FROM operator_complete_quest(target, scanned, scanned_version, 'practice:' || gen_random_uuid()::text) c;
    RAISE EXCEPTION 'practice scan undone' USING ERRCODE = 'PX000';
  EXCEPTION
    WHEN SQLSTATE 'PX000' THEN
      done := 'completed';
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS code = RETURNED_SQLSTATE, detail = PG_EXCEPTION_DETAIL;
      done := 'refused';
  END;
  RETURN QUERY SELECT done, would_points, would_occurrence, code, nullif(detail, '');
END $$;
REVOKE ALL ON FUNCTION operator_practice_scan(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_practice_scan(uuid, uuid, integer) TO questify_app;

-- ================================================================ My station today (ADR-251)
-- Completions of one station's quest by every method and operator: in the event's day (its timezone and day start
-- hour, the same day as operator_stations) and in the last 60 minutes. Counts only: no player, no points. For an
-- operator of the event (OP403), a station quest of that event (scan or challenge taking My QR; OQ404 otherwise, also
-- for another event's quest), inside the operator's quest limit (OS403). The day's bounds are computed once, so the
-- count is a range scan on quest_completion_quest_idx.
CREATE FUNCTION operator_station_today(target_event uuid, target_quest uuid)
  RETURNS TABLE (today bigint, last_hour bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
  ev         event%ROWTYPE;
  local_day  timestamp;
  day_start  timestamptz;
  day_end    timestamptz;
  hour_start timestamptz := now() - interval '1 hour';
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM quest q
                 WHERE q.id = target_quest AND q.event_id = target_event AND q.type IN ('scan_qr', 'challenge')
                   AND 'my_qr' = ANY (q.verification)) THEN
    RAISE EXCEPTION 'not a station of this event' USING ERRCODE = 'OQ404';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
     AND NOT EXISTS (SELECT 1 FROM staff_assignment_quest s
                     WHERE s.assignment_id = assignment.id AND s.quest_id = target_quest) THEN
    RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  local_day := date_trunc('day', (now() AT TIME ZONE ev.timezone) - make_interval(hours => ev.day_start_hour))
               + make_interval(hours => ev.day_start_hour);
  day_start := local_day AT TIME ZONE ev.timezone;
  day_end := (local_day + interval '1 day') AT TIME ZONE ev.timezone;
  RETURN QUERY
  SELECT count(*) FILTER (WHERE c.created_at >= day_start AND c.created_at < day_end),
         count(*) FILTER (WHERE c.created_at > hour_start)
  FROM quest_completion c
  WHERE c.quest_id = target_quest AND c.created_at >= least(day_start, hour_start);
END $$;
REVOKE ALL ON FUNCTION operator_station_today(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_station_today(uuid, uuid) TO questify_app;
