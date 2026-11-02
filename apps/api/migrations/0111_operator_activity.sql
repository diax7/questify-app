-- Operator activity and the staff briefing (T-617, FR-1844, ADR-402): what each operator of an event did today and last,
-- and a short push that reaches the event's operators and nobody else. Nothing about points, sign-in or tenant isolation
-- changes: the activity is one read over rows other doors already write (the ledger's operator entries, submission
-- reviews, help-desk answers), and the briefing is one personal notice per current operator through notice_create (kind
-- `staff_briefing`), so the fan-out, the center, the claim and the worker are T-501's and are not touched except for one
-- membership rule. Deny by default: the new table keeps row-level security forced and no grant; every function is closed
-- to PUBLIC in the group that creates it and only the two doors are granted to the API role. No EXCEPTION block.
SET LOCAL lock_timeout = '10s';
-- The event is a foreign-key target of the new table; ledger_entry, submission and ticket gain an index (read only
-- otherwise).
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the indexes (ADR-402 (2))
-- An operator's entries in one event, newest first: the last action, today's counts and the recent list are each a seek
-- per operator and a range on time, however many entries the event's players and the operator's other events hold.
-- `ledger_entry_operator_idx` (0026) leads with the operator and has no event. The index carries the two columns the
-- counts group by, so a count never visits the table's rows (an index-only scan once the page is vacuumed: 90 ms against
-- 380 ms for 270,000 entries). Partial: only entries an operator wrote.
CREATE INDEX ledger_entry_operator_event_idx ON ledger_entry (event_id, operator_id, created_at DESC)
  INCLUDE (kind, quest_id) WHERE operator_id IS NOT NULL;
-- The same for the other two things an operator does: the submissions they reviewed and the help requests they answered.
-- Partial on the rows an operator handled; 0040's and 0059's operator keys lead with the same two columns but carry
-- the key, not the time.
CREATE INDEX submission_operator_reviewed_idx ON submission (event_id, reviewed_by_operator, reviewed_at DESC)
  WHERE reviewed_by_operator IS NOT NULL;
CREATE INDEX ticket_operator_answered_idx ON ticket (event_id, answered_by_operator, closed_at DESC)
  WHERE answered_by_operator IS NOT NULL;

-- ================================================================ the kind (ADR-402 (3))
-- Personal (priority 0), no topic (a work instruction cannot be muted), six hours like a shift's briefing. The new
-- membership value `staff` means the recipient holds a staff assignment of the notice's event, so the rule lives in the
-- kind's row and is asked at the fan-out and again at the claim, as every membership rule is.
ALTER TABLE notice_kind DROP CONSTRAINT notice_kind_membership_check;
ALTER TABLE notice_kind ADD CONSTRAINT notice_kind_membership_check
  CHECK (membership IN ('active', 'decided', 'none', 'staff'));
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('staff_briefing', 'personal', NULL, 'staff', false, 0, interval '6 hours');

-- As 0076, plus `staff`: only a current operator of the event is a recipient, whatever their enrollment, so an operator
-- removed after the briefing was written (or between the fan-out and the claim) gets no push and no center row.
CREATE OR REPLACE FUNCTION notice_membership_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  k  notice_kind;
  ev event;
BEGIN
  IF nt.event_id IS NULL THEN
    RETURN true;
  END IF;
  SELECT x.* INTO k FROM notice_kind x WHERE x.kind = nt.kind;
  IF NOT FOUND THEN
    RETURN false;
  ELSIF k.membership = 'none' THEN
    RETURN true;
  ELSIF k.membership = 'staff' THEN
    RETURN EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = nt.event_id AND sa.player_id = nt.player_id);
  ELSIF member.id IS NULL OR member.event_id <> nt.event_id THEN
    RETURN false;
  ELSIF k.membership = 'decided' THEN
    RETURN member.status IN ('active', 'declined');
  ELSIF member.status <> 'active' OR excluded_from_event(member.event_id, member.player_id) THEN
    RETURN false;
  ELSIF k.class <> 'event' THEN
    RETURN true;
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = nt.event_id;
  RETURN notice_status_ok(k, event_status_now(ev.status, ev.starts_at, ev.ends_at), member);
END $$;
REVOKE ALL ON FUNCTION notice_membership_ok(notice, enrollment) FROM PUBLIC;

-- ================================================================ the briefings (ADR-402 (4))
-- One row per briefing sent: the text as sent (a title and a text of up to 140 characters in each language, so the push
-- and the center carry it whole), the Idempotency-Key hash (unique per event) and how many operators were told. The
-- notices are T-501's; this row is the replay, the rate limit and the dashboard's short history.
CREATE TABLE staff_briefing (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  title_ar     text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 60 AND title_ar !~ '[[:cntrl:]]'),
  title_en     text NOT NULL CHECK (char_length(title_en) BETWEEN 1 AND 60 AND title_en !~ '[[:cntrl:]]'),
  body_ar      text NOT NULL CHECK (char_length(body_ar) BETWEEN 1 AND 140 AND body_ar !~ '[[:cntrl:]]'),
  body_en      text NOT NULL CHECK (char_length(body_en) BETWEEN 1 AND 140 AND body_en !~ '[[:cntrl:]]'),
  press        text NOT NULL CHECK (press ~ '^[0-9a-f]{64}$'),
  recipients   integer NOT NULL CHECK (recipients >= 1),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, press),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX staff_briefing_event ON staff_briefing (event_id, created_at DESC, id DESC);
