-- A batch of review follow-ups (docs/FOLLOWUPS.md, 2026-11-06 batch 6; ADR-745 to ADR-748). Nothing here writes points,
-- signs anyone in or touches a redemption. Three restated functions keep their arguments, results and grants (internal or
-- the API role's door, closed to PUBLIC next to each); three new indexes. No table, no new function. Deployed migrations
-- untouched.
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration indexes, up front, in one order.
LOCK TABLE event IN SHARE MODE;
LOCK TABLE notice IN SHARE MODE;
LOCK TABLE push_send IN SHARE MODE;

-- ================================================================ closing reports with an action taken (T-705b, ADR-745)
-- As 0130, with one change: an outcome that names an action is accepted only when that action is in place now (RP409
-- otherwise, nothing closed): `unpublished` a live hold on a quest, a reward or an announcement; `event_suspended` the
-- target's event (or its organizer) suspended, for anything but a username; `username_changed` the player's username no
-- longer the one an open report names; `player_banned` the player banned. `dismissed` needs nothing.
CREATE OR REPLACE FUNCTION admin_report_resolve(target_kind text, target uuid, resolution text, request uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  closed integer;
  ev_id  uuid;
BEGIN
  IF resolution IS NULL OR resolution NOT IN ('dismissed', 'unpublished', 'event_suspended', 'username_changed',
                                              'player_banned') THEN
    RAISE EXCEPTION 'an outcome from the list' USING ERRCODE = 'RP422';
  END IF;
  PERFORM report_target_lock(admin_report_resolve.target_kind, target);
  IF NOT (CASE resolution
    WHEN 'dismissed' THEN true
    WHEN 'unpublished' THEN admin_report_resolve.target_kind IN ('quest', 'reward', 'announcement')
                            AND content_held(admin_report_resolve.target_kind, target)
    WHEN 'event_suspended' THEN admin_report_resolve.target_kind <> 'username'
                                AND coalesce(event_suspended(coalesce(
                                      report_event(admin_report_resolve.target_kind, target),
                                      (SELECT r.event_id FROM content_report r
                                       WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target
                                         AND r.event_id IS NOT NULL LIMIT 1))), false)
    WHEN 'username_changed' THEN admin_report_resolve.target_kind = 'username'
                                 AND NOT EXISTS (SELECT 1 FROM content_report r JOIN player p ON p.id = r.target_id
                                                 WHERE r.target_kind = 'username' AND r.target_id = target
                                                   AND r.status = 'open'
                                                   AND r.snapshot ->> 'username' = p.username)
    WHEN 'player_banned' THEN admin_report_resolve.target_kind = 'username'
                              AND EXISTS (SELECT 1 FROM player p WHERE p.id = target AND p.status = 'banned')
  END) THEN
    RAISE EXCEPTION 'take the action first, then close the reports with it' USING ERRCODE = 'RP409';
  END IF;
  WITH done AS (
    UPDATE content_report r
    SET status = CASE WHEN resolution = 'dismissed' THEN 'dismissed' ELSE 'actioned' END, outcome = resolution,
        handled_by = me, handled_at = now()
    WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target AND r.status = 'open'
    RETURNING r.event_id)
  SELECT count(*), max(d.event_id::text)::uuid INTO closed, ev_id FROM done d;
  IF closed > 0 THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'report.resolve', target_kind,
            target::text, jsonb_build_object('outcome', resolution, 'closed', closed), request);
  END IF;
  RETURN closed;
END $$;
REVOKE ALL ON FUNCTION admin_report_resolve(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_report_resolve(text, uuid, text, uuid) TO questify_app;

-- ================================================================ catalog names (T-713 review, ADR-746)
-- As 0119, with the gap 0161 closed for home text: the zero-width and mark characters U+200B to U+200F, U+061C and
-- U+FEFF are refused like the control and direction ones, and a name of whitespace alone (a no-break or ideographic
-- space, which `btrim` keeps) is refused like an empty one. Internal, closed to PUBLIC.
CREATE OR REPLACE FUNCTION catalog_text(value text, field text, max_length integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  clean text := btrim(value);
BEGIN
  IF clean IS NULL OR char_length(clean) NOT BETWEEN 1 AND max_length
     OR clean ~ '[\x01-\x1F\x7F-\x9F؜​-‏ -‮⁦-⁩﻿]'
     OR clean ~ '^[[:space:]   -   　]*$' THEN
    RAISE EXCEPTION '% must have 1 to % characters, without control, direction or invisible characters', field,
      max_length USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  RETURN clean;
END $$;
REVOKE ALL ON FUNCTION catalog_text(text, text, integer) FROM PUBLIC;

-- ================================================================ an organizer's latest events (T-714, ADR-747)
-- `console_feature_usage` (0140) reads an organizer's 201 latest events by `created_at DESC, id`. Without this index the
-- read fetched every event of the organizer and sorted them; with it, the read stops after 201 index entries.
CREATE INDEX event_organizer_created_idx ON event (organizer_id, created_at DESC, id);

-- ================================================================ the oldest waiting push and notice (T-709, ADR-748)
-- The health view's "oldest" of the push queue and the notice fan-out came from an unordered sample of 10,001 rows, so
-- past that many waiting it could show a younger row. These two partial indexes give the oldest row in one probe.
CREATE INDEX push_send_queued_oldest ON push_send (created_at) WHERE state = 'queued';
CREATE INDEX notice_unfanned_oldest ON notice (created_at) WHERE fanned_at IS NULL AND fan_failures = 0;

-- As 0117, with one change: the push queue's and the fan-out's oldest are the oldest rows waiting (ordered through the
-- two indexes above), not the oldest of the counted sample. Counts still stop at 10,001.
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
