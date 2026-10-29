-- T-503: the top-10 rank push (FR-613, ADR-362) and the organizer alert switches and outbox (FR-1727, ADR-362, ADR-363;
-- plan docs/plans/2026-10-29-t-503b-rank-diff.md). Rank: a tick reads each live event's top ten in the board's own
-- order and rule, compares it with the stored previous ten (`rank_top_snapshot`, one row per event) and writes one
-- personal `rank` notice through notice_create per entry and per exit; nothing here touches the completion transaction or
-- the ranking cache. Alerts: one switch per member and type (default ON), an id-only outbox, producers that write it,
-- and a sender that re-checks the member and the switch when it sends. No EXCEPTION block anywhere. Deny by default: the
-- new tables keep row-level security forced and no grant; every function is closed to PUBLIC in the group that creates
-- it; only the doors are granted to the API role. Migrations 0081 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration references or gives a trigger, up front, in one order: the foreign-key targets
-- (organizer, organizer_member, event) and the four tables that gain a trigger (event, event_limit_alert, reward,
-- audit_log), plus flag (a new index).
LOCK TABLE organizer IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organizer_member IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE event_limit_alert IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE reward IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE audit_log IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE flag IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the rank kinds (ADR-362)
-- Personal (priority 0), topic `rank` (mutable, FR-1115), membership `active`, five minutes to live: a late "you are in the
-- top 10" is worse than none. Fixed text with no rank number (ADR-346); both open the ranking tab.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('rank_top_ten', 'personal', 'rank', 'active', false, 0, interval '5 minutes'),
  ('rank_top_ten_exit', 'personal', 'rank', 'active', false, 0, interval '5 minutes');