ALTER TABLE staff_briefing ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_briefing FORCE ROW LEVEL SECURITY;
REVOKE ALL ON staff_briefing FROM PUBLIC, questify_app;

-- Sends a briefing to every operator of the event (FR-1844): one personal notice each, written through notice_create
-- (kind `staff_briefing`), so only a current operator with an active account is told, at the fan-out and again at the
-- claim. `draft` holds titleAr, titleEn, bodyAr and bodyEn, already cleaned and checked by the API (the announcement
-- rules, with a text of 140 characters at most); the same Idempotency-Key answers the first result with `replayed`. A
-- briefing may go before the event starts (the doors open at nine) and until it ends. At most 3 an hour and 10 a day for
-- the event (PL429 detail `hour` or `day`); PA422 a field of the draft; PE409 `event_closed` for an ended or archived
-- event; PT409 `nobody` when the event has no operator who can receive it; AN404 for an event outside the caller's
-- organizer or event limit; PK400 a missing key. Audited `staff.briefing` with the count only, never the text.
CREATE FUNCTION staff_briefing_send(target_event uuid, draft jsonb, press text, request uuid)
  RETURNS TABLE (id uuid, recipients integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  key     text;
  earlier staff_briefing;
  fields  text[];
  fresh   uuid := gen_random_uuid();
  sent    integer;
BEGIN
  IF press IS NULL OR char_length(press) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an Idempotency-Key of 1 to 255 characters is required' USING ERRCODE = 'PK400';
  END IF;
  key := encode(sha256(convert_to(press, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('staff_briefing:' || ev.id, 0));
  PERFORM 1 FROM event e WHERE e.id = target_event FOR SHARE;
  ev := award_event_of(target_event);
  SELECT b.* INTO earlier FROM staff_briefing b WHERE b.event_id = ev.id AND b.press = key;
  IF FOUND THEN
    RETURN QUERY SELECT earlier.id, earlier.recipients, true;
    RETURN;
  END IF;
  fields := ARRAY[announcement_field(draft, 'titleAr', 60), announcement_field(draft, 'titleEn', 60),
                  announcement_field(draft, 'bodyAr', 140), announcement_field(draft, 'bodyEn', 140)];
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF (SELECT count(*) FROM staff_briefing b
         WHERE b.event_id = ev.id AND b.created_at > now() - interval '1 hour') >= 3 THEN
    RAISE EXCEPTION 'too many briefings in an hour' USING ERRCODE = 'PL429', DETAIL = 'hour';
  ELSIF (SELECT count(*) FROM staff_briefing b
         WHERE b.event_id = ev.id AND b.created_at > now() - interval '1 day') >= 10 THEN
    RAISE EXCEPTION 'too many briefings in a day' USING ERRCODE = 'PL429', DETAIL = 'day';
  END IF;
  SELECT count(notice_create('staff_briefing', ev.organizer_id, ev.id, sa.player_id,
                             jsonb_build_object('briefing', fresh),
                             announcement_params(ev, fields[1], fields[2], fields[3], fields[4]),
                             'staff_briefing:' || fresh || ':' || sa.player_id, NULL))::integer
  INTO sent
  FROM staff_assignment sa JOIN player p ON p.id = sa.player_id AND p.status = 'active'
  WHERE sa.event_id = ev.id;
  IF sent = 0 THEN
    RAISE EXCEPTION 'no operator can receive it' USING ERRCODE = 'PT409', DETAIL = 'nobody';
  END IF;
  INSERT INTO staff_briefing (id, organizer_id, event_id, title_ar, title_en, body_ar, body_en, press, recipients,
                              created_by)
  VALUES (fresh, ev.organizer_id, ev.id, fields[1], fields[2], fields[3], fields[4], key, sent, app_staff_user_id());
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'staff.briefing', 'staff_briefing', fresh::text,
          jsonb_build_object('recipients', sent), request);
  RETURN QUERY SELECT fresh, sent, false;
END $$;
REVOKE ALL ON FUNCTION staff_briefing_send(uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_briefing_send(uuid, jsonb, text, uuid) TO questify_app;

-- ================================================================ the activity (ADR-402 (1), (5))
-- What an operator did, as one word: a quest scan, a session check-in (both a scan of the player's code), a manual
-- award, a prize hand-over or the operator's cancel of a reservation. Reading the operator's ledger rows by kind keeps
-- the rule in one place; the ledger allows no other kind with an operator (0093's operator_quests_only).
CREATE FUNCTION operator_action_of(entry_kind text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE entry_kind WHEN 'quest' THEN 'scan' WHEN 'session' THEN 'check_in' WHEN 'award' THEN 'award'
                         WHEN 'handover' THEN 'hand_over' WHEN 'redeem_return' THEN 'cancel' END
$$;
REVOKE ALL ON FUNCTION operator_action_of(text) FROM PUBLIC;

-- The event's operators, one object each, the most recently active first: today's counts (scans in the last hour and
-- since the event's day began, awards, hand-overs, submissions reviewed and help requests answered), the last thing they
-- did, and the five stations they scanned most today. One seek and range per operator on the new index, one look at
-- the operator's own reviews and answers (0040's and 0059's operator keys lead with the event and the operator).
-- Usernames and counts only; no player they served.
CREATE FUNCTION operator_activity_rows(ev event, day_start timestamptz, hour_start timestamptz) RETURNS jsonb
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
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE s.reviewed_at >= day_start) AS today, max(s.reviewed_at) AS last_at
                        FROM submission s
                        WHERE s.event_id = ev.id AND s.reviewed_by_operator = o.player_id) r),
  answers AS (
    SELECT o.player_id AS op, a.today, a.last_at
    FROM ops o
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE t.closed_at >= day_start) AS today, max(t.closed_at) AS last_at
                        FROM ticket t
                        WHERE t.event_id = ev.id AND t.answered_by_operator = o.player_id) a),
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

-- The latest `lim` actions of the event's operators, newest first: each operator's own newest ledger entries,
-- submissions reviewed and help requests answered (at most `lim` of each, so the merge is bounded by the operators and
-- the page size however busy the event is), cut to the newest `lim` overall. The station's title comes with a scan.
CREATE FUNCTION operator_activity_recent(ev event, lim integer) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'at', r.at, 'action', r.action, 'operatorId', r.id, 'username', r.username, 'questId', r.quest_id,
           'titleAr', q.title_ar, 'titleEn', q.title_en) ORDER BY r.at DESC, r.id), '[]'::jsonb)
  FROM (
    SELECT u.at, u.action, u.id, u.username, u.quest_id
    FROM (
      SELECT o.id, p.username, e.at, operator_action_of(e.kind) AS action,
             CASE WHEN e.kind = 'quest' THEN e.quest_id END AS quest_id
      FROM staff_assignment o JOIN player p ON p.id = o.player_id
      CROSS JOIN LATERAL (SELECT l.kind, l.quest_id, l.created_at AS at FROM ledger_entry l
                          WHERE l.event_id = ev.id AND l.operator_id = o.player_id
                          ORDER BY l.created_at DESC LIMIT lim) e
      WHERE o.event_id = ev.id
      UNION ALL
      SELECT o.id, p.username, s.at, 'review', NULL::uuid
      FROM staff_assignment o JOIN player p ON p.id = o.player_id
      CROSS JOIN LATERAL (SELECT x.reviewed_at AS at FROM submission x
                          WHERE x.event_id = ev.id AND x.reviewed_by_operator = o.player_id
                          ORDER BY x.reviewed_at DESC LIMIT lim) s
      WHERE o.event_id = ev.id
      UNION ALL
      SELECT o.id, p.username, a.at, 'answer', NULL::uuid
      FROM staff_assignment o JOIN player p ON p.id = o.player_id
      CROSS JOIN LATERAL (SELECT x.closed_at AS at FROM ticket x
                          WHERE x.event_id = ev.id AND x.answered_by_operator = o.player_id
                          ORDER BY x.closed_at DESC LIMIT lim) a
      WHERE o.event_id = ev.id) u
    ORDER BY u.at DESC, u.id LIMIT lim) r
  LEFT JOIN quest q ON q.id = r.quest_id
