-- Location check-in quests and the location flags (T-303b, ADR-206 to ADR-208; plan
-- docs/plans/2026-10-24-t-303b-location.md). A `location` quest has a place (pin and radius) and always its own quest
-- QR, by the database's check (FR-216). A check-in proves only that the phone claimed to be there: every value of a
-- reading is client-reported. No coordinate is stored anywhere: a reading reaches the database only as an argument and
-- leaves as rounded distances, its accuracy and the mocked mark, in completion_position, which no API role can read.
-- Two flags (FR-331, FR-332): far from the venue (from that row) and impossible speed (from quest pins only). Deny by
-- default: completion_position has no grant and no policy; the definers below are its only doors.

-- ================================================================ the venue pin and quest places
-- Optional for every kind of event; an event without a pin raises no far-from-venue flag.
ALTER TABLE event
  ADD COLUMN venue_lat      numeric(9, 6) CHECK (venue_lat BETWEEN -90 AND 90),
  ADD COLUMN venue_lng      numeric(9, 6) CHECK (venue_lng BETWEEN -180 AND 180),
  ADD COLUMN venue_radius_m integer NOT NULL DEFAULT 1000 CHECK (venue_radius_m BETWEEN 100 AND 20000),
  ADD CONSTRAINT event_venue_pin_pair CHECK ((venue_lat IS NULL) = (venue_lng IS NULL));
GRANT INSERT (venue_lat, venue_lng, venue_radius_m), UPDATE (venue_lat, venue_lng, venue_radius_m)
  ON event TO questify_app;

-- A place on the spot types only, and required for a location quest.
ALTER TABLE quest
  ADD COLUMN place_lat      numeric(9, 6) CHECK (place_lat BETWEEN -90 AND 90),
  ADD COLUMN place_lng      numeric(9, 6) CHECK (place_lng BETWEEN -180 AND 180),
  ADD COLUMN place_radius_m integer CHECK (place_radius_m BETWEEN 20 AND 2000),
  ADD CONSTRAINT quest_place_shape
    CHECK (num_nonnulls(place_lat, place_lng, place_radius_m) IN (0, 3)),
  ADD CONSTRAINT quest_place_types
    CHECK ((place_lat IS NULL OR type IN ('scan_qr', 'challenge', 'location'))
           AND (type <> 'location' OR place_lat IS NOT NULL));
GRANT INSERT (place_lat, place_lng, place_radius_m), UPDATE (place_lat, place_lng, place_radius_m)
  ON quest TO questify_app;

-- ================================================================ the type (FR-215, FR-216)
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known
  CHECK (type IN ('scan_qr', 'enter_code', 'submission', 'vote', 'quiz', 'challenge', 'survey', 'share', 'passport',
                  'location'));
-- Every location quest keeps its quest QR at the spot: the fallback for a refused or failed check-in.
ALTER TABLE quest DROP CONSTRAINT quest_verification_known;
ALTER TABLE quest ADD CONSTRAINT quest_verification_known CHECK (
  verification <@ ARRAY['quest_qr', 'my_qr']
  AND (type <> 'scan_qr' OR cardinality(verification) >= 1)
  AND (type <> 'challenge' OR verification = ARRAY['my_qr'])
  AND (type <> 'location' OR verification = ARRAY['quest_qr'])
  AND (type IN ('scan_qr', 'challenge', 'location') OR cardinality(verification) = 0));

CREATE OR REPLACE FUNCTION quest_verification_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification IS NULL THEN
    NEW.verification := CASE NEW.type WHEN 'scan_qr' THEN ARRAY['quest_qr']
                                      WHEN 'location' THEN ARRAY['quest_qr']
                                      WHEN 'challenge' THEN ARRAY['my_qr']
                                      ELSE ARRAY[]::text[] END;
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport',
                    'location'));

