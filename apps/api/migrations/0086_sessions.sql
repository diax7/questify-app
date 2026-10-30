-- T-505: the agenda and its sessions (FR-808 to FR-810, FR-1787 to FR-1797 except the session's points; plan
-- docs/plans/2026-10-30-t-505-agenda-sessions.md; ADR-373). An owner or editor adds sessions (a talk, a workshop or an
-- activity) by hand or from a spreadsheet; a player sees the agenda, registers for a session that asks for it while a seat
-- is left, and cancels; an operator checks a player in at the door by My QR; the push worker reminds registrants before
-- the start; the organizer reads the attendance report and messages the registrants. Registration is free and records the
-- player, the session and the time only (FR-1789). The session's points on check-in are T-505b (they write the points
-- ledger). Deny by default: the four new tables keep row-level security forced and no grant; every function is closed to
-- PUBLIC in the group that creates it and only the doors are granted to the API role. No EXCEPTION block. Migrations 0085
-- and earlier untouched; push_due() is restated (0081's body plus one scan).
SET LOCAL lock_timeout = '10s';
-- The event, the enrollment and the quest are foreign-key targets of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE enrollment IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quest IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the kinds (ADR-373 (5))
-- Both personal (priority 0) and sent to one registrant each. A reminder is under the Reminders topic like the streak's;
-- a message from the organizer under Announcements, so a player who muted that topic keeps the center row and loses the
-- push. Two hours covers a reminder asked for up to a day ahead: the fan-out runs within a minute of the notice.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('session_reminder', 'personal', 'reminders', 'active', false, 0, interval '2 hours'),
  ('session_message', 'personal', 'announcements', 'active', false, 0, interval '6 hours');

-- ================================================================ the tables (ADR-373 (2))
-- A session. A title in one language is enough (the other shows in its place), as a quest's is. `seats` NULL is no limit;
-- `closes_at` NULL closes registration at the start; `registration_open` is the organizer's close and reopen; `walk_ins`
-- lets the door check in a player who did not register. An open session carries none of those. No price column exists.
CREATE TABLE event_session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id      uuid NOT NULL,
  event_id          uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('talk', 'workshop', 'activity')),
  title_ar          text CHECK (char_length(title_ar) BETWEEN 1 AND 120 AND title_ar !~ '[[:cntrl:]]'),
  title_en          text CHECK (char_length(title_en) BETWEEN 1 AND 120 AND title_en !~ '[[:cntrl:]]'),
  description_ar    text CHECK (char_length(description_ar) BETWEEN 1 AND 2000),
  description_en    text CHECK (char_length(description_en) BETWEEN 1 AND 2000),
  place_ar          text CHECK (char_length(place_ar) BETWEEN 1 AND 120 AND place_ar !~ '[[:cntrl:]]'),
  place_en          text CHECK (char_length(place_en) BETWEEN 1 AND 120 AND place_en !~ '[[:cntrl:]]'),
  speakers          text[] NOT NULL DEFAULT '{}' CHECK (cardinality(speakers) <= 10),
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  access            text NOT NULL CHECK (access IN ('open', 'registration')),
  seats             integer CHECK (seats BETWEEN 1 AND 100000),
  closes_at         timestamptz,
  registration_open boolean NOT NULL DEFAULT true,
  walk_ins          boolean NOT NULL DEFAULT false,
  reminder_minutes  integer NOT NULL DEFAULT 15 CHECK (reminder_minutes BETWEEN 1 AND 1440),
  quest_id          uuid,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  -- The linked quest is one of the same event; deleting the quest unlinks it.
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE SET NULL (quest_id),
  UNIQUE (id, event_id),
  CONSTRAINT event_session_title CHECK (title_ar IS NOT NULL OR title_en IS NOT NULL),
  CONSTRAINT event_session_time CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'),
  CONSTRAINT event_session_closes CHECK (closes_at IS NULL OR closes_at <= starts_at),
  CONSTRAINT event_session_open CHECK (access = 'registration'
                                       OR (seats IS NULL AND closes_at IS NULL AND NOT walk_ins))
);
CREATE INDEX event_session_event ON event_session (event_id, starts_at, id);
CREATE INDEX event_session_due ON event_session (starts_at) WHERE access = 'registration';
ALTER TABLE event_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_session FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_session FROM PUBLIC, questify_app;

-- A registration: the player, the session and the time only (FR-1789). It goes with its enrollment (the rehearsal wipe,
-- a deleted account) and with its session; cancelling deletes it, so the seat is free at once.
CREATE TABLE session_registration (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  session_id    uuid NOT NULL,
  enrollment_id uuid NOT NULL REFERENCES enrollment (id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, player_id),
  FOREIGN KEY (session_id, event_id) REFERENCES event_session (id, event_id) ON DELETE CASCADE
);
CREATE INDEX session_registration_player ON session_registration (event_id, player_id);
ALTER TABLE session_registration ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_registration FORCE ROW LEVEL SECURITY;
REVOKE ALL ON session_registration FROM PUBLIC, questify_app;

