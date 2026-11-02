-- A batch of review follow-ups (docs/FOLLOWUPS.md). Nothing about points, the ledger, sign-in, redemptions or tenant
-- isolation changes: three functions are restated with the same arguments, results and grants, and two partial indexes
-- are added. Deny by default: every restated function keeps PUBLIC without EXECUTE and the grant it had, and the new
-- indexes belong to a table the API's role cannot read.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the usage view's alert email counts (T-609 review)
-- `usage_organizers` and `usage_events` (0104) count an organizer's or an event's `sent` alert rows per listed row, and the
-- table has no index on either column, so each count walked the 30 days of the outbox. A partial index on the sent rows
-- answers each count index-only; the rows enter it once, when the email is sent.
CREATE INDEX organizer_alert_sent_organizer_idx ON organizer_alert (organizer_id) WHERE state = 'sent';
CREATE INDEX organizer_alert_sent_event_idx ON organizer_alert (event_id) WHERE state = 'sent';

-- ================================================================ the sender's claim (T-609 review)
-- As 0104, in the other order: a call first leases up to `size` rows that pass `alert_skip_reason`, and only when that
-- leaves room (fewer than `size`, or a size of 0) does it skip the unsendable rows among the oldest 500 queued ones, each
-- with its reason. A busy queue of sendable rows no longer re-checks 500 rows on every call; an empty or short answer
-- still clears the unsendable rows, so none outlives the first call that finds room.
CREATE OR REPLACE FUNCTION alert_claim(size integer)
  RETURNS TABLE (alert_id bigint, lease uuid, kind text, organizer uuid, event uuid, address text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  wanted integer := least(greatest(alert_claim.size, 0), 50);
  taken  integer;
BEGIN
  PERFORM push_system_only();
  RETURN QUERY
  WITH picked AS (
    SELECT a.id FROM organizer_alert a
    WHERE a.state = 'queued' AND a.created_at > now() - interval '24 hours' AND alert_skip_reason(a) IS NULL
    ORDER BY a.id LIMIT wanted FOR UPDATE SKIP LOCKED),
  leased AS (
    UPDATE organizer_alert a SET state = 'sending', lease_token = gen_random_uuid(),
                                 lease_until = now() + interval '60 seconds'
    FROM picked p WHERE a.id = p.id
    RETURNING a.id, a.lease_token, a.alert_type, a.organizer_id, a.event_id, a.staff_user_id)
  SELECT l.id, l.lease_token, l.alert_type, l.organizer_id, l.event_id, u.email
  FROM leased l JOIN staff_user u ON u.id = l.staff_user_id
  ORDER BY l.id;
  GET DIAGNOSTICS taken = ROW_COUNT;
  IF taken < greatest(wanted, 1) THEN
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
  END IF;
END $$;
REVOKE ALL ON FUNCTION alert_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_claim(integer) TO questify_app;

-- ================================================================ the top-10 diff (T-503 review)
-- As 0082, with two changes. The rehearsal erase stamp is read after the new top ten, so a wipe that commits while the
-- diff runs is seen as a changed stamp (a new baseline) and never diffs a snapshot taken before it. And a member who
-- left the ten and is no longer ranked (banned, excluded, made staff or left the event after the snapshot) gets no exit
-- notice: the board no longer counts that player, so "you left the top 10" would not be true.
CREATE OR REPLACE FUNCTION rank_push_diff(target uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event%ROWTYPE;
  snap     rank_top_snapshot%ROWTYPE;
  erased   timestamptz;
  had      boolean;
  fresh    uuid[];
  made     integer;
BEGIN
  PERFORM push_system_only();
  IF NOT pg_try_advisory_xact_lock(hashtextextended('rank_top_ten:' || target::text, 0)) THEN
    RETURN jsonb_build_object('state', 'busy');
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = target;
  IF NOT FOUND OR event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'live' OR NOT ranking_on(ev) THEN
    DELETE FROM rank_top_snapshot s WHERE s.event_id = target;
    RETURN jsonb_build_object('state', 'idle');
  END IF;
  SELECT s.* INTO snap FROM rank_top_snapshot s WHERE s.event_id = target;
  had := FOUND;
  fresh := rank_top_ten_ids(target);
  SELECT r.erased_at INTO erased FROM event_rehearsal r WHERE r.event_id = target;
  INSERT INTO rank_top_snapshot (event_id, enrollment_ids, rehearsal_erased_at)
  VALUES (target, fresh, erased)
  ON CONFLICT (event_id) DO UPDATE
  SET enrollment_ids = excluded.enrollment_ids, rehearsal_erased_at = excluded.rehearsal_erased_at, taken_at = now();
  IF NOT had OR snap.rehearsal_erased_at IS DISTINCT FROM erased THEN
    RETURN jsonb_build_object('state', 'baseline');
  END IF;
  SELECT count(notice_create(CASE WHEN m.entered THEN 'rank_top_ten' ELSE 'rank_top_ten_exit' END,
                             n.organizer_id, n.event_id, n.player_id, '{}'::jsonb,
                             jsonb_build_object('event', push_names(ev.name_ar, ev.name_en)),
                             'rank_top_ten:' || n.id || ':' || (extract(epoch FROM now()) * 1000000)::bigint, NULL))
  INTO made
  FROM (SELECT x AS enrollment_id, true AS entered FROM unnest(fresh) x WHERE NOT x = ANY (snap.enrollment_ids)
        UNION ALL
        SELECT x, false FROM unnest(snap.enrollment_ids) x WHERE NOT x = ANY (fresh)) m
  JOIN enrollment n ON n.id = m.enrollment_id AND n.event_id = target
  WHERE n.joined_via IS DISTINCT FROM 'rehearsal'
    AND (m.entered OR ranking_eligible(n))
    AND NOT EXISTS (SELECT 1 FROM notice c
                    WHERE c.player_id = n.player_id AND c.event_id = target
                      AND c.kind IN ('rank_top_ten', 'rank_top_ten_exit')
                      AND c.created_at > now() - interval '10 minutes');
  RETURN jsonb_build_object('state', 'diffed', 'notices', made);
END $$;
REVOKE ALL ON FUNCTION rank_push_diff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rank_push_diff(uuid) TO questify_app;

-- ================================================================ the operators page (T-617 review)
-- As 0111, with the two per-operator reviews and answers reads cut to what they show: today's count is a range on the
-- (event, operator, time) index and the last time is one seek, where both used to read the operator's whole history of
-- reviews and answers for every operator on every load. The result is the same.
CREATE OR REPLACE FUNCTION operator_activity_rows(ev event, day_start timestamptz, hour_start timestamptz) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH ops AS (
    SELECT sa.id, sa.player_id, p.username
    FROM staff_assignment sa JOIN player p ON p.id = sa.player_id
    WHERE sa.event_id = ev.id),
  grouped AS (
    SELECT o.player_id AS op, g.kind, g.quest_id, g.n, g.recent, g.last_at
    FROM ops o
    CROSS JOIN LATERAL (
      SELECT l.kind, l.quest_id, count(*) AS n, count(*) FILTER (WHERE l.created_at > hour_start) AS recent,
             max(l.created_at) AS last_at
      FROM ledger_entry l
      WHERE l.event_id = ev.id AND l.operator_id = o.player_id AND l.created_at >= day_start
      GROUP BY l.kind, l.quest_id) g),
  totals AS (
    SELECT g.op,
           sum(g.recent) FILTER (WHERE g.kind IN ('quest', 'session')) AS scans_hour,
           sum(g.n) FILTER (WHERE g.kind IN ('quest', 'session')) AS scans,
           sum(g.n) FILTER (WHERE g.kind = 'award') AS awards,
           sum(g.n) FILTER (WHERE g.kind = 'handover') AS hand_overs
    FROM grouped g GROUP BY g.op),
  stations AS (
    SELECT r.op, jsonb_agg(jsonb_build_object('questId', r.quest_id, 'titleAr', q.title_ar, 'titleEn', q.title_en,
                                              'scans', r.n, 'lastAt', r.last_at) ORDER BY r.n DESC, r.last_at DESC) AS items
    FROM (SELECT g.op, g.quest_id, g.n, g.last_at,
                 row_number() OVER (PARTITION BY g.op ORDER BY g.n DESC, g.last_at DESC, g.quest_id) AS place
          FROM grouped g WHERE g.kind = 'quest' AND g.quest_id IS NOT NULL) r
    JOIN quest q ON q.id = r.quest_id
    WHERE r.place <= 5
    GROUP BY r.op),
  latest AS (
    SELECT o.player_id AS op, ll.kind, ll.at
    FROM ops o
    LEFT JOIN LATERAL (SELECT l.kind, l.created_at AS at FROM ledger_entry l
                       WHERE l.event_id = ev.id AND l.operator_id = o.player_id
                       ORDER BY l.created_at DESC LIMIT 1) ll ON true),
  reviews AS (
    SELECT o.player_id AS op, r.today, r.last_at
    FROM ops o
    CROSS JOIN LATERAL (
      SELECT (SELECT count(*) FROM submission s
              WHERE s.event_id = ev.id AND s.reviewed_by_operator = o.player_id AND s.reviewed_at >= day_start) AS today,
             (SELECT s.reviewed_at FROM submission s
              WHERE s.event_id = ev.id AND s.reviewed_by_operator = o.player_id AND s.reviewed_at IS NOT NULL
              ORDER BY s.reviewed_at DESC LIMIT 1) AS last_at) r),
  answers AS (
    SELECT o.player_id AS op, a.today, a.last_at
    FROM ops o
    CROSS JOIN LATERAL (
      SELECT (SELECT count(*) FROM ticket t
              WHERE t.event_id = ev.id AND t.answered_by_operator = o.player_id AND t.closed_at >= day_start) AS today,
             (SELECT t.closed_at FROM ticket t
              WHERE t.event_id = ev.id AND t.answered_by_operator = o.player_id AND t.closed_at IS NOT NULL
              ORDER BY t.closed_at DESC LIMIT 1) AS last_at) a),
  listed AS (
    SELECT o.id, o.username, newest.at AS last_at, jsonb_build_object(
             'id', o.id, 'username', o.username,
             'scansHour', coalesce(t.scans_hour, 0), 'scans', coalesce(t.scans, 0), 'awards', coalesce(t.awards, 0),
             'handOvers', coalesce(t.hand_overs, 0), 'handled', rv.today + an.today,
             'lastAt', newest.at, 'lastAction', newest.action,
             'stations', coalesce(st.items, '[]'::jsonb)) AS item
    FROM ops o
    JOIN latest la ON la.op = o.player_id
    JOIN reviews rv ON rv.op = o.player_id
    JOIN answers an ON an.op = o.player_id
    LEFT JOIN totals t ON t.op = o.player_id
    LEFT JOIN stations st ON st.op = o.player_id
    LEFT JOIN LATERAL (
      SELECT v.at, v.action
      FROM (VALUES (la.at, operator_action_of(la.kind)), (rv.last_at, 'review'), (an.last_at, 'answer'))
             AS v (at, action)
      WHERE v.at IS NOT NULL ORDER BY v.at DESC LIMIT 1) newest ON true)
  SELECT coalesce(jsonb_agg(x.item ORDER BY x.last_at DESC NULLS LAST, x.username, x.id), '[]'::jsonb) FROM listed x
$$;
REVOKE ALL ON FUNCTION operator_activity_rows(event, timestamptz, timestamptz) FROM PUBLIC;