-- As 0046, with location: a daily check-in at a spot behaves like a daily scan.
CREATE OR REPLACE FUNCTION quest_refresh_type() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('category_refresh:' || NEW.event_id, 0));
  IF NEW.type NOT IN ('scan_qr', 'enter_code', 'challenge', 'location')
     AND EXISTS (SELECT 1 FROM category c WHERE c.id = NEW.category_id AND c.refresh <> 'none') THEN
    RAISE EXCEPTION 'only scan, code, challenge and location quests sit in a refreshing category'
      USING ERRCODE = 'QT422', DETAIL = 'refresh';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION category_refresh_type() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('category_refresh:' || NEW.event_id, 0));
  IF EXISTS (SELECT 1 FROM quest q
             WHERE q.category_id = NEW.id AND q.type NOT IN ('scan_qr', 'enter_code', 'challenge', 'location')) THEN
    RAISE EXCEPTION 'only scan, code, challenge and location quests sit in a refreshing category'
      USING ERRCODE = 'QT422', DETAIL = 'refresh';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ what is kept of a reading (ADR-206)
-- One row per completion that came with a usable reading: rounded distances, the reported accuracy and Android's
-- mocked mark, never a coordinate. Personal data: deleted with the account, and with its completion (cascade).
CREATE TABLE completion_position (
  completion_id    bigint PRIMARY KEY REFERENCES quest_completion (id) ON DELETE CASCADE,
  organizer_id     uuid NOT NULL,
  event_id         uuid NOT NULL,
  enrollment_id    uuid NOT NULL,
  accuracy_m       integer NOT NULL CHECK (accuracy_m BETWEEN 0 AND 10000),
  mocked           boolean NOT NULL,
  -- From the event's venue pin, rounded to 10 m; NULL without a pin or in a virtual event.
  venue_distance_m integer CHECK (venue_distance_m >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX completion_position_enrollment ON completion_position (enrollment_id);
ALTER TABLE completion_position ENABLE ROW LEVEL SECURITY;
ALTER TABLE completion_position FORCE ROW LEVEL SECURITY;
REVOKE ALL ON completion_position FROM PUBLIC;

-- ================================================================ reading a position
-- A reading `{lat, lng, accuracyM, ageS, mocked?}` as numbers, or all NULL when its shape is bad: not an object, an
-- extra key, a value not a number (mocked not a boolean), out of range, accuracy not 0 < a <= 10000, age not
-- 0 <= s <= 86400. The age is returned, not judged: the caller tells a stale fix from a bad one. Never raises, so a bad
-- reading never blocks a QR or code scan. Numbers are compared as numeric first, so a huge one cannot overflow.
CREATE FUNCTION position_of(reading jsonb, OUT lat double precision, OUT lng double precision,
                            OUT accuracy_m double precision, OUT age_s double precision, OUT mocked boolean)
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF reading IS NULL OR jsonb_typeof(reading) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(reading) k WHERE k NOT IN ('lat', 'lng', 'accuracyM', 'ageS', 'mocked'))
  THEN
    RETURN;
  END IF;
  IF jsonb_typeof(reading -> 'lat') IS DISTINCT FROM 'number' OR jsonb_typeof(reading -> 'lng') IS DISTINCT FROM 'number'
     OR jsonb_typeof(reading -> 'accuracyM') IS DISTINCT FROM 'number'
     OR jsonb_typeof(reading -> 'ageS') IS DISTINCT FROM 'number'
     OR (reading ? 'mocked' AND jsonb_typeof(reading -> 'mocked') IS DISTINCT FROM 'boolean') THEN
    RETURN;
  END IF;
  IF NOT ((reading ->> 'lat')::numeric BETWEEN -90 AND 90 AND (reading ->> 'lng')::numeric BETWEEN -180 AND 180
          AND (reading ->> 'accuracyM')::numeric > 0 AND (reading ->> 'accuracyM')::numeric <= 10000
          AND (reading ->> 'ageS')::numeric BETWEEN 0 AND 86400) THEN
    RETURN;
  END IF;
  lat := (reading ->> 'lat')::double precision;
  lng := (reading ->> 'lng')::double precision;
  accuracy_m := (reading ->> 'accuracyM')::double precision;
  age_s := (reading ->> 'ageS')::double precision;
  mocked := coalesce((reading ->> 'mocked')::boolean, false);
END $$;
REVOKE ALL ON FUNCTION position_of(jsonb) FROM PUBLIC;

-- Metres between two points on a 6371008 m sphere (haversine). No PostGIS: one formula is not worth a dependency.
CREATE FUNCTION distance_m(lat1 double precision, lng1 double precision, lat2 double precision,
                           lng2 double precision) RETURNS double precision
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 2 * 6371008 * asin(least(1, sqrt(power(sin(radians(lat2 - lat1) / 2), 2)
                                          + cos(radians(lat1)) * cos(radians(lat2))
                                            * power(sin(radians(lng2 - lng1) / 2), 2))))
$$;
REVOKE ALL ON FUNCTION distance_m(double precision, double precision, double precision, double precision) FROM PUBLIC;

-- A distance as the player and the team see it: rounded to 10 m.
CREATE FUNCTION rounded_m(metres double precision) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (round(metres / 10) * 10)::integer
$$;
REVOKE ALL ON FUNCTION rounded_m(double precision) FROM PUBLIC;

-- A check-in's verdict (ADR-206): raises QV422 with the reason, or returns when the reading is inside the quest's
-- place. No reading, a bad shape, a fix older than 2 minutes or less precise than 500 m are refused before any
-- distance; then the fix must be within the radius plus its accuracy, the allowance capped at the radius so a coarse
-- fix never passes a far player. not_here carries the rounded distance in HINT (the player's own number).
CREATE FUNCTION check_in_check(quest_row quest, reading jsonb) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fix record;
  far double precision;
BEGIN
  IF reading IS NULL THEN
    RAISE EXCEPTION 'no position' USING ERRCODE = 'QV422', DETAIL = 'no_position';
  END IF;
  SELECT * INTO fix FROM position_of(reading);
  IF fix.lat IS NULL THEN
    RAISE EXCEPTION 'bad position' USING ERRCODE = 'QV422', DETAIL = 'bad_position';
  END IF;
  IF fix.age_s > 120 THEN
    RAISE EXCEPTION 'stale position' USING ERRCODE = 'QV422', DETAIL = 'stale';
  END IF;
  IF fix.accuracy_m > 500 THEN
    RAISE EXCEPTION 'imprecise position' USING ERRCODE = 'QV422', DETAIL = 'imprecise';
  END IF;
  far := distance_m(fix.lat, fix.lng, quest_row.place_lat::double precision, quest_row.place_lng::double precision);
  IF far > quest_row.place_radius_m + least(fix.accuracy_m, quest_row.place_radius_m) THEN
    RAISE EXCEPTION 'not at the spot' USING ERRCODE = 'QV422', DETAIL = 'not_here', HINT = rounded_m(far)::text;
  END IF;
END $$;
REVOKE ALL ON FUNCTION check_in_check(quest, jsonb) FROM PUBLIC;

-- Keeps what a usable reading (well shaped, no older than 2 minutes) says about a completion; a bad, stale or absent
-- one keeps nothing, and nothing is kept in a virtual event (FR-1744: no location flag there). The venue distance only
-- for an event with a pin.
CREATE FUNCTION keep_position(made bigint, enrolled enrollment, reading jsonb) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  fix record;
  ev  event%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  IF ev.kind = 'virtual' THEN
    RETURN;
  END IF;
  SELECT * INTO fix FROM position_of(reading);
  IF fix.lat IS NULL OR fix.age_s > 120 THEN
    RETURN;
  END IF;
  INSERT INTO completion_position (completion_id, organizer_id, event_id, enrollment_id, accuracy_m, mocked,
                                   venue_distance_m)
  VALUES (made, enrolled.organizer_id, enrolled.event_id, enrolled.id, round(fix.accuracy_m)::integer, fix.mocked,
          CASE WHEN ev.venue_lat IS NOT NULL
               THEN rounded_m(distance_m(fix.lat, fix.lng, ev.venue_lat::double precision,
                                         ev.venue_lng::double precision)) END);
END $$;
REVOKE ALL ON FUNCTION keep_position(bigint, enrollment, jsonb) FROM PUBLIC;

-- ================================================================ the payer and the player's door
-- As 0047, with a 12th parameter: the phone's reading. A location proof is judged by check_in_check before any count is
-- read; a quest QR completes a location quest too (FR-216). A usable reading of any proof is kept beside the completion
-- (keep_position). A replay ignores the reading and answers the first completion. Every existing caller passes 11
-- arguments and keeps working (the default).
DROP FUNCTION record_completion(uuid, uuid, text, integer, text, text, uuid, uuid, uuid, text, uuid);
CREATE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                  typed_code text, request_key text, device uuid, operator uuid,
                                  staff uuid, reason text, expected_event uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row      quest%ROWTYPE;
  enrolled       enrollment%ROWTYPE;
  earlier        quest_completion%ROWTYPE;
  earlier_by     uuid;
  earlier_staff  uuid;
  lifetime_count integer;
  made           bigint;
  entry          bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
    RAISE EXCEPTION 'this key is reserved' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.event_id IS DISTINCT FROM expected_event THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment WHERE event_id = quest_row.event_id AND player_id = who FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;

  SELECT * INTO earlier FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.idempotency_key = request_key;
  IF FOUND THEN
    SELECT l.operator_id, l.staff_user_id INTO earlier_by, earlier_staff
    FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    IF earlier.quest_id <> target OR earlier.method <> proof_method OR earlier_by IS DISTINCT FROM operator
       OR earlier_staff IS DISTINCT FROM staff THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, l.score_delta, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled, proof_method = 'manual');
  -- A quiz in play pays itself at its end; a manual award now would pay the quest twice (T-302).
  IF proof_method = 'manual' AND quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target AND a.status = 'open') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type IN ('scan_qr', 'location') AND proof_method = 'qr'
             AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'location' AND proof_method = 'location')
            OR (quest_row.type = 'enter_code' AND proof_method = 'code')
            OR (quest_row.type = 'vote' AND proof_method = 'vote')
            OR (quest_row.type = 'survey' AND proof_method = 'survey')
            OR (quest_row.type = 'share' AND proof_method = 'share')) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
    END IF;
    IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
    END IF;
    IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
    END IF;
    IF proof_method = 'location' THEN
      PERFORM check_in_check(quest_row, reading);
    END IF;
  END IF;

  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  -- Both counts are read under the enrollment lock taken above.
  IF period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  SELECT count(*) INTO lifetime_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  PERFORM lock_quest_items(quest_row);

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff)
  RETURNING id INTO entry;
  IF proof_method = 'manual' THEN
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason)
    VALUES (entry, enrolled.organizer_id, enrolled.event_id, clean_reason(reason));
    INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
    SELECT enrolled.organizer_id, enrolled.event_id, enrolled.id, c.id
    FROM category c WHERE c.id = quest_row.category_id AND c.hidden
    ON CONFLICT DO NOTHING;
  END IF;
  IF lifetime_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);

  RETURN QUERY SELECT made, quest_row.points::bigint, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION record_completion(uuid, uuid, text, integer, text, text, uuid, uuid, uuid, text, uuid, jsonb)
  FROM PUBLIC;

