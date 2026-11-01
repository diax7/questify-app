-- Organizer alerts, second part (T-609, FR-1727, FR-1730, ADR-394): the claim that reaches a sendable row however many rows
-- to skip lie ahead of it, the quest-item stock source, and the console's usage doors.
-- Deny by default: PUBLIC holds no EXECUTE on anything here, the grants name the API's role alone, no table or column is
-- granted, and the two usage doors answer a platform admin only (US404 for anyone else).
SET LOCAL lock_timeout = '10s';

-- ================================================================ the claim
-- 0082's claim picked up to `size` rows in id order and checked them afterwards, so a batch made only of rows to skip
-- (an ex-member's, a disabled account's) leased nothing and the sender ended its run with sendable rows still waiting.
-- Now a call first skips the unsendable rows among the oldest 500 queued ones (each with its reason, as before), then
-- leases up to `size` rows that pass `alert_skip_reason`, wherever they lie in the queue: an empty answer means no
-- sendable row is waiting (rows another sender holds are left to it). Same arguments and result as 0082.
CREATE OR REPLACE FUNCTION alert_claim(size integer)
  RETURNS TABLE (alert_id bigint, lease uuid, kind text, organizer uuid, event uuid, address text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM push_system_only();
  WITH oldest AS (
    SELECT a.id, alert_skip_reason(a) AS reason FROM organizer_alert a
    WHERE a.state = 'queued' AND a.created_at > now() - interval '24 hours'
    ORDER BY a.id LIMIT 500),
  unsendable AS (
    SELECT a.id, o.reason FROM organizer_alert a JOIN oldest o ON o.id = a.id
    WHERE o.reason IS NOT NULL AND a.state = 'queued'
    ORDER BY a.id FOR UPDATE OF a SKIP LOCKED)
  UPDATE organizer_alert a SET state = 'skipped', code = u.reason, finished_at = now()
  FROM unsendable u WHERE a.id = u.id;
  RETURN QUERY
  WITH picked AS (
    SELECT a.id FROM organizer_alert a
    WHERE a.state = 'queued' AND a.created_at > now() - interval '24 hours' AND alert_skip_reason(a) IS NULL
    ORDER BY a.id LIMIT least(greatest(alert_claim.size, 0), 50) FOR UPDATE SKIP LOCKED),
  leased AS (
    UPDATE organizer_alert a SET state = 'sending', lease_token = gen_random_uuid(),
                                 lease_until = now() + interval '60 seconds'
    FROM picked p WHERE a.id = p.id
    RETURNING a.id, a.lease_token, a.alert_type, a.organizer_id, a.event_id, a.staff_user_id)
  SELECT l.id, l.lease_token, l.alert_type, l.organizer_id, l.event_id, u.email
  FROM leased l JOIN staff_user u ON u.id = l.staff_user_id
  ORDER BY l.id;
END $$;
REVOKE ALL ON FUNCTION alert_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_claim(integer) TO questify_app;

-- ================================================================ the quest-item stock source
-- A quest item's stock crossing into low, the same rule as a reward's (0082): at most max(1, 10% of the total, rounded
-- up) left with a total above 0. Only a crossing counts, so a change of the total alone never opens a second alert,
-- restocking above the line closes the episode and the next fall opens a new one. Items are `stock_low` (the type's
-- wording names rewards and quest items). Only a live or ended event, because before the start only rehearsal accounts
-- take items. The condition is spelled out in the WHEN clause: the trigger runs with the updater's rights.
CREATE FUNCTION alert_on_item_low() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM alert_enqueue(NEW.organizer_id, NEW.event_id, 'stock_low', 'item:' || NEW.id || ':' || txid_current())
  FROM event e
  WHERE e.id = NEW.event_id AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('live', 'ended');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_item_low() FROM PUBLIC;
CREATE TRIGGER quest_item_alert_low AFTER UPDATE OF stock_total, units_out, status ON quest_item
  FOR EACH ROW
  WHEN (NEW.status = 'active' AND NEW.stock_total > 0
        AND NEW.stock_total - NEW.units_out <= greatest(1, ceil(NEW.stock_total * 0.1))
        AND NOT (OLD.status = 'active' AND OLD.stock_total > 0
                 AND OLD.stock_total - OLD.units_out <= greatest(1, ceil(OLD.stock_total * 0.1))))
  EXECUTE FUNCTION alert_on_item_low();

-- ================================================================ the console's usage view
-- Counts only, from rows that already exist: no counter table, no write in any hot path. Players are the event's
-- members who are not rehearsal accounts (pending and declined requests left out, as the analytics do); invitations
-- sent are the campaign counters of 0073; alert emails are the organizer's `sent` outbox rows (the outbox keeps finished
-- rows 30 days). Login SMS, promotional email, push volume and storage are not metered yet (Q-361), so they are not here.
-- No personal data, so these reads are not audited.

-- The 100 organizers created last, newest first.
CREATE FUNCTION usage_organizers() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_admin_id() IS NULL THEN
    RAISE EXCEPTION 'only a Questify admin can read usage' USING ERRCODE = 'US404';
  END IF;
  RETURN jsonb_build_object('organizers', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', o.id,
      'name', o.name,
      'events', (SELECT count(*)::integer FROM event e WHERE e.organizer_id = o.id),
      'players', (SELECT count(*)::integer FROM enrollment n JOIN event e ON e.id = n.event_id
                  WHERE e.organizer_id = o.id AND n.status NOT IN ('pending', 'declined')
                    AND n.joined_via IS DISTINCT FROM 'rehearsal'),
      'invitationsSent', (SELECT coalesce(sum(c.sent), 0)::integer FROM invitation_campaign c
                          WHERE c.organizer_id = o.id),
      'alertEmails', (SELECT count(*)::integer FROM organizer_alert a
                      WHERE a.organizer_id = o.id AND a.state = 'sent')) ORDER BY o.created_at DESC, o.id)
    FROM (SELECT x.id, x.name, x.created_at FROM organizer x ORDER BY x.created_at DESC, x.id LIMIT 100) o),
    '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION usage_organizers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage_organizers() TO questify_app;

-- One organizer's events (200 at most, the latest created first) with the same figures; US404 for an unknown organizer.
CREATE FUNCTION usage_events(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org organizer;
BEGIN
  IF app_admin_id() IS NULL THEN
    RAISE EXCEPTION 'only a Questify admin can read usage' USING ERRCODE = 'US404';
  END IF;
  SELECT * INTO org FROM organizer WHERE id = target;
  IF org.id IS NULL THEN
    RAISE EXCEPTION 'no such organizer' USING ERRCODE = 'US404';
  END IF;
  RETURN jsonb_build_object(
    'organizer', jsonb_build_object('id', org.id, 'name', org.name),
    'events', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', e.id,
        'name', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
        'status', event_status_now(e.status, e.starts_at, e.ends_at),
        'players', (SELECT count(*)::integer FROM enrollment n
                    WHERE n.event_id = e.id AND n.status NOT IN ('pending', 'declined')
                      AND n.joined_via IS DISTINCT FROM 'rehearsal'),
        'invitationsSent', (SELECT coalesce(sum(c.sent), 0)::integer FROM invitation_campaign c
                            WHERE c.event_id = e.id),
        'alertEmails', (SELECT count(*)::integer FROM organizer_alert a
                        WHERE a.event_id = e.id AND a.state = 'sent')) ORDER BY e.created_at DESC, e.id)
      FROM (SELECT x.* FROM event x WHERE x.organizer_id = org.id ORDER BY x.created_at DESC, x.id LIMIT 200) e),
      '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION usage_events(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage_events(uuid) TO questify_app;
