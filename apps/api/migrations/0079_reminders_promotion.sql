-- T-501f: reminders and promotion by push (FR-1102's streak reminder, FR-1111 and FR-1114 on push; plan
-- docs/plans/2026-10-28-t-501f-reminders-promotion.md on the T-501 plan's "Owed pushes" rows 13 to 16; ADR-356). Three
-- kinds: the daily streak reminder (personal, a due scan from 18:00 Riyadh; the daily games reminder is folded into it),
-- the shop closing the day before its window closes (event, a due scan) and the Questify invitation by push (promo,
-- written by the invitation sender's hand-off door). Each producer calls only notice_create (one insert: an unknown kind
-- inserts nothing and raises nothing), so a broken kind never undoes its door. The invitation takes push beside SMS: the
-- fill gives each chosen player one row, push when opted in on push with a pushable device, else SMS, never both; the
-- channel CHECK, invitation_candidates (gains the channel), invitation_start_due and invitation_approve are restated.
-- The claim asks each kind's own audience rule for every notice (push_skip_reason restated), and the read door marks an
-- invitation's open once (mark_notifications_read restated). No EXCEPTION block anywhere. Deny by default: every function
-- is closed to PUBLIC in the group that creates it; only invitation_push_hand is newly granted (the system seat checks
-- itself), and the restated doors keep their grants. Migrations 0078 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- The channel CHECK is replaced (ACCESS EXCLUSIVE on a small table) and the streak days gain a by-day index (SHARE).
LOCK TABLE invitation_campaign IN ACCESS EXCLUSIVE MODE;
LOCK TABLE questify_streak_day IN SHARE MODE;

-- The streak scan reads one Questify day's rows in player order (the primary key leads with the player).
CREATE INDEX questify_streak_day_by_day ON questify_streak_day (day, player_id);

-- ================================================================ the kinds (ADR-356 (1))
-- The streak reminder is personal with the `reminders` topic and needs no event; the shop's closing is an event push on
-- `reminders`; the invitation is promotional (consent, not topics) and needs no enrollment (its players have none).
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('streak_reminder', 'personal', 'reminders', 'none', false, 0, interval '6 hours'),
  ('shop_closing', 'event', 'reminders', 'active', false, 1, interval '24 hours'),
  ('invitation', 'promo', NULL, 'none', false, 2, interval '7 days');

-- ================================================================ small rules (internal: no grant)
-- The rewards shop is on for the event unless its own switch (`config.features.shop`) or the platform's
-- (`platform_setting` features.shop.enabled) is false, as the composed configuration reads them (FR-1617's switch).
CREATE FUNCTION shop_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> 'shop' <> 'false'::jsonb, true)
     AND coalesce((SELECT s.value -> 'shop' -> 'enabled' <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION shop_on(event) FROM PUBLIC;

-- Whether a streak reminder may still go: the daily streak switch is on and the player has played on no Questify day
-- since the one its marker names (`streak:{player}:{day}`); a marker in another format never sends.
CREATE FUNCTION push_streak_open(nt notice) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  day_text text := split_part(nt.dedupe, ':', 3);
BEGIN
  IF day_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR NOT daily_streak_on() THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM questify_streak_day d
                     WHERE d.player_id = nt.player_id AND d.day >= to_date(day_text, 'YYYY-MM-DD'));
END $$;
REVOKE ALL ON FUNCTION push_streak_open(notice) FROM PUBLIC;

-- Whether a shop-closing push may still reach a member (ADR-356 (3)): a balance above 0, the shop switched on, the shop
-- open by shop_state (T-410's one definition of closed) and closing exactly when the notice says (`params.date`): a
-- window extended after the notice was written is not pushed, and no second push follows.
CREATE FUNCTION push_shop_open(nt notice, ev event, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF member.balance <= 0 OR NOT shop_on(ev)
     OR shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) <> 'open'
     OR jsonb_typeof(nt.params -> 'date') IS DISTINCT FROM 'string' THEN
    RETURN false;
  END IF;
  RETURN (nt.params ->> 'date')::timestamptz = ev.ends_at + make_interval(days => ev.shop_days_after);
END $$;
REVOKE ALL ON FUNCTION push_shop_open(notice, event, enrollment) FROM PUBLIC;

-- ================================================================ who receives (ADR-356 (2), (3), (4), (7))
-- As 0078, plus the T-501f kinds, and now asked for every notice at the claim (push_skip_reason below): a streak
-- reminder while nothing was played since its day; an invitation while its player has no enrollment in the event (any
-- status: joined meanwhile, it is not pushed); the shop's closing per push_shop_open, for members who may play. Personal
-- kinds of T-501d pass as before (they are checked before the enrollment is required).
CREATE OR REPLACE FUNCTION notice_audience_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev     event;
  target uuid;
BEGIN
  IF nt.id IS NULL THEN
    RETURN false;
  ELSIF nt.kind = 'streak_reminder' THEN
    RETURN push_streak_open(nt);
  ELSIF nt.kind = 'invitation' THEN
    RETURN member.id IS NULL;
  ELSIF nt.kind NOT IN ('flash_quest', 'boost_start', 'poll_sent', 'community_step', 'category_open', 'event_soon',
                        'shop_closing') THEN
    RETURN true;
  ELSIF member.id IS NULL THEN
    RETURN false;
  END IF;
  SELECT e.* INTO ev FROM event e
  WHERE e.id = nt.event_id
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                    WHERE sa.event_id = e.id AND sa.player_id = member.player_id AND NOT sa.can_play);
  IF NOT FOUND THEN
    RETURN false;
  ELSIF nt.kind = 'shop_closing' THEN
    RETURN push_shop_open(nt, ev, member);
  ELSIF nt.kind IN ('flash_quest', 'boost_start', 'category_open') AND NOT push_category_opened(nt) THEN
    RETURN false;
  ELSIF nt.kind IN ('flash_quest', 'category_open') THEN
    RETURN true;
  ELSIF nt.kind = 'poll_sent' THEN
    IF NOT polls_shown(ev) THEN
      RETURN false;
    END IF;
    target := push_ref(nt.refs, 'quest');
    RETURN NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = member.id AND qc.quest_id = target);
  ELSIF nt.kind = 'boost_start' THEN
    IF NOT boosts_on(ev) THEN
      RETURN false;
    END IF;
    target := push_ref(nt.refs, 'boost');
    RETURN EXISTS (SELECT 1 FROM boost b
                   WHERE b.id = target AND b.event_id = ev.id AND b.ends_at > now()
                     AND b.rehearsal = (member.joined_via IS NOT DISTINCT FROM 'rehearsal'));
  ELSIF nt.kind = 'event_soon' THEN
    RETURN nt.dedupe = 'event_soon:' || ev.id || ':' || push_instant(ev.starts_at);
  END IF;
  RETURN community_on(ev);  -- community_step, the last kind left
END $$;
REVOKE ALL ON FUNCTION notice_audience_ok(notice, enrollment) FROM PUBLIC;

-- As 0076, with one change: the kind's own audience rule is asked for every notice, personal and promotional too (a
-- streak reminder after the player played, an invitation after the player joined), not only event notices.
CREATE OR REPLACE FUNCTION push_skip_reason(send bigint) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r record;
BEGIN
  SELECT p.status AS player_status, c.player_id AS recipient, e.status AS event_status, d AS device, k.class,
         k.topic, nt AS note, n AS member
  INTO r
  FROM push_send s
  JOIN notification c ON c.id = s.notification_id
  JOIN notice nt ON nt.id = c.notice_id
  JOIN notice_kind k ON k.kind = nt.kind
  JOIN push_device d ON d.id = s.device_id
  LEFT JOIN player p ON p.id = c.player_id
  LEFT JOIN event e ON e.id = nt.event_id
  LEFT JOIN enrollment n ON n.event_id = nt.event_id AND n.player_id = c.player_id
  WHERE s.id = send;
  RETURN CASE
    WHEN r.player_status IS DISTINCT FROM 'active' THEN 'player'
    WHEN r.event_status = 'archived' THEN 'archived'
    WHEN (r.device).player_id <> r.recipient OR NOT push_pushable(r.device) THEN 'device'
    WHEN r.class = 'promo' AND NOT push_consented(r.recipient) THEN 'consent'
    WHEN push_muted(r.recipient, r.topic) THEN 'muted'
    WHEN NOT notice_membership_ok(r.note, r.member) THEN 'not_member'
    WHEN (r.note).event_id IS NOT NULL AND NOT notice_visible(r.note, r.member) THEN 'not_visible'
    WHEN NOT notice_audience_ok(r.note, r.member) THEN 'not_member'
  END;