-- As 0030, with the reading and the location proof. The signature changed: DROP and CREATE, REVOKE and GRANT repeated.
DROP FUNCTION complete_quest(uuid, text, integer, text, text, uuid);
CREATE FUNCTION complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
                               request_key text, device uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- My QR is the operator's method only; manual is staff's.
  IF proof_method IS NULL OR proof_method NOT IN ('qr', 'code', 'location') THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
  END IF;
  -- The player's own scan names no event: the quest's own is the one expected.
  RETURN QUERY SELECT * FROM record_completion(target, me, proof_method, proof_version, typed_code, request_key, device,
                                               NULL, NULL, NULL, (SELECT q.event_id FROM quest q WHERE q.id = target),
                                               reading);
END $$;
REVOKE ALL ON FUNCTION complete_quest(uuid, text, integer, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_quest(uuid, text, integer, text, text, uuid, jsonb) TO questify_app;

-- ================================================================ the flags (FR-331, FR-332; ADR-207)
ALTER TABLE flag DROP CONSTRAINT flag_kind_check;
ALTER TABLE flag ADD CONSTRAINT flag_kind_check
  CHECK (kind IN ('shared_device', 'burst', 'far_from_venue', 'impossible_speed'));
-- One open case per account and kind; evidence {"completions": [ids]}, the newest 50.
CREATE UNIQUE INDEX flag_location_open ON flag (enrollment_id, kind)
  WHERE kind IN ('far_from_venue', 'impossible_speed') AND status = 'open';

-- The location flag numbers (Q-171) until T-703 makes them console settings. Their own function, beside 0031's
-- flag_tuning (left as it is, with its callers and grants).
CREATE FUNCTION location_tuning(OUT far_margin_m integer, OUT speed_mps double precision, OUT speed_min_gap_m integer)
  LANGUAGE sql IMMUTABLE AS $$ SELECT 1000, 15::double precision, 300 $$;
REVOKE ALL ON FUNCTION location_tuning() FROM PUBLIC;

-- Opens a location case for the account, or adds these completions to its open one (the newest 50 kept).
CREATE FUNCTION raise_location_flag(done quest_completion, flag_kind text, completions jsonb) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
  VALUES (done.organizer_id, done.event_id, done.enrollment_id, flag_kind, jsonb_build_object('completions', completions))
  ON CONFLICT (enrollment_id, kind) WHERE kind IN ('far_from_venue', 'impossible_speed') AND status = 'open' DO UPDATE
  SET last_seen_at = now(),
      evidence = jsonb_build_object('completions', (
        SELECT jsonb_agg(x ORDER BY x) FROM (
          SELECT DISTINCT x FROM jsonb_array_elements((flag.evidence -> 'completions') || (EXCLUDED.evidence -> 'completions')) x
          ORDER BY x DESC LIMIT 50) newest));
END $$;
REVOKE ALL ON FUNCTION raise_location_flag(quest_completion, text, jsonb) FROM PUBLIC;

-- Far from the venue (FR-331, FR-1744): raised when a completion's position row is written (after the completion, so
-- raise_completion_flags cannot see it). Never in a virtual event, never for a manual or system-paid completion. A
-- mocked fix, or a fix that less its accuracy is beyond the venue radius plus the margin.
CREATE FUNCTION raise_position_flags() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  done   quest_completion%ROWTYPE;
  ev     event%ROWTYPE;
  tuning record;