$$;
REVOKE ALL ON FUNCTION operator_activity_recent(event, integer) FROM PUBLIC;

-- The operators page's read for the event's team (an owner or an editor within their event limit, AN404 for anyone
-- else): the operators with their numbers, the latest `recent_limit` actions (1 to 50, default 5) and the last five
-- briefings with how many operators each reached. The event's day is the one the station counts use (its time zone and
-- day-start hour). Usernames, counts and the organizer's own briefing text; no player the operators served, no
-- contact detail. Read only.
CREATE FUNCTION operator_activity(target_event uuid, recent_limit integer DEFAULT 5) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  day_start timestamptz := event_day_start(ev, event_day(now(), ev));
BEGIN
  RETURN jsonb_build_object(
    'asOf', now(),
    'operators', operator_activity_rows(ev, day_start, now() - interval '1 hour'),
    'recent', operator_activity_recent(ev, least(greatest(coalesce(recent_limit, 5), 1), 50)),
    'briefings', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'titleAr', x.title_ar, 'titleEn', x.title_en, 'bodyAr', x.body_ar,
                                          'bodyEn', x.body_en, 'recipients', x.recipients, 'sentAt', x.created_at)
                       ORDER BY x.created_at DESC, x.id DESC)
      FROM (SELECT b.* FROM staff_briefing b WHERE b.event_id = ev.id
            ORDER BY b.created_at DESC, b.id DESC LIMIT 5) x), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION operator_activity(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_activity(uuid, integer) TO questify_app;