END $$;
REVOKE ALL ON FUNCTION push_skip_reason(bigint) FROM PUBLIC;

-- ================================================================ the due scans (ADR-356 (2), (3))
-- The daily streak reminder at `at` (the door passes now(); tests pass a fixed moment): from 18:00 to midnight Riyadh,
-- while the daily streak switch is on, for each active player whose Questify streak is 2 days or more (days yesterday
-- and the day before) with nothing played today, who has a pushable device and has not muted `reminders` (a reminder
-- nobody can be pushed writes no center row). One a day (`streak:{player}:{day}`), until midnight. Names nothing.
CREATE FUNCTION push_due_streak(lim integer, at timestamptz) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH clock AS (
    SELECT questify_day(at) AS today,
           (date_trunc('day', at AT TIME ZONE 'Asia/Riyadh') + interval '1 day') AT TIME ZONE 'Asia/Riyadh' AS midnight
    WHERE extract(hour FROM at AT TIME ZONE 'Asia/Riyadh') >= 18 AND daily_streak_on()),
  due AS (
    SELECT y.player_id, 'streak:' || y.player_id || ':' || to_char(k.today, 'YYYY-MM-DD') AS marker, k.midnight
    FROM clock k
    JOIN questify_streak_day y ON y.day = k.today - 1
    JOIN player p ON p.id = y.player_id AND p.status = 'active'
    WHERE EXISTS (SELECT 1 FROM questify_streak_day b WHERE b.player_id = y.player_id AND b.day = k.today - 2)
      AND NOT EXISTS (SELECT 1 FROM questify_streak_day t WHERE t.player_id = y.player_id AND t.day >= k.today)
      AND EXISTS (SELECT 1 FROM push_live_devices() d WHERE d.player_id = y.player_id)
      AND NOT EXISTS (SELECT 1 FROM push_topic_mute m WHERE m.player_id = y.player_id AND m.topic = 'reminders')
      AND NOT EXISTS (SELECT 1 FROM notice nt
                      WHERE nt.dedupe = 'streak:' || y.player_id || ':' || to_char(k.today, 'YYYY-MM-DD'))
    ORDER BY y.player_id
    LIMIT push_due_streak.lim)
  SELECT count(notice_create('streak_reminder', NULL, NULL, due.player_id, '{}'::jsonb, '{}'::jsonb, due.marker,
                             due.midnight))::integer
  FROM due
