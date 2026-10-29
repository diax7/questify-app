-- T-502: organizer announcements (FR-1107, FR-1108, FR-806, FR-807; plan docs/plans/2026-10-28-t-502-announcements.md on
-- the T-501 plan's "Owed pushes" row 18; ADR-358). An owner or editor writes an announcement in Arabic and English and
-- sends it now or at a set time. Sending writes ONE notice through notice_create (kind `announcement`, topic
-- `announcements`); the fan-out, the center rows, the mutes, the claim's re-checks and the route are T-501's and are not
-- touched. The text is organizer free text going to up to 50,000 phones, so the API cleans it and runs the T-409 name rule
-- before calling a door (the rule lives in JavaScript, as T-409's does); the doors bound it again, freeze it, and
-- limit the event to 3 announcements an hour and 10 a day, counted over any rolling hour and day on their send time.
-- Announcements never go by email or SMS: nothing here reads a contact, a consent or the invitation tables. Deny by
-- default: the new table keeps row-level security forced and no grant; every function is closed to PUBLIC in the group
-- that creates it and only the five doors are granted to the API role. No EXCEPTION block. Migrations 0080 and earlier
-- untouched; push_due() is restated (0079's body plus one scan).
SET LOCAL lock_timeout = '10s';
-- The event is a foreign-key target of the new table.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the kind (ADR-358 (1))
-- Event class (priority 1), topic announcements (mutable: a muted topic keeps the center row and loses the push), 2 hours
-- like an opening. Not a `before_start` kind: it reaches the real members of a live event and, before the start, only
-- the rehearsal accounts (notice_status_ok, 0078). It names no quest, category or reward, so notice_visible passes it,
-- and notice_audience_ok (0080) lets every kind it does not list through, an operator kept from playing included.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('announcement', 'event', 'announcements', 'active', false, 1, interval '2 hours');

-- ================================================================ the table (ADR-358 (2))
-- One row per announcement. The text is frozen at creation (announcement_frozen); only the state moves: `scheduled` to
-- `sent`, `cancelled` or `skipped`, once. `push_body_*` are the cut texts the push and the center carry (the API cuts
-- them, the shared package is the one implementation); `press` is the sha256 of the request's Idempotency-Key, unique per
-- event; `rehearsal` marks a send made before the start, which only rehearsal accounts received. `notice_id` has no
-- foreign key: the notice is purged 180 days after its last center row and the dashboard then shows no count.
CREATE TABLE announcement (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  title_ar     text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 60 AND title_ar !~ '[[:cntrl:]]'),
  title_en     text NOT NULL CHECK (char_length(title_en) BETWEEN 1 AND 60 AND title_en !~ '[[:cntrl:]]'),
  body_ar      text NOT NULL CHECK (char_length(body_ar) BETWEEN 1 AND 500 AND body_ar !~ '[[:cntrl:]]'),
  body_en      text NOT NULL CHECK (char_length(body_en) BETWEEN 1 AND 500 AND body_en !~ '[[:cntrl:]]'),
  push_body_ar text NOT NULL CHECK (char_length(push_body_ar) BETWEEN 1 AND 140 AND push_body_ar !~ '[[:cntrl:]]'),
  push_body_en text NOT NULL CHECK (char_length(push_body_en) BETWEEN 1 AND 140 AND push_body_en !~ '[[:cntrl:]]'),
  status       text NOT NULL CHECK (status IN ('scheduled', 'sent', 'cancelled', 'skipped')),
  send_at      timestamptz NOT NULL,
  press        text NOT NULL CHECK (press ~ '^[0-9a-f]{64}$'),
  rehearsal    boolean NOT NULL DEFAULT false,
  notice_id    bigint,
  skip_reason  text CHECK (skip_reason IN ('event_closed', 'not_live', 'late')),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  cancelled_at timestamptz,
  UNIQUE (event_id, press),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CONSTRAINT announcement_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL AND notice_id IS NOT NULL)),
  CONSTRAINT announcement_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT announcement_skipped CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CONSTRAINT announcement_rehearsal CHECK (NOT rehearsal OR status = 'sent')
);
-- The dashboard's list (newest send time first) and the due scan (scheduled rows by their time).
CREATE INDEX announcement_event ON announcement (event_id, send_at DESC, id DESC);
CREATE INDEX announcement_due ON announcement (send_at, id) WHERE status = 'scheduled';
ALTER TABLE announcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement FORCE ROW LEVEL SECURITY;
REVOKE ALL ON announcement FROM PUBLIC, questify_app;