-- ================================================================ the snapshot
-- The previous top ten of a live event, as enrollment ids (no player id, no name), and the rehearsal erase stamp it was
-- taken under: a changed stamp means a rehearsal wipe moved the board, so the next read is a baseline. Ids of an enrollment
-- erased or wiped since drop out at the next tick. Written only by rank_push_diff; an event that stops being live loses
-- its row, so a return to live starts from a baseline.
CREATE TABLE rank_top_snapshot (
  event_id            uuid PRIMARY KEY REFERENCES event (id) ON DELETE CASCADE,
  enrollment_ids      uuid[] NOT NULL CHECK (cardinality(enrollment_ids) <= 10),
  rehearsal_erased_at timestamptz,
  taken_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE rank_top_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_top_snapshot FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rank_top_snapshot FROM PUBLIC, questify_app;

-- The event's ten best-placed enrollments in the board's order (points, then who reached them first) and under the
-- board's rule (ranking_eligible, the row form of ranked_enrollments). It walks enrollment_ranking_idx in order and stops
-- at ten, so an event of 50,000 players costs one index range, not a pass over every member. Internal: no grant.
CREATE FUNCTION rank_top_ten_ids(target uuid) RETURNS uuid[]
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(array_agg(t.id ORDER BY t.score DESC, t.score_version), '{}'::uuid[])
  FROM (SELECT e.id, e.score, e.score_version FROM enrollment e
        WHERE e.event_id = target AND e.status = 'active' AND e.score > 0 AND ranking_eligible(e)
        ORDER BY e.score DESC, e.score_version LIMIT 10) t
$$;
REVOKE ALL ON FUNCTION rank_top_ten_ids(uuid) FROM PUBLIC;

-- The tick's list (system context only): the live events, never-read and oldest snapshot first so a tick cut short by its
-- time budget picks up where it stopped. Also drops the snapshots of events that are no longer live.
CREATE FUNCTION rank_push_events(lim integer) RETURNS SETOF uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM push_system_only();
  DELETE FROM rank_top_snapshot s
  WHERE NOT EXISTS (SELECT 1 FROM event e WHERE e.id = s.event_id AND e.status = 'live');
  RETURN QUERY
    SELECT e.id FROM event e LEFT JOIN rank_top_snapshot s ON s.event_id = e.id
    WHERE e.status = 'live'
    ORDER BY s.taken_at NULLS FIRST, e.id
    LIMIT least(greatest(rank_push_events.lim, 0), 1000);
END $$;
REVOKE ALL ON FUNCTION rank_push_events(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rank_push_events(integer) TO questify_app;

-- The event ranking is on unless the event's own switch (`config.features.ranking`) or the platform's
-- (`platform_setting` features.ranking.enabled) is false, as the composed configuration reads them (FR-607).
CREATE FUNCTION ranking_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> 'ranking' <> 'false'::jsonb, true)
     AND coalesce((SELECT s.value -> 'ranking' -> 'enabled' <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION ranking_on(event) FROM PUBLIC;

-- One event's diff (system context only), in one transaction under a try-lock on the event: a second runner or API
-- instance gets `busy` and does nothing. Not live, or the ranking switched off: the snapshot goes and nothing is sent.
-- No snapshot, or a changed rehearsal erase stamp: the new ten is stored as a baseline with no notices. Otherwise one notice
-- per enrollment that entered and per enrollment that left, never to a rehearsal account and never to a member who got a
-- top-10 notice for this event in the last 10 minutes (the dropped one is not queued). Eligibility of the recipient (active
-- member and player) is the push store's, at fan-out and at the claim.
CREATE FUNCTION rank_push_diff(target uuid) RETURNS jsonb
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
  SELECT r.erased_at INTO erased FROM event_rehearsal r WHERE r.event_id = target;
  SELECT s.* INTO snap FROM rank_top_snapshot s WHERE s.event_id = target;
  had := FOUND;
  fresh := rank_top_ten_ids(target);
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
    AND NOT EXISTS (SELECT 1 FROM notice c
                    WHERE c.player_id = n.player_id AND c.event_id = target
                      AND c.kind IN ('rank_top_ten', 'rank_top_ten_exit')
                      AND c.created_at > now() - interval '10 minutes');
  RETURN jsonb_build_object('state', 'diffed', 'notices', made);
END $$;
REVOKE ALL ON FUNCTION rank_push_diff(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rank_push_diff(uuid) TO questify_app;

-- ================================================================ organizer alert switches (FR-1727)
-- The seven types, the one list the tables and the doors check against.
CREATE FUNCTION organizer_alert_types() RETURNS text[]
  LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['activated', 'stock_low', 'codes_low', 'new_flags', 'content_unpublished', 'support_access',
               'size_limit']
$$;
REVOKE ALL ON FUNCTION organizer_alert_types() FROM PUBLIC;

-- One row per member and type once the member has saved their switches; a missing row means ON. Removing the member
-- removes their switches, and a member who is invited again starts from ON.
CREATE TABLE organizer_alert_switch (
  organizer_id  uuid NOT NULL,
  staff_user_id uuid NOT NULL,
  alert_type    text NOT NULL CHECK (alert_type = ANY (organizer_alert_types())),
  enabled       boolean NOT NULL,
  PRIMARY KEY (organizer_id, staff_user_id, alert_type),
  FOREIGN KEY (organizer_id, staff_user_id) REFERENCES organizer_member (organizer_id, staff_user_id)
    ON DELETE CASCADE
);
ALTER TABLE organizer_alert_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_alert_switch FORCE ROW LEVEL SECURITY;
REVOKE ALL ON organizer_alert_switch FROM PUBLIC, questify_app;

-- The calling member of the organizer in context: an active staff account that is a member of `org` and is the
-- organizer in the request's context. AL404 for anyone else (another organizer, an admin, a player, no context).
CREATE FUNCTION alert_caller(org uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid;
BEGIN
  SELECT m.staff_user_id INTO who
  FROM organizer_member m JOIN staff_user u ON u.id = m.staff_user_id AND u.status = 'active'
  WHERE m.organizer_id = alert_caller.org AND alert_caller.org = app_organizer_id()
    AND m.staff_user_id = app_staff_user_id() AND app_player_id() IS NULL;
  IF who IS NULL THEN
    RAISE EXCEPTION 'not a member of this organizer' USING ERRCODE = 'AL404';
  END IF;
  RETURN who;
END $$;
REVOKE ALL ON FUNCTION alert_caller(uuid) FROM PUBLIC;

-- The caller's own switches: every type, true unless the member switched it off.
CREATE FUNCTION own_alert_switches(org uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := alert_caller(own_alert_switches.org);
BEGIN
  RETURN (SELECT jsonb_object_agg(t, coalesce((SELECT s.enabled FROM organizer_alert_switch s
                                               WHERE s.organizer_id = own_alert_switches.org
                                                 AND s.staff_user_id = who AND s.alert_type = t), true))
          FROM unnest(organizer_alert_types()) t);
END $$;
REVOKE ALL ON FUNCTION own_alert_switches(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_alert_switches(uuid) TO questify_app;

-- Saves the caller's own switches, all seven (AL422 for anything else), and answers them as stored. Nothing here takes a
-- member id: no one sets another member's switches. A change is audited with the booleans only.
CREATE FUNCTION set_own_alert_switches(org uuid, switches jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who    uuid := alert_caller(set_own_alert_switches.org);
  was    jsonb := own_alert_switches(set_own_alert_switches.org);
  is_now jsonb;
BEGIN
  IF jsonb_typeof(set_own_alert_switches.switches) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'every alert type needs true or false' USING ERRCODE = 'AL422';
  END IF;
  IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(set_own_alert_switches.switches) k)
       IS DISTINCT FROM (SELECT array_agg(t ORDER BY t) FROM unnest(organizer_alert_types()) t)
     OR EXISTS (SELECT 1 FROM jsonb_each(set_own_alert_switches.switches) e
                WHERE jsonb_typeof(e.value) <> 'boolean') THEN
    RAISE EXCEPTION 'every alert type needs true or false' USING ERRCODE = 'AL422';
  END IF;
  INSERT INTO organizer_alert_switch (organizer_id, staff_user_id, alert_type, enabled)
  SELECT set_own_alert_switches.org, who, e.key, (e.value #>> '{}')::boolean
  FROM jsonb_each(set_own_alert_switches.switches) e
  ON CONFLICT (organizer_id, staff_user_id, alert_type) DO UPDATE SET enabled = excluded.enabled;
  is_now := own_alert_switches(set_own_alert_switches.org);
  IF is_now IS DISTINCT FROM was THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, before, after,
                           request_id)
    VALUES ('staff', who, set_own_alert_switches.org, 'organizer.alerts_set', 'organizer_member', who::text, was,
            is_now, set_own_alert_switches.request);
  END IF;
  RETURN is_now;
END $$;
REVOKE ALL ON FUNCTION set_own_alert_switches(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_own_alert_switches(uuid, jsonb, uuid) TO questify_app;

-- ================================================================ the outbox
-- One row per member and fact: ids only, never an address, a name or a text. `dedupe` is the once-only key (the fact's
-- key and the member), so a repeated source writes nothing. No foreign key to the member or the account: the sender checks
-- them when it sends. A row is `queued` until claimed; `sending` under a 60-second lease; then `sent`, `failed` (the
-- transport refused it for sure), `uncertain` (the send was started and its result is not known: never sent again) or
-- `skipped` with the reason in `code`.
CREATE TABLE organizer_alert (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id  uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  event_id      uuid,
  staff_user_id uuid NOT NULL,
  alert_type    text NOT NULL CHECK (alert_type = ANY (organizer_alert_types())),
  dedupe        text NOT NULL UNIQUE,
  state         text NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued', 'sending', 'sent', 'skipped', 'failed', 'uncertain')),
  code          text CHECK (code ~ '^[a-z_]{1,40}$'),
  lease_token   uuid,
  lease_until   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CHECK ((state = 'sending') = (lease_token IS NOT NULL)),
  CHECK ((state = 'sending') = (lease_until IS NOT NULL)),
  CHECK ((state IN ('queued', 'sending')) = (finished_at IS NULL))
);
CREATE INDEX organizer_alert_queue ON organizer_alert (id) WHERE state = 'queued';
CREATE INDEX organizer_alert_leased ON organizer_alert (lease_until) WHERE state = 'sending';
CREATE INDEX organizer_alert_finished ON organizer_alert (finished_at) WHERE finished_at IS NOT NULL;
ALTER TABLE organizer_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizer_alert FORCE ROW LEVEL SECURITY;
REVOKE ALL ON organizer_alert FROM PUBLIC, questify_app;

-- The producer's one write: a row per active member of the organizer whose event limit covers the event and whose switch
-- for the type is on (a missing switch is on), at the moment the fact happens. `marker` names the fact; the member is
-- appended. Answers how many rows it wrote. Internal: no grant.
CREATE FUNCTION alert_enqueue(for_org uuid, for_event uuid, for_type text, marker text) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH made AS (
    INSERT INTO organizer_alert (organizer_id, event_id, staff_user_id, alert_type, dedupe)
    SELECT m.organizer_id, alert_enqueue.for_event, m.staff_user_id, alert_enqueue.for_type,
           alert_enqueue.marker || ':' || m.staff_user_id
    FROM organizer_member m
    JOIN staff_user u ON u.id = m.staff_user_id AND u.status = 'active'
    WHERE m.organizer_id = alert_enqueue.for_org AND alert_enqueue.for_type = ANY (organizer_alert_types())
      AND (alert_enqueue.for_event IS NULL OR in_event_scope(alert_enqueue.for_event, m.event_scope))
      AND coalesce((SELECT s.enabled FROM organizer_alert_switch s
                    WHERE s.organizer_id = m.organizer_id AND s.staff_user_id = m.staff_user_id
                      AND s.alert_type = alert_enqueue.for_type), true)
    ORDER BY m.staff_user_id
    ON CONFLICT (dedupe) DO NOTHING
    RETURNING 1)
  SELECT count(*)::integer FROM made
$$;
REVOKE ALL ON FUNCTION alert_enqueue(uuid, uuid, text, text) FROM PUBLIC;

-- ================================================================ the producers
-- An event activated: draft to scheduled, once per event.
CREATE FUNCTION alert_on_event_activated() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM alert_enqueue(NEW.organizer_id, NEW.id, 'activated', 'activated:' || NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_event_activated() FROM PUBLIC;
CREATE TRIGGER event_alert_activated AFTER UPDATE OF status ON event
  FOR EACH ROW WHEN (OLD.status = 'draft' AND NEW.status = 'scheduled')
  EXECUTE FUNCTION alert_on_event_activated();

-- The 80% or 100% mark of an event's player limit, as 0027 records it (once per limit; an activation records them again,
-- so the time of the record is part of the key).
CREATE FUNCTION alert_on_limit_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM alert_enqueue(NEW.organizer_id, NEW.event_id, 'size_limit',
                        'size_limit:' || NEW.event_id || ':' || NEW.level || ':'
                          || (extract(epoch FROM NEW.reached_at) * 1000000)::bigint);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_limit_alert() FROM PUBLIC;
CREATE TRIGGER event_limit_alert_mail AFTER INSERT ON event_limit_alert
  FOR EACH ROW EXECUTE FUNCTION alert_on_limit_alert();

-- A reward's stock crossing into low: at most max(1, 10% of the total, rounded up) left, with a total above 0. Only a
-- crossing counts (not low before, low now), so a change of the total alone never opens a second alert, restocking above
-- the line closes the episode and the next fall opens a new one. Digital rewards are `codes_low`, items and experiences
-- `stock_low`. Only a live or ended event: before the start only rehearsal accounts can reserve. The condition is spelled
-- out in the WHEN clause: it runs with the updater's rights.
CREATE FUNCTION alert_on_reward_low() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM alert_enqueue(NEW.organizer_id, NEW.event_id,
                        CASE WHEN NEW.kind = 'digital' THEN 'codes_low' ELSE 'stock_low' END,
                        'reward:' || NEW.id || ':' || txid_current())
  FROM event e
  WHERE e.id = NEW.event_id AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('live', 'ended');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_reward_low() FROM PUBLIC;
CREATE TRIGGER reward_alert_low AFTER UPDATE OF stock_total, units_out, status ON reward
  FOR EACH ROW
  WHEN (NEW.status = 'active' AND NEW.stock_total > 0
        AND NEW.stock_total - NEW.units_out <= greatest(1, ceil(NEW.stock_total * 0.1))
        AND NOT (OLD.status = 'active' AND OLD.stock_total > 0
                 AND OLD.stock_total - OLD.units_out <= greatest(1, ceil(OLD.stock_total * 0.1))))
  EXECUTE FUNCTION alert_on_reward_low();

-- Support looking at an event's tickets (0061's `console.ticket_read`): once per admin, event and day.
CREATE FUNCTION alert_on_support_read() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM alert_enqueue(NEW.organizer_id, NEW.event_id, 'support_access',
                        'support:' || coalesce(NEW.event_id::text, '-') || ':' || coalesce(NEW.actor_id::text, '-')
                          || ':' || (NEW.at AT TIME ZONE 'UTC')::date);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_support_read() FROM PUBLIC;
CREATE TRIGGER audit_log_alert_support AFTER INSERT ON audit_log
  FOR EACH ROW WHEN (NEW.action = 'console.ticket_read' AND NEW.organizer_id IS NOT NULL)
  EXECUTE FUNCTION alert_on_support_read();

-- New flags: found by a scan (system context only) of the flags raised in the last 15 minutes, never by a trigger, so the
-- completion that raises a flag does no extra work. Each flag is keyed by its id, so a flag seen again writes nothing; a
-- rehearsal account's flag raises no alert. At most `lim` flags a call.
CREATE INDEX flag_raised_idx ON flag (raised_at);
CREATE FUNCTION alert_scan_flags(lim integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made integer;
BEGIN
  PERFORM push_system_only();
  SELECT coalesce(sum(alert_enqueue(f.organizer_id, f.event_id, 'new_flags', 'flag:' || f.id)), 0)::integer
  INTO made
  FROM (SELECT x.id, x.organizer_id, x.event_id, x.enrollment_id FROM flag x
        WHERE x.raised_at > now() - interval '15 minutes' ORDER BY x.id LIMIT least(greatest(alert_scan_flags.lim, 0), 2000)) f
  JOIN enrollment n ON n.id = f.enrollment_id AND n.joined_via IS DISTINCT FROM 'rehearsal';
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION alert_scan_flags(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_scan_flags(integer) TO questify_app;

-- ================================================================ the sender's doors (system context only)
-- Why a queued row must not be sent now, or NULL: the account is not active, the member is gone or joined after the fact
-- (a membership started again is a new one), the event is outside the member's event limit, or the member switched
-- the type off. The one rule, read at the moment of sending.
CREATE FUNCTION alert_skip_reason(a organizer_alert) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM staff_user u WHERE u.id = a.staff_user_id AND u.status = 'active') THEN 'staff'
    WHEN NOT EXISTS (SELECT 1 FROM organizer_member m
                     WHERE m.organizer_id = a.organizer_id AND m.staff_user_id = a.staff_user_id
                       AND m.created_at <= a.created_at) THEN 'member'
    WHEN a.event_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM organizer_member m
                         WHERE m.organizer_id = a.organizer_id AND m.staff_user_id = a.staff_user_id
                           AND in_event_scope(a.event_id, m.event_scope)) THEN 'scope'
    WHEN NOT coalesce((SELECT s.enabled FROM organizer_alert_switch s
                       WHERE s.organizer_id = a.organizer_id AND s.staff_user_id = a.staff_user_id
                         AND s.alert_type = a.alert_type), true) THEN 'switch'
  END
$$;
REVOKE ALL ON FUNCTION alert_skip_reason(organizer_alert) FROM PUBLIC;

-- Claims up to `size` (50 at most) queued rows younger than 24 hours: each is checked again (alert_skip_reason) and
-- skipped with its reason, or leased for 60 seconds. Answers what the sender needs: the row, its lease, the type, the
-- organizer and event ids and the member's current address, which the sender holds in memory for this one send.
CREATE FUNCTION alert_claim(size integer)
  RETURNS TABLE (alert_id bigint, lease uuid, kind text, organizer uuid, event uuid, address text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM push_system_only();
  RETURN QUERY
  WITH picked AS (
    SELECT a.id FROM organizer_alert a
    WHERE a.state = 'queued' AND a.created_at > now() - interval '24 hours'
    ORDER BY a.id LIMIT least(greatest(alert_claim.size, 0), 50) FOR UPDATE SKIP LOCKED),
  checked AS (
    SELECT a.id, alert_skip_reason(a) AS reason FROM organizer_alert a JOIN picked p ON p.id = a.id),
  skipped AS (
    UPDATE organizer_alert a SET state = 'skipped', code = c.reason, finished_at = now()
    FROM checked c WHERE a.id = c.id AND c.reason IS NOT NULL RETURNING a.id),
  leased AS (
    UPDATE organizer_alert a SET state = 'sending', lease_token = gen_random_uuid(),
                                 lease_until = now() + interval '60 seconds'
    FROM checked c WHERE a.id = c.id AND c.reason IS NULL
    RETURNING a.id, a.lease_token, a.alert_type, a.organizer_id, a.event_id, a.staff_user_id)
  SELECT l.id, l.lease_token, l.alert_type, l.organizer_id, l.event_id, u.email
  FROM leased l JOIN staff_user u ON u.id = l.staff_user_id
  ORDER BY l.id;
END $$;
REVOKE ALL ON FUNCTION alert_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_claim(integer) TO questify_app;

-- Records what happened to leased rows, by id and lease token: `sent`, `failed` (refused for sure) or `uncertain`. A row
-- whose lease is not the given one, or is not leased, is left alone. Answers how many rows it changed.
CREATE FUNCTION alert_ack(ids bigint[], leases uuid[], outcomes text[], codes text[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  changed integer;
BEGIN
  PERFORM push_system_only();
  WITH given AS (
    SELECT g.id, g.lease, g.outcome, g.code
    FROM unnest(alert_ack.ids, alert_ack.leases, alert_ack.outcomes, alert_ack.codes) AS g (id, lease, outcome, code)
    WHERE g.outcome IN ('sent', 'failed', 'uncertain')),
  moved AS (
    UPDATE organizer_alert a SET state = given.outcome, code = given.code, lease_token = NULL, lease_until = NULL,
                                 finished_at = now()
    FROM given WHERE a.id = given.id AND a.state = 'sending' AND a.lease_token = given.lease RETURNING 1)
  SELECT count(*)::integer INTO changed FROM moved;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION alert_ack(bigint[], uuid[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_ack(bigint[], uuid[], text[], text[]) TO questify_app;

-- Settle (system context only): a lease that ran out becomes `uncertain` (the send may have happened: never sent again);
-- a row older than 24 hours is skipped as `expired`; while the transport is off every queued row is skipped as
-- `transport_off`; finished rows are deleted after 30 days. Each step is bounded; `more` when a bound was reached.
CREATE FUNCTION alert_settle(transport_on boolean) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_leases  integer;
  n_expired integer;
  n_off     integer := 0;
  n_purged  integer;
BEGIN
  PERFORM push_system_only();
  WITH stale AS (
    SELECT a.id FROM organizer_alert a WHERE a.state = 'sending' AND a.lease_until < now()
    ORDER BY a.lease_until LIMIT 1000 FOR UPDATE SKIP LOCKED),
  moved AS (
    UPDATE organizer_alert a SET state = 'uncertain', code = 'lease_expired', lease_token = NULL, lease_until = NULL,
                                 finished_at = now()
    FROM stale s WHERE a.id = s.id RETURNING 1)
  SELECT count(*)::integer INTO n_leases FROM moved;
  WITH old AS (
    SELECT a.id FROM organizer_alert a WHERE a.state = 'queued' AND a.created_at < now() - interval '24 hours'
    ORDER BY a.id LIMIT 5000 FOR UPDATE SKIP LOCKED),
  moved AS (
    UPDATE organizer_alert a SET state = 'skipped', code = 'expired', finished_at = now()
    FROM old WHERE a.id = old.id RETURNING 1)
  SELECT count(*)::integer INTO n_expired FROM moved;
  IF NOT alert_settle.transport_on THEN
    WITH waiting AS (
      SELECT a.id FROM organizer_alert a WHERE a.state = 'queued' ORDER BY a.id LIMIT 5000 FOR UPDATE SKIP LOCKED),
    moved AS (
      UPDATE organizer_alert a SET state = 'skipped', code = 'transport_off', finished_at = now()
      FROM waiting WHERE a.id = waiting.id RETURNING 1)
    SELECT count(*)::integer INTO n_off FROM moved;
  END IF;
  WITH gone AS (
    DELETE FROM organizer_alert a WHERE a.id IN (
      SELECT x.id FROM organizer_alert x WHERE x.finished_at < now() - interval '30 days' ORDER BY x.id LIMIT 5000)
    RETURNING 1)
  SELECT count(*)::integer INTO n_purged FROM gone;
  RETURN jsonb_build_object('leases', n_leases, 'expired', n_expired, 'off', n_off, 'purged', n_purged,
                            'more', n_leases >= 1000 OR n_expired >= 5000 OR n_off >= 5000 OR n_purged >= 5000);
END $$;
REVOKE ALL ON FUNCTION alert_settle(boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alert_settle(boolean) TO questify_app;
