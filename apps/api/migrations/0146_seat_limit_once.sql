-- T-221: the seat limit is checked once per statement, so accept-all becomes one call (FR-1821, FR-1825; plan
-- docs/plans/2026-11-03-t-221-seat-limit-once.md; ADR-630 to ADR-632, Q-590, Q-591; answers Q-323). The row guard
-- `enrollment_player_limit` (0027, 0032, 0036) counted the event's seats again for every row moving into `active`, so
-- an accept-all of n requests on an event with s seats cost n counts of s rows. It becomes two AFTER statement triggers
-- with transition tables over one function: one count per event per statement.
--
-- Semantics kept: a seat is `active` or `banned`, rehearsal never counts, a ban lift never takes a new seat, a limit
-- lowered below the seats refuses every new seat and keeps everyone in, a soft limit only records the marks, QL409 with
-- the limit as detail at a hard limit (the whole statement is undone). One difference: a statement that frees one seat
-- and takes another at exactly the limit passes on the net count (no door writes one).
--
-- Lock order unchanged for every definer (seat lock, then the rows; the trigger re-takes the locks they hold). A direct
-- write by the owner connection now locks all its rows before the seat lock (ADR-630).
--
-- lock_timeout 1 s, below the app pool's 2 s (src/db/pool-options.ts): while the ACCESS EXCLUSIVE request waits, every
-- statement on `enrollment` queues behind it, and an app statement queued past its own 2 s fails. At 1 s the migration
-- gives up first and the runner retries 55P03 (ADR-580). Not deployed during a live event's peak (RUNBOOK). The lock is
-- taken once up front (DROP TRIGGER needs it) so nothing upgrades a lock mid-file. Catalog-only: no rewrite, no index,
-- no data change; signatures unchanged, so the running API works before and after.
--
-- Deny by default: the two new functions are internal (PUBLIC revoked next to each create); no grant changes.
-- Earlier migrations untouched.
SET LOCAL lock_timeout = '1s';
LOCK TABLE enrollment IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER enrollment_player_limit ON enrollment;
DROP FUNCTION enrollment_player_limit();

-- ================================================================ the marks at the crossing (internal)
-- The 80 and 100 marks a statement crossed, recorded with the count at the crossing, the value the row guard recorded:
-- the first seat at or above the mark, `greatest(threshold, seats_before + 1)`. The 80 mark is 0027's ceil(0.8 × limit).
CREATE FUNCTION record_limit_crossings(target uuid, org uuid, cap integer, seats_before integer, seats_after integer)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO event_limit_alert (event_id, organizer_id, level, players)
  SELECT target, org, mark.level, greatest(mark.threshold, seats_before + 1)
  FROM (VALUES (80::smallint, ceil(cap * 0.8)::integer), (100::smallint, cap)) AS mark(level, threshold)
  WHERE cap IS NOT NULL AND seats_after >= mark.threshold
  ON CONFLICT (event_id, level) DO NOTHING
$$;
REVOKE ALL ON FUNCTION record_limit_crossings(uuid, uuid, integer, integer, integer) FROM PUBLIC;

-- ================================================================ the seat limit, once a statement (ADR-630)
-- The seated rows of the statement: now `active`, not rehearsal, and for an update not `active` or `banned` before.
-- None (every score update, leave, ban, erase) returns after one EXISTS and locks nothing. Otherwise, per event in id order (a
-- multi-event statement cannot deadlock against another): the event KEY SHARE (waits for an admin changing the limit),
-- the seat lock, the limit read again, one count. Only correct under READ COMMITTED: the count after the seat lock must
-- be a fresh snapshot that sees every seat committed while this statement waited, so it refuses any other level.
-- TG_OP picks the query: the INSERT trigger has no old table.
CREATE FUNCTION enrollment_seat_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  events uuid[];
  taken integer[];
  mode text;
  cap integer;
  org uuid;
  seats integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM seated_new nw
                   WHERE nw.status = 'active' AND nw.joined_via IS DISTINCT FROM 'rehearsal') THEN
      RETURN NULL;
    END IF;
    SELECT array_agg(s.event_id ORDER BY s.event_id), array_agg(s.n ORDER BY s.event_id) INTO events, taken
    FROM (SELECT nw.event_id, count(*)::integer AS n FROM seated_new nw
          WHERE nw.status = 'active' AND nw.joined_via IS DISTINCT FROM 'rehearsal'
          GROUP BY nw.event_id) s;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM seated_new nw JOIN seated_old od ON od.id = nw.id
                   WHERE nw.status = 'active' AND nw.joined_via IS DISTINCT FROM 'rehearsal'
                     AND od.status NOT IN ('active', 'banned')) THEN
      RETURN NULL;
    END IF;
    SELECT array_agg(s.event_id ORDER BY s.event_id), array_agg(s.n ORDER BY s.event_id) INTO events, taken
    FROM (SELECT nw.event_id, count(*)::integer AS n FROM seated_new nw JOIN seated_old od ON od.id = nw.id
          WHERE nw.status = 'active' AND nw.joined_via IS DISTINCT FROM 'rehearsal'
            AND od.status NOT IN ('active', 'banned')
          GROUP BY nw.event_id) s;
  END IF;
  FOR i IN 1 .. cardinality(events) LOOP
    SELECT e.player_limit_mode INTO mode FROM event e WHERE e.id = events[i] FOR KEY SHARE;
    CONTINUE WHEN mode IS NULL OR mode = 'none';
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'the seat limit is checked under READ COMMITTED only' USING ERRCODE = 'feature_not_supported';
    END IF;
    PERFORM lock_event_seats(events[i]);
    SELECT e.player_limit_mode, e.player_limit, e.organizer_id INTO mode, cap, org FROM event e WHERE e.id = events[i];
    seats := event_seats(events[i]);
    IF mode = 'hard' AND seats > cap THEN
      RAISE EXCEPTION 'the event is full' USING ERRCODE = 'QL409', DETAIL = cap::text;
    END IF;
    IF mode <> 'none' THEN
      PERFORM record_limit_crossings(events[i], org, cap, seats - taken[i], seats);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION enrollment_seat_limit() FROM PUBLIC;