-- The text, the event, the key and the author never change, and a finished announcement never changes state again, not
-- even for the table's owner: "the text is frozen at send" is a database fact (ADR-358 (2)).
CREATE FUNCTION announcement_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.organizer_id, NEW.event_id, NEW.title_ar, NEW.title_en, NEW.body_ar, NEW.body_en, NEW.push_body_ar,
      NEW.push_body_en, NEW.send_at, NEW.press, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organizer_id, OLD.event_id, OLD.title_ar, OLD.title_en, OLD.body_ar, OLD.body_en,
                       OLD.push_body_ar, OLD.push_body_en, OLD.send_at, OLD.press, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'an announcement''s text and time are frozen' USING ERRCODE = 'PA409', DETAIL = 'frozen';
  ELSIF OLD.status <> 'scheduled' THEN
    RAISE EXCEPTION 'a finished announcement does not change' USING ERRCODE = 'PA409', DETAIL = 'finished';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION announcement_frozen() FROM PUBLIC;
CREATE TRIGGER announcement_frozen BEFORE UPDATE ON announcement
  FOR EACH ROW EXECUTE FUNCTION announcement_frozen();

-- ================================================================ helpers (internal: no grant)
-- Where an event stands for an announcement: `live` (a live event, real members), `rehearsal` (a draft or scheduled event
-- with an open rehearsal: its rehearsal accounts), `idle` (a draft or scheduled event with no rehearsal: no one to tell),
-- `closed` (ended or archived: nothing new goes out). Reads only.
CREATE FUNCTION announcement_phase(ev event) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  phase text := event_status_now(ev.status, ev.starts_at, ev.ends_at);
BEGIN
  IF phase = 'live' THEN
    RETURN 'live';
  ELSIF phase NOT IN ('draft', 'scheduled') THEN
    RETURN 'closed';
  ELSIF EXISTS (SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL) THEN
    RETURN 'rehearsal';
  END IF;
  RETURN 'idle';
END $$;
REVOKE ALL ON FUNCTION announcement_phase(event) FROM PUBLIC;