BEGIN
  SELECT * INTO done FROM quest_completion c WHERE c.id = NEW.completion_id;
  IF done.method = 'manual' OR system_paid(done.method, done.idempotency_key) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = NEW.event_id;
  IF ev.kind = 'virtual' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO tuning FROM location_tuning();
  IF NEW.mocked OR coalesce(NEW.venue_distance_m - NEW.accuracy_m > ev.venue_radius_m + tuning.far_margin_m, false) THEN
    PERFORM raise_location_flag(done, 'far_from_venue', jsonb_build_array(done.id));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION raise_position_flags() FROM PUBLIC;
CREATE TRIGGER completion_position_flags AFTER INSERT ON completion_position
  FOR EACH ROW EXECUTE FUNCTION raise_position_flags();

-- The player's counted completion at a placed quest just before this one (manual and system-paid ones aside), by
-- server receipt time: the other end of a speed check.
CREATE FUNCTION previous_placed(done quest_completion)
  RETURNS TABLE (id bigint, created_at timestamptz, place_lat numeric, place_lng numeric, place_radius_m integer)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT c.id, c.created_at, q.place_lat, q.place_lng, q.place_radius_m
  FROM quest_completion c JOIN quest q ON q.id = c.quest_id
  WHERE c.enrollment_id = done.enrollment_id AND (c.created_at, c.id) < (done.created_at, done.id)
    AND c.method <> 'manual' AND NOT system_paid(c.method, c.idempotency_key) AND q.place_lat IS NOT NULL
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION previous_placed(quest_completion) FROM PUBLIC;

