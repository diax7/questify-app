-- The console's platform health, platform numbers, admin accounts and their sessions (T-709, FR-1783, FR-1419, FR-1785).
-- Four read-only doors answer counts, flags and the sessions of platform admins; one write door ends a live admin
-- session with a reason and an audit entry. Nothing here reads a player's contact, a token or a message text.
-- Deny by default: every function is revoked from PUBLIC in this file and granted to the API's role only when it is a
-- door; each door checks `app_admin_id()` (an active platform admin, re-read from the account) before it answers.

-- The failed-push count of the health view reads the last day of failed or unknown sends; only those rows are indexed.
CREATE INDEX push_send_failed ON push_send (finished_at) WHERE state IN ('failed', 'unknown');

-- ================================================================ platform health (FR-1783)
-- Every count that can grow without bound is read through `LIMIT 10001`, so a backlog of millions costs as much as a
-- backlog of ten thousand; the API shows 10,001 as "10,000+". Ages are seconds. A lease counts as stuck five minutes
-- after it ran out (the claim takes an expired lease again at once, so a lease this old means no worker is claiming).
-- The oldest push is the oldest of the rows counted. No ticker keeps a run record, so a stopped ticker shows as its
-- symptoms: events past their start or end that did not move, queue ages and leases that ran out.
CREATE FUNCTION console_health() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cap       constant integer := 10001;
  stale     constant interval := interval '5 minutes';
  ev        record;
  overdue   integer;
  busiest   jsonb;
  push_q    integer;
  push_min  bigint;
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

  SELECT count(*), min(q.id) INTO push_q, push_min
    FROM (SELECT id FROM push_send WHERE state = 'queued' LIMIT cap) q;
  push_age := (SELECT extract(epoch FROM now() - s.created_at)::integer FROM push_send s WHERE s.id = push_min);
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
  fan_age := (SELECT extract(epoch FROM now() - min(q.created_at))::integer
              FROM (SELECT created_at FROM notice WHERE fanned_at IS NULL AND fan_failures = 0 LIMIT cap) q);

  sv_wait := (SELECT count(*) FROM (SELECT 1 FROM souvenir_work
                                    WHERE ready_at <= now() AND (lease_until IS NULL OR lease_until < now())
                                    LIMIT cap) q);
  sv_bad := (SELECT count(*) FROM (SELECT 1 FROM souvenir_work WHERE error_code IS NOT NULL LIMIT cap) q);
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
    'souvenirs', jsonb_build_object('waiting', sv_wait, 'failing', sv_bad, 'stuck', sv_stk),
    'invitations', jsonb_build_object('sending', inv.sending, 'stuck', inv_stk, 'sentWeek', inv.sent,
                                      'failedWeek', inv.failed, 'unknownWeek', inv.unknown),
    'holds', holds);
END $$;
REVOKE ALL ON FUNCTION console_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_health() TO questify_app;

-- ================================================================ platform numbers (FR-1419)
-- Counts only. Players are counted by status (no name, no contact). Activity is the points entries of the last hour in
-- the events live now, read per event through the (event_id, created_at) index and capped at 100,001 per event.
CREATE FUNCTION console_numbers() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  orgs    record;
  evs     record;
  pls     record;
  staff   record;
  live_id uuid[];
  seated  bigint;
  entries bigint;
