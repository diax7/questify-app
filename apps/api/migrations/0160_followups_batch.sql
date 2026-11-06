-- A batch of review follow-ups (docs/FOLLOWUPS.md; ADR-735 to ADR-741). Nothing here writes points: the ledger, its
-- triggers and every payer are untouched; the manual-awards report only reads more of the ledger. Restated functions keep
-- their arguments, results and grants; the new ones are closed to PUBLIC next to their CREATE, and only the doors are
-- granted to the API role. One new table (`streak_scan_quiet`, no personal data) keeps row-level security forced and no
-- grant. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration alters or indexes, up front, in one order.
LOCK TABLE rank_top_snapshot IN ACCESS EXCLUSIVE MODE;
LOCK TABLE group_push IN ACCESS EXCLUSIVE MODE;
LOCK TABLE organizer_alert IN SHARE MODE;

-- ================================================================ the rank push's failed events (T-503 review, ADR-735)
-- A snapshot row with no ids is an event whose diff failed before it ever had a baseline: it holds only the time of the
-- failure, so the tick's list (never-read and oldest first) puts it behind the others, and the next diff that works
-- stores a baseline and sends nothing.
ALTER TABLE rank_top_snapshot ALTER COLUMN enrollment_ids DROP NOT NULL;

-- As 0113, with one change: a snapshot with no ids is no baseline (`had` is false), so the first diff that works after a
-- failure stores the ten and sends nothing.
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
  had := FOUND AND snap.enrollment_ids IS NOT NULL;
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