-- Edge to edge: the metres between two quest places less both radii (never below 0).
CREATE FUNCTION place_gap_m(lat1 numeric, lng1 numeric, r1 integer, lat2 numeric, lng2 numeric, r2 integer)
  RETURNS double precision
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT greatest(0, distance_m(lat1::double precision, lng1::double precision, lat2::double precision,
                                lng2::double precision) - r1 - r2)
$$;
REVOKE ALL ON FUNCTION place_gap_m(numeric, numeric, integer, numeric, numeric, integer) FROM PUBLIC;

-- Impossible speed (FR-332): two completions at placed quests at least the minimum gap apart, edge to edge, faster than
-- the speed limit. Quest pins only: it needs no phone position and works with location refused. A station scan
-- counts (the player stood at that station).
CREATE FUNCTION raise_speed_flag(done quest_completion) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  here   quest%ROWTYPE;
  prev   record;
  tuning record;
  gap    double precision;
BEGIN
  SELECT * INTO here FROM quest q WHERE q.id = done.quest_id;
  IF here.place_lat IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO prev FROM previous_placed(done);
  IF prev.id IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO tuning FROM location_tuning();
  gap := place_gap_m(here.place_lat, here.place_lng, here.place_radius_m, prev.place_lat, prev.place_lng,
                     prev.place_radius_m);
  IF gap >= tuning.speed_min_gap_m
     AND gap / greatest(extract(epoch FROM done.created_at - prev.created_at)::double precision, 1) > tuning.speed_mps
  THEN
    PERFORM raise_location_flag(done, 'impossible_speed', jsonb_build_array(prev.id, done.id));
  END IF;