$$;
REVOKE ALL ON FUNCTION push_due_streak(integer, timestamptz) FROM PUBLIC;

-- The shop's closing (T-410, ADR-338 (6)): an ended event whose shop is open by shop_state and switched on, closing
-- within 24 hours; once per event (`shop_closing:{event}`), naming the event and the closing date, until the close. A
-- 0-day window is closed at the end, so it never qualifies. Its members are filtered by notice_audience_ok.
CREATE FUNCTION push_due_shop(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT e.id, e.organizer_id, e.name_ar, e.name_en, e.ends_at + make_interval(days => e.shop_days_after) AS closes
    FROM event e
    WHERE event_status_now(e.status, e.starts_at, e.ends_at) = 'ended'
      AND shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after) = 'open'
      AND e.ends_at + make_interval(days => e.shop_days_after) <= now() + interval '24 hours'
      AND shop_on(e)
      AND NOT EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = 'shop_closing:' || e.id)
    ORDER BY e.ends_at, e.id
    LIMIT push_due_shop.lim)
  SELECT count(notice_create('shop_closing', due.organizer_id, due.id, NULL, '{}'::jsonb,
                             jsonb_build_object('event', push_names(due.name_ar, due.name_en), 'date', due.closes),
                             'shop_closing:' || due.id, due.closes))::integer
  FROM due
$$;
REVOKE ALL ON FUNCTION push_due_shop(integer) FROM PUBLIC;

-- As 0078, plus the streak and the shop scans, 500 notices each a call; `more` when any bound was reached.
CREATE OR REPLACE FUNCTION push_due() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_ready    integer;
  n_ending   integer;
  n_flash    integer;
  n_boost    integer;
  n_category integer;
  n_soon     integer;
  n_streak   integer;
  n_shop     integer;
