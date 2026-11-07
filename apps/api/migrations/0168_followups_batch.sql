-- FOLLOWUPS batch 14 (docs/FOLLOWUPS.md). Four functions restated with the same arguments, so their grants stay:
-- console_numbers, session_message, session_check_in, own_level. No new table, column or function. Nothing here changes what
-- a sign-in does, a tenant rule or how a redemption is locked. session_check_in writes a ledger row: that insert, its checks
-- and its order are as 0093 left them; the one change is the `who` line. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ platform numbers (Q-525)
-- As 0117, without the review demo: its organizer, every event of that organizer (so the live figures too) and the
-- accounts the demo made. With no demo row `demo` is NULL and every organizer and event counts.
CREATE OR REPLACE FUNCTION console_numbers() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  orgs    record;
  evs     record;
  pls     record;
  staff   record;
  live_id uuid[];
  seated  bigint;
  entries bigint;
  demo    uuid;
BEGIN
  PERFORM console_admin();
  SELECT d.organizer_id INTO demo FROM review_demo d;
  SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'pending') AS pending,
         count(*) FILTER (WHERE status = 'paused') AS paused
    INTO orgs FROM organizer o WHERE o.id IS DISTINCT FROM demo;
  SELECT count(*) FILTER (WHERE s = 'draft') AS draft, count(*) FILTER (WHERE s = 'scheduled') AS scheduled,
         count(*) FILTER (WHERE s = 'live') AS live, count(*) FILTER (WHERE s = 'ended') AS ended,
         count(*) FILTER (WHERE s = 'archived') AS archived, count(*) FILTER (WHERE suspended) AS suspended,
         coalesce(array_agg(id) FILTER (WHERE s = 'live'), '{}') AS live_ids
    INTO evs
    FROM (SELECT e.id, event_status_now(e.status, e.starts_at, e.ends_at) AS s, e.suspended_at IS NOT NULL AS suspended
          FROM event e WHERE e.organizer_id IS DISTINCT FROM demo) x;
  live_id := evs.live_ids;
  SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'banned') AS banned,
         count(*) FILTER (WHERE status <> 'deleted' AND created_at >= now() - interval '7 days') AS joined_week
    INTO pls FROM player p WHERE NOT EXISTS (SELECT 1 FROM review_demo_player r WHERE r.player_id = p.id);
  SELECT count(*) FILTER (WHERE platform_role = 'admin' AND status = 'active') AS admins, count(*) AS accounts
    INTO staff FROM staff_user;
  seated := (SELECT count(*) FROM enrollment en WHERE en.event_id = ANY (live_id) AND en.status = 'active');
  entries := (SELECT coalesce(sum(c.n), 0)
              FROM unnest(live_id) AS l(id)
              CROSS JOIN LATERAL (SELECT count(*) AS n FROM (SELECT 1 FROM ledger_entry x
                                                              WHERE x.event_id = l.id
                                                                AND x.created_at >= now() - interval '1 hour'
                                                              LIMIT 100001) q) c);
  RETURN jsonb_build_object(
    'organizers', jsonb_build_object('active', orgs.active, 'pending', orgs.pending, 'paused', orgs.paused),
    'events', jsonb_build_object('draft', evs.draft, 'scheduled', evs.scheduled, 'live', evs.live,
                                 'ended', evs.ended, 'archived', evs.archived, 'suspended', evs.suspended),
    'players', jsonb_build_object('active', pls.active, 'banned', pls.banned, 'joinedWeek', pls.joined_week),
    'staff', jsonb_build_object('accounts', staff.accounts, 'admins', staff.admins),
    'activity', jsonb_build_object('playersInLiveEvents', seated, 'entriesHour', entries));
END $$;