-- The notice's params: the event's name (the push's fallback title) and the frozen title and cut text, each {ar, en}.
CREATE FUNCTION announcement_params(ev event, title_ar text, title_en text, push_ar text, push_en text) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('event', push_names(ev.name_ar, ev.name_en),
                            'title', jsonb_build_object('ar', title_ar, 'en', title_en),
                            'body', jsonb_build_object('ar', push_ar, 'en', push_en))
$$;
REVOKE ALL ON FUNCTION announcement_params(event, text, text, text, text) FROM PUBLIC;

-- Whether one more announcement at `at` would put more than `cap` of the event's announcements inside a window of `span`
-- (scheduled and sent ones count; cancelled and skipped ones never went out). Every window that would hold the new send
-- starts at the new send itself or at an existing send up to `span` before it, so those are the starts tried: the new
-- send plus the existing ones in [start, start + span). Callers hold the event's announcement lock.
CREATE FUNCTION announcement_crowded(target_event uuid, at timestamptz, span interval, cap integer) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(max(w.n), 0) > cap
  FROM (SELECT 1 + (SELECT count(*) FROM announcement a
                    WHERE a.event_id = target_event AND a.status IN ('scheduled', 'sent')
                      AND a.send_at >= s.t AND a.send_at < s.t + span) AS n
        FROM (SELECT at AS t
              UNION
              SELECT a.send_at FROM announcement a
              WHERE a.event_id = target_event AND a.status IN ('scheduled', 'sent')
                AND a.send_at > at - span AND a.send_at <= at) s) w
$$;
REVOKE ALL ON FUNCTION announcement_crowded(uuid, timestamptz, interval, integer) FROM PUBLIC;

-- A draft field of the door's jsonb: text of 1 to `max` characters without control characters, else PA422 with the
-- field's name. The API has cleaned and checked it already; this keeps a bypassed API from storing anything else.
CREATE FUNCTION announcement_field(draft jsonb, field text, max_length integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  value text := CASE WHEN jsonb_typeof(draft -> field) = 'string' THEN draft ->> field END;
BEGIN
  IF value IS NULL OR char_length(value) NOT BETWEEN 1 AND max_length OR value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'check the announcement''s %', field USING ERRCODE = 'PA422', DETAIL = field;
  END IF;
  RETURN value;
END $$;
REVOKE ALL ON FUNCTION announcement_field(jsonb, text, integer) FROM PUBLIC;

-- The members an announcement tells in this phase: one set-based statement over the rules the fan-out states per member
-- (notice_membership_ok: an active enrollment of an active player, not on the event's exclusion list, real members on a
-- live event and rehearsal accounts before the start; the exclusion rule is excluded_from_event's own test written out,
-- because that SQL function holds a sub-select and is never inlined, so asked per row it is 16 times slower once an
-- event has one entry). A database test requires the count to equal the fan-out's recipients on a crowd that holds every
-- excluded kind. 0 for a phase nobody is told in.
CREATE FUNCTION announcement_audience(ev event, phase text) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN phase NOT IN ('live', 'rehearsal') THEN 0 ELSE (
    SELECT count(*)::integer
    FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE n.event_id = ev.id AND n.status = 'active'
      AND (n.joined_via IS NOT DISTINCT FROM 'rehearsal') = (phase = 'rehearsal')
      AND NOT EXISTS (SELECT 1 FROM player_contact pc JOIN event_exclusion x ON x.event_id = n.event_id
                      WHERE pc.player_id = n.player_id
                        AND ((x.kind = 'phone' AND x.value = pc.phone_e164)
                             OR (x.kind = 'email_domain' AND x.value = split_part(pc.email, '@', 2))))) END
$$;
REVOKE ALL ON FUNCTION announcement_audience(event, text) FROM PUBLIC;

-- ================================================================ the team's doors (ADR-358 (3))
-- How many members an announcement would tell now and where the event stands (`live`, `rehearsal`, `idle`, `closed`),
-- for the dashboard's confirmation. A read for owners and editors inside their event limit; AN404 otherwise.
CREATE FUNCTION announcement_preview(target_event uuid) RETURNS TABLE (members integer, phase text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  now_phase text;
BEGIN
  now_phase := announcement_phase(ev);
  RETURN QUERY SELECT announcement_audience(ev, now_phase), now_phase;
END $$;
REVOKE ALL ON FUNCTION announcement_preview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION announcement_preview(uuid) TO questify_app;

-- Sends an announcement now (`at` NULL) or schedules it. `draft` holds titleAr, titleEn, bodyAr, bodyEn, pushBodyAr and
-- pushBodyEn, already cleaned and checked by the API. `press` is the request's Idempotency-Key (1 to 255 characters),
-- hashed: the same key answers the first result with `replayed` and writes nothing (checked first, under the event's
-- announcement lock, so a racing second press waits and then replays). Lock order: announcement advisory, event FOR
-- SHARE, then announcement rows; authorization and event state are read again after both waits. The event lock lasts
-- through the notice and state write, excluding lifecycle UPDATEs. Refusals: AN404 (not the caller's event), PK400
-- (the key), PA422 (a field of the draft, or `sendAt`: past, too_far, before_start, after_end), PE409 (event_closed: ended
-- or archived; event_not_live: a draft or scheduled event with no open rehearsal, for a send now), PT409 (nobody: a send
-- now that would tell no one), PL429 (limit: detail `hour` or `day`). Send now writes the notice and the row
-- together; a missing kind row writes nothing and raises nothing: the door answers a NULL id. A schedule writes the row
-- only; the due scan sends it at its time. Audited `announcement.send`.
CREATE FUNCTION announcement_send(target_event uuid, draft jsonb, at timestamptz, press text, request uuid)
  RETURNS TABLE (id uuid, status text, send_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  key     text;
  earlier announcement;
  phase   text;
  moment  timestamptz;
  fresh   uuid := gen_random_uuid();
  fields  text[];
  made    bigint;
BEGIN
  IF press IS NULL OR char_length(press) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an Idempotency-Key of 1 to 255 characters is required' USING ERRCODE = 'PK400';
  END IF;
  key := encode(sha256(convert_to(press, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('announcement:' || ev.id, 0));
  PERFORM 1 FROM event e WHERE e.id = target_event FOR SHARE;
  ev := award_event_of(target_event);
  SELECT a.* INTO earlier FROM announcement a WHERE a.event_id = ev.id AND a.press = key;
  IF FOUND THEN
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.send_at, true;
    RETURN;
  END IF;
  fields := ARRAY[announcement_field(draft, 'titleAr', 60), announcement_field(draft, 'titleEn', 60),
                  announcement_field(draft, 'bodyAr', 500), announcement_field(draft, 'bodyEn', 500),
                  announcement_field(draft, 'pushBodyAr', 140), announcement_field(draft, 'pushBodyEn', 140)];
  phase := announcement_phase(ev);
  IF phase = 'closed' THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF at IS NULL AND phase = 'idle' THEN
    RAISE EXCEPTION 'the event has not started and has no rehearsal' USING ERRCODE = 'PE409', DETAIL = 'event_not_live';
  ELSIF at IS NULL AND announcement_audience(ev, phase) = 0 THEN
    RAISE EXCEPTION 'no member would receive it' USING ERRCODE = 'PT409', DETAIL = 'nobody';
  ELSIF at IS NOT NULL AND at < now() + interval '2 minutes' THEN
    RAISE EXCEPTION 'choose a later time' USING ERRCODE = 'PA422', DETAIL = 'sendAt:past';
  ELSIF at IS NOT NULL AND at > now() + interval '180 days' THEN
    RAISE EXCEPTION 'choose a nearer time' USING ERRCODE = 'PA422', DETAIL = 'sendAt:too_far';
  ELSIF at IS NOT NULL AND ev.starts_at IS NOT NULL AND at < ev.starts_at THEN
    RAISE EXCEPTION 'choose a time after the event starts' USING ERRCODE = 'PA422', DETAIL = 'sendAt:before_start';
  ELSIF at IS NOT NULL AND ev.ends_at IS NOT NULL AND at >= ev.ends_at THEN
    RAISE EXCEPTION 'choose a time before the event ends' USING ERRCODE = 'PA422', DETAIL = 'sendAt:after_end';
  END IF;
  moment := coalesce(at, now());
  IF announcement_crowded(ev.id, moment, interval '1 hour', 3) THEN
    RAISE EXCEPTION 'too many announcements in an hour' USING ERRCODE = 'PL429', DETAIL = 'hour';
  ELSIF announcement_crowded(ev.id, moment, interval '1 day', 10) THEN
    RAISE EXCEPTION 'too many announcements in a day' USING ERRCODE = 'PL429', DETAIL = 'day';
  END IF;
  IF at IS NULL THEN
    made := notice_create('announcement', ev.organizer_id, ev.id, NULL, jsonb_build_object('announcement', fresh),
                          announcement_params(ev, fields[1], fields[2], fields[5], fields[6]),
                          'announcement:' || fresh, NULL);
    IF made IS NULL THEN
      RETURN QUERY SELECT NULL::uuid, 'unavailable'::text, moment, false;
      RETURN;
    END IF;
  END IF;
  INSERT INTO announcement (id, organizer_id, event_id, title_ar, title_en, body_ar, body_en, push_body_ar, push_body_en,
                            status, send_at, press, rehearsal, notice_id, created_by, sent_at)
  VALUES (fresh, ev.organizer_id, ev.id, fields[1], fields[2], fields[3], fields[4], fields[5], fields[6],
          CASE WHEN at IS NULL THEN 'sent' ELSE 'scheduled' END, moment, key, at IS NULL AND phase = 'rehearsal', made,
          app_staff_user_id(), CASE WHEN at IS NULL THEN now() END);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'announcement.send', 'announcement', fresh::text,
          jsonb_build_object('sendAt', moment, 'scheduled', at IS NOT NULL, 'rehearsal', at IS NULL AND phase = 'rehearsal'),
          request);
  RETURN QUERY SELECT fresh, CASE WHEN at IS NULL THEN 'sent' ELSE 'scheduled' END, moment, false;
END $$;
REVOKE ALL ON FUNCTION announcement_send(uuid, jsonb, timestamptz, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION announcement_send(uuid, jsonb, timestamptz, text, uuid) TO questify_app;

-- Cancels a scheduled announcement before it goes out. The row is locked FOR UPDATE, as the due scan locks it, so a
-- cancel and the scan cannot both win: the loser finds the other's state. Cancelling a cancelled one answers `cancelled`
-- again; a sent or skipped one is PA409 (detail `sent` or `skipped`). AN404 for an announcement of another event.
-- Audited `announcement.cancel`.
CREATE FUNCTION announcement_cancel(target_event uuid, target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  existing announcement;
BEGIN
  SELECT a.* INTO existing FROM announcement a WHERE a.id = target AND a.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such announcement in this event' USING ERRCODE = 'AN404';
  ELSIF existing.status = 'cancelled' THEN
    RETURN 'cancelled';
  ELSIF existing.status <> 'scheduled' THEN
    RAISE EXCEPTION 'it has already gone out' USING ERRCODE = 'PA409', DETAIL = existing.status;
  END IF;
  UPDATE announcement SET status = 'cancelled', cancelled_at = now() WHERE id = existing.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'announcement.cancel', 'announcement', existing.id::text,
          request);
  RETURN 'cancelled';
END $$;
REVOKE ALL ON FUNCTION announcement_cancel(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION announcement_cancel(uuid, uuid, uuid) TO questify_app;

-- Pending schedules are read separately, earliest first with a (send_at, id) cursor and one lookahead row (31 rows,
-- exposed as pages of 30 by the API). History excludes scheduled rows and keeps the newest 30. A sent one carries
-- the players it
-- reached in the app, rounded (exact below 10, else the nearest 10; the center rows of its notice, so a muted topic or a
-- refused permission still counts), NULL once the notice has been purged, and `delivering` while the fan-out is still
-- writing center rows. Nothing about any one player.
CREATE FUNCTION announcement_list(target_event uuid, pending boolean DEFAULT false,
                                  after_at timestamptz DEFAULT NULL, after_id uuid DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY CASE WHEN pending THEN x.send_at END, CASE WHEN pending THEN x.id END,
                                   x.send_at DESC, x.id DESC)
    FROM (SELECT a.id, a.send_at, jsonb_build_object(
                   'id', a.id, 'titleAr', a.title_ar, 'titleEn', a.title_en, 'bodyAr', a.body_ar, 'bodyEn', a.body_en,
                   'status', a.status, 'sendAt', a.send_at, 'sentAt', a.sent_at, 'rehearsal', a.rehearsal,
                   'skipReason', a.skip_reason,
                   'delivered', CASE WHEN a.status = 'sent' AND nt.id IS NOT NULL THEN
                                  (CASE WHEN reached.n < 10 THEN reached.n ELSE (round(reached.n / 10.0) * 10)::integer END)
                                END,
                   'delivering', a.status = 'sent' AND nt.id IS NOT NULL AND nt.fanned_at IS NULL) AS item
          FROM announcement a
          LEFT JOIN notice nt ON nt.id = a.notice_id
          LEFT JOIN LATERAL (SELECT count(*)::integer AS n FROM notification c
                             WHERE c.notice_id = nt.id AND a.status = 'sent') reached ON true
          WHERE a.event_id = ev.id AND (a.status = 'scheduled') = pending
            AND (NOT pending OR after_at IS NULL OR (a.send_at, a.id) > (after_at, after_id))
          ORDER BY CASE WHEN pending THEN a.send_at END, CASE WHEN pending THEN a.id END,
                   a.send_at DESC, a.id DESC
          LIMIT CASE WHEN pending THEN 31 ELSE 30 END) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION announcement_list(uuid, boolean, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION announcement_list(uuid, boolean, timestamptz, uuid) TO questify_app;

-- ================================================================ the player's list (FR-807)
-- The latest announcements of an event the caller is an active member of, newest first, at most `size` (1 to 50): the
-- full text in both languages. A rehearsal account sees the ones sent in the rehearsal, a real member the others, so a
-- test announcement is never shown to the event's players. AM403 for anyone who is not an active member of a
-- non-archived event (the API answers 403 not_enrolled, as Home does).
CREATE FUNCTION member_announcements(target_event uuid, size integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment;
BEGIN
  SELECT n.* INTO member
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN event e ON e.id = n.event_id AND e.status <> 'archived'
  WHERE n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active'
    AND app_device_id() IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an active member of this event' USING ERRCODE = 'AM403';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.sent_at DESC, x.id DESC)
    FROM (SELECT a.id, a.sent_at, jsonb_build_object(
                   'id', a.id, 'title', jsonb_build_object('ar', a.title_ar, 'en', a.title_en),
                   'body', jsonb_build_object('ar', a.body_ar, 'en', a.body_en), 'sentAt', a.sent_at) AS item
          FROM announcement a
          WHERE a.event_id = target_event AND a.status = 'sent'
            AND a.rehearsal = (member.joined_via IS NOT DISTINCT FROM 'rehearsal')
          ORDER BY a.sent_at DESC, a.id DESC
          LIMIT least(greatest(coalesce(size, 20), 1), 50)) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION member_announcements(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_announcements(uuid, integer) TO questify_app;

-- ================================================================ the due scan (ADR-358 (4))
-- Scheduled announcements whose time has come, at most `lim` candidates a call. Lock the event FOR SHARE before the
-- announcement FOR UPDATE SKIP LOCKED, then recheck its scheduled state. A cancel holds the latter lock, so the scan
-- leaves that row to the next tick. The event lock excludes lifecycle writes until notice/state commit: closed events
-- are skipped (event_closed), not yet live is skipped (not_live), and a row more than 30 minutes past its time is
-- `skipped` (late: a worker that was down does not send a
-- stale "lunch is ready"). Otherwise the notice is written with the text frozen at creation; a missing kind row writes
-- nothing and the row waits for the next tick (then goes late). Each outcome is audited by the system. Returns the rows
-- it changed.
CREATE FUNCTION push_due_announcement(lim integer) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  due    announcement;
  ev     event;
  phase  text;
  why    text;
  made   bigint;
  moved  integer := 0;
BEGIN
  FOR due IN
    SELECT a.* FROM announcement a WHERE a.status = 'scheduled' AND a.send_at <= now()
    ORDER BY a.send_at, a.id LIMIT push_due_announcement.lim
  LOOP
    SELECT e.* INTO ev FROM event e WHERE e.id = due.event_id FOR SHARE;
    SELECT a.* INTO due FROM announcement a WHERE a.id = due.id AND a.status = 'scheduled'
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    phase := announcement_phase(ev);
    why := CASE WHEN phase = 'closed' THEN 'event_closed'
                WHEN phase <> 'live' THEN 'not_live'
                WHEN due.send_at < now() - interval '30 minutes' THEN 'late' END;
    IF why IS NOT NULL THEN
      UPDATE announcement SET status = 'skipped', skip_reason = why WHERE id = due.id;
      INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after)
      VALUES ('system', due.organizer_id, due.event_id, 'announcement.skip', 'announcement', due.id::text,
              jsonb_build_object('reason', why));
      moved := moved + 1;
    ELSE
      made := notice_create('announcement', due.organizer_id, due.event_id, NULL, jsonb_build_object('announcement', due.id),
                            announcement_params(ev, due.title_ar, due.title_en, due.push_body_ar, due.push_body_en),
                            'announcement:' || due.id, NULL);
      IF made IS NOT NULL THEN
        UPDATE announcement SET status = 'sent', sent_at = now(), notice_id = made WHERE id = due.id;
        INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id)
        VALUES ('system', due.organizer_id, due.event_id, 'announcement.release', 'announcement', due.id::text);
        moved := moved + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN moved;
END $$;
REVOKE ALL ON FUNCTION push_due_announcement(integer) FROM PUBLIC;

-- As 0079, plus the announcement scan (100 a call: each row is a notice and an audit line, and they are rare).
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
  n_announce integer;
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
  n_announce := push_due_announcement(100);
  RETURN jsonb_build_object('ready', n_ready, 'ending', n_ending, 'flash', n_flash, 'boost', n_boost,
                            'category', n_category, 'soon', n_soon, 'streak', n_streak, 'shop', n_shop,
                            'announcement', n_announce,
                            'more', greatest(n_ready, n_ending, n_flash, n_boost, n_category, n_soon, n_streak,
                                             n_shop) >= 500 OR n_announce >= 100);
END $$;
REVOKE ALL ON FUNCTION push_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_due() TO questify_app;