BEGIN
  PERFORM push_system_only();
  n_ready := push_due_ready(500);
  n_ending := push_due_ending(500);
  n_flash := push_due_flash(500);
  n_boost := push_due_boost(500);
  n_category := push_due_category(500);
  n_soon := push_due_event_soon(500);
  n_streak := push_due_streak(500, now());
  n_shop := push_due_shop(500);
  RETURN jsonb_build_object('ready', n_ready, 'ending', n_ending, 'flash', n_flash, 'boost', n_boost,
                            'category', n_category, 'soon', n_soon, 'streak', n_streak, 'shop', n_shop,
                            'more', greatest(n_ready, n_ending, n_flash, n_boost, n_category, n_soon, n_streak,
                                             n_shop) >= 500);
END $$;
REVOKE ALL ON FUNCTION push_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_due() TO questify_app;

-- ================================================================ invitations by push (ADR-356 (4))
ALTER TABLE invitation_campaign DROP CONSTRAINT invitation_campaign_channels_check,
  ADD CONSTRAINT invitation_campaign_channels_check
    CHECK (cardinality(channels) >= 1 AND channels <@ ARRAY['push', 'sms']);

-- As 0073, with each player's channel: push when the campaign has push (before approval, both channels count) and the
-- player is in promo_pool on push with a pushable device; else SMS when the campaign has SMS and the player is in
-- promo_pool on SMS. The two sets never overlap (an SMS candidate opted in on push with a pushable device is a push one),
-- so a player is one row with one channel. Plain SQL, no SET clause, tables schema-qualified (inlined by its callers).
DROP FUNCTION invitation_candidates(uuid);
CREATE FUNCTION invitation_candidates(target uuid) RETURNS TABLE (player_id uuid, draw text, channel text)
  LANGUAGE sql STABLE AS $$
  SELECT p.player_id, md5(c.id::text || p.player_id::text), p.channel
  FROM public.invitation_campaign c
  CROSS JOIN LATERAL (
    SELECT x.player_id, 'push'::text AS channel
    FROM public.promo_pool('push', c.city_id, c.interests) x
    WHERE 'push' = ANY (coalesce(c.channels, ARRAY['push', 'sms']))
      AND EXISTS (SELECT 1 FROM public.push_live_devices() d WHERE d.player_id = x.player_id)
    UNION ALL
    SELECT x.player_id, 'sms'::text
    FROM public.promo_pool('sms', c.city_id, c.interests) x
    WHERE 'sms' = ANY (coalesce(c.channels, ARRAY['push', 'sms']))
      AND NOT ('push' = ANY (coalesce(c.channels, ARRAY['push', 'sms']))
               AND EXISTS (SELECT 1 FROM public.marketing_state s
                           WHERE s.player_id = x.player_id AND s.channel = 'push' AND s.opted_in)
               AND EXISTS (SELECT 1 FROM public.push_live_devices() d WHERE d.player_id = x.player_id))) p
  WHERE c.id = target
    AND (c.history = 'none'
         OR (c.history = 'recent' AND EXISTS (
               SELECT 1 FROM public.enrollment n
               WHERE n.player_id = p.player_id AND n.status NOT IN ('pending', 'declined')
                 AND n.joined_via IS DISTINCT FROM 'rehearsal' AND n.joined_at >= now() - interval '365 days'))
         OR (c.history = 'own' AND EXISTS (
               SELECT 1 FROM public.enrollment n
               WHERE n.player_id = p.player_id AND n.organizer_id = c.organizer_id AND n.event_id <> c.event_id
                 AND n.status NOT IN ('pending', 'declined') AND n.joined_via IS DISTINCT FROM 'rehearsal')))
    AND NOT EXISTS (SELECT 1 FROM public.enrollment n WHERE n.event_id = c.event_id AND n.player_id = p.player_id)
    AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r JOIN public.invitation_campaign o ON o.id = r.campaign_id
                    WHERE r.player_id = p.player_id AND o.event_id = c.event_id
                      AND r.state IN ('queued', 'sending', 'sent', 'unknown'))
    AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r
                    WHERE r.player_id = p.player_id
                      AND (r.state IN ('queued', 'sending')
                           OR (r.state IN ('sent', 'unknown') AND r.sent_at > now() - interval '7 days')))