BEGIN
  PERFORM console_admin();
  SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'pending') AS pending,
         count(*) FILTER (WHERE status = 'paused') AS paused
    INTO orgs FROM organizer;
  SELECT count(*) FILTER (WHERE s = 'draft') AS draft, count(*) FILTER (WHERE s = 'scheduled') AS scheduled,
         count(*) FILTER (WHERE s = 'live') AS live, count(*) FILTER (WHERE s = 'ended') AS ended,
         count(*) FILTER (WHERE s = 'archived') AS archived, count(*) FILTER (WHERE suspended) AS suspended,
         coalesce(array_agg(id) FILTER (WHERE s = 'live'), '{}') AS live_ids
    INTO evs
    FROM (SELECT e.id, event_status_now(e.status, e.starts_at, e.ends_at) AS s, e.suspended_at IS NOT NULL AS suspended
          FROM event e) x;
  live_id := evs.live_ids;
  SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'banned') AS banned,
         count(*) FILTER (WHERE status <> 'deleted' AND created_at >= now() - interval '7 days') AS joined_week
    INTO pls FROM player;
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
REVOKE ALL ON FUNCTION console_numbers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_numbers() TO questify_app;

-- ================================================================ admin accounts and sessions (FR-1785)
-- Platform admins and how many sessions each has open. A session is open while it is not revoked, was used within the
-- idle limit and began within the maximum age; both limits come from the caller (the sign-in code's own numbers).
-- The role itself is granted and revoked only by `staff-cli` (ADR-405): no door here changes it.
CREATE FUNCTION console_admin_accounts(idle_seconds integer, max_age_seconds integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', u.id, 'email', u.email, 'status', u.status, 'createdAt', u.created_at,
             'sessions', s.open, 'lastSeenAt', s.last_seen) ORDER BY u.email, u.id)
    FROM staff_user u
    CROSS JOIN LATERAL (SELECT count(*)::integer AS open, max(x.last_seen_at) AS last_seen
                        FROM staff_session x
                        WHERE x.staff_user_id = u.id AND x.revoked_at IS NULL
                          AND x.last_seen_at > now() - make_interval(secs => idle_seconds)
                          AND x.created_at > now() - make_interval(secs => max_age_seconds)) s
    WHERE u.platform_role = 'admin'), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION console_admin_accounts(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_admin_accounts(integer, integer) TO questify_app;

-- One admin's open sessions, newest first. QA404 for an account that is not a platform admin: the console never lists
-- an organizer member's sessions.
CREATE FUNCTION console_admin_sessions(target uuid, idle_seconds integer, max_age_seconds integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  IF NOT EXISTS (SELECT 1 FROM staff_user u WHERE u.id = target AND u.platform_role = 'admin') THEN
    RAISE EXCEPTION 'no such admin account' USING ERRCODE = 'QA404';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'createdAt', x.created_at, 'lastSeenAt', x.last_seen_at,
                                        'userAgent', x.user_agent, 'ip', x.ip) ORDER BY x.created_at DESC, x.id)
    FROM staff_session x
    WHERE x.staff_user_id = target AND x.revoked_at IS NULL
      AND x.last_seen_at > now() - make_interval(secs => idle_seconds)
      AND x.created_at > now() - make_interval(secs => max_age_seconds)), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION console_admin_sessions(uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_admin_sessions(uuid, integer, integer) TO questify_app;

-- Ends one open session of a platform admin at once (a lost laptop): the next request with its token is refused. The
-- reason is 10 to 300 characters (SU400); the audit entry holds the reason and whose session it was, never the token.
-- QA404 when the session does not exist, is already ended or belongs to an account that is not a platform admin.
CREATE FUNCTION admin_end_session(target uuid, reason text, request uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := suspension_reason_clean(reason);
  owner uuid;
BEGIN
  SELECT s.staff_user_id INTO owner
    FROM staff_session s JOIN staff_user u ON u.id = s.staff_user_id AND u.platform_role = 'admin'
    WHERE s.id = target AND s.revoked_at IS NULL
    FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such open admin session' USING ERRCODE = 'QA404';
  END IF;
  UPDATE staff_session SET revoked_at = now() WHERE id = target;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'staff.session.force_end', 'staff_session', target::text,
          jsonb_build_object('reason', clean, 'staffUserId', owner), request);
END $$;
REVOKE ALL ON FUNCTION admin_end_session(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_end_session(uuid, text, uuid) TO questify_app;