END $$;
REVOKE ALL ON FUNCTION raise_speed_flag(quest_completion) FROM PUBLIC;

-- As 0041, plus the speed check (never in a virtual event). Reads only the player's own rows, under the enrollment lock
-- every payer already holds; no new lock.
CREATE OR REPLACE FUNCTION raise_completion_flags() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tuning  record;
  since   timestamptz;
  recent  jsonb;
BEGIN
  IF NEW.method = 'manual' OR system_paid(NEW.method, NEW.idempotency_key) THEN
    RETURN NULL;
  END IF;
  IF NEW.device_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('device:' || NEW.event_id || ':' || NEW.device_id, 0));
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, device_id)
    SELECT NEW.organizer_id, NEW.event_id, s.enrollment_id, 'shared_device', NEW.device_id
    FROM (SELECT DISTINCT c.enrollment_id FROM quest_completion c
          JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
          WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id) s
    WHERE EXISTS (SELECT 1 FROM quest_completion c
                  JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
                  WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id
                    AND c.enrollment_id <> NEW.enrollment_id)
    ORDER BY s.enrollment_id
    ON CONFLICT (enrollment_id, device_id) WHERE kind = 'shared_device' DO NOTHING;
  END IF;

  SELECT * INTO tuning FROM flag_tuning();
  SELECT max(f.resolved_at) INTO since FROM flag f
  WHERE f.enrollment_id = NEW.enrollment_id AND f.kind = 'burst' AND f.status <> 'open';
  SELECT jsonb_agg(c.id ORDER BY c.id) INTO recent FROM quest_completion c
  WHERE c.enrollment_id = NEW.enrollment_id AND c.method <> 'manual'
    AND NOT system_paid(c.method, c.idempotency_key)
    AND c.created_at > now() - tuning.burst_window AND c.created_at > coalesce(since, '-infinity');
  IF jsonb_array_length(coalesce(recent, '[]'::jsonb)) >= tuning.burst_count THEN
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
    VALUES (NEW.organizer_id, NEW.event_id, NEW.enrollment_id, 'burst', jsonb_build_object('completions', recent))
    ON CONFLICT (enrollment_id) WHERE kind = 'burst' AND status = 'open' DO UPDATE
    SET last_seen_at = now(),
        evidence = jsonb_build_object('completions', (
          SELECT jsonb_agg(x ORDER BY x) FROM (
            SELECT DISTINCT x FROM jsonb_array_elements((flag.evidence -> 'completions') || (EXCLUDED.evidence -> 'completions')) x
            ORDER BY x DESC LIMIT 50) newest));
  END IF;

  IF EXISTS (SELECT 1 FROM event e WHERE e.id = NEW.event_id AND e.kind <> 'virtual') THEN
    PERFORM raise_speed_flag(NEW);
  END IF;
  RETURN NULL;