-- Attendance: who the door checked in, by which operator and when. `walk_in` is a player of a registration-required session
-- who had not registered (the organizer allowed it). One row per player and session.
CREATE TABLE session_attendance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  session_id    uuid NOT NULL,
  enrollment_id uuid NOT NULL REFERENCES enrollment (id) ON DELETE CASCADE,
  player_id     uuid NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  operator_id   uuid NOT NULL REFERENCES player (id),
  walk_in       boolean NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, player_id),
  FOREIGN KEY (session_id, event_id) REFERENCES event_session (id, event_id) ON DELETE CASCADE
);
ALTER TABLE session_attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_attendance FORCE ROW LEVEL SECURITY;
REVOKE ALL ON session_attendance FROM PUBLIC, questify_app;

-- A message to a session's registrants: the text as sent, the Idempotency-Key hash (unique per event) and how many
-- notices were written. The notices are T-501's; this row is the replay and the rate limit.
CREATE TABLE session_message (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  session_id   uuid NOT NULL,
  title_ar     text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 60 AND title_ar !~ '[[:cntrl:]]'),
  title_en     text NOT NULL CHECK (char_length(title_en) BETWEEN 1 AND 60 AND title_en !~ '[[:cntrl:]]'),
  body_ar      text NOT NULL CHECK (char_length(body_ar) BETWEEN 1 AND 500 AND body_ar !~ '[[:cntrl:]]'),
  body_en      text NOT NULL CHECK (char_length(body_en) BETWEEN 1 AND 500 AND body_en !~ '[[:cntrl:]]'),
  press        text NOT NULL CHECK (press ~ '^[0-9a-f]{64}$'),
  recipients   integer NOT NULL CHECK (recipients >= 1),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, press),
  FOREIGN KEY (session_id, event_id) REFERENCES event_session (id, event_id) ON DELETE CASCADE
);
CREATE INDEX session_message_event ON session_message (event_id, created_at DESC);
ALTER TABLE session_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_message FORCE ROW LEVEL SECURITY;
REVOKE ALL ON session_message FROM PUBLIC, questify_app;

-- ================================================================ helpers (internal: no grant)
-- A text field of the draft: NULL when missing or blank, else 1 to `max_length` characters without control characters
-- (a line break is allowed when `multiline`). PS422 with the field's name otherwise. The API has checked the draft already;
-- this keeps a bypassed API from storing anything else.
CREATE FUNCTION session_text(draft jsonb, field text, max_length integer, multiline boolean) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  value text;
BEGIN
  IF draft -> field IS NULL OR jsonb_typeof(draft -> field) = 'null' THEN
    RETURN NULL;
  ELSIF jsonb_typeof(draft -> field) <> 'string' THEN
    RAISE EXCEPTION 'check the session''s %', field USING ERRCODE = 'PS422', DETAIL = field;
  END IF;
  value := btrim(draft ->> field);
  IF value = '' THEN
    RETURN NULL;
  ELSIF char_length(value) > max_length
        OR (CASE WHEN multiline THEN replace(value, E'\n', '') ELSE value END) ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'check the session''s %', field USING ERRCODE = 'PS422', DETAIL = field;
  END IF;
  RETURN value;
END $$;
REVOKE ALL ON FUNCTION session_text(jsonb, text, integer, boolean) FROM PUBLIC;

-- A moment of the draft as an ISO instant with an offset; NULL when missing and not `required`.
CREATE FUNCTION session_time(draft jsonb, field text, required boolean) RETURNS timestamptz
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  value text := CASE WHEN jsonb_typeof(draft -> field) = 'string' THEN draft ->> field END;
BEGIN
  IF value IS NULL AND NOT required AND coalesce(jsonb_typeof(draft -> field), 'null') = 'null' THEN
    RETURN NULL;
  ELSIF value IS NULL
        OR value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
    RAISE EXCEPTION 'check the session''s %', field USING ERRCODE = 'PS422', DETAIL = field;
  END IF;
  RETURN value::timestamptz;
END $$;
REVOKE ALL ON FUNCTION session_time(jsonb, text, boolean) FROM PUBLIC;

-- A whole number of the draft between `low` and `high`; NULL when missing.
CREATE FUNCTION session_int(draft jsonb, field text, low integer, high integer) RETURNS integer
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  kind text := coalesce(jsonb_typeof(draft -> field), 'null');
BEGIN
  IF kind = 'null' THEN
    RETURN NULL;
  ELSIF kind <> 'number' OR (draft ->> field) !~ '^[0-9]{1,9}$' OR (draft ->> field)::integer NOT BETWEEN low AND high THEN
    RAISE EXCEPTION 'check the session''s %', field USING ERRCODE = 'PS422', DETAIL = field;
  END IF;
  RETURN (draft ->> field)::integer;
END $$;
REVOKE ALL ON FUNCTION session_int(jsonb, text, integer, integer) FROM PUBLIC;

-- The speakers' names: at most 10, each 1 to 80 characters without control characters.
CREATE FUNCTION session_speakers(draft jsonb) RETURNS text[]
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  item  jsonb;
  name  text;
  names text[] := '{}';