CREATE TRIGGER enrollment_seat_limit_insert AFTER INSERT ON enrollment
  REFERENCING NEW TABLE AS seated_new FOR EACH STATEMENT EXECUTE FUNCTION enrollment_seat_limit();
CREATE TRIGGER enrollment_seat_limit_update AFTER UPDATE ON enrollment
  REFERENCING OLD TABLE AS seated_old NEW TABLE AS seated_new FOR EACH STATEMENT EXECUTE FUNCTION enrollment_seat_limit();

-- ================================================================ accept-all, up to 1,000 a call (ADR-631, Q-591)
-- As 0077, with one change: a call accepts at most 1,000 requests in both modes, or the free seats of a hard-limited
-- event when fewer (`least` ignores a NULL `free`); a hard-limited event took 250 before. 1,000 is what fits 3.5 s on
-- the T-221 fixture (20,000 seated, welcome points, a souvenir rule, the decision push: about 3 ms a row, most of it
-- the welcome grant), under the API's 5 s statement limit; the dashboard repeats above it.
CREATE OR REPLACE FUNCTION accept_all_join_requests(target_event uuid, request uuid)
  RETURNS TABLE (outcome text, accepted integer, remaining integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
  free integer;
  taken integer;
BEGIN
  ev := team_event(target_event);
  IF ev.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, 0, 0;
    RETURN;
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, 0, 0;
    RETURN;
  END IF;
  free := free_seats(ev.id);
  WITH picked AS (
    SELECT n.id, n.waitlisted FROM enrollment n
    WHERE n.event_id = ev.id AND n.status = 'pending' AND n.joined_via IS DISTINCT FROM 'rehearsal'
    ORDER BY n.joined_at, n.id
    LIMIT least(free, 1000)
    FOR UPDATE SKIP LOCKED
  ), moved AS (
    UPDATE enrollment n SET status = 'active', waitlisted = false
    FROM picked WHERE n.id = picked.id
    RETURNING n.id, picked.waitlisted
  ), logged AS (
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                           after, request_id)
    SELECT 'staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.join_accept', 'enrollment', moved.id::text,
           jsonb_build_object('status', 'pending', 'waitlisted', moved.waitlisted),
           jsonb_build_object('status', 'active'), request
    FROM moved
    RETURNING 1
  )
  SELECT count(*)::integer INTO taken FROM logged;
  RETURN QUERY SELECT 'done'::text, taken,
    (SELECT count(*)::integer FROM enrollment n
     WHERE n.event_id = ev.id AND n.status = 'pending' AND n.joined_via IS DISTINCT FROM 'rehearsal');
END $$;
REVOKE ALL ON FUNCTION accept_all_join_requests(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_all_join_requests(uuid, uuid) TO questify_app;

-- ================================================================ the per-row work of an acceptance (ADR-632)
-- As 0064, in PL/pgSQL: the same one insert and answers. A LANGUAGE sql function with a SET clause is planned again on
-- every call (PostgreSQL 17); here the plan is kept for the session, which every enrollment, completion, quiz, round,
-- staff and reinstate trigger call shares.
CREATE OR REPLACE FUNCTION souvenir_enqueue(target uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 INSERT INTO souvenir_work(event_id,enrollment_id)
 SELECT n.event_id,n.id FROM enrollment n JOIN player p ON p.id=n.player_id
 WHERE n.id=target AND n.joined_via IS DISTINCT FROM 'rehearsal' AND p.status='active'
   AND n.status='active' AND NOT n.waitlisted
   AND EXISTS(SELECT 1 FROM souvenir_rule r WHERE r.event_id=n.event_id AND r.status='active'
    AND NOT EXISTS(SELECT 1 FROM souvenir_receipt s WHERE s.rule_id=r.id AND s.player_id=n.player_id))
 ON CONFLICT(event_id,enrollment_id) DO UPDATE SET generation=souvenir_work.generation+1,
  ready_at=least(souvenir_work.ready_at,now());
END $$;
REVOKE ALL ON FUNCTION souvenir_enqueue(uuid) FROM PUBLIC;

-- As 0038, with one change: the event's ranking mark is written once per transaction. `now()` is the transaction's
-- time, so every later welcome of the same accept-all would write the same value again, each a new version of one row
-- that the next write walks past; the mark the ranking worker reads is the same.
CREATE OR REPLACE FUNCTION grant_welcome() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  amount integer;
  made bigint;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') OR NEW.joined_via = 'rehearsal' THEN
    RETURN NULL;
  END IF;
  SELECT e.welcome_points INTO amount FROM event e WHERE e.id = NEW.event_id;
  IF amount IS NULL OR erased_marked(NEW.player_id, NEW.event_id, 'welcomed') THEN
    RETURN NULL;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
  VALUES (NEW.organizer_id, NEW.event_id, NEW.id, 'welcome', amount, amount, 'system')
  ON CONFLICT (enrollment_id) WHERE kind = 'welcome' DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    INSERT INTO ranking_repair (event_id) VALUES (NEW.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now()
    WHERE ranking_repair.marked_at IS DISTINCT FROM now();
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION grant_welcome() FROM PUBLIC;