END $$;

-- As 0031; the scans count for every kind that holds completions.
CREATE OR REPLACE FUNCTION event_flags(target_event uuid, open_only boolean, before_id bigint, page integer)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, enrollment_id uuid, username text, avatar text,
                 accounts integer, scans integer, waiting integer, hold boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.raised_at, f.last_seen_at, f.resolved_at, f.enrollment_id,
         p.username, p.avatar,
         CASE WHEN f.kind = 'shared_device' THEN
           (SELECT count(DISTINCT c.enrollment_id)::integer FROM quest_completion c
            WHERE c.event_id = ev.id AND c.device_id = f.device_id) END,
         CASE WHEN f.kind <> 'shared_device' THEN jsonb_array_length(f.evidence -> 'completions') END,
         (SELECT count(*)::integer FROM redemption d WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         ev.flag_hold
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE f.event_id = ev.id AND (f.status = 'open') = coalesce(open_only, true)
    AND (before_id IS NULL OR f.id < before_id)
  ORDER BY f.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;

-- As 0047; each completion line adds what its position row kept (distanceM from the venue, accuracyM, mocked) and,
-- for a completion at a placed quest, the edge-to-edge gap and the seconds from the player's previous counted
-- completion at a placed quest (gapM, seconds; NULL for the first). Never a coordinate.
CREATE OR REPLACE FUNCTION flag_detail(target_event uuid, target_flag bigint)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, note text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, resolved_by text, enrollment_id uuid,
                 username text, avatar text, enrollment_status text, paused boolean, hold boolean,
                 evidence jsonb, waiting jsonb, removals jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.note, f.raised_at, f.last_seen_at, f.resolved_at, su.email,
         f.enrollment_id, p.username, p.avatar, n.status, n.redeem_paused_at IS NOT NULL, ev.flag_hold,
         CASE WHEN f.kind = 'shared_device' THEN (
           SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId', a.enrollment_id, 'username', ap.username,
                                                        'lastScanAt', a.last_at) ORDER BY a.last_at DESC), '[]')
           FROM (SELECT c.enrollment_id, max(c.created_at) AS last_at FROM quest_completion c
                 WHERE c.event_id = ev.id AND c.device_id = f.device_id GROUP BY c.enrollment_id) a
           JOIN enrollment an ON an.id = a.enrollment_id JOIN player ap ON ap.id = an.player_id)
         ELSE (
           SELECT coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'method', c.method, 'questAr', q.title_ar,
                                                        'questEn', q.title_en, 'operator', op.username,
                                                        'distanceM', cp.venue_distance_m, 'accuracyM', cp.accuracy_m,
                                                        'mocked', cp.mocked,
                                                        'gapM', CASE WHEN q.place_lat IS NOT NULL AND pv.id IS NOT NULL THEN rounded_m(
                                                          place_gap_m(q.place_lat, q.place_lng, q.place_radius_m,
                                                                      pv.place_lat, pv.place_lng, pv.place_radius_m))
                                                          END,
                                                        'seconds', CASE WHEN q.place_lat IS NOT NULL AND pv.id IS NOT NULL THEN
                                                          round(extract(epoch FROM c.created_at - pv.created_at))::integer
                                                          END)
                                     ORDER BY c.id), '[]')
           FROM quest_completion c
           JOIN quest q ON q.id = c.quest_id
           LEFT JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
           LEFT JOIN player op ON op.id = l.operator_id
           LEFT JOIN completion_position cp ON cp.completion_id = c.id
           LEFT JOIN LATERAL previous_placed(c) pv ON true
           WHERE c.enrollment_id = f.enrollment_id
             AND c.id IN (SELECT (x #>> '{}')::bigint FROM jsonb_array_elements(f.evidence -> 'completions') x))
         END,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('nameAr', coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                       'nameEn', coalesce(r.name_en, k.name_en, i.name_en),
                                                       'reservedUntil', d.reserved_until) ORDER BY d.created_at), '[]')
          FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
          LEFT JOIN quest_item i ON i.id = d.quest_item_id
          WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('entryId', l.id, 'at', l.created_at, 'score', l.score_delta,
                                                       'balance', l.balance_delta, 'reason', ln.reason)
                                    ORDER BY l.id), '[]')
          FROM ledger_entry l LEFT JOIN ledger_note ln ON ln.entry_id = l.id
          WHERE l.enrollment_id = f.enrollment_id AND l.kind = 'removal' AND l.created_at >= f.raised_at)
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN staff_user su ON su.id = f.resolved_by
  WHERE f.id = target_flag AND f.event_id = ev.id;