$$;
REVOKE ALL ON FUNCTION invitation_candidates(uuid) FROM PUBLIC;

-- As 0073, with channels {push, sms} (IV422 `channels` otherwise). The API offers only the channels the server can send
-- and moves the send time out of quiet hours when SMS is among them (push has none, Q-287).
CREATE OR REPLACE FUNCTION invitation_approve(campaign uuid, chans text[], new_cap integer, at timestamptz, note text,
                                              expected_ar text, expected_en text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  c     invitation_campaign;
  ev    event;
  why   text;
BEGIN
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such campaign' USING ERRCODE = 'IV404';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = c.event_id FOR SHARE;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = campaign FOR UPDATE;
  IF c.state <> 'requested' THEN
    RAISE EXCEPTION 'only a requested campaign can be approved' USING ERRCODE = 'IV409', DETAIL = 'wrong_state';
  END IF;
  why := invitation_event_ok(ev, false);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'this event cannot take an invitation'
      USING ERRCODE = 'IV422', DETAIL = 'event_not_eligible', HINT = why;
  END IF;
  IF expected_ar IS DISTINCT FROM ev.name_ar OR expected_en IS DISTINCT FROM ev.name_en THEN
    RAISE EXCEPTION 'the event was renamed since the console read it' USING ERRCODE = 'IV409', DETAIL = 'event_renamed';
  END IF;
  IF nullif(btrim(ev.name_ar), '') IS NULL AND nullif(btrim(ev.name_en), '') IS NULL THEN
    RAISE EXCEPTION 'the event has no name to send' USING ERRCODE = 'IV422', DETAIL = 'name';
  END IF;
  IF chans IS NULL OR cardinality(chans) = 0 OR array_position(chans, NULL) IS NOT NULL
     OR NOT chans <@ ARRAY['push', 'sms'] THEN
    RAISE EXCEPTION 'channels are push or sms' USING ERRCODE = 'IV422', DETAIL = 'channels';
  END IF;
  IF new_cap IS NULL OR new_cap NOT BETWEEN 50 AND 100000 THEN
    RAISE EXCEPTION 'a cap is 50 to 100000' USING ERRCODE = 'IV422', DETAIL = 'cap';
  END IF;
  IF at IS NULL OR at < now() - interval '1 minute' OR at > ev.ends_at - interval '1 hour' THEN
    RAISE EXCEPTION 'the send time is from now to an hour before the event ends' USING ERRCODE = 'IV422', DETAIL = 'sendAt';
  END IF;
  IF note IS NOT NULL AND char_length(btrim(note)) > 500 THEN
    RAISE EXCEPTION 'a note is at most 500 characters' USING ERRCODE = 'IV422', DETAIL = 'note';
  END IF;
  UPDATE invitation_campaign x
  SET state = 'approved', channels = ARRAY(SELECT DISTINCT unnest(chans) ORDER BY 1), cap = new_cap, send_at = at,
      admin_note = nullif(btrim(note), ''), name_ar = nullif(btrim(ev.name_ar), ''),
      name_en = nullif(btrim(ev.name_en), ''), decided_by = admin, decided_at = now()
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'admin', 'invitation.approve', request);
  RETURN invitation_admin_json(c);