BEGIN
  IF coalesce(jsonb_typeof(draft -> 'speakers'), 'null') = 'null' THEN
    RETURN names;
  ELSIF jsonb_typeof(draft -> 'speakers') <> 'array' OR jsonb_array_length(draft -> 'speakers') > 10 THEN
    RAISE EXCEPTION 'check the session''s speakers' USING ERRCODE = 'PS422', DETAIL = 'speakers';
  END IF;
  FOR item IN SELECT jsonb_array_elements(draft -> 'speakers') LOOP
    name := CASE WHEN jsonb_typeof(item) = 'string' THEN btrim(item #>> '{}') END;
    IF name IS NULL OR char_length(name) NOT BETWEEN 1 AND 80 OR name ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'check the session''s speakers' USING ERRCODE = 'PS422', DETAIL = 'speakers';
    END IF;
    names := names || name;
  END LOOP;
  RETURN names;
END $$;
REVOKE ALL ON FUNCTION session_speakers(jsonb) FROM PUBLIC;

-- Creates or updates a session of `ev` from the draft and answers its id. An update locks the session row, refuses a seat
-- limit below the registered number (PS409 `seats_below:N`) and refuses turning a session with registrations into an
-- open one (PS409 `has_registrations`). A new session beyond the event's 1,000th is PS409 `limit`. The caller holds the
-- event and has authorized it.
CREATE FUNCTION session_write(ev event, target uuid, draft jsonb) RETURNS uuid
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  existing  event_session;
  made      uuid := coalesce(target, gen_random_uuid());
  new_kind  text := CASE WHEN jsonb_typeof(draft) = 'object' AND jsonb_typeof(draft -> 'kind') = 'string'
                         THEN draft ->> 'kind' END;
  new_access text := CASE WHEN jsonb_typeof(draft) = 'object' AND jsonb_typeof(draft -> 'access') = 'string'
                          THEN draft ->> 'access' END;
  t_ar      text;
  t_en      text;
  starts    timestamptz;
  ends      timestamptz;
  new_seats integer;
  closes    timestamptz;
  walk      boolean;
  quest     uuid;
  registered integer;
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'check the session' USING ERRCODE = 'PS422', DETAIL = 'session';
  ELSIF new_kind IS NULL OR new_kind NOT IN ('talk', 'workshop', 'activity') THEN
    RAISE EXCEPTION 'check the session''s kind' USING ERRCODE = 'PS422', DETAIL = 'kind';
  ELSIF new_access IS NULL OR new_access NOT IN ('open', 'registration') THEN
    RAISE EXCEPTION 'check the session''s access' USING ERRCODE = 'PS422', DETAIL = 'access';
  END IF;
  t_ar := session_text(draft, 'titleAr', 120, false);
  t_en := session_text(draft, 'titleEn', 120, false);
  IF t_ar IS NULL AND t_en IS NULL THEN
    RAISE EXCEPTION 'a title is required' USING ERRCODE = 'PS422', DETAIL = 'title';
  END IF;
  starts := session_time(draft, 'startsAt', true);
  ends := session_time(draft, 'endsAt', true);
  IF ends <= starts THEN
    RAISE EXCEPTION 'the session must end after it starts' USING ERRCODE = 'PS422', DETAIL = 'endsAt:before_start';
  ELSIF ends - starts > interval '24 hours' THEN
    RAISE EXCEPTION 'a session lasts at most 24 hours' USING ERRCODE = 'PS422', DETAIL = 'endsAt:too_long';
  ELSIF (ev.starts_at IS NOT NULL AND starts < ev.starts_at) OR (ev.ends_at IS NOT NULL AND ends > ev.ends_at) THEN
    RAISE EXCEPTION 'the session is outside the event' USING ERRCODE = 'PS422', DETAIL = 'startsAt:outside_event';
  END IF;
  new_seats := CASE WHEN new_access = 'registration' THEN session_int(draft, 'seats', 1, 100000) END;
  closes := CASE WHEN new_access = 'registration' THEN session_time(draft, 'closesAt', false) END;
  IF closes > starts THEN
    RAISE EXCEPTION 'registration closes by the start' USING ERRCODE = 'PS422', DETAIL = 'closesAt';
  END IF;
  walk := new_access = 'registration' AND coalesce(draft -> 'walkIns' = 'true'::jsonb, false);
  IF coalesce(jsonb_typeof(draft -> 'questId'), 'null') <> 'null' THEN
    IF jsonb_typeof(draft -> 'questId') <> 'string'
       OR (draft ->> 'questId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'check the session''s quest' USING ERRCODE = 'PS422', DETAIL = 'questId';
    END IF;
    SELECT q.id INTO quest FROM quest q WHERE q.id = (draft ->> 'questId')::uuid AND q.event_id = ev.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'PS422', DETAIL = 'questId';
    END IF;
  END IF;
  IF target IS NULL THEN
    IF (SELECT count(*) FROM event_session s WHERE s.event_id = ev.id) >= 1000 THEN
      RAISE EXCEPTION 'an event holds at most 1,000 sessions' USING ERRCODE = 'PS409', DETAIL = 'limit';
    END IF;
  ELSE
    SELECT s.* INTO existing FROM event_session s WHERE s.id = target AND s.event_id = ev.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
    END IF;
    SELECT count(*)::integer INTO registered FROM session_registration r WHERE r.session_id = existing.id;
    IF new_access = 'open' AND registered > 0 THEN
      RAISE EXCEPTION 'players are registered' USING ERRCODE = 'PS409', DETAIL = 'has_registrations';
    ELSIF new_seats IS NOT NULL AND new_seats < registered THEN
      RAISE EXCEPTION '% are registered', registered USING ERRCODE = 'PS409', DETAIL = 'seats_below:' || registered;
    END IF;
  END IF;
  IF target IS NULL THEN
    INSERT INTO event_session (id, organizer_id, event_id, kind, title_ar, title_en, description_ar, description_en,
                               place_ar, place_en, speakers, starts_at, ends_at, access, seats, closes_at, walk_ins,
                               reminder_minutes, quest_id, created_by)
    VALUES (made, ev.organizer_id, ev.id, new_kind, t_ar, t_en, session_text(draft, 'descriptionAr', 2000, true),
            session_text(draft, 'descriptionEn', 2000, true), session_text(draft, 'placeAr', 120, false),
            session_text(draft, 'placeEn', 120, false), session_speakers(draft), starts, ends, new_access, new_seats,
            closes, walk, coalesce(session_int(draft, 'reminderMinutes', 1, 1440), 15), quest, app_staff_user_id());
  ELSE
    UPDATE event_session SET kind = new_kind, title_ar = t_ar, title_en = t_en,
      description_ar = session_text(draft, 'descriptionAr', 2000, true),
      description_en = session_text(draft, 'descriptionEn', 2000, true), place_ar = session_text(draft, 'placeAr', 120, false),
      place_en = session_text(draft, 'placeEn', 120, false), speakers = session_speakers(draft), starts_at = starts,
      ends_at = ends, access = new_access, seats = new_seats, closes_at = closes, walk_ins = walk,
      reminder_minutes = coalesce(session_int(draft, 'reminderMinutes', 1, 1440), 15), quest_id = quest, updated_at = now()
    WHERE id = made;
  END IF;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION session_write(event, uuid, jsonb) FROM PUBLIC;

-- A session as the dashboard reads it, with its numbers: registered now, attended (walk-ins counted), the walk-ins among
-- them, and the no-shows (registered, never checked in, counted once the session has started).
CREATE FUNCTION session_team_item(s event_session) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'kind', s.kind, 'titleAr', s.title_ar, 'titleEn', s.title_en, 'descriptionAr', s.description_ar,
    'descriptionEn', s.description_en, 'placeAr', s.place_ar, 'placeEn', s.place_en, 'speakers', to_jsonb(s.speakers),
    'startsAt', s.starts_at, 'endsAt', s.ends_at, 'access', s.access, 'seats', s.seats, 'closesAt', s.closes_at,
    'registrationOpen', s.registration_open, 'walkIns', s.walk_ins, 'reminderMinutes', s.reminder_minutes,
    'questId', s.quest_id,
    'registered', (SELECT count(*) FROM session_registration r WHERE r.session_id = s.id),
    'attended', (SELECT count(*) FROM session_attendance a WHERE a.session_id = s.id),
    'walkInCount', (SELECT count(*) FROM session_attendance a WHERE a.session_id = s.id AND a.walk_in),
    'noShows', CASE WHEN now() < s.starts_at THEN 0 ELSE
                 (SELECT count(*) FROM session_registration r
                  WHERE r.session_id = s.id
                    AND NOT EXISTS (SELECT 1 FROM session_attendance a
                                    WHERE a.session_id = s.id AND a.player_id = r.player_id)) END)
$$;
REVOKE ALL ON FUNCTION session_team_item(event_session) FROM PUBLIC;

-- The caller as an active member of a non-archived event, else AM403 (the API answers 403 not_enrolled, as Home does).
-- A paired device is never a member.
CREATE FUNCTION session_member(target_event uuid) RETURNS enrollment
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
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
  RETURN member;
END $$;
REVOKE ALL ON FUNCTION session_member(uuid) FROM PUBLIC;

-- ================================================================ the team's doors (ADR-373 (3))
-- Whether the caller may write this event's agenda: AN404 otherwise. The API asks before it replays a stored answer to a
-- retried write, so a team member whose access ended gets nothing back.
CREATE FUNCTION session_authorize(target_event uuid) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM award_event_of(target_event);
END $$;
REVOKE ALL ON FUNCTION session_authorize(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_authorize(uuid) TO questify_app;

-- Adds a session (`target_session` NULL) or edits one. The draft holds kind, titleAr, titleEn, descriptionAr,
-- descriptionEn, placeAr, placeEn, speakers, startsAt, endsAt, access, seats, closesAt, walkIns, reminderMinutes and
-- questId, already checked by the API. AN404 (not the caller's event), SS404 (no such session), PS422 (a field, as the
-- detail), PS409 (`seats_below:N`, `has_registrations`, `limit`), PE409 (`event_closed`: archived). Audited `session.save`.
CREATE FUNCTION session_save(target_event uuid, draft jsonb, target_session uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := award_event_of(target_event);
  made uuid;
  item event_session;
BEGIN
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR SHARE;
  ev := award_event_of(target_event);
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  END IF;
  made := session_write(ev, target_session, draft);
  SELECT s.* INTO item FROM event_session s WHERE s.id = made;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.save', 'event_session', made::text,
          jsonb_build_object('created', target_session IS NULL, 'kind', item.kind, 'access', item.access), request);
  RETURN session_team_item(item);
END $$;
REVOKE ALL ON FUNCTION session_save(uuid, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_save(uuid, jsonb, uuid, uuid) TO questify_app;

-- Adds up to 500 sessions from a spreadsheet in one transaction. The API has checked each row and listed the ones it
-- could not read; the rows sent here are written all or none. Answers how many. Audited `session.import`.
CREATE FUNCTION session_import(target_event uuid, rows jsonb, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := award_event_of(target_event);
  item jsonb;
  made integer := 0;
BEGIN
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR SHARE;
  ev := award_event_of(target_event);
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'send 1 to 500 sessions' USING ERRCODE = 'PS422', DETAIL = 'rows';
  END IF;
  FOR item IN SELECT jsonb_array_elements(rows) LOOP
    PERFORM session_write(ev, NULL, item);
    made := made + 1;
  END LOOP;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.import', 'event', ev.id::text,
          jsonb_build_object('count', made), request);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION session_import(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_import(uuid, jsonb, uuid) TO questify_app;

-- Deletes a session that nobody has been checked in to; its registrations go with it (the dashboard says how many and
-- offers a message first). PS409 `has_attendance` otherwise, SS404 for a session of another event. Audited
-- `session.delete` with the number of registrations lost.
CREATE FUNCTION session_delete(target_event uuid, target_session uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  existing   event_session;
  registered integer;
BEGIN
  SELECT s.* INTO existing FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  ELSIF EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = existing.id) THEN
    RAISE EXCEPTION 'players were checked in' USING ERRCODE = 'PS409', DETAIL = 'has_attendance';
  END IF;
  SELECT count(*)::integer INTO registered FROM session_registration r WHERE r.session_id = existing.id;
  DELETE FROM event_session WHERE id = existing.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.delete', 'event_session', existing.id::text,
          jsonb_build_object('registrations', registered), request);
  RETURN registered;
END $$;
REVOKE ALL ON FUNCTION session_delete(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_delete(uuid, uuid, uuid) TO questify_app;

-- The event's sessions in time order with their numbers: the dashboard's list and the attendance report (FR-1795).
CREATE FUNCTION session_list(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((SELECT jsonb_agg(session_team_item(s) ORDER BY s.starts_at, s.id)
                   FROM event_session s WHERE s.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION session_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_list(uuid) TO questify_app;

-- Closes or reopens registration and sets the seat limit (NULL = no limit) while the event runs (FR-1796). A limit below
-- the registered number is PS409 `seats_below:N`, naming N. A session that needs no registration is PS409
-- `not_required`. The session row is locked, as a registration locks it, so the count cannot move under the check.
-- Audited `session.registration`.
CREATE FUNCTION session_registration_set(target_event uuid, target_session uuid, is_open boolean, new_seats integer,
                                         request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  existing   event_session;
  registered integer;
BEGIN
  IF is_open IS NULL OR new_seats NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'check the seats' USING ERRCODE = 'PS422', DETAIL = 'seats';
  END IF;
  SELECT s.* INTO existing FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  ELSIF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF existing.access <> 'registration' THEN
    RAISE EXCEPTION 'this session needs no registration' USING ERRCODE = 'PS409', DETAIL = 'not_required';
  END IF;
  SELECT count(*)::integer INTO registered FROM session_registration r WHERE r.session_id = existing.id;
  IF new_seats < registered THEN
    RAISE EXCEPTION '% are registered', registered USING ERRCODE = 'PS409', DETAIL = 'seats_below:' || registered;
  END IF;
  UPDATE event_session SET registration_open = is_open, seats = new_seats, updated_at = now() WHERE id = existing.id
  RETURNING * INTO existing;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.registration', 'event_session',
          existing.id::text, jsonb_build_object('open', is_open, 'seats', new_seats), request);
  RETURN session_team_item(existing);
END $$;
REVOKE ALL ON FUNCTION session_registration_set(uuid, uuid, boolean, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_registration_set(uuid, uuid, boolean, integer, uuid) TO questify_app;

-- Sends a message to everyone registered for a session (FR-1797): one personal notice each, written through
-- notice_create (kind `session_message`), so a player who left the event is dropped at the claim and one who muted the
-- Announcements topic keeps the center row. `draft` holds titleAr, titleEn, bodyAr, bodyEn, pushBodyAr and pushBodyEn,
-- already cleaned and checked by the API (the announcement rules). The same Idempotency-Key answers the first result with
-- `replayed`. At most 3 messages an hour and 10 a day for the event (PL429 `hour` or `day`). PE409 `event_closed` for an
-- ended or archived event, PT409 `nobody` when no one is registered. Audited `session.message`.
CREATE FUNCTION session_message(target_event uuid, target_session uuid, draft jsonb, press text, request uuid)
  RETURNS TABLE (id uuid, recipients integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  key      text;
  earlier  session_message;
  target   event_session;
  fields   text[];
  fresh    uuid := gen_random_uuid();
  sent     integer;
  expected integer;
BEGIN
  IF press IS NULL OR char_length(press) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an Idempotency-Key of 1 to 255 characters is required' USING ERRCODE = 'PK400';
  END IF;
  key := encode(sha256(convert_to(press, 'UTF8')), 'hex');
  PERFORM pg_advisory_xact_lock(hashtextextended('session_message:' || ev.id, 0));
  PERFORM 1 FROM event e WHERE e.id = target_event FOR SHARE;
  ev := award_event_of(target_event);
  SELECT m.* INTO earlier FROM session_message m WHERE m.event_id = ev.id AND m.press = key;
  IF FOUND THEN
    RETURN QUERY SELECT earlier.id, earlier.recipients, true;
    RETURN;
  END IF;
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  END IF;
  fields := ARRAY[announcement_field(draft, 'titleAr', 60), announcement_field(draft, 'titleEn', 60),
                  announcement_field(draft, 'bodyAr', 500), announcement_field(draft, 'bodyEn', 500),
                  announcement_field(draft, 'pushBodyAr', 140), announcement_field(draft, 'pushBodyEn', 140)];
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF (SELECT count(*) FROM session_message m
         WHERE m.event_id = ev.id AND m.created_at > now() - interval '1 hour') >= 3 THEN
    RAISE EXCEPTION 'too many messages in an hour' USING ERRCODE = 'PL429', DETAIL = 'hour';
  ELSIF (SELECT count(*) FROM session_message m
         WHERE m.event_id = ev.id AND m.created_at > now() - interval '1 day') >= 10 THEN
    RAISE EXCEPTION 'too many messages in a day' USING ERRCODE = 'PL429', DETAIL = 'day';
  END IF;
  SELECT count(*)::integer INTO expected
  FROM session_registration r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.status = 'active'
  JOIN player p ON p.id = r.player_id AND p.status = 'active'
  WHERE r.session_id = target.id;
  IF expected = 0 THEN
    RAISE EXCEPTION 'no one is registered' USING ERRCODE = 'PT409', DETAIL = 'nobody';
  END IF;
  SELECT count(notice_create('session_message', ev.organizer_id, ev.id, r.player_id,
                             jsonb_build_object('session', target.id),
                             announcement_params(ev, fields[1], fields[2], fields[5], fields[6]),
                             'session_message:' || fresh || ':' || r.player_id, NULL))::integer
  INTO sent
  FROM session_registration r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.status = 'active'
  JOIN player p ON p.id = r.player_id AND p.status = 'active'
  WHERE r.session_id = target.id;
  IF sent = 0 THEN
    RAISE EXCEPTION 'no one can receive it' USING ERRCODE = 'PT409', DETAIL = 'nobody';
  END IF;
  INSERT INTO session_message (id, organizer_id, event_id, session_id, title_ar, title_en, body_ar, body_en, press,
                               recipients, created_by)
  VALUES (fresh, ev.organizer_id, ev.id, target.id, fields[1], fields[2], fields[3], fields[4], key, sent,
          app_staff_user_id());
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.message', 'event_session', target.id::text,
          jsonb_build_object('recipients', sent), request);
  RETURN QUERY SELECT fresh, sent, false;
END $$;
REVOKE ALL ON FUNCTION session_message(uuid, uuid, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_message(uuid, uuid, jsonb, text, uuid) TO questify_app;

-- ================================================================ the player's doors (ADR-373 (4))
-- The event's agenda for an active member, in time order, with the caller's own state in each session: `open` (needs no
-- registration), `registered`, `full`, `closed` (registration closed, closed by the organizer or the session started) or
-- `available`. `seatsLeft` is NULL for a session without a limit. The linked quest is named only while it is visible.
-- Nobody else's registration is shown. AM403 for anyone who is not an active member of a non-archived event.
CREATE FUNCTION member_sessions(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := session_member(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.starts_at, x.id)
    FROM (SELECT s.id, s.starts_at, jsonb_build_object(
            'id', s.id, 'kind', s.kind,
            'title', jsonb_build_object('ar', coalesce(s.title_ar, s.title_en), 'en', coalesce(s.title_en, s.title_ar)),
            'description', jsonb_build_object('ar', coalesce(s.description_ar, s.description_en),
                                              'en', coalesce(s.description_en, s.description_ar)),
            'place', jsonb_build_object('ar', coalesce(s.place_ar, s.place_en), 'en', coalesce(s.place_en, s.place_ar)),
            'speakers', to_jsonb(s.speakers), 'startsAt', s.starts_at, 'endsAt', s.ends_at, 'access', s.access,
            'seats', s.seats, 'seatsLeft', CASE WHEN s.seats IS NULL THEN NULL ELSE greatest(s.seats - c.n, 0) END,
            'registered', me.id IS NOT NULL, 'checkedIn', att.id IS NOT NULL,
            'started', now() >= s.starts_at,
            'cancellable', me.id IS NOT NULL AND now() < s.starts_at,
            'status', CASE WHEN s.access = 'open' THEN 'open'
                           WHEN me.id IS NOT NULL THEN 'registered'
                           WHEN now() >= s.starts_at OR NOT s.registration_open
                                OR (s.closes_at IS NOT NULL AND now() >= s.closes_at) THEN 'closed'
                           WHEN s.seats IS NOT NULL AND c.n >= s.seats THEN 'full'
                           ELSE 'available' END,
            'quest', CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object(
                       'id', q.id, 'title', jsonb_build_object('ar', coalesce(q.title_ar, q.title_en),
                                                               'en', coalesce(q.title_en, q.title_ar))) END) AS item
          FROM event_session s
          CROSS JOIN LATERAL (SELECT count(*)::integer AS n FROM session_registration r WHERE r.session_id = s.id) c
          LEFT JOIN session_registration me ON me.session_id = s.id AND me.player_id = member.player_id
          LEFT JOIN session_attendance att ON att.session_id = s.id AND att.player_id = member.player_id
          LEFT JOIN quest q ON q.id = s.quest_id AND q.event_id = s.event_id AND q.visible
          WHERE s.event_id = target_event) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION member_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_sessions(uuid) TO questify_app;

-- Registers the caller for a session (FR-1788, FR-1793). The session row is locked before the seats are counted, so two
-- players on the last seat cannot both win. A player already registered gets `registered` again. When the caller already
-- holds a registration that overlaps and `confirm_overlap` is false, nothing is written and the answer is `overlap`
-- with those sessions' names; the app asks and calls again with true. Refusals: AM403, SS404, PE409 `event_closed`,
-- PS409 `not_required` (an open session), `closed` (closed, past its closing time or started) and `full`. Waits for a
-- rehearsal wipe first, as every writer does.
CREATE FUNCTION session_register(target_event uuid, target_session uuid, confirm_overlap boolean) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member  enrollment;
  ev      event;
  target  event_session;
  taken   integer;
  clashes jsonb;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  member := session_member(target_event);
  SELECT e.* INTO ev FROM event e WHERE e.id = target_event;
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session AND s.event_id = target_event FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  ELSIF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF target.access <> 'registration' THEN
    RAISE EXCEPTION 'this session needs no registration' USING ERRCODE = 'PS409', DETAIL = 'not_required';
  ELSIF EXISTS (SELECT 1 FROM session_registration r
                WHERE r.session_id = target.id AND r.player_id = member.player_id) THEN
    RETURN jsonb_build_object('outcome', 'registered', 'replayed', true);
  ELSIF now() >= target.starts_at OR NOT target.registration_open
        OR (target.closes_at IS NOT NULL AND now() >= target.closes_at) THEN
    RAISE EXCEPTION 'registration is closed' USING ERRCODE = 'PS409', DETAIL = 'closed';
  END IF;
  SELECT count(*)::integer INTO taken FROM session_registration r WHERE r.session_id = target.id;
  IF target.seats IS NOT NULL AND taken >= target.seats THEN
    RAISE EXCEPTION 'the session is full' USING ERRCODE = 'PS409', DETAIL = 'full';
  END IF;
  IF NOT coalesce(confirm_overlap, false) THEN
    SELECT jsonb_agg(jsonb_build_object('id', o.id, 'title', jsonb_build_object('ar', coalesce(o.title_ar, o.title_en),
                                                                              'en', coalesce(o.title_en, o.title_ar)))
                     ORDER BY o.starts_at, o.id)
    INTO clashes
    FROM session_registration r
    JOIN event_session o ON o.id = r.session_id
    WHERE r.event_id = target_event AND r.player_id = member.player_id
      AND o.starts_at < target.ends_at AND target.starts_at < o.ends_at;
    IF clashes IS NOT NULL THEN
      RETURN jsonb_build_object('outcome', 'overlap', 'overlaps', clashes);
    END IF;
  END IF;
  INSERT INTO session_registration (organizer_id, event_id, session_id, enrollment_id, player_id)
  VALUES (target.organizer_id, target.event_id, target.id, member.id, member.player_id);
  RETURN jsonb_build_object('outcome', 'registered', 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION session_register(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_register(uuid, uuid, boolean) TO questify_app;

-- Cancels the caller's registration and frees the seat at once (FR-1790). A session that has started is PS409
-- `started`; cancelling when not registered answers `cancelled` again (a retry).
CREATE FUNCTION session_cancel(target_event uuid, target_session uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment;
  target event_session;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  member := session_member(target_event);
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session AND s.event_id = target_event FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  ELSIF now() >= target.starts_at THEN
    RAISE EXCEPTION 'the session has started' USING ERRCODE = 'PS409', DETAIL = 'started';
  END IF;
  DELETE FROM session_registration r WHERE r.session_id = target.id AND r.player_id = member.player_id;
  RETURN 'cancelled';
END $$;
REVOKE ALL ON FUNCTION session_cancel(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_cancel(uuid, uuid) TO questify_app;

-- ================================================================ the door (ADR-373 (6))
-- Checks a scanned player in to a session (FR-1791). The caller is an operator of the session's event with the scan
-- ability and no quest limit (a station operator does not work the door); the scanned code names the player and their My QR
-- version. Refusals as the station scan's: OP403 not an operator of this event, OA403 the ability is off, OS403 the
-- assignment is limited to quests, OY409 the operator's own code, OM422 not the player's current My QR, QC404 not in the
-- event, QC403 the enrollment is not active; SS404 no such session. Answers `checked_in`, `already` (nothing new written),
-- `not_registered` (a registration-required session without walk-ins: nothing written), `too_early` (more than an hour
-- before the start) or `ended`, each with who was scanned. `walkIn` is true for a player checked in without a
-- registration. The assignment is read FOR SHARE, so a removal waits for a scan in flight.
CREATE FUNCTION session_check_in(target_session uuid, scanned uuid, scanned_version integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  target     event_session;
  assignment staff_assignment;
  current    integer;
  member     enrollment;
  who        jsonb;
  registered boolean;
  walk       boolean;
  made       uuid;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session' USING ERRCODE = 'SS404';
  END IF;
  SELECT sa.* INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = target.event_id AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  ELSIF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  ELSIF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id) THEN
    RAISE EXCEPTION 'this operator works quest stations' USING ERRCODE = 'OS403';
  ELSIF scanned = me THEN
    RAISE EXCEPTION 'an operator cannot scan their own code' USING ERRCODE = 'OY409';
  END IF;
  PERFORM ensure_rehearsal_wiped(target.event_id);
  SELECT p.my_qr_version INTO current FROM player p WHERE p.id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  ELSIF current IS DISTINCT FROM scanned_version THEN
    RAISE EXCEPTION 'an earlier My QR' USING ERRCODE = 'OM422';
  END IF;
  SELECT n.* INTO member FROM enrollment n WHERE n.event_id = target.event_id AND n.player_id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  ELSIF member.status <> 'active' THEN
    RAISE EXCEPTION 'the enrollment is not active' USING ERRCODE = 'QC403', DETAIL = member.status;
  END IF;
  SELECT jsonb_build_object('username', p.username, 'avatar', p.avatar) INTO who FROM player p WHERE p.id = scanned;
  IF now() < target.starts_at - interval '1 hour' THEN
    RETURN jsonb_build_object('outcome', 'too_early', 'player', who);
  ELSIF now() >= target.ends_at THEN
    RETURN jsonb_build_object('outcome', 'ended', 'player', who);
  ELSIF EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = target.id AND a.player_id = scanned) THEN
    RETURN jsonb_build_object('outcome', 'already', 'player', who);
  END IF;
  registered := EXISTS (SELECT 1 FROM session_registration r WHERE r.session_id = target.id AND r.player_id = scanned);
  IF target.access = 'registration' AND NOT registered AND NOT target.walk_ins THEN
    RETURN jsonb_build_object('outcome', 'not_registered', 'player', who);
  END IF;
  walk := target.access = 'registration' AND NOT registered;
  INSERT INTO session_attendance (organizer_id, event_id, session_id, enrollment_id, player_id, operator_id, walk_in)
  VALUES (target.organizer_id, target.event_id, target.id, member.id, scanned, me, walk)
  ON CONFLICT (session_id, player_id) DO NOTHING
  RETURNING id INTO made;
  IF made IS NULL THEN
    RETURN jsonb_build_object('outcome', 'already', 'player', who);
  END IF;
  RETURN jsonb_build_object('outcome', 'checked_in', 'walkIn', walk, 'player', who);
END $$;
REVOKE ALL ON FUNCTION session_check_in(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_check_in(uuid, uuid, integer) TO questify_app;

-- The sessions an operator can check players in to right now: those of the event that start within the hour or are on,
-- earliest first (the same window as session_check_in). The caller is an operator of the event with the scan ability and no
-- quest limit, else OP403, OA403 or OS403 as the check-in answers.
CREATE FUNCTION operator_sessions(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT sa.* INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  ELSIF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  ELSIF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id) THEN
    RAISE EXCEPTION 'this operator works quest stations' USING ERRCODE = 'OS403';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', s.id, 'kind', s.kind,
             'title', jsonb_build_object('ar', s.title_ar, 'en', s.title_en),
             'startsAt', s.starts_at, 'endsAt', s.ends_at, 'access', s.access, 'walkIns', s.walk_ins)
           ORDER BY s.starts_at, s.id)
    FROM event_session s
    WHERE s.event_id = target_event AND now() >= s.starts_at - interval '1 hour' AND now() < s.ends_at), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION operator_sessions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_sessions(uuid) TO questify_app;

-- ================================================================ the reminder scan (ADR-373 (5))
-- Registrants of a session whose reminder time has come (its start minus the organizer's minutes, default 15) and that has
-- not started: one personal notice each, marked `session:{session}:{player}` so it goes once, until the start. A player who
-- cancelled has no registration row and gets nothing. Events that are ended, archived or draft are left out. At most `lim`
-- notices a call; the number written is returned.
CREATE FUNCTION push_due_session(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT r.player_id, s.id AS session_id, e.id AS event_id, e.organizer_id, e.name_ar, e.name_en, s.starts_at,
           coalesce(s.title_ar, s.title_en) AS title_ar, coalesce(s.title_en, s.title_ar) AS title_en,
           'session:' || s.id || ':' || r.player_id AS marker
    FROM event_session s
    JOIN event e ON e.id = s.event_id
                AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    JOIN session_registration r ON r.session_id = s.id
    WHERE s.access = 'registration' AND s.starts_at > now()
      AND s.starts_at - make_interval(mins => s.reminder_minutes) <= now()
      AND NOT EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = 'session:' || s.id || ':' || r.player_id)
    ORDER BY s.starts_at, r.id
    LIMIT push_due_session.lim)
  SELECT count(notice_create('session_reminder', due.organizer_id, due.event_id, due.player_id,
                             jsonb_build_object('session', due.session_id),
                             jsonb_build_object('event', push_names(due.name_ar, due.name_en),
                                                'session', push_names(due.title_ar, due.title_en),
                                                'time', due.starts_at),
                             due.marker, due.starts_at))::integer
  FROM due
$$;
REVOKE ALL ON FUNCTION push_due_session(integer) FROM PUBLIC;

-- As 0081, plus the session reminder scan (500 notices a call).
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
  n_session  integer;
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
  n_session := push_due_session(500);
  RETURN jsonb_build_object('ready', n_ready, 'ending', n_ending, 'flash', n_flash, 'boost', n_boost,
                            'category', n_category, 'soon', n_soon, 'streak', n_streak, 'shop', n_shop,
                            'announcement', n_announce, 'session', n_session,
                            'more', greatest(n_ready, n_ending, n_flash, n_boost, n_category, n_soon, n_streak,
                                             n_shop, n_session) >= 500 OR n_announce >= 100);
END $$;
REVOKE ALL ON FUNCTION push_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_due() TO questify_app;