-- ================================================================ a message to a session's registrants
-- As 0086, and the limit is the one the announcements live under (T-505 plan): 3 an hour and 10 a day for the event count
-- its session messages and the announcements sent or due in that window together. An announcement due later does not
-- count: the message goes out now. The announcement door itself still counts only announcements.
CREATE OR REPLACE FUNCTION session_message(target_event uuid, target_session uuid, draft jsonb, press text, request uuid)
  RETURNS TABLE (id uuid, recipients integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  key      text;
  earlier  session_message;
  target   event_session;
  fields   text[];
  fresh    uuid := gen_random_uuid();
  sent     integer;
  expected integer;
BEGIN
  IF press IS NULL OR char_length(press) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an Idempotency-Key of 1 to 255 characters is required' USING ERRCODE = 'PK400';
  END IF;
  key := encode(sha256(convert_to(press, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('session_message:' || ev.id, 0));
  PERFORM 1 FROM event e WHERE e.id = target_event FOR SHARE;
  ev := award_event_of(target_event);
  SELECT m.* INTO earlier FROM session_message m WHERE m.event_id = ev.id AND m.press = key;
  IF FOUND THEN
    RETURN QUERY SELECT earlier.id, earlier.recipients, true;
    RETURN;
  END IF;
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  END IF;
  fields := ARRAY[announcement_field(draft, 'titleAr', 60), announcement_field(draft, 'titleEn', 60),
                  announcement_field(draft, 'bodyAr', 500), announcement_field(draft, 'bodyEn', 500),
                  announcement_field(draft, 'pushBodyAr', 140), announcement_field(draft, 'pushBodyEn', 140)];
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF (SELECT count(*) FROM session_message m
         WHERE m.event_id = ev.id AND m.created_at > now() - interval '1 hour')
        + (SELECT count(*) FROM announcement a
           WHERE a.event_id = ev.id AND a.status IN ('scheduled', 'sent')
             AND a.send_at > now() - interval '1 hour' AND a.send_at <= now()) >= 3 THEN
    RAISE EXCEPTION 'too many messages in an hour' USING ERRCODE = 'PL429', DETAIL = 'hour';
  ELSIF (SELECT count(*) FROM session_message m
         WHERE m.event_id = ev.id AND m.created_at > now() - interval '1 day')
        + (SELECT count(*) FROM announcement a
           WHERE a.event_id = ev.id AND a.status IN ('scheduled', 'sent')
             AND a.send_at > now() - interval '1 day' AND a.send_at <= now()) >= 10 THEN
    RAISE EXCEPTION 'too many messages in a day' USING ERRCODE = 'PL429', DETAIL = 'day';
  END IF;
  SELECT count(*)::integer INTO expected
  FROM session_registration r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.status = 'active'
  JOIN player p ON p.id = r.player_id AND p.status = 'active'
  WHERE r.session_id = target.id;
  IF expected = 0 THEN
    RAISE EXCEPTION 'no one is registered' USING ERRCODE = 'PT409', DETAIL = 'nobody';
  END IF;
  SELECT count(notice_create('session_message', ev.organizer_id, ev.id, r.player_id,
                             jsonb_build_object('session', target.id),
                             announcement_params(ev, fields[1], fields[2], fields[5], fields[6]),
                             'session_message:' || fresh || ':' || r.player_id, NULL))::integer
  INTO sent
  FROM session_registration r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.status = 'active'
  JOIN player p ON p.id = r.player_id AND p.status = 'active'
  WHERE r.session_id = target.id;
  IF sent = 0 THEN
    RAISE EXCEPTION 'no one can receive it' USING ERRCODE = 'PT409', DETAIL = 'nobody';
  END IF;
  INSERT INTO session_message (id, organizer_id, event_id, session_id, title_ar, title_en, body_ar, body_en, press,
                               recipients, created_by)
  VALUES (fresh, ev.organizer_id, ev.id, target.id, fields[1], fields[2], fields[3], fields[4], key, sent,
          app_staff_user_id());
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.message', 'event_session', target.id::text,
          jsonb_build_object('recipients', sent), request);
  RETURN QUERY SELECT fresh, sent, false;
END $$;

-- ================================================================ the door's check-in (T-615)
-- As 0093, and `who` carries `fullName`: the name the event's staff may see, NULL while the event shows usernames only
-- (staff_full_name, as the station scan and the desk). The operator's seat is checked above. Nothing else changes.
CREATE OR REPLACE FUNCTION session_check_in(target_session uuid, scanned uuid, scanned_version integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  target     event_session;
  assignment staff_assignment;
  ev         event;
  current    integer;
  member     enrollment;
  who        jsonb;
  registered boolean;
  walk       boolean;
  made       uuid;
  paid       integer := 0;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session' USING ERRCODE = 'SS404';
  END IF;
  SELECT sa.* INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = target.event_id AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  ELSIF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  ELSIF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id) THEN
    RAISE EXCEPTION 'this operator works quest stations' USING ERRCODE = 'OS403';
  ELSIF scanned = me THEN
    RAISE EXCEPTION 'an operator cannot scan their own code' USING ERRCODE = 'OY409';
  END IF;
  PERFORM ensure_rehearsal_wiped(target.event_id);
  SELECT e.* INTO ev FROM event e WHERE e.id = target.event_id;
  IF NOT feature_enabled(ev, 'agenda') THEN
    RAISE EXCEPTION 'the agenda is switched off' USING ERRCODE = 'AG403', DETAIL = 'feature_off';
  END IF;
  SELECT p.my_qr_version INTO current FROM player p WHERE p.id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  ELSIF current IS DISTINCT FROM scanned_version THEN
    RAISE EXCEPTION 'an earlier My QR' USING ERRCODE = 'OM422';
  END IF;
  SELECT n.* INTO member FROM enrollment n WHERE n.event_id = target.event_id AND n.player_id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  ELSIF member.status <> 'active' THEN
    RAISE EXCEPTION 'the enrollment is not active' USING ERRCODE = 'QC403', DETAIL = member.status;
  ELSIF NOT EXISTS (SELECT 1 FROM player p WHERE p.id = scanned AND p.status = 'active') THEN
    RAISE EXCEPTION 'the account is not active' USING ERRCODE = 'QC403', DETAIL = 'account';
  ELSIF NOT (CASE WHEN member.joined_via IS NOT DISTINCT FROM 'rehearsal'
                  THEN play_phase(ev, member) IS NOT NULL
                  ELSE event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('scheduled', 'live') END) THEN
    RAISE EXCEPTION 'the event is not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  SELECT jsonb_build_object('username', p.username, 'avatar', p.avatar,
                            'fullName', staff_full_name(target.event_id, scanned))
  INTO who FROM player p WHERE p.id = scanned;
  IF now() < target.starts_at - interval '1 hour' THEN
    RETURN jsonb_build_object('outcome', 'too_early', 'player', who);
  ELSIF now() >= target.ends_at THEN
    RETURN jsonb_build_object('outcome', 'ended', 'player', who);
  ELSIF EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = target.id AND a.player_id = scanned) THEN
    RETURN jsonb_build_object('outcome', 'already', 'points', session_points_held(target.id, member.id), 'player', who);
  END IF;
  registered := EXISTS (SELECT 1 FROM session_registration r WHERE r.session_id = target.id AND r.player_id = scanned);
  IF target.access = 'registration' AND NOT registered AND NOT target.walk_ins THEN
    RETURN jsonb_build_object('outcome', 'not_registered', 'player', who);
  END IF;
  walk := target.access = 'registration' AND NOT registered;
  INSERT INTO session_attendance (organizer_id, event_id, session_id, enrollment_id, player_id, operator_id, walk_in)
  VALUES (target.organizer_id, target.event_id, target.id, member.id, scanned, me, walk)
  ON CONFLICT (session_id, player_id) DO NOTHING
  RETURNING id INTO made;
  IF made IS NULL THEN
    RETURN jsonb_build_object('outcome', 'already', 'points', session_points_held(target.id, member.id), 'player', who);
  END IF;
  IF target.points > 0 AND member_may_play(ev, member) THEN
    -- A plain insert: a second entry for the pair is a broken invariant and must fail loudly (23505).
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              operator_id, session_id)
    VALUES (target.organizer_id, target.event_id, member.id, 'session', target.points, target.points, 'operator', me,
            target.id);
    paid := target.points;
    PERFORM ranking_repair_mark(ev.id);
  END IF;
  RETURN jsonb_build_object('outcome', 'checked_in', 'walkIn', walk, 'points', paid, 'player', who);