-- A diff that failed (a statement timeout, any error; its own transaction rolled back): the event's snapshot is stamped
-- now, keeping the ids it had, so the next tick reads the other live events first. A live event with no snapshot gets a
-- row with no ids. Nothing for an event that is gone. System context only (PN403).
CREATE FUNCTION rank_push_failed(target uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM push_system_only();
  INSERT INTO rank_top_snapshot (event_id, enrollment_ids, rehearsal_erased_at)
  SELECT e.id, NULL, NULL FROM event e
  WHERE e.id = target AND event_status_now(e.status, e.starts_at, e.ends_at) = 'live'
  ON CONFLICT (event_id) DO UPDATE SET taken_at = now();
END $$;
REVOKE ALL ON FUNCTION rank_push_failed(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rank_push_failed(uuid) TO questify_app;

-- ================================================================ a group push that keeps failing (T-706b review, ADR-736)
-- The page's failures in a row and when the next try may start; both move only while the send is running.
ALTER TABLE group_push
  ADD COLUMN fan_failures integer NOT NULL DEFAULT 0 CHECK (fan_failures BETWEEN 0 AND 1000),
  ADD COLUMN retry_after timestamptz;

-- One page of a running send, as 0138's body after the send is chosen: the players after its cursor, a notice each unless
-- the weekly cap says no, and the cursor, the counts and the state; a page that works clears the failure count.
-- Internal: no grant.
CREATE FUNCTION group_push_page(g group_push) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ids    uuid[];
  who    uuid;
  fresh  integer := 0;
  held   integer := 0;
  width  constant integer := 500;
BEGIN
  ids := ARRAY(SELECT a.player_id FROM marketing_audience('push', g.city_id, g.interests, g.cursor_player, width) a);
  FOREACH who IN ARRAY ids LOOP
    IF NOT promo_push_free(who) THEN
      held := held + 1;
    ELSIF notice_create('group_push_promo', NULL, NULL, who, '{}', group_push_params(g), 'gpush:' || g.id || ':' || who,
                        NULL) IS NOT NULL THEN
      fresh := fresh + 1;
    END IF;
  END LOOP;
  UPDATE group_push x
  SET cursor_player = coalesce(ids[cardinality(ids)], x.cursor_player), notices = x.notices + fresh,
      capped = x.capped + held, state = CASE WHEN cardinality(ids) < width THEN 'done' ELSE 'sending' END,
      finished_at = CASE WHEN cardinality(ids) < width THEN now() END, fan_failures = 0, retry_after = NULL
  WHERE x.id = g.id;
  RETURN jsonb_build_object('rows', cardinality(ids), 'more', cardinality(ids) >= width);
END $$;
REVOKE ALL ON FUNCTION group_push_page(group_push) FROM PUBLIC;

-- A failed page (its work already rolled back to the block's savepoint), as push_fan_out_failed (0076) for a notice:
-- counted, and the next try waits 1 minute, then 4, 16, and at most an hour, so the sends behind it go first. Answers what
-- the worker logs: `failed` (the send), the SQLSTATE, `retryAfter`, and `parked` at the third failure in a row (the
-- alert). Internal: no grant.
CREATE FUNCTION group_push_fan_failed(target uuid, state text) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  failures integer;
  waits    timestamptz;
BEGIN
  UPDATE group_push x
  SET fan_failures = least(x.fan_failures + 1, 1000),
      retry_after = now() + least(interval '1 minute' * power(4, least(x.fan_failures, 10)), interval '1 hour')
  WHERE x.id = target
  RETURNING x.fan_failures, x.retry_after INTO failures, waits;
  RETURN jsonb_build_object('rows', 0, 'more', false, 'failed', target, 'code', state, 'retryAfter', waits,
                            'parked', coalesce(failures = 3, false));
END $$;
REVOKE ALL ON FUNCTION group_push_fan_failed(uuid, text) FROM PUBLIC;

-- As 0138, with one change: the oldest running send not waiting out a back-off is chosen, and its page runs in a block of
-- its own; a page that fails for any reason, a statement timeout included, is undone alone and counted
-- (group_push_fan_failed), so the sends behind it are written instead of waiting on it every second. Same locks, in the
-- same order: the invitation fill's key, then the send row `FOR UPDATE SKIP LOCKED`, then the notices.
CREATE OR REPLACE FUNCTION group_push_fan() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g     group_push;
  state text;
BEGIN
  PERFORM push_system_only();
  IF NOT pg_try_advisory_xact_lock(hashtext('invitation_fill')) THEN
    RETURN jsonb_build_object('rows', 0, 'more', false);
  END IF;
  SELECT x.* INTO g FROM group_push x
  WHERE x.state = 'sending' AND (x.retry_after IS NULL OR x.retry_after <= now())
  ORDER BY x.created_at, x.id LIMIT 1
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('rows', 0, 'more', false);
  END IF;
  BEGIN
    RETURN group_push_page(g);
  EXCEPTION
    WHEN query_canceled THEN
      GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
  END;
  RETURN group_push_fan_failed(g.id, state);
END $$;
REVOKE ALL ON FUNCTION group_push_fan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_push_fan() TO questify_app;

-- ================================================================ old cheers go (T-509 review, ADR-737)
-- The cheers of a moment that ended 3 days ago or more, at most `batch` (1 to 5,000) a call, oldest event first; the
-- lifecycle tick calls it once a run (every 30 s), so 1.5M rows go in about 2.5 hours. A cheer is kept only to draw the moment on the big screen and
-- to count a player's last minute, so nothing reads it after its moment ends. Reads across organizers on purpose (a
-- retention sweep, rules.md). Row locks are SKIP LOCKED, so a moment being restarted is left for the next call.
-- Answers how many went.
CREATE FUNCTION cheers_purge(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  WITH due AS (
    SELECT c.id FROM cheers_moment m JOIN cheer c ON c.event_id = m.event_id
    WHERE m.ends_at <= now() - interval '3 days'
    ORDER BY m.ends_at, c.event_id, c.id
    LIMIT least(greatest(coalesce(batch, 5000), 1), 5000)
    FOR UPDATE OF c SKIP LOCKED)
  DELETE FROM cheer c USING due WHERE c.id = due.id;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION cheers_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cheers_purge(integer) TO questify_app;

-- ================================================================ the Ask Questify request under a lock (T-711b review)
-- As 0141, with one change (ADR-738): the event row is read `FOR SHARE`, and the admin's unlock takes it `FOR UPDATE`
-- before it writes the entitlement (settings/store.ts insertEntitlement). An ask that starts while an Allow is being
-- written waits for it and then reads the entitlement (RQ409); an Allow that starts while an ask is being written waits
-- for it and then closes the request it opened. Lock order: the event row, then the request rows.
CREATE OR REPLACE FUNCTION request_feature(target_event uuid, wanted text, request uuid)
  RETURNS TABLE (id uuid, status text, requested_at timestamptz, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me       uuid := app_staff_user_id();
  ev       event%ROWTYPE;
  made     feature_request%ROWTYPE;
  declined timestamptz;
BEGIN
  SELECT e.* INTO ev FROM event e WHERE e.id = target_event FOR SHARE;
  IF NOT FOUND OR me IS NULL OR ev.organizer_id IS DISTINCT FROM app_organizer_id() THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'RQ404';
  ELSIF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner asks Questify' USING ERRCODE = 'RQ403';
  ELSIF wanted IS NULL OR NOT feature_request_addon(wanted) THEN
    RAISE EXCEPTION 'not an add-on' USING ERRCODE = 'RQ422';
  ELSIF EXISTS (SELECT 1 FROM event_entitlement x WHERE x.event_id = ev.id AND x.feature = wanted) THEN
    RAISE EXCEPTION 'already unlocked' USING ERRCODE = 'RQ409';
  END IF;
  SELECT r.* INTO made FROM feature_request r WHERE r.event_id = ev.id AND r.feature = wanted AND r.status = 'open';
  IF FOUND THEN
    RETURN QUERY SELECT made.id, made.status, made.requested_at, false;
    RETURN;
  END IF;
  SELECT max(r.decided_at) INTO declined FROM feature_request r
  WHERE r.event_id = ev.id AND r.feature = wanted AND r.status = 'declined';
  IF declined > now() - interval '24 hours' THEN
    RAISE EXCEPTION 'declined in the last 24 hours' USING ERRCODE = 'RQ429',
      HINT = to_char((declined + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  END IF;
  INSERT INTO feature_request (organizer_id, event_id, feature, requested_by)
  VALUES (ev.organizer_id, ev.id, wanted, me)
  ON CONFLICT (event_id, feature) WHERE status = 'open' DO NOTHING
  RETURNING * INTO made;
  IF NOT FOUND THEN
    -- Another call of the same owner opened it in the same instant: answer that row.
    SELECT r.* INTO made FROM feature_request r WHERE r.event_id = ev.id AND r.feature = wanted AND r.status = 'open';
    RETURN QUERY SELECT made.id, made.status, made.requested_at, false;
    RETURN;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'feature_request.create', 'feature_request', made.id::text,
          jsonb_build_object('feature', wanted), request);
  RETURN QUERY SELECT made.id, made.status, made.requested_at, true;
END $$;
REVOKE ALL ON FUNCTION request_feature(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_feature(uuid, text, uuid) TO questify_app;

-- ================================================================ one snapshot for a copy (T-601 review, ADR-739)
-- As 0105, with one change: the copy runs only in a REPEATABLE READ (or SERIALIZABLE) transaction (ED500
-- `needs_repeatable_read` otherwise), so every helper reads the source as of one moment and a quest or category added to
-- the source while the copy runs is either wholly in it or wholly out of it, never a quest whose category was not copied.
-- The API's duplicate opens its transaction that way (events/events.ts). The organizer checks come first, unchanged.
CREATE OR REPLACE FUNCTION event_copy_setup(source_event uuid, target_event uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  src    event := award_event_of(source_event);
  tgt    event := award_event_of(target_event);
  shift  interval;
  counts jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'an event is copied in one snapshot' USING ERRCODE = 'ED500', DETAIL = 'needs_repeatable_read';
  END IF;
  IF src.id = tgt.id THEN
    RAISE EXCEPTION 'an event cannot be copied onto itself' USING ERRCODE = 'ED422', DETAIL = 'same_event';
  END IF;
  PERFORM 1 FROM event e WHERE e.id = src.id FOR SHARE;
  PERFORM 1 FROM event e WHERE e.id = tgt.id FOR NO KEY UPDATE;
  IF tgt.status <> 'draft' OR NOT event_copy_target_ok(tgt.id) THEN
    RAISE EXCEPTION 'the new event must be an empty draft' USING ERRCODE = 'ED409', DETAIL = 'target_not_empty';
  END IF;
  DELETE FROM category c WHERE c.event_id = tgt.id;
  shift := coalesce(tgt.starts_at - src.starts_at, interval '0');
  PERFORM event_copy_settings(src, tgt, shift);
  counts := event_copy_structure(src, tgt, shift);
  counts := counts || jsonb_build_object('quests', event_copy_quests(src, tgt, shift));
  counts := counts || event_copy_prizes(src, tgt, shift) || event_copy_extras(src, tgt, shift);
  PERFORM event_copy_home_content(tgt.id);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), tgt.organizer_id, tgt.id, 'event.duplicate', 'event', tgt.id::text,
          jsonb_build_object('source', src.id) || counts, request);
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION event_copy_setup(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_copy_setup(uuid, uuid, uuid) TO questify_app;

-- ================================================================ a quiet streak scan (T-501f review, ADR-740)
-- A Questify day whose streak scan last found nobody to remind, and until when the scan rests. No personal data. Written
-- and read only by push_due_streak; rows of earlier days are deleted by it.
CREATE TABLE streak_scan_quiet (
  day         date PRIMARY KEY,
  quiet_until timestamptz NOT NULL
);
ALTER TABLE streak_scan_quiet ENABLE ROW LEVEL SECURITY;
ALTER TABLE streak_scan_quiet FORCE ROW LEVEL SECURITY;
REVOKE ALL ON streak_scan_quiet FROM PUBLIC, questify_app;

-- As 0079, in PL/pgSQL, with one change: a pass that finds nobody to remind rests the scan for an hour of that day, so
-- the evening reads yesterday's streak rows about 6 times instead of every minute, and a player who becomes reachable in
-- the evening (a new phone, an unmuted topic) is still reminded within the hour.
CREATE OR REPLACE FUNCTION push_due_streak(lim integer, at timestamptz) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  today    date := questify_day(at);
  midnight timestamptz := (date_trunc('day', at AT TIME ZONE 'Asia/Riyadh') + interval '1 day') AT TIME ZONE 'Asia/Riyadh';
  quiet    timestamptz;
  made     integer;
BEGIN
  IF extract(hour FROM at AT TIME ZONE 'Asia/Riyadh') < 18 OR NOT daily_streak_on() THEN
    RETURN 0;
  END IF;
  SELECT q.quiet_until INTO quiet FROM streak_scan_quiet q WHERE q.day = today;
  IF quiet > at THEN
    RETURN 0;
  END IF;
  WITH due AS (
    SELECT y.player_id, 'streak:' || y.player_id || ':' || to_char(today, 'YYYY-MM-DD') AS marker
    FROM questify_streak_day y
    JOIN player p ON p.id = y.player_id AND p.status = 'active'
    WHERE y.day = today - 1
      AND EXISTS (SELECT 1 FROM questify_streak_day b WHERE b.player_id = y.player_id AND b.day = today - 2)
      AND NOT EXISTS (SELECT 1 FROM questify_streak_day t WHERE t.player_id = y.player_id AND t.day >= today)
      AND EXISTS (SELECT 1 FROM push_live_devices() d WHERE d.player_id = y.player_id)
      AND NOT EXISTS (SELECT 1 FROM push_topic_mute m WHERE m.player_id = y.player_id AND m.topic = 'reminders')
      AND NOT EXISTS (SELECT 1 FROM notice nt
                      WHERE nt.dedupe = 'streak:' || y.player_id || ':' || to_char(today, 'YYYY-MM-DD'))
    ORDER BY y.player_id
    LIMIT push_due_streak.lim)
  SELECT count(notice_create('streak_reminder', NULL, NULL, due.player_id, '{}'::jsonb, '{}'::jsonb, due.marker,
                             midnight))::integer
  INTO made
  FROM due;
  IF made = 0 THEN
    INSERT INTO streak_scan_quiet (day, quiet_until) VALUES (today, at + interval '1 hour')
    ON CONFLICT (day) DO UPDATE SET quiet_until = excluded.quiet_until;
    DELETE FROM streak_scan_quiet q WHERE q.day < today;
  END IF;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION push_due_streak(integer, timestamptz) FROM PUBLIC;

-- ================================================================ a low-stock cooldown (T-609 review, ADR-741)
-- The cooldown's probe: an event's alerts by time (the outbox keeps rows 30 days).
CREATE INDEX organizer_alert_event_recent_idx ON organizer_alert (event_id, created_at) WHERE event_id IS NOT NULL;

-- As 0082, with one change: a reward that crosses into low within 6 hours of its last low alert (a reservation that
-- expired and was taken again, a restock that ran out) emails nobody; the next crossing after the 6 hours does.
CREATE OR REPLACE FUNCTION alert_on_reward_low() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizer_alert a
             WHERE a.event_id = NEW.event_id AND a.created_at > now() - interval '6 hours'
               AND a.dedupe LIKE 'reward:' || NEW.id || ':%') THEN
    RETURN NULL;
  END IF;
  PERFORM alert_enqueue(NEW.organizer_id, NEW.event_id,
                        CASE WHEN NEW.kind = 'digital' THEN 'codes_low' ELSE 'stock_low' END,
                        'reward:' || NEW.id || ':' || txid_current())
  FROM event e
  WHERE e.id = NEW.event_id AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('live', 'ended');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_reward_low() FROM PUBLIC;

-- As 0104, with the same 6-hour cooldown per quest item.
CREATE OR REPLACE FUNCTION alert_on_item_low() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM organizer_alert a
             WHERE a.event_id = NEW.event_id AND a.created_at > now() - interval '6 hours'
               AND a.dedupe LIKE 'item:' || NEW.id || ':%') THEN
    RETURN NULL;
  END IF;
  PERFORM alert_enqueue(NEW.organizer_id, NEW.event_id, 'stock_low', 'item:' || NEW.id || ':' || txid_current())
  FROM event e
  WHERE e.id = NEW.event_id AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('live', 'ended');
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION alert_on_item_low() FROM PUBLIC;

-- ================================================================ points changes in the manual-awards report (T-604)
-- As 0030, plus the `adjust` lines a quest's points change wrote (FR-311; display only, the ledger is unchanged): one line
-- per player whose points moved, with the quest, the signed amount and the staff member who changed it, and no reason.
-- Each branch walks its own index newest first and stops at the page, then the two are merged by entry id.
CREATE OR REPLACE FUNCTION manual_awards(target_event uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, points bigint, score_delta bigint, balance_delta bigint,
                 reverses bigint, enrollment_id uuid, username text, quest_id uuid, title_ar text, title_en text,
                 reason text, bulk_id uuid, by_operator text, by_staff text, removed boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := award_event_of(target_event);
  size integer := least(greatest(coalesce(page, 50), 1), 100);
BEGIN
  RETURN QUERY
  WITH lines AS (
    (SELECT n.entry_id, coalesce(n.reason, b.reason) AS reason, n.bulk_id
     FROM ledger_note n LEFT JOIN bulk_award b ON b.id = n.bulk_id
     WHERE n.event_id = ev.id AND (before_id IS NULL OR n.entry_id < before_id)
     ORDER BY n.entry_id DESC LIMIT size)
    UNION ALL
    (SELECT a.id, NULL::text, NULL::uuid
     FROM quest_points_change c JOIN ledger_entry a ON a.points_change_id = c.id AND a.kind = 'adjust'
     WHERE c.event_id = ev.id AND (before_id IS NULL OR a.id < before_id)
     ORDER BY a.id DESC LIMIT size))
  SELECT l.id, l.created_at, l.kind, coalesce(r.score_delta, l.score_delta), l.score_delta, l.balance_delta,
         l.reverses, l.enrollment_id, p.username, l.quest_id, q.title_ar, q.title_en, x.reason,
         x.bulk_id, op.username, su.email,
         EXISTS (SELECT 1 FROM ledger_entry y WHERE y.reverses = l.id)
  FROM lines x
  JOIN ledger_entry l ON l.id = x.entry_id
  JOIN enrollment e ON e.id = l.enrollment_id
  JOIN player p ON p.id = e.player_id
  LEFT JOIN ledger_entry r ON r.id = l.reverses
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  ORDER BY l.id DESC
  LIMIT size;
END $$;
REVOKE ALL ON FUNCTION manual_awards(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION manual_awards(uuid, bigint, integer) TO questify_app;