END $$;
REVOKE ALL ON FUNCTION invitation_approve(uuid, text[], integer, timestamptz, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_approve(uuid, text[], integer, timestamptz, text, text, text, uuid) TO questify_app;

-- As 0073, with one change: each row takes its player's channel from invitation_candidates (push or SMS, never both).
CREATE OR REPLACE FUNCTION invitation_start_due() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp SET work_mem = '64MB' AS $$
DECLARE
  c   invitation_campaign;
  ev  event;
  n   integer := 0;
  why text;
BEGIN
  PERFORM invitation_system_only();
  IF NOT invitation_on() THEN
    RETURN 'off';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('invitation_fill')) THEN
    RETURN 'busy';
  END IF;
  SELECT x.* INTO c FROM invitation_campaign x
  WHERE x.state = 'approved' AND x.send_at <= now() ORDER BY x.send_at, x.id LIMIT 1;
  IF NOT FOUND THEN
    RETURN 'idle';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = c.event_id FOR SHARE;
  SELECT * INTO c FROM invitation_campaign x WHERE x.id = c.id FOR UPDATE;
  IF c.state <> 'approved' THEN
    RETURN 'idle';
  END IF;
  why := CASE WHEN ev.ends_at <= now() THEN 'event_over'
              WHEN invitation_event_ok(ev, true) IS NOT NULL THEN 'event_changed' END;
  IF why IS NULL THEN
    INSERT INTO invitation_recipient (campaign_id, player_id, channel)
    SELECT c.id, k.player_id, k.channel FROM invitation_candidates(c.id) k ORDER BY k.draw LIMIT c.cap;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n < 50 THEN
      DELETE FROM invitation_recipient q WHERE q.campaign_id = c.id;
      why := 'too_small';
    END IF;
  END IF;
  IF why IS NOT NULL THEN
    UPDATE invitation_campaign x
    SET state = 'cancelled', end_reason = why, finished_at = now(), final_at = now()
    WHERE x.id = c.id RETURNING x.* INTO c;
    PERFORM invitation_audit(c, 'system', 'invitation.end', NULL);
    RETURN why;
  END IF;
  UPDATE invitation_campaign x SET state = 'sending', planned = n, started_at = now()
  WHERE x.id = c.id RETURNING x.* INTO c;
  PERFORM invitation_audit(c, 'system', 'invitation.start', NULL);
  RETURN 'started';
END $$;
REVOKE ALL ON FUNCTION invitation_start_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_start_due() TO questify_app;

-- Up to `lim` queued push rows of the running campaigns (locked by the caller), oldest campaign first, FOR UPDATE SKIP
-- LOCKED, each checked again: consent on push now (promo_pool, `opted_out`) and no enrollment in the event (`member`).
-- Each other row gets one notice through notice_create (the campaign's frozen names and the event's public join code,
-- until the event's end; marker `invitation:{row}`) and becomes `sent` with sent_at now: handed to the push store, which
-- checks consent again at the fan-out and the claim. A row whose notice could not be written (a broken kind) becomes
-- `failed` (`no_kind`) and the door commits. Answers the rows read.
CREATE FUNCTION invitation_push_rows(running uuid[], lim integer) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r      record;
  made   bigint;
  sent   bigint[] := '{}';
  failed bigint[] := '{}';
  seen   integer := 0;
BEGIN
  FOR r IN
    SELECT q.id AS row_id, q.campaign_id AS camp, q.player_id AS who, x.organizer_id AS org, x.event_id AS ev,
           x.name_ar AS nar, x.name_en AS nen, e.ends_at AS ends, e.join_code AS code
    FROM invitation_recipient q
    JOIN invitation_campaign x ON x.id = q.campaign_id
    JOIN event e ON e.id = x.event_id
    WHERE q.campaign_id = ANY (running) AND q.state = 'queued' AND q.channel = 'push'
    ORDER BY x.started_at, x.id, q.id
    LIMIT lim
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    seen := seen + 1;
    IF NOT EXISTS (SELECT 1 FROM promo_pool('push', NULL, NULL) p WHERE p.player_id = r.who) THEN
      PERFORM invitation_skip_row(r.row_id, r.camp, 'opted_out');
    ELSIF EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = r.ev AND n.player_id = r.who) THEN
      PERFORM invitation_skip_row(r.row_id, r.camp, 'member');
    ELSE
      made := notice_create('invitation', r.org, r.ev, r.who, jsonb_build_object('recipient', r.row_id),
                            jsonb_build_object('event', push_names(r.nar, r.nen), 'code', r.code),
                            'invitation:' || r.row_id, r.ends);
      IF made IS NULL THEN
        failed := failed || r.row_id;
      ELSE
        sent := sent || r.row_id;
      END IF;
    END IF;
  END LOOP;
  UPDATE invitation_recipient q SET state = 'sent', sent_at = now() WHERE q.id = ANY (sent);
  UPDATE invitation_recipient q SET state = 'failed', error_code = 'no_kind' WHERE q.id = ANY (failed);
  UPDATE invitation_campaign c SET sent = c.sent + m.n_sent, failed = c.failed + m.n_failed
  FROM (SELECT q.campaign_id, count(*) FILTER (WHERE q.id = ANY (sent))::integer AS n_sent,
               count(*) FILTER (WHERE q.id = ANY (failed))::integer AS n_failed
        FROM invitation_recipient q WHERE q.id = ANY (sent || failed) GROUP BY q.campaign_id) m
  WHERE c.id = m.campaign_id;
  RETURN seen;
