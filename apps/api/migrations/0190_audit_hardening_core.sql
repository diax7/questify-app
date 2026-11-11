-- Audit hardening, the core walls (security audit run 1: w2-seats 1 and 2, w2-flows 2; plan
-- docs/plans/2026-11-11-audit-hardening-core.md, decisions in its section 8). No table, grant, route or string. Each
-- object is restated from its latest definition with its signature, owner and grants unchanged (CREATE OR REPLACE keeps
-- them):
--   play_event_id(text, text)     from 0134  PL/pgSQL now (docs/rules.md); two more kinds, `meet_pass` (a whole number,
--                                            as `game_round`) and `redemption`, for the player guard's suspension wall
--   mark_ranking_repair(uuid)     from 0095  PL/pgSQL now; the system branch needs no device seat (a paired kiosk or a
--                                            forged device id marks nothing), as the device-aware gates of 0064, 0073
--                                            and 0076 do
--   souvenir_scan_batch(uuid)     from 0064  a pass of a suspended event (or a paused organizer's) waits
--   souvenir_claim_work(uuid,int) from 0064  work of a suspended event is not claimed; it waits
--   souvenir_evaluate(uuid)       from 0064  a claim taken before the suspension raises ES423 in the unlocked pre-check,
--                                            so the payer acks a failure and the work is kept with its back-off
--   souvenir_health()             from 0064  held work (suspended event or paused organizer) leaves `due`, `failed` and
--                                            `oldestAt` and is counted as `held`; PL/pgSQL SELECT ... INTO now
--   console_health()              from 0162  the same for the health view's souvenir counts, plus `held`
-- The suspension test is written inline in each query (docs/rules.md: no SET-clause function inside a query over a
-- set). 0189 and earlier untouched; 0156 stays reserved.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the event an object id names
-- As 0134, in PL/pgSQL: each kind's lookup is a `SELECT ... INTO` (first row, null on none). An id not of its kind's
-- form (a uuid; a whole number for a game round or a meet pass) is null, as before.
CREATE OR REPLACE FUNCTION play_event_id(kind text, ref text) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found  uuid;
  target uuid;
  serial bigint;
BEGIN
  IF kind = 'join_code' THEN
    SELECT e.id INTO found FROM event e WHERE lower(e.join_code) = lower(play_event_id.ref);
    RETURN found;
  END IF;
  IF kind IN ('game_round', 'meet_pass') THEN
    IF ref !~ '^[1-9][0-9]{0,17}$' THEN
      RETURN NULL;
    END IF;
    serial := ref::bigint;
    IF kind = 'game_round' THEN
      SELECT g.event_id INTO found FROM game_round g WHERE g.id = serial;
    ELSE
      SELECT m.event_id INTO found FROM meet_pass m WHERE m.id = serial;
    END IF;
    RETURN found;
  END IF;
  IF ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN NULL;
  END IF;
  target := ref::uuid;
  IF kind = 'quest' THEN
    SELECT q.event_id INTO found FROM quest q WHERE q.id = target;
  ELSIF kind = 'step' THEN
    SELECT s.event_id INTO found FROM passport_step s WHERE s.id = target;
  ELSIF kind = 'category' THEN
    SELECT c.event_id INTO found FROM category c WHERE c.id = target;
  ELSIF kind = 'reward' THEN
    SELECT r.event_id INTO found FROM reward r WHERE r.id = target;
  ELSIF kind = 'session' THEN
    SELECT x.event_id INTO found FROM event_session x WHERE x.id = target;
  ELSIF kind = 'desk_sale' THEN
    SELECT d.event_id INTO found FROM desk_sale d WHERE d.id = target;
  ELSIF kind = 'redemption' THEN
    SELECT p.event_id INTO found FROM redemption p WHERE p.id = target;
  END IF;
  RETURN found;
END $$;

-- ================================================================ the repair mark: no device seat
-- As 0095, in PL/pgSQL, with one change: the system branch (`ranking_system()`: no player, organizer, staff or admin)
-- also needs no device, so a kiosk's or a screen's context (or a forged device id) marks nothing. The app marks in an
-- empty context (ranking.ts), which still marks.
CREATE OR REPLACE FUNCTION mark_ranking_repair(target uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO ranking_repair (event_id) SELECT ev.id FROM event ev
  WHERE ev.id = target
    AND ((ranking_system() AND app_device_id() IS NULL)
         OR ranking_reader_enrollment(target) IS NOT NULL
         OR (ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope()))
         OR EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = app_player_id()))
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
END $$;