END $$;

-- ================================================================ the player's quest list
-- As 0047, with a location quest's place (the organizer's spot, so the app can say how far it is). Other quests'
-- places are not sent to players. The output changed: DROP and CREATE.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz,
                 item_ar text, item_en text, bonus_item_ar text, bonus_item_en text, place_lat numeric,
                 place_lng numeric, place_radius_m integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         period_count(me.id, q)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification,
         c.order_mode, c.opens_at, c.unlock_after,
         CASE WHEN sees_category(me.id, u) THEN u.name_ar END,
         CASE WHEN sees_category(me.id, u) THEN u.name_en END,
         c.completion_bonus,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.category_id = c.id),
         EXISTS (SELECT 1 FROM category_bonus b
                 WHERE b.enrollment_id = me.id AND b.category_id = c.id
                   AND b.period_start >= category_period_start(c, e)),
         category_lock(q, me.id),
         CASE WHEN q.type = 'passport' THEN (SELECT count(*)::int FROM passport_stamp p
                                             WHERE p.enrollment_id = me.id AND p.quest_id = q.id) END,
         CASE WHEN q.type = 'passport' THEN (q.type_config ->> 'needed')::int END,
         c.refresh,
         category_resets_at(c, e),
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_ar END,
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_en END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_ar END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_en END,
         CASE WHEN q.type = 'location' THEN q.place_lat END,
         CASE WHEN q.type = 'location' THEN q.place_lng END,
         CASE WHEN q.type = 'location' THEN q.place_radius_m END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ erasure
-- As 0047, plus: the account's position rows are deleted.
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM player_fingerprint WHERE player_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
