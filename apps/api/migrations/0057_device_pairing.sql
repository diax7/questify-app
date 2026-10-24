-- Device pairing and the rotating screen QR (T-309, F-106, F-238, FR-314, FR-1713, ADR-239, ADR-240, ADR-241; plan
-- docs/plans/2026-10-24-t-309-stations-kiosks-pairing.md). A station page, a kiosk page or a big screen opened in any
-- browser shows an 8-character pairing code; staff claim it from staff mode or the dashboard, and the browser becomes a
-- paired device of one event (and, for a station or kiosk, one quest). The browser holds its own secret in an HttpOnly
-- cookie; only its SHA-256 is stored here, and it is replaced once at activation, so a secret seen while the page waited
-- is worthless after. A station shows the quest's rotating code: the quest id and the 30-second window of the database
-- clock, signed by the API; the door judges the window with now(). Deny by default: both tables have row-level security
-- forced, PUBLIC revoked and no grant; every new function is closed to PUBLIC here, and only the doors are granted.

-- ================================================================ the method (FR-314; ADR-240)
-- `screen_qr` on scan quests only, and never with the printed quest QR (a printed code beside a rotating one would undo
-- the rotation). NFC needs the quest QR (0056), so NFC and the screen QR are never combined (Q-203).
ALTER TABLE quest DROP CONSTRAINT quest_verification_known;
ALTER TABLE quest ADD CONSTRAINT quest_verification_known CHECK (
  verification <@ ARRAY['quest_qr', 'my_qr', 'nfc', 'screen_qr']
  AND (type <> 'scan_qr' OR cardinality(verification) >= 1)
  AND (type <> 'challenge' OR verification = ARRAY['my_qr'])
  AND (type <> 'location' OR verification = ARRAY['quest_qr'])
  AND (type IN ('scan_qr', 'challenge', 'location') OR cardinality(verification) = 0)
  AND (NOT ('nfc' = ANY (verification)) OR (type = 'scan_qr' AND 'quest_qr' = ANY (verification)))
  AND (NOT ('screen_qr' = ANY (verification)) OR (type = 'scan_qr' AND NOT ('quest_qr' = ANY (verification)))));

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport',
                    'location', 'meet_scan', 'meet_shown', 'game', 'nfc', 'screen_qr'));
-- The one-pay-per-window rule (CTO 6) reads this enrollment's latest screen completions of the quest.
CREATE INDEX quest_completion_screen_idx ON quest_completion (enrollment_id, quest_id, created_at DESC)
  WHERE method = 'screen_qr';

-- ================================================================ one clock (ADR-240)
-- The 30-second window of an instant: floor(epoch / 30). Fits 4 bytes until the year 6053.
CREATE FUNCTION screen_window_of(at timestamptz) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT floor(extract(epoch FROM at) / 30)::integer
$$;
REVOKE ALL ON FUNCTION screen_window_of(timestamptz) FROM PUBLIC;