-- ================================================================ souvenirs wait while their event is suspended
-- ADR-406: a suspended event grants nothing, and what it owes waits. A pass and queued work of a suspended event (or of
-- a paused organizer) are skipped, not ended, so the souvenirs arrive after the lift.
CREATE OR REPLACE FUNCTION souvenir_scan_batch(only_event uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE chosen souvenir_scan; r souvenir_rule; members uuid[]; member uuid;
BEGIN
 PERFORM souvenir_system_only();
 SELECT s.* INTO chosen FROM souvenir_scan s JOIN souvenir_rule sr ON sr.id=s.rule_id JOIN event e ON e.id=sr.event_id
  JOIN organizer o ON o.id=e.organizer_id
 WHERE sr.status='active' AND s.next_at<=now() AND (only_event IS NULL OR sr.event_id=only_event)
   AND event_status_now(e.status,e.starts_at,e.ends_at) IN ('live','ended','archived')
   AND e.suspended_at IS NULL AND o.status<>'paused'
 ORDER BY s.next_at,s.rule_id FOR UPDATE OF s SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN 0; END IF;
 SELECT * INTO r FROM souvenir_rule sr WHERE sr.id=chosen.rule_id;
 members:=ARRAY(SELECT n.id FROM enrollment n JOIN player p ON p.id=n.player_id
  WHERE n.event_id=r.event_id AND n.joined_via IS DISTINCT FROM 'rehearsal' AND p.status='active'
   AND n.status='active' AND NOT n.waitlisted AND (chosen.cursor_id IS NULL OR n.id>chosen.cursor_id)
   AND NOT EXISTS(SELECT 1 FROM souvenir_receipt s WHERE s.rule_id=r.id AND s.player_id=n.player_id)
   AND (r.audience<>'rank' OR EXISTS(SELECT 1 FROM event_result er JOIN result_place rp ON rp.event_id=er.event_id
    WHERE er.event_id=r.event_id AND rp.enrollment_id=n.id AND rp.rank BETWEEN r.rank_from AND r.rank_to))
  ORDER BY n.id LIMIT 500);
 FOREACH member IN ARRAY members LOOP PERFORM souvenir_enqueue(member); END LOOP;
 IF cardinality(members)=500 THEN
  UPDATE souvenir_scan SET cursor_id=members[500],next_at=now() WHERE rule_id=r.id;
 ELSE
  DELETE FROM souvenir_scan WHERE rule_id=r.id;
 END IF;
 RETURN cardinality(members);
END $$;

CREATE OR REPLACE FUNCTION souvenir_claim_work(only_event uuid,page_size integer)
 RETURNS TABLE(event_id uuid,enrollment_id uuid,generation bigint,lease_token uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM souvenir_system_only();
 RETURN QUERY WITH due AS(SELECT w.event_id,w.enrollment_id FROM souvenir_work w
  JOIN event e ON e.id=w.event_id JOIN organizer o ON o.id=e.organizer_id
  WHERE w.ready_at<=now() AND (w.lease_until IS NULL OR w.lease_until<now())
   AND (only_event IS NULL OR w.event_id=only_event)
   AND e.suspended_at IS NULL AND o.status<>'paused'
  ORDER BY w.ready_at,w.enrollment_id FOR UPDATE OF w SKIP LOCKED LIMIT least(greatest(page_size,1),500))
 UPDATE souvenir_work w SET lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=w.attempts+1
 FROM due d WHERE w.event_id=d.event_id AND w.enrollment_id=d.enrollment_id
 RETURNING w.event_id,w.enrollment_id,w.generation,w.lease_token;
END $$;

-- The suspension check sits in the unlocked pre-check, before any lock: a suspension committed while an evaluation runs
-- can still grant (the lag of the other unlocked reads here). ES423 is acked as a failure, so the work is kept and
-- waits its back-off (up to 300 s) after the lift; returning 0 would let the ack delete it.
CREATE OR REPLACE FUNCTION souvenir_evaluate(target uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE who uuid; member enrollment; r souvenir_rule; made integer:=0; written integer;
BEGIN
 PERFORM souvenir_system_only();
 SELECT * INTO member FROM enrollment n WHERE n.id=target AND n.joined_via IS DISTINCT FROM 'rehearsal';
 IF NOT FOUND THEN RETURN 0; END IF;
 who:=member.player_id;
 -- Unlocked pre-check: a member owed no missing active souvenir takes no player, enrollment or XP lock. A fact
 -- committed after this read bumps the queue generation, so the member is evaluated again (ADR-272).
 IF member.status<>'active' OR member.waitlisted
   OR NOT EXISTS(SELECT 1 FROM player p WHERE p.id=who AND p.status='active')
   OR NOT EXISTS(SELECT 1 FROM event e WHERE e.id=member.event_id AND event_status_now(e.status,e.starts_at,e.ends_at) IN ('live','ended','archived'))
   OR NOT EXISTS(SELECT 1 FROM souvenir_rule sr WHERE sr.event_id=member.event_id AND sr.status='active'
    AND NOT EXISTS(SELECT 1 FROM souvenir_receipt s WHERE s.rule_id=sr.id AND s.player_id=who)
    AND souvenir_qualifies(member,sr))
 THEN RETURN 0; END IF;
 -- A suspended event (or paused organizer) grants nothing; the work waits for the lift (ADR-406).
 IF event_suspended(member.event_id) THEN
  RAISE EXCEPTION 'this event is suspended' USING ERRCODE='ES423';
 END IF;
 -- SHARE, not KEY SHARE: a non-key admin status UPDATE must serialize with the entire grant.
 PERFORM 1 FROM player p WHERE p.id=who AND p.status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN 0; END IF;
 SELECT * INTO member FROM enrollment n WHERE n.id=target FOR NO KEY UPDATE;
 IF member.player_id<>who OR member.status<>'active' OR member.waitlisted OR member.joined_via='rehearsal'
   OR NOT EXISTS(SELECT 1 FROM event e WHERE e.id=member.event_id AND event_status_now(e.status,e.starts_at,e.ends_at) IN ('live','ended','archived'))
 THEN RETURN 0; END IF;
 -- All rule locks precede XP. They do not lock event: confirm_results takes event then enrollment.
 PERFORM 1 FROM souvenir_rule sr WHERE sr.event_id=member.event_id AND sr.status='active' ORDER BY sr.id FOR SHARE;
 PERFORM 1 FROM player_xp x WHERE x.player_id=who FOR UPDATE;
 FOR r IN SELECT * FROM souvenir_rule sr WHERE sr.event_id=member.event_id AND sr.status='active' ORDER BY sr.id LOOP
  CONTINUE WHEN NOT souvenir_qualifies(member,r);
  INSERT INTO souvenir_receipt(rule_id,event_id,item_id,player_id,enrollment_id)
   VALUES(r.id,r.event_id,r.item_id,who,member.id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS written=ROW_COUNT;
  INSERT INTO player_item(player_id,item_id,source,source_rule_id,source_event_id,earned_at)
   SELECT who,r.item_id,'souvenir',r.id,r.event_id,s.earned_at FROM souvenir_receipt s
   WHERE s.rule_id=r.id AND s.player_id=who ON CONFLICT DO NOTHING;
  made:=made+written;
 END LOOP;
 RETURN made;
END $$;

-- Held work is not late work: the tick (src/souvenirs/tick.ts) logs `souvenir.pending` on `failed` and `oldestAt`, so a
-- suspension would otherwise log every run until it is lifted.
CREATE OR REPLACE FUNCTION souvenir_health() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 PERFORM souvenir_system_only();
 SELECT jsonb_build_object('due',count(*) FILTER(WHERE NOT h.held),
  'failed',count(*) FILTER(WHERE w.error_code IS NOT NULL AND NOT h.held),
  'held',count(*) FILTER(WHERE h.held),
  'oldestAt',min(w.ready_at) FILTER(WHERE NOT h.held)) INTO result
 FROM souvenir_work w JOIN event e ON e.id=w.event_id JOIN organizer o ON o.id=e.organizer_id
 CROSS JOIN LATERAL (SELECT e.suspended_at IS NOT NULL OR o.status='paused' AS held) h;
 RETURN result;
END $$;

-- ================================================================ the health view's souvenir counts
-- As 0162, with one change: souvenir work of a suspended event or a paused organizer is not `waiting` or `failing` but
-- `held` (it waits for the lift, ADR-406). Counts still stop at 10,001.
CREATE OR REPLACE FUNCTION console_health() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cap       constant integer := 10001;
  stale     constant interval := interval '5 minutes';
  ev        record;
  overdue   integer;
  busiest   jsonb;
  push_q    integer;
  push_age  integer;
  push_stk  integer;
  push_bad  integer;
  alert_q   integer;
  alert_age integer;
  alert_stk integer;
  alert_bad integer;
  fan_wait  integer;
  fan_bad   integer;
  fan_age   integer;
  sv_wait   integer;
  sv_bad    integer;
  sv_stk    integer;
  sv_held   integer;
  inv_stk   integer;
  inv       record;
  holds     jsonb;
BEGIN
  PERFORM console_admin();

  SELECT count(*) FILTER (WHERE event_status_now(e.status, e.starts_at, e.ends_at) = 'live') AS live,
         count(*) FILTER (WHERE event_status_now(e.status, e.starts_at, e.ends_at) = 'scheduled') AS scheduled,
         count(*) FILTER (WHERE e.suspended_at IS NOT NULL) AS suspended
    INTO ev
    FROM event e WHERE e.status IN ('scheduled', 'live') OR e.suspended_at IS NOT NULL;
  overdue := (SELECT count(*) FROM event WHERE status = 'scheduled' AND starts_at <= now() - interval '2 minutes')
             + (SELECT count(*) FROM event WHERE status = 'live' AND ends_at <= now() - interval '2 minutes');

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', jsonb_build_object('ar', t.name_ar, 'en', t.name_en),
                                               'organizer', t.organizer, 'entries', t.entries)
                            ORDER BY t.entries DESC, t.id), '[]'::jsonb)
    INTO busiest
    FROM (SELECT l.id, l.name_ar, l.name_en, l.organizer, l.entries
          FROM (SELECT e.id, e.name_ar, e.name_en, o.name AS organizer,
                       (SELECT count(*) FROM (SELECT 1 FROM ledger_entry x
                                              WHERE x.event_id = e.id AND x.created_at >= now() - interval '1 hour'
                                              LIMIT 100001) c)::integer AS entries
                FROM event e JOIN organizer o ON o.id = e.organizer_id
                WHERE event_status_now(e.status, e.starts_at, e.ends_at) = 'live') l
          ORDER BY l.entries DESC, l.id LIMIT 5) t;

  push_q := (SELECT count(*) FROM (SELECT 1 FROM push_send WHERE state = 'queued' LIMIT cap) q);
  push_age := (SELECT extract(epoch FROM now() - s.created_at)::integer
               FROM push_send s WHERE s.state = 'queued' ORDER BY s.created_at LIMIT 1);
  push_stk := (SELECT count(*) FROM (SELECT 1 FROM push_send
                                     WHERE state = 'sending' AND lease_until < now() - stale LIMIT cap) q);
  push_bad := (SELECT count(*) FROM (SELECT 1 FROM push_send
                                     WHERE state IN ('failed', 'unknown') AND finished_at >= now() - interval '1 day'
                                     LIMIT cap) q);

  alert_q := (SELECT count(*) FROM (SELECT 1 FROM organizer_alert WHERE state = 'queued' LIMIT cap) q);
  alert_age := (SELECT extract(epoch FROM now() - a.created_at)::integer
                FROM organizer_alert a WHERE a.state = 'queued' ORDER BY a.id LIMIT 1);
  alert_stk := (SELECT count(*) FROM (SELECT 1 FROM organizer_alert
                                      WHERE state = 'sending' AND lease_until < now() - stale LIMIT cap) q);
  alert_bad := (SELECT count(*) FROM (SELECT 1 FROM organizer_alert
                                      WHERE state IN ('failed', 'uncertain') AND finished_at >= now() - interval '1 day'
                                      LIMIT cap) q);

  fan_wait := (SELECT count(*) FROM (SELECT 1 FROM notice WHERE fanned_at IS NULL LIMIT cap) q);
  fan_bad := (SELECT count(*) FROM (SELECT 1 FROM notice WHERE fanned_at IS NULL AND fan_failures > 0 LIMIT cap) q);
  fan_age := (SELECT extract(epoch FROM now() - n.created_at)::integer
              FROM notice n WHERE n.fanned_at IS NULL AND n.fan_failures = 0 ORDER BY n.created_at LIMIT 1);

  sv_wait := (SELECT count(*) FROM (SELECT 1 FROM souvenir_work w
                                    JOIN event e ON e.id = w.event_id JOIN organizer o ON o.id = e.organizer_id
                                    WHERE w.ready_at <= now() AND (w.lease_until IS NULL OR w.lease_until < now())
                                      AND e.suspended_at IS NULL AND o.status <> 'paused'
                                    LIMIT cap) q);
  sv_bad := (SELECT count(*) FROM (SELECT 1 FROM souvenir_work w
                                   JOIN event e ON e.id = w.event_id JOIN organizer o ON o.id = e.organizer_id
                                   WHERE w.error_code IS NOT NULL AND e.suspended_at IS NULL AND o.status <> 'paused'
                                   LIMIT cap) q);
  sv_held := (SELECT count(*) FROM (SELECT 1 FROM souvenir_work w
                                    JOIN event e ON e.id = w.event_id JOIN organizer o ON o.id = e.organizer_id
                                    WHERE e.suspended_at IS NOT NULL OR o.status = 'paused'
                                    LIMIT cap) q);
  sv_stk := (SELECT count(*) FROM (SELECT 1 FROM souvenir_work WHERE lease_until < now() - stale LIMIT cap) q);

  inv_stk := (SELECT count(*) FROM (SELECT 1 FROM invitation_recipient
                                    WHERE state = 'sending' AND lease_until < now() - stale LIMIT cap) q);
  SELECT count(*) FILTER (WHERE c.state = 'sending') AS sending,
         coalesce(sum(c.sent), 0)::bigint AS sent,
         coalesce(sum(c.failed), 0)::bigint AS failed,
         coalesce(sum(c.unknown), 0)::bigint AS unknown
    INTO inv
    FROM invitation_campaign c WHERE c.state = 'sending' OR c.started_at >= now() - interval '7 days';

  SELECT coalesce(jsonb_agg(jsonb_build_object('channel', h.channel, 'until', h.hold_until, 'code', h.code)
                            ORDER BY h.channel), '[]'::jsonb)
    INTO holds
    FROM invitation_channel_hold h WHERE h.hold_until > now();

  RETURN jsonb_build_object(
    'events', jsonb_build_object('live', ev.live, 'scheduled', ev.scheduled, 'suspended', ev.suspended,
                                 'overdue', overdue, 'busiest', busiest),
    'push', jsonb_build_object('queued', push_q, 'oldestSeconds', push_age, 'stuck', push_stk, 'failedDay', push_bad),
    'alerts', jsonb_build_object('queued', alert_q, 'oldestSeconds', alert_age, 'stuck', alert_stk,
                                 'failedDay', alert_bad),
    'fanOut', jsonb_build_object('waiting', fan_wait, 'failing', fan_bad, 'oldestSeconds', fan_age),
    'souvenirs', jsonb_build_object('waiting', sv_wait, 'failing', sv_bad, 'stuck', sv_stk, 'held', sv_held),
    'invitations', jsonb_build_object('sending', inv.sending, 'stuck', inv_stk, 'sentWeek', inv.sent,
                                      'failedWeek', inv.failed, 'unknownWeek', inv.unknown),
    'holds', holds);
END $$;