END $$;

-- ================================================================ the level a scan reached (T-709d)
-- As 0148, and a level counts as this scan's only when it was written in the scan's own transaction. xp_catch_up files the
-- levels a lowered curve made due on the latest XP entry, so a later read of that older scan used to report a level-up it
-- did not cause. Both times are now() in the writing transaction, so they are equal exactly for the scan's own levels.
-- Read only: no XP, level or ledger row is written differently.
CREATE OR REPLACE FUNCTION public.own_level(completion bigint)
 RETURNS TABLE(xp bigint, level smallint, level_from bigint, next_level_at bigint, title_ar text, title_en text, level_up smallint, up_title_ar text, up_title_en text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT x.xp, cur.level, cur.xp_from, nxt.xp_from, t.name_ar, t.name_en, up.level, ut.name_ar, ut.name_en
  FROM player_xp x
  JOIN player p ON p.id = x.player_id AND p.status = 'active'
  JOIN xp_level cur ON cur.level = xp_level_of(x.xp)
  LEFT JOIN xp_level nxt ON nxt.level = cur.level + 1
  LEFT JOIN LATERAL level_title_of(cur.level) t ON true
  LEFT JOIN LATERAL (SELECT max(r.level) AS level FROM level_reached r
                     JOIN xp_entry e ON e.id = r.xp_entry_id
                     JOIN ledger_entry l ON l.id = e.ledger_entry_id
                     WHERE r.player_id = x.player_id AND l.completion_id = completion AND l.kind = 'quest'
                       AND r.reached_at = e.created_at) up ON true
  LEFT JOIN LATERAL level_title_of(up.level) ut ON true
  WHERE x.player_id = app_player_id();
END
$function$;