END $$;
REVOKE ALL ON FUNCTION invitation_push_rows(uuid[], integer) FROM PUBLIC;

-- The hand-off door (system context only; ADR-356 (4)): with the switch on, the claim's campaign locks (every sending
-- campaign and every one with an expired lease, FOR NO KEY UPDATE in id order) and its skips of campaigns whose event is
-- over or changed, then up to 500 push rows. No quiet hours (Q-287: SMS only). `{rows, more}`.
CREATE FUNCTION invitation_push_hand() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  camps   uuid[];
  running uuid[];
  seen    integer := 0;
BEGIN
  PERFORM invitation_system_only();
  IF NOT invitation_on() THEN
    RETURN jsonb_build_object('rows', 0, 'more', false);
  END IF;
  camps := invitation_claim_lock();
  running := invitation_claim_campaigns(camps);
  IF cardinality(running) > 0 THEN
    seen := invitation_push_rows(running, 500);
  END IF;
  RETURN jsonb_build_object('rows', seen, 'more', seen >= 500);
END $$;
REVOKE ALL ON FUNCTION invitation_push_hand() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION invitation_push_hand() TO questify_app;

-- ================================================================ the invitation's open (ADR-356 (5))
-- The caller's unread invitation rows among `ids`: each one's recipient row (the caller's own) is marked opened once
-- and its campaign counts it, while the event runs and the results are open, like the landing page's open. Lock order
-- as the open's: the row's campaign id read unlocked, the campaign FOR NO KEY UPDATE, then the recipient row; the center
-- rows are updated after (erasure deletes recipient rows before center rows too).
CREATE FUNCTION invitation_push_opened(who uuid, ids bigint[]) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  target bigint;
  camp   uuid;
BEGIN
  FOR target IN
    SELECT DISTINCT (nt.refs ->> 'recipient')::bigint
    FROM notification c JOIN notice nt ON nt.id = c.notice_id
    WHERE c.player_id = who AND c.id = ANY (ids) AND c.read_at IS NULL AND nt.kind = 'invitation'
      AND nt.refs ->> 'recipient' ~ '^[0-9]{1,18}$'
    ORDER BY 1
  LOOP
    SELECT q.campaign_id INTO camp FROM invitation_recipient q WHERE q.id = target AND q.player_id = who;
    CONTINUE WHEN camp IS NULL;
    PERFORM 1 FROM invitation_campaign x JOIN event e ON e.id = x.event_id
    WHERE x.id = camp AND x.final_at IS NULL AND e.ends_at > now()
    FOR NO KEY UPDATE OF x;
    CONTINUE WHEN NOT FOUND;
    UPDATE invitation_recipient q SET opened_at = now()
    WHERE q.id = target AND q.opened_at IS NULL AND q.state IN ('sending', 'sent', 'unknown');
    IF FOUND THEN
      UPDATE invitation_campaign x SET opened = x.opened + 1 WHERE x.id = camp;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION invitation_push_opened(uuid, bigint[]) FROM PUBLIC;

-- As 0076, plus the invitation's open for the rows named (a tap on the push or on the row); "all" counts no open.
CREATE OR REPLACE FUNCTION mark_notifications_read(ids bigint[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  IF ids IS NOT NULL AND coalesce(cardinality(ids), 0) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'name 1 to 100 notifications, or none for all' USING ERRCODE = 'PN422', DETAIL = 'ids';
  END IF;
  IF ids IS NOT NULL THEN
    PERFORM invitation_push_opened(who, ids);
  END IF;
  UPDATE notification c SET read_at = now()
  WHERE c.player_id = who AND c.read_at IS NULL AND (ids IS NULL OR c.id = ANY (ids));
  RETURN own_unread_notifications();
END $$;
REVOKE ALL ON FUNCTION mark_notifications_read(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_notifications_read(bigint[]) TO questify_app;
