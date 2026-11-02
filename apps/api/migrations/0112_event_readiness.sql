-- The go-live readiness checklist (T-618, FR-1845, ADR-403): what is set up and what is not, for one event, in one read.
-- Read-only: no table, no write, nothing about points, sign-in or tenant isolation changes, and no second store of
-- anything: every fact is a flag or a count over rows the dashboard's pages already write. The checklist blocks nothing;
-- the API turns these facts into done, warning and blocking items (packages/shared/src/readiness).
--
-- Two doors, both read-only and counts-and-flags only (no player, no name, no text):
--   event_readiness(event)  for the event's team (an owner or an editor within their event limit, AN404 for anyone
--                           else, as event_inbox in 0110);
--   readiness_soon()        for a Questify admin (RD404 for anyone else, as the usage doors in 0104): the events that
--                           start within 14 days (or should have started and are not live), with the same facts.
-- Deny by default: `readiness_facts` is internal (nobody holds EXECUTE), PUBLIC holds no EXECUTE on a door and the
-- grants name the API's role alone.
SET LOCAL lock_timeout = '10s';

-- The facts of one event. `activation` is none, pending, rejected or active; `dates` is missing, past or set; the
-- rehearsal fact is the rehearsal card's own (the first play kept after an erase, or a rehearsal quest entry before
-- one); a live, ended or archived event cannot rehearse, so the ledger is read only while it can. Playable quests are
-- published, not removed, not paused, not skipped, already open and not closed. Operator-only quests are the playable
-- ones whose one proof is the player's My QR (an operator scans it). Device-only quests are the playable ones whose
-- methods are all the kiosk or the screen QR (a quest with no method is not one); `deviceUnserved` counts those that
-- no active device of the kind that serves them is paired to: a kiosk quest needs a kiosk, a screen QR quest a station
-- (a big screen serves no quest). The prize desk fact counts the active item and experience rewards (FR-1716), in
-- stock only once open and not closed; `shop` is whether the shop is on (the event's switch and the platform's), as
-- `bigScreen` is for the add-on. `devices` counts the paired devices that are not revoked, by kind.
CREATE FUNCTION readiness_facts(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
  now_status text;
  can_rehearse boolean;
  rehearsed boolean;
  setup_steps text;
BEGIN
  SELECT * INTO ev FROM event WHERE id = target_event;
  now_status := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  can_rehearse := now_status IN ('draft', 'scheduled');
  SELECT r.first_play_at IS NOT NULL OR (can_rehearse AND EXISTS (
           SELECT 1 FROM ledger_entry l WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest'))
    INTO rehearsed
    FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
  SELECT s.steps INTO setup_steps FROM event_setup s WHERE s.event_id = ev.id;
  RETURN jsonb_build_object(
    'status', now_status,
    'dates', CASE WHEN ev.starts_at IS NULL OR ev.ends_at IS NULL THEN 'missing'
                  WHEN ev.ends_at <= now() THEN 'past' ELSE 'set' END,
    'activation', CASE WHEN ev.activated_at IS NOT NULL THEN 'active'
                       WHEN EXISTS (SELECT 1 FROM event_activation_request a
                                    WHERE a.event_id = ev.id AND a.state = 'pending') THEN 'pending'
                       WHEN EXISTS (SELECT 1 FROM event_activation_request a
                                    WHERE a.event_id = ev.id AND a.state = 'rejected') THEN 'rejected'
                       ELSE 'none' END,
    'quests', (SELECT jsonb_build_object(
                 'total', count(*),
                 'playable', count(*) FILTER (WHERE q.playable),
                 'operatorOnly', count(*) FILTER (WHERE q.playable AND q.verification = ARRAY['my_qr']),
                 'deviceOnly', count(*) FILTER (WHERE q.playable AND q.device_only),
                 'deviceUnserved', count(*) FILTER (WHERE q.playable AND q.device_only AND NOT EXISTS (
                                     SELECT 1 FROM paired_device d
                                     WHERE d.quest_id = q.id AND d.status = 'active'
                                       AND ((d.kind = 'kiosk' AND 'kiosk' = ANY (q.verification))
                                         OR (d.kind = 'station' AND 'screen_qr' = ANY (q.verification))))))
               FROM (SELECT x.id, x.verification,
                            x.visible AND x.paused_at IS NULL AND x.skipped_at IS NULL
                              AND (x.opens_at IS NULL OR x.opens_at <= now())
                              AND (x.closes_at IS NULL OR x.closes_at > now()) AS playable,
                            cardinality(x.verification) > 0
                              AND x.verification <@ ARRAY['kiosk', 'screen_qr'] AS device_only
                     FROM quest x WHERE x.event_id = ev.id AND x.deleted_at IS NULL) q),
    'rewards', (SELECT jsonb_build_object(
                  'active', count(*),
                  'inStock', count(*) FILTER (WHERE w.stock_total > w.units_out
                                                    AND (w.opens_at IS NULL OR w.opens_at <= now())
                                                    AND (w.closes_at IS NULL OR w.closes_at > now())),
                  'items', count(*) FILTER (WHERE w.kind = 'item'),
                  'experiences', count(*) FILTER (WHERE w.kind = 'experience'))
                FROM reward w WHERE w.event_id = ev.id AND w.status = 'active'),
    'shop', feature_enabled(ev, 'shop'),
    'desk', jsonb_build_object('place', ev.desk_location_ar IS NOT NULL OR ev.desk_location_en IS NOT NULL),
    'operators', (SELECT count(*) FROM staff_assignment o WHERE o.event_id = ev.id),
    'devices', (SELECT jsonb_build_object(
                  'stations', count(*) FILTER (WHERE d.kind = 'station'),
                  'kiosks', count(*) FILTER (WHERE d.kind = 'kiosk'),
                  'bigScreens', count(*) FILTER (WHERE d.kind = 'screen'))
                FROM paired_device d WHERE d.event_id = ev.id AND d.status = 'active'),
    'join', jsonb_build_object(
              'access', ev.access,
              'guestListOnly', ev.guest_list_only,
              'guests', (SELECT count(*) FROM event_guest g WHERE g.event_id = ev.id)),
    'rules', ev.rules_ar IS NOT NULL OR ev.rules_en IS NOT NULL,
    'bigScreen', EXISTS (SELECT 1 FROM event_entitlement x WHERE x.event_id = ev.id AND x.feature = 'bigScreen')
                 AND coalesce(ev.config #>> '{features,bigScreen}', 'true') <> 'false',
    'rehearsed', coalesce(rehearsed, false),
    'branding', coalesce(ev.config #>> '{branding,accent}', '') <> '',
    'setup', jsonb_build_object(
               'decided', coalesce(length(replace(setup_steps, 'n', '')), 0),
               'finished', EXISTS (SELECT 1 FROM event_setup s WHERE s.event_id = ev.id AND s.finished_at IS NOT NULL)));
END $$;
REVOKE ALL ON FUNCTION readiness_facts(uuid) FROM PUBLIC;

-- The facts of one event for its team: an owner, or an editor within their event limit (AN404 for anyone else).
CREATE FUNCTION event_readiness(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN readiness_facts((award_event_of(target_event)).id);
END $$;
REVOKE ALL ON FUNCTION event_readiness(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_readiness(uuid) TO questify_app;

-- The console's list: up to 100 events that are still a draft or scheduled, have not ended, and start within 14 days
-- (an event whose start passed without going live is the most urgent), soonest first, with their organizer and the same
-- facts. Names and times only beside the facts; no personal data, so the read is not audited (as the usage doors).
CREATE FUNCTION readiness_soon() RETURNS jsonb
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
            AND x.starts_at <= now() + interval '14 days' AND x.ends_at > now()
          ORDER BY x.starts_at, x.id LIMIT 100) e
    JOIN organizer o ON o.id = e.organizer_id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION readiness_soon() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION readiness_soon() TO questify_app;