-- The window now (the database's clock, never a screen's or a phone's) and the milliseconds until it changes.
CREATE FUNCTION screen_window(OUT window_number integer, OUT ms_to_next integer)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT screen_window_of(now()),
         greatest(ceil(((screen_window_of(now()) + 1) * 30 - extract(epoch FROM now())) * 1000), 1)::integer
$$;
REVOKE ALL ON FUNCTION screen_window() FROM PUBLIC;

-- Whether a code of window `version` is good at `at`: the current window, or the previous one while fewer than 15
-- seconds of the current one have passed (accepted at 14.999 s, refused at 15.000 s; CTO 7). So a code lives 30 seconds
-- on the screen and dies at most 15 seconds after it changed.
CREATE FUNCTION screen_window_ok(version integer, at timestamptz) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT version IS NOT NULL
     AND (version = screen_window_of(at)
          OR (version = screen_window_of(at) - 1
              AND extract(epoch FROM at) - screen_window_of(at)::numeric * 30 < 15))
$$;
REVOKE ALL ON FUNCTION screen_window_ok(integer, timestamptz) FROM PUBLIC;

-- ================================================================ the pairing request (ADR-239)
-- A browser waiting to be paired: the SHA-256 of its secret (the cookie), the keyed hash of its code, the kind of page
-- it is, and the browser and system it said it is (`client`, never more). Belongs to no one yet, so no tenant columns.
-- Written only by open_device_request, renew_device_request and the claims.
CREATE TABLE device_request (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_hash bytea NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
  code_hash   bytea NOT NULL UNIQUE CHECK (length(code_hash) = 32),
  kind        text NOT NULL CHECK (kind IN ('station', 'kiosk', 'screen')),
  client      text NOT NULL DEFAULT '' CHECK (char_length(client) <= 60),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_request_expires_idx ON device_request (expires_at);
ALTER TABLE device_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_request FORCE ROW LEVEL SECURITY;
REVOKE ALL ON device_request FROM PUBLIC;

-- ================================================================ the paired device (ADR-239)
-- One paired browser. An active device always names who paired it (an operator's assignment or a team member); a
-- revoked one may have lost it, and its `device.pair` audit row keeps who it was (CTO 1). `previous_hash` is the secret
-- replaced at activation, accepted only while `previous_until` is ahead (60 seconds, or until the new secret is first
-- used; CTO 2). Setup, not evidence: it goes with its event or quest, and the rehearsal wipe keeps it.
CREATE TABLE paired_device (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id       uuid NOT NULL,
  event_id           uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('station', 'kiosk', 'screen')),
  quest_id           uuid,
  label              text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  client             text NOT NULL DEFAULT '' CHECK (char_length(client) <= 60),
  secret_hash        bytea NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
  previous_hash      bytea UNIQUE CHECK (length(previous_hash) = 32),
  previous_until     timestamptz,
  activated_at       timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  paired_by_operator uuid REFERENCES staff_assignment (id) ON DELETE SET NULL,
  paired_by_staff    uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  paired_at          timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT paired_device_quest CHECK ((kind = 'screen') = (quest_id IS NULL)),
  CONSTRAINT paired_device_by CHECK (num_nonnulls(paired_by_operator, paired_by_staff) <= 1
                                     AND (status = 'revoked' OR num_nonnulls(paired_by_operator, paired_by_staff) = 1)),
  CONSTRAINT paired_device_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CONSTRAINT paired_device_previous CHECK ((previous_hash IS NULL) = (previous_until IS NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE
);
CREATE INDEX paired_device_event_idx ON paired_device (event_id, paired_at DESC);
CREATE INDEX paired_device_quest_idx ON paired_device (quest_id) WHERE quest_id IS NOT NULL;
CREATE INDEX paired_device_operator_idx ON paired_device (paired_by_operator) WHERE paired_by_operator IS NOT NULL;
CREATE INDEX paired_device_staff_idx ON paired_device (paired_by_staff) WHERE paired_by_staff IS NOT NULL;
ALTER TABLE paired_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE paired_device FORCE ROW LEVEL SECURITY;
REVOKE ALL ON paired_device FROM PUBLIC;

-- The device a request is about: set by the API's device guard after device_session found the row, never from a
-- request value. Device definers read their device row themselves, so a forged setting without a row opens nothing.
CREATE FUNCTION app_device_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.device_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION app_device_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_device_id() TO questify_app;

-- ================================================================ removals revoke (FR-905; CTO 1)
-- Revokes the active devices `who` names (an assignment, a staff user in an organizer, or a staff user anywhere),
-- audited `device.revoke` with the reason. Does nothing when there are none, so a delete with no devices is unchanged.
-- When the device's event is already gone (an event delete cascading to its operators), the devices go with it: they
-- are deleted rather than revoked, since the event's own cascade removes them anyway.
CREATE FUNCTION revoke_devices_of(by_operator uuid, by_staff uuid, in_organizer uuid, reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM paired_device d
                 WHERE d.status = 'active'
                   AND (d.paired_by_operator = by_operator
                        OR (d.paired_by_staff = by_staff AND (in_organizer IS NULL OR d.organizer_id = in_organizer))))
  THEN
    RETURN;
  END IF;
  DELETE FROM paired_device d
  WHERE (d.paired_by_operator = by_operator
         OR (d.paired_by_staff = by_staff AND (in_organizer IS NULL OR d.organizer_id = in_organizer)))
    AND NOT EXISTS (SELECT 1 FROM event e WHERE e.id = d.event_id);
  WITH revoked AS (
    UPDATE paired_device d SET status = 'revoked', revoked_at = now()
    WHERE d.status = 'active'
      AND (d.paired_by_operator = by_operator
           OR (d.paired_by_staff = by_staff AND (in_organizer IS NULL OR d.organizer_id = in_organizer)))
    RETURNING d.*)
  INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, before)
  SELECT 'system', r.organizer_id, r.event_id, 'device.revoke', 'paired_device', r.id::text,
         jsonb_build_object('reason', reason, 'kind', r.kind, 'label', r.label, 'questId', r.quest_id)
  FROM revoked r;
END $$;
REVOKE ALL ON FUNCTION revoke_devices_of(uuid, uuid, uuid, text) FROM PUBLIC;

CREATE FUNCTION staff_assignment_revoke_devices() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM revoke_devices_of(OLD.id, NULL, NULL, 'operator_removed');
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION staff_assignment_revoke_devices() FROM PUBLIC;
CREATE TRIGGER staff_assignment_revoke_devices BEFORE DELETE ON staff_assignment
  FOR EACH ROW EXECUTE FUNCTION staff_assignment_revoke_devices();

CREATE FUNCTION organizer_member_revoke_devices() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM revoke_devices_of(NULL, OLD.staff_user_id, OLD.organizer_id, 'member_removed');
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION organizer_member_revoke_devices() FROM PUBLIC;
CREATE TRIGGER organizer_member_revoke_devices BEFORE DELETE ON organizer_member
  FOR EACH ROW EXECUTE FUNCTION organizer_member_revoke_devices();

-- A staff user's delete: their devices are revoked before the foreign key sets `paired_by_staff` NULL.
CREATE FUNCTION staff_user_revoke_devices() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM revoke_devices_of(NULL, OLD.id, NULL, 'member_removed');
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION staff_user_revoke_devices() FROM PUBLIC;
CREATE TRIGGER staff_user_revoke_devices BEFORE DELETE ON staff_user
  FOR EACH ROW EXECUTE FUNCTION staff_user_revoke_devices();

-- ================================================================ the device's own calls (ADR-239)
-- A browser asks to be paired (`POST /v1/device/pairing`, public): stores the hashes of its secret and code for 10
-- minutes. Each call deletes up to 100 requests expired more than a day ago. DV503 busy at 5,000 unexpired requests
-- (a flood cannot fill the table; the API logs `device.request_flood`), DV409 code_taken when the code's hash exists
-- (the API draws another, up to 3 times), DV422 invalid_device kind or client.
CREATE FUNCTION open_device_request(secret bytea, code bytea, device_kind text, client_text text)
  RETURNS TABLE (request_id uuid, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made device_request%ROWTYPE;
BEGIN
  IF device_kind IS NULL OR device_kind NOT IN ('station', 'kiosk', 'screen') THEN
    RAISE EXCEPTION 'unknown device kind' USING ERRCODE = 'DV422', DETAIL = 'kind';
  END IF;
  IF secret IS NULL OR length(secret) <> 32 OR code IS NULL OR length(code) <> 32 THEN
    RAISE EXCEPTION 'a secret and a code hash are 32 bytes' USING ERRCODE = 'DV422', DETAIL = 'secret';
  END IF;
  IF char_length(coalesce(client_text, '')) > 60 THEN
    RAISE EXCEPTION 'a client name is at most 60 characters' USING ERRCODE = 'DV422', DETAIL = 'client';
  END IF;
  DELETE FROM device_request r WHERE r.id IN (
    SELECT o.id FROM device_request o WHERE o.expires_at < now() - interval '1 day' ORDER BY o.expires_at LIMIT 100);
  IF (SELECT count(*) FROM (SELECT 1 FROM device_request o WHERE o.expires_at > now() LIMIT 5000) c) >= 5000 THEN
    RAISE EXCEPTION 'too many pairing requests' USING ERRCODE = 'DV503', DETAIL = 'busy';
  END IF;
  INSERT INTO device_request (secret_hash, code_hash, kind, client, expires_at)
  VALUES (secret, code, device_kind, coalesce(client_text, ''), now() + interval '10 minutes')
  ON CONFLICT DO NOTHING
  RETURNING * INTO made;
  IF made.id IS NULL THEN
    RAISE EXCEPTION 'this code is taken' USING ERRCODE = 'DV409', DETAIL = 'code_taken';
  END IF;
  RETURN QUERY SELECT made.id, made.expires_at;
END $$;
REVOKE ALL ON FUNCTION open_device_request(bytea, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_device_request(bytea, bytea, text, text) TO questify_app;

-- A fresh code for a pending browser (its code expired, or the page was reloaded and no longer holds it): the same
-- secret, a new code hash and 10 more minutes, for at most an hour after the request was made (CTO code review 1: a
-- request kept alive for ever would let one address bucket fill the 5,000 cap; with this, one bucket holds at most
-- 6 × 60 open requests). DV401 when the secret opens no request or its hour is over (the page then asks afresh, against
-- its address limit), DV409 code_taken as above, also when another renew took the code in between.
CREATE FUNCTION renew_device_request(secret bytea, code bytea) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  until timestamptz;
BEGIN
  IF code IS NULL OR length(code) <> 32 THEN
    RAISE EXCEPTION 'a code hash is 32 bytes' USING ERRCODE = 'DV422', DETAIL = 'secret';
  END IF;
  IF EXISTS (SELECT 1 FROM device_request r WHERE r.code_hash = code) THEN
    RAISE EXCEPTION 'this code is taken' USING ERRCODE = 'DV409', DETAIL = 'code_taken';
  END IF;
  BEGIN
    UPDATE device_request r SET code_hash = code, expires_at = now() + interval '10 minutes'
    WHERE r.secret_hash = secret AND r.created_at > now() - interval '1 hour'
    RETURNING r.expires_at INTO until;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'this code is taken' USING ERRCODE = 'DV409', DETAIL = 'code_taken';
  END;
  IF until IS NULL THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DV401';
  END IF;
  RETURN until;
END $$;
REVOKE ALL ON FUNCTION renew_device_request(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION renew_device_request(bytea, bytea) TO questify_app;

-- Whether a paired device still works: active, its event not ended more than 24 hours ago, and seen within 30 days.
CREATE FUNCTION device_alive(d paired_device) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT d.status = 'active' AND d.last_seen_at > now() - interval '30 days'
     AND EXISTS (SELECT 1 FROM event e
                 WHERE e.id = d.event_id
                   AND NOT (event_status_now(e.status, e.starts_at, e.ends_at) IN ('ended', 'archived')
                            AND (e.ends_at IS NULL OR e.ends_at <= now() - interval '24 hours')))
$$;
REVOKE ALL ON FUNCTION device_alive(paired_device) FROM PUBLIC;

-- Who a device cookie is (the guard, on every device route): a paired device (its current secret; or the secret it
-- replaced at activation, only while `previous_until` is ahead, answered as not activated so it can only activate
-- again), else a pending request, else no row. The first use of a new secret ends the old one at once (CTO 2).
-- `last_seen_at` is written at most once a minute.
CREATE FUNCTION device_session(secret bytea)
  RETURNS TABLE (state text, device_id uuid, kind text, event_id uuid, quest_id uuid, activated boolean,
                 expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d   paired_device%ROWTYPE;
  req device_request%ROWTYPE;
BEGIN
  IF secret IS NULL OR length(secret) <> 32 THEN
    RETURN;
  END IF;
  SELECT * INTO d FROM paired_device p WHERE p.secret_hash = secret;
  IF FOUND THEN
    IF NOT device_alive(d) THEN
      RETURN;
    END IF;
    IF d.previous_hash IS NOT NULL OR d.last_seen_at < now() - interval '1 minute' THEN
      UPDATE paired_device p
      SET previous_hash = NULL, previous_until = NULL,
          last_seen_at = CASE WHEN p.last_seen_at < now() - interval '1 minute' THEN now() ELSE p.last_seen_at END
      WHERE p.id = d.id;
    END IF;
    RETURN QUERY SELECT 'paired', d.id, d.kind, d.event_id, d.quest_id, d.activated_at IS NOT NULL,
                        NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO d FROM paired_device p WHERE p.previous_hash = secret AND p.previous_until > now();
  IF FOUND THEN
    IF NOT device_alive(d) THEN
      RETURN;
    END IF;
    RETURN QUERY SELECT 'paired', d.id, d.kind, d.event_id, d.quest_id, false, NULL::timestamptz;
    RETURN;
  END IF;
  -- A request past its hour is no longer anyone's (renew_device_request): the page asks afresh.
  SELECT * INTO req FROM device_request r
  WHERE r.secret_hash = secret AND r.created_at > now() - interval '1 hour';
  IF FOUND THEN
    RETURN QUERY SELECT 'pending', NULL::uuid, req.kind, NULL::uuid, NULL::uuid, false, req.expires_at;
  END IF;
END $$;
REVOKE ALL ON FUNCTION device_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION device_session(bytea) TO questify_app;

-- Activation (CTO 2): the device's secret is replaced once it is paired; the old one is kept as `previous_hash` for 60
-- seconds (a lost answer does not strand the screen). A second activation with the old secret inside those 60 seconds
-- draws a fresh secret and never extends `previous_until`. Under the device row (FOR UPDATE), so an old-secret request
-- in flight is accepted or refused, never half. Answers false when the device is already activated under its current
-- secret (nothing changes, no new cookie). DV401 when the secret opens no live paired device.
CREATE FUNCTION activate_device(secret bytea, fresh bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d paired_device%ROWTYPE;
BEGIN
  IF fresh IS NULL OR length(fresh) <> 32 OR fresh = secret THEN
    RAISE EXCEPTION 'a fresh secret hash is 32 bytes' USING ERRCODE = 'DV422', DETAIL = 'secret';
  END IF;
  SELECT * INTO d FROM paired_device p
  WHERE p.secret_hash = secret OR (p.previous_hash = secret AND p.previous_until > now())
  FOR UPDATE;
  IF NOT FOUND OR NOT device_alive(d) THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DV401';
  END IF;
  IF d.secret_hash = secret THEN
    IF d.activated_at IS NOT NULL THEN
      RETURN false;
    END IF;
    UPDATE paired_device p SET secret_hash = fresh, previous_hash = secret,
                               previous_until = now() + interval '60 seconds', activated_at = now(),
                               last_seen_at = now()
    WHERE p.id = d.id;
  ELSE
    UPDATE paired_device p SET secret_hash = fresh, last_seen_at = now() WHERE p.id = d.id;
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION activate_device(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION activate_device(bytea, bytea) TO questify_app;

-- The live device of this request (app_device_id), activated, or DV401. Internal.
CREATE FUNCTION current_device() RETURNS paired_device
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  d paired_device%ROWTYPE;
BEGIN
  SELECT * INTO d FROM paired_device p WHERE p.id = app_device_id();
  IF NOT FOUND OR d.activated_at IS NULL OR NOT device_alive(d) THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DV401';
  END IF;
  RETURN d;
END $$;
REVOKE ALL ON FUNCTION current_device() FROM PUBLIC;

-- ================================================================ what a screen may show (FR-314)
-- Why a quest shows no screen code now, or NULL when it shows one: `method_off` (no longer a scan quest with the screen
-- QR on), `hidden` (not published, or a flash quest outside its launch), `not_started`, `ended` (its window), or
-- `event_ended`. A Draft or Scheduled event shows codes (rehearsal accounts may scan them; the door refuses others).
CREATE FUNCTION screen_quest_state(quest_row quest) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RETURN 'event_ended';
  END IF;
  IF quest_row.type <> 'scan_qr' OR NOT ('screen_qr' = ANY (quest_row.verification)) THEN
    RETURN 'method_off';
  END IF;
  IF quest_row.opens_at IS NOT NULL AND quest_row.opens_at > now() THEN
    RETURN 'not_started';
  END IF;
  IF quest_row.closes_at IS NOT NULL AND quest_row.closes_at <= now() THEN
    RETURN 'ended';
  END IF;
  IF NOT quest_row.visible OR NOT flash_shown(quest_row) THEN
    RETURN 'hidden';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION screen_quest_state(quest) FROM PUBLIC;

-- Whether a device paired by an operator is paused (CTO 3): that operator no longer has the ability its kind needs
-- (`show_rotating_qr` for a station, `scan_quests` for a kiosk) or the quest left their limit. A device paired by the
-- team is never paused. It resumes when the ability or quest comes back.
CREATE FUNCTION device_paused(d paired_device) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT d.paired_by_operator IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM staff_assignment sa
    WHERE sa.id = d.paired_by_operator
      AND (CASE d.kind WHEN 'station' THEN 'show_rotating_qr' WHEN 'kiosk' THEN 'scan_quests' END) = ANY (sa.abilities)
      AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = sa.id)
           OR EXISTS (SELECT 1 FROM staff_assignment_quest q
                      WHERE q.assignment_id = sa.id AND q.quest_id = d.quest_id)))
$$;
REVOKE ALL ON FUNCTION device_paused(paired_device) FROM PUBLIC;

-- The paired page's view (`GET /v1/device`, activated): its kind and label, the event's name, the quest's title and
-- points (a station or kiosk), and why it shows nothing now (`paused`, or screen_quest_state's reason), else NULL.
-- Nothing read from a ranking or a player.
CREATE FUNCTION device_view() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d         paired_device := current_device();
  ev        event%ROWTYPE;
  quest_row quest%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = d.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = d.quest_id;
  RETURN jsonb_build_object(
    'kind', d.kind, 'label', d.label,
    'event', jsonb_build_object('nameAr', ev.name_ar, 'nameEn', ev.name_en),
    'quest', CASE WHEN d.quest_id IS NULL THEN NULL
                  ELSE jsonb_build_object('titleAr', quest_row.title_ar, 'titleEn', quest_row.title_en,
                                          'points', quest_row.points) END,
    'shut', CASE WHEN d.kind = 'screen' THEN
                   CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
                        THEN 'event_ended' END
                 WHEN device_paused(d) THEN 'paused'
                 ELSE screen_quest_state(quest_row) END);
END $$;
REVOKE ALL ON FUNCTION device_view() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION device_view() TO questify_app;

-- A station's code (`GET /v1/device/screen-code`): its quest and the window now, or why it shows none (`shut`:
-- `not_station`, `paused`, or screen_quest_state's reason) with no window. A read: nothing is written per code. It takes
-- no quest argument, so a device can never ask for another quest's code.
CREATE FUNCTION screen_code_for_device()
  RETURNS TABLE (quest_id uuid, shut text, window_number integer, ms_to_next integer, title_ar text, title_en text,
                 points integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d         paired_device := current_device();
  quest_row quest%ROWTYPE;
  reason    text;
  w         record;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = d.quest_id;
  reason := CASE WHEN d.kind <> 'station' THEN 'not_station'
                 WHEN device_paused(d) THEN 'paused'
                 ELSE screen_quest_state(quest_row) END;
  SELECT * INTO w FROM screen_window();
  RETURN QUERY SELECT d.quest_id, reason,
                      CASE WHEN reason IS NULL THEN w.window_number END,
                      CASE WHEN reason IS NULL THEN w.ms_to_next END,
                      quest_row.title_ar, quest_row.title_en, quest_row.points;
END $$;
REVOKE ALL ON FUNCTION screen_code_for_device() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_code_for_device() TO questify_app;

-- ================================================================ who may pair (ADR-239)
-- The calling operator's assignment for pairing (or showing) a station or kiosk of this quest, held FOR SHARE so a
-- removal waits: OP403 not an operator of the event, OA403 the ability off (`show_rotating_qr` for a station,
-- `scan_quests` for a kiosk), DV422 invalid_device `kind` (a big screen is the dashboard's only) or `quest` (none
-- named), OQ404 no such quest in the event, OS403 outside the operator's quests. Internal.
CREATE FUNCTION device_operator(target_event uuid, device_kind text, target_quest uuid) RETURNS staff_assignment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = target_event AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF device_kind IS NULL OR device_kind NOT IN ('station', 'kiosk') THEN
    RAISE EXCEPTION 'big screens are paired from the dashboard' USING ERRCODE = 'DV422', DETAIL = 'kind';
  END IF;
  IF target_quest IS NULL THEN
    RAISE EXCEPTION 'a station or kiosk has a quest' USING ERRCODE = 'DV422', DETAIL = 'quest';
  END IF;
  IF NOT ((CASE device_kind WHEN 'kiosk' THEN 'scan_quests' ELSE 'show_rotating_qr' END) = ANY (assignment.abilities))
  THEN
    RAISE EXCEPTION 'this ability is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = target_event) THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'OQ404';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id)
     AND NOT EXISTS (SELECT 1 FROM staff_assignment_quest q
                     WHERE q.assignment_id = assignment.id AND q.quest_id = target_quest) THEN
    RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
  END IF;
  RETURN assignment;
END $$;
REVOKE ALL ON FUNCTION device_operator(uuid, text, uuid) FROM PUBLIC;

-- The pending request a code names, for the claim (FOR UPDATE: two claims of one code cannot both win) or for the
-- preview. DV404 unknown_code for an unknown or expired code, with the event's organizer as DETAIL (the API counts the
-- miss against the event and the organizer; CTO 8). Internal.
CREATE FUNCTION device_request_of(code bytea, ev event, for_claim boolean) RETURNS device_request
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  req device_request%ROWTYPE;
BEGIN
  IF for_claim THEN
    SELECT * INTO req FROM device_request r WHERE r.code_hash = code FOR UPDATE;
  ELSE
    SELECT * INTO req FROM device_request r WHERE r.code_hash = code;
  END IF;
  IF NOT FOUND OR req.expires_at <= now() THEN
    RAISE EXCEPTION 'unknown code' USING ERRCODE = 'DV404', DETAIL = ev.organizer_id::text;
  END IF;
  RETURN req;
END $$;
REVOKE ALL ON FUNCTION device_request_of(bytea, event, boolean) FROM PUBLIC;

-- The checks every claim makes on the event and the quest: DV409 event_closed (ended or archived), DV422 invalid_device
-- (`quest` named for a big screen or missing for a station or kiosk; `label` not 1 to 40 characters), DV409
-- not_screen_qr (a station's quest has no screen QR) or not_kiosk (a kiosk's quest has no kiosk method, T-309b), OQ404 a
-- quest of another event. Answers the trimmed label. Internal.
CREATE FUNCTION device_claim_check(ev event, device_kind text, target_quest uuid, device_label text) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  label_text text := btrim(coalesce(device_label, ''));
  quest_row  quest%ROWTYPE;
BEGIN
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'DV409', DETAIL = 'event_closed';
  END IF;
  IF device_kind IS NULL OR device_kind NOT IN ('station', 'kiosk', 'screen') THEN
    RAISE EXCEPTION 'unknown device kind' USING ERRCODE = 'DV422', DETAIL = 'kind';
  END IF;
  IF (device_kind = 'screen') <> (target_quest IS NULL) THEN
    RAISE EXCEPTION 'a station or kiosk has a quest; a big screen has none' USING ERRCODE = 'DV422', DETAIL = 'quest';
  END IF;
  IF char_length(label_text) NOT BETWEEN 1 AND 40 THEN
    RAISE EXCEPTION 'a label is 1 to 40 characters' USING ERRCODE = 'DV422', DETAIL = 'label';
  END IF;
  IF target_quest IS NOT NULL THEN
    SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quest not found' USING ERRCODE = 'OQ404';
    END IF;
    IF device_kind = 'station'
       AND (quest_row.type <> 'scan_qr' OR NOT ('screen_qr' = ANY (quest_row.verification))) THEN
      RAISE EXCEPTION 'this quest has no screen code' USING ERRCODE = 'DV409', DETAIL = 'not_screen_qr';
    END IF;
    IF device_kind = 'kiosk' AND NOT ('kiosk' = ANY (quest_row.verification)) THEN
      RAISE EXCEPTION 'this quest has no kiosk' USING ERRCODE = 'DV409', DETAIL = 'not_kiosk';
    END IF;
  END IF;
  RETURN label_text;
END $$;
REVOKE ALL ON FUNCTION device_claim_check(event, text, uuid, text) FROM PUBLIC;

-- Turns the request into a paired device in one transaction (lock order: the caller's assignment FOR SHARE or the team
-- check, the request FOR UPDATE, the event's device advisory lock, then the insert). DV409 wrong_kind when the page is
-- of another kind than the one chosen, limit_reached at 200 active devices an event. The request is deleted; its secret
-- is the device's until activation. Audited `device.pair` (who, kind, label, quest; never a secret or code). Internal.
CREATE FUNCTION make_device(code bytea, ev event, device_kind text, target_quest uuid, label_text text,
                            by_operator uuid, by_staff uuid, request uuid) RETURNS uuid
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  req  device_request := device_request_of(code, ev, true);
  made uuid;
BEGIN
  IF req.kind <> device_kind THEN
    RAISE EXCEPTION 'this page is another kind of device' USING ERRCODE = 'DV409', DETAIL = 'wrong_kind';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('device:' || ev.id, 0));
  IF (SELECT count(*) FROM paired_device d WHERE d.event_id = ev.id AND d.status = 'active') >= 200 THEN
    RAISE EXCEPTION 'too many devices' USING ERRCODE = 'DV409', DETAIL = 'limit_reached';
  END IF;
  INSERT INTO paired_device (organizer_id, event_id, kind, quest_id, label, client, secret_hash, paired_by_operator,
                             paired_by_staff)
  VALUES (ev.organizer_id, ev.id, device_kind, target_quest, label_text, req.client, req.secret_hash, by_operator,
          by_staff)
  RETURNING id INTO made;
  DELETE FROM device_request r WHERE r.id = req.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES (CASE WHEN by_staff IS NULL THEN 'system' ELSE 'staff' END, by_staff, ev.organizer_id, ev.id, 'device.pair',
          'paired_device', made::text,
          jsonb_build_object('kind', device_kind, 'label', label_text, 'questId', target_quest,
                             'operatorId', by_operator), request);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION make_device(bytea, event, text, uuid, text, uuid, uuid, uuid) FROM PUBLIC;

-- An operator claims a code from staff mode (stations with `show_rotating_qr`, kiosks with `scan_quests`, within their
-- quest limit; never a big screen). Refusals: device_operator's, device_claim_check's, make_device's, DV404.
CREATE FUNCTION operator_claim_device(code bytea, target_event uuid, device_kind text, target_quest uuid,
                                      device_label text, request uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  assignment staff_assignment := device_operator(target_event, device_kind, target_quest);
  ev         event%ROWTYPE;
  label_text text;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  label_text := device_claim_check(ev, device_kind, target_quest, device_label);
  RETURN make_device(code, ev, device_kind, target_quest, label_text, assignment.id, NULL, request);
END $$;
REVOKE ALL ON FUNCTION operator_claim_device(bytea, uuid, text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_claim_device(bytea, uuid, text, uuid, text, uuid) TO questify_app;

-- An owner or editor claims a code from the Devices page (any kind). AN404 outside the caller's event.
CREATE FUNCTION team_claim_device(code bytea, target_event uuid, device_kind text, target_quest uuid,
                                  device_label text, request uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  label_text text := device_claim_check(ev, device_kind, target_quest, device_label);
BEGIN
  RETURN make_device(code, ev, device_kind, target_quest, label_text, NULL, app_staff_user_id(), request);
END $$;
REVOKE ALL ON FUNCTION team_claim_device(bytea, uuid, text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_claim_device(bytea, uuid, text, uuid, text, uuid) TO questify_app;

-- What a code's page told the API, shown before staff confirm (so they can tell it is the screen in front of them):
-- its kind and client. For an operator of the event (`player` set) or the event's team. DV404 as the claim's.
CREATE FUNCTION preview_device(code bytea, target_event uuid)
  RETURNS TABLE (kind text, client text, expires_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event%ROWTYPE;
  req device_request%ROWTYPE;
BEGIN
  IF app_player_id() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM staff_assignment sa
                   WHERE sa.event_id = target_event AND sa.player_id = app_player_id()) THEN
      RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
    END IF;
    SELECT * INTO ev FROM event e WHERE e.id = target_event;
  ELSE
    ev := award_event_of(target_event);
  END IF;
  req := device_request_of(code, ev, false);
  RETURN QUERY SELECT req.kind, req.client, req.expires_at;
END $$;
REVOKE ALL ON FUNCTION preview_device(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preview_device(bytea, uuid) TO questify_app;

-- ================================================================ revoking (FR-1713)
-- Revokes one active device of the caller's event (the team) or, for an operator, one they paired. The device row FOR
-- UPDATE only. DN404 unknown, revoked or another event's (or another operator's). Audited `device.revoke`.
CREATE FUNCTION revoke_device(target_event uuid, target_device uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  assignment uuid;
  d          paired_device%ROWTYPE;
BEGIN
  IF app_player_id() IS NOT NULL THEN
    SELECT sa.id INTO assignment FROM staff_assignment sa
    WHERE sa.event_id = target_event AND sa.player_id = app_player_id();
    IF assignment IS NULL THEN
      RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
    END IF;
    SELECT * INTO ev FROM event e WHERE e.id = target_event;
  ELSE
    ev := award_event_of(target_event);
  END IF;
  SELECT * INTO d FROM paired_device p
  WHERE p.id = target_device AND p.event_id = ev.id AND p.status = 'active'
    AND (assignment IS NULL OR p.paired_by_operator = assignment)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DN404';
  END IF;
  UPDATE paired_device p SET status = 'revoked', revoked_at = now() WHERE p.id = d.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES (CASE WHEN assignment IS NULL THEN 'staff' ELSE 'system' END,
          CASE WHEN assignment IS NULL THEN app_staff_user_id() END, ev.organizer_id, ev.id, 'device.revoke',
          'paired_device', d.id::text,
          jsonb_build_object('kind', d.kind, 'label', d.label, 'questId', d.quest_id, 'operatorId', assignment),
          request);
END $$;
REVOKE ALL ON FUNCTION revoke_device(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_device(uuid, uuid, uuid) TO questify_app;

-- Revoke all, or all of one kind ("Revoke all big screens", ADR-241: the big screen's "regenerate the link"). The
-- team's only; answers how many. Audited once, `device.revoke_all`, with the kind and the count.
CREATE FUNCTION revoke_devices(target_event uuid, device_kind text, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  revoked integer;
BEGIN
  IF device_kind IS NOT NULL AND device_kind NOT IN ('station', 'kiosk', 'screen') THEN
    RAISE EXCEPTION 'unknown device kind' USING ERRCODE = 'DV422', DETAIL = 'kind';
  END IF;
  UPDATE paired_device p SET status = 'revoked', revoked_at = now()
  WHERE p.event_id = ev.id AND p.status = 'active' AND (device_kind IS NULL OR p.kind = device_kind);
  GET DIAGNOSTICS revoked = ROW_COUNT;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'device.revoke_all', 'event', ev.id::text,
          jsonb_build_object('kind', device_kind, 'revoked', revoked), request);
  RETURN revoked;
END $$;
REVOKE ALL ON FUNCTION revoke_devices(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_devices(uuid, text, uuid) TO questify_app;

-- ================================================================ the lists
-- One device as the lists show it: never a secret or a code.
CREATE FUNCTION device_json(d paired_device) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'label', d.label, 'questId', d.quest_id,
    'questTitleAr', q.title_ar, 'questTitleEn', q.title_en, 'client', d.client,
    'pairedBy', CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('type', 'operator', 'name', p.username)
                     WHEN s.id IS NOT NULL THEN jsonb_build_object('type', 'staff', 'name', s.email) END,
    'pairedAt', d.paired_at, 'lastSeenAt', d.last_seen_at, 'activated', d.activated_at IS NOT NULL,
    'status', CASE WHEN d.status = 'active' AND NOT device_alive(d) THEN 'ended' ELSE d.status END,
    'paused', d.status = 'active' AND device_paused(d), 'revokedAt', d.revoked_at)
  FROM (SELECT 1) one
  LEFT JOIN quest q ON q.id = d.quest_id
  LEFT JOIN staff_assignment sa ON sa.id = d.paired_by_operator
  LEFT JOIN player p ON p.id = sa.player_id
  LEFT JOIN staff_user s ON s.id = d.paired_by_staff
$$;
REVOKE ALL ON FUNCTION device_json(paired_device) FROM PUBLIC;

-- The event's Devices page (owners and editors): active first, newest first, the latest 300. AN404.
CREATE FUNCTION event_devices(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(device_json(x) ORDER BY x.status, x.paired_at DESC, x.id)
    FROM (SELECT * FROM paired_device d WHERE d.event_id = ev.id
          ORDER BY d.status, d.paired_at DESC, d.id LIMIT 300) x), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION event_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_devices(uuid) TO questify_app;

-- Staff mode's devices page for the calling operator (OP403): the devices they paired (the latest 50), and the quests
-- they may show or pair a station for (scan quests with the screen QR on, inside their quest limit, while
-- `show_rotating_qr` is on).
CREATE FUNCTION operator_devices(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
BEGIN
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF me IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  RETURN jsonb_build_object(
    'devices', coalesce((
      SELECT jsonb_agg(device_json(x) ORDER BY x.status, x.paired_at DESC, x.id)
      FROM (SELECT * FROM paired_device d WHERE d.event_id = target_event AND d.paired_by_operator = assignment.id
            ORDER BY d.status, d.paired_at DESC, d.id LIMIT 50) x), '[]'::jsonb),
    'quests', CASE WHEN NOT ('show_rotating_qr' = ANY (assignment.abilities)) THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'titleAr', q.title_ar, 'titleEn', q.title_en,
                                          'points', q.points)
                       ORDER BY c.position, q.position, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target_event AND q.type = 'scan_qr' AND 'screen_qr' = ANY (q.verification)
        AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
             OR EXISTS (SELECT 1 FROM staff_assignment_quest s
                        WHERE s.assignment_id = assignment.id AND s.quest_id = q.id))), '[]'::jsonb) END);
END $$;
REVOKE ALL ON FUNCTION operator_devices(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_devices(uuid) TO questify_app;

-- The operator's own phone showing a quest's code (Tools → Rotating QR, FR-922): device_operator's checks for a
-- station (`show_rotating_qr`, the quest limit), then as screen_code_for_device: the window, or why none (`shut`).
CREATE FUNCTION screen_code_for_operator(target_event uuid, target_quest uuid)
  RETURNS TABLE (quest_id uuid, shut text, window_number integer, ms_to_next integer, title_ar text, title_en text,
                 points integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  reason    text;
  w         record;
BEGIN
  PERFORM device_operator(target_event, 'station', target_quest);
  SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest;
  reason := screen_quest_state(quest_row);
  SELECT * INTO w FROM screen_window();
  RETURN QUERY SELECT quest_row.id, reason,
                      CASE WHEN reason IS NULL THEN w.window_number END,
                      CASE WHEN reason IS NULL THEN w.ms_to_next END,
                      quest_row.title_ar, quest_row.title_en, quest_row.points;
END $$;
REVOKE ALL ON FUNCTION screen_code_for_operator(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_code_for_operator(uuid, uuid) TO questify_app;

-- ================================================================ the one door
-- As 0056, with `screen_qr` on a scan quest that offers it: the window judged by the database clock after the
-- enrollment lock (QV422 expired), and one pay per player per window (CTO 6): a screen completion of this quest by this
-- enrollment in the last 45 seconds answers QD409, so one code cannot pay a repeatable quest twice. Here only
-- complete_quest passes `screen_qr`; 0058 restates this door for the kiosk's `kiosk` method.
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
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
  boosted        boost%ROWTYPE;
  paid           bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%'
     OR request_key LIKE 'meet:%' OR request_key LIKE 'game:%' THEN
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
  -- Read again after the wipe: a rehearsal launch of this flash quest is a draft again.
  SELECT * INTO quest_row FROM quest WHERE id = target;

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
  IF proof_method = 'manual' AND operator IS NOT NULL AND quest_community_lock(quest_row) IS NOT NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'community_locked';
  END IF;
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
            OR (quest_row.type = 'scan_qr' AND proof_method = 'nfc' AND 'nfc' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'screen_qr'
                AND 'screen_qr' = ANY (quest_row.verification))
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
    IF proof_method = 'screen_qr' AND NOT screen_window_ok(proof_version, now()) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'expired';
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
  -- One pay per player per screen window (CTO 6), read under the enrollment lock taken above.
  IF proof_method = 'screen_qr' AND EXISTS (
    SELECT 1 FROM quest_completion c
    WHERE c.enrollment_id = enrolled.id AND c.quest_id = target AND c.method = 'screen_qr'
      AND c.created_at > now() - interval '45 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  -- Both counts are read under the enrollment lock taken above.
  IF period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  SELECT count(*) INTO lifetime_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  PERFORM lock_quest_items(quest_row);
  -- Staff award the quest's own points: a manual award is never boosted (ADR-232).
  IF proof_method <> 'manual' THEN
    boosted := quest_boost(quest_row, enrolled, now());
  END IF;
  paid := quest_row.points::bigint * coalesce(boosted.multiplier, 1);

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id, boost_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', paid, paid, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff, boosted.id)
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

  RETURN QUERY SELECT made, paid, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- As 0048, admitting the screen QR (the API opened its code for this quest and passes its window as the version).
CREATE OR REPLACE FUNCTION complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
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
  -- My QR is the operator's method only; manual is staff's; a tag's tap is tap_quest's.
  IF proof_method IS NULL OR proof_method NOT IN ('qr', 'code', 'location', 'screen_qr') THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
  END IF;
  -- The player's own scan names no event: the quest's own is the one expected.
  RETURN QUERY SELECT * FROM record_completion(target, me, proof_method, proof_version, typed_code, request_key, device,
                                               NULL, NULL, NULL, (SELECT q.event_id FROM quest q WHERE q.id = target),
                                               reading);
END $$;
