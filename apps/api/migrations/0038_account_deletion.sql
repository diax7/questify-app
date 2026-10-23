-- Account deletion (T-217, FR-126, FR-127, FR-128, FR-1704, FR-1739; ADR-175 to ADR-178). A deleted account becomes a
-- tombstone: the player row keeps its id with status 'deleted' and nothing personal, so the ledger, enrollments,
-- frozen results and handed-over prizes stay right and name no one. Deletion takes a fresh code (its own challenge,
-- never a sign-in) and a single-use deletion token. A keyed fingerprint of every contact the account held survives
-- only as ban and welcome marks, so an event ban and the welcome reward still apply after a re-sign-up.

-- ================================================================ the tombstone
ALTER TABLE player ALTER COLUMN username DROP NOT NULL;
ALTER TABLE player ADD CONSTRAINT player_tombstone CHECK ((username IS NULL) = (status = 'deleted'));

-- Deletion goes through erase_player only: a player can no longer set their own status (the tombstone check also
-- stops an admin from making or reviving a tombstone by hand).
CREATE OR REPLACE FUNCTION player_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A wall for the API's own role; the owner connection (migrations, definers, support work) is trusted.
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF (NEW.status IS DISTINCT FROM OLD.status OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) AND NOT app_is_admin()
  THEN
    RAISE EXCEPTION 'only a Questify admin can change a player''s status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- A tombstone's cleared name is not a rename.
CREATE OR REPLACE FUNCTION record_username() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO username_history (player_id, username, reason) VALUES (NEW.id, NEW.username, 'signup');
  ELSIF NEW.username IS DISTINCT FROM OLD.username AND NEW.username IS NOT NULL THEN
    INSERT INTO username_history (player_id, username, reason) VALUES (NEW.id, NEW.username, 'rename');
  END IF;
  RETURN NULL;
END $$;

-- ================================================================ fingerprints (ADR-176)
-- An HMAC-SHA256 of a normalised contact under a key only the API holds: every contact the account ever held, so a
-- contact change cannot wash a ban out. Fingerprints only, never the contact. No grant: definers only.
CREATE TABLE player_fingerprint (
  player_id   uuid NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, fingerprint)
);
CREATE INDEX player_fingerprint_fingerprint_idx ON player_fingerprint (fingerprint);
ALTER TABLE player_fingerprint ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_fingerprint FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_fingerprint FROM PUBLIC;

-- What a deleted account leaves: a ban in an event (until the event's data goes), the welcome reward of an event (until
-- the event ends) and a platform ban (event NULL). No player id: nothing here leads back to anyone.
CREATE TABLE erased_mark (
  fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
  event_id    uuid REFERENCES event (id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('banned', 'welcomed')),
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (event_id IS NOT NULL OR kind = 'banned'),
  CHECK ((kind = 'welcomed') = (expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX erased_mark_key ON erased_mark (fingerprint, event_id, kind) NULLS NOT DISTINCT;
CREATE INDEX erased_mark_event_idx ON erased_mark (event_id);
ALTER TABLE erased_mark ENABLE ROW LEVEL SECURITY;
ALTER TABLE erased_mark FORCE ROW LEVEL SECURITY;
REVOKE ALL ON erased_mark FROM PUBLIC;

-- Whether any fingerprint the player holds carries this mark for this event (NULL: the platform).
CREATE FUNCTION erased_marked(holder uuid, target_event uuid, mark text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM player_fingerprint f JOIN erased_mark m ON m.fingerprint = f.fingerprint
    WHERE f.player_id = holder AND m.event_id IS NOT DISTINCT FROM target_event AND m.kind = mark
      AND (m.expires_at IS NULL OR m.expires_at > now()))
$$;
REVOKE ALL ON FUNCTION erased_marked(uuid, uuid, text) FROM PUBLIC;

CREATE FUNCTION platform_marked(contact_fp bytea) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM erased_mark m WHERE m.fingerprint = contact_fp AND m.event_id IS NULL)
$$;
REVOKE ALL ON FUNCTION platform_marked(bytea) FROM PUBLIC;

-- Challenges live minutes: the ones open at deploy are dropped, so the fingerprint can be required.
DELETE FROM player_login_challenge;
ALTER TABLE player_login_challenge
  ADD COLUMN contact_fp bytea NOT NULL CHECK (octet_length(contact_fp) = 32);
DELETE FROM player_contact_challenge;
ALTER TABLE player_contact_challenge
  ADD COLUMN contact_fp bytea NOT NULL CHECK (octet_length(contact_fp) = 32);

-- ================================================================ sign-in, sign-up and contact change record them
DROP FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text);
-- As 0017, plus the contact's fingerprint.
CREATE FUNCTION start_player_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                       code bytea, terms text, privacy text, fp bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE player_login_challenge SET cancelled_at = now()
  WHERE contact_key = key AND cancelled_at IS NULL;
  INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                      terms_version, privacy_version, contact_fp)
  VALUES (challenge, token, method, contact_value, key, code, now() + interval '5 minutes', terms, privacy, fp);
END $$;
REVOKE ALL ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea)
  TO questify_app;

-- As 0017, plus: a new contact with a platform mark is refused as banned (after the right code only), and a returning
-- player's fingerprint is recorded (accounts made before 0038 gain it at their next sign-in).
CREATE OR REPLACE FUNCTION sign_in_player(token bytea, code bytea, access_hash bytea, refresh_hash bytea, family uuid,
                               signup bytea)
  RETURNS TABLE (outcome text, attempts_left integer, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_challenge player_login_challenge%ROWTYPE;
  owner           uuid;
  owner_status    text;
BEGIN
  IF signup IS NULL THEN
    RAISE EXCEPTION 'sign_in_player needs a signup token hash' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO found_challenge FROM player_login_challenge c
  WHERE c.token_hash = token AND c.cancelled_at IS NULL AND c.signup_hash IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR found_challenge.attempts >= 3 THEN
    RETURN QUERY SELECT 'expired'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  IF found_challenge.code_hash <> code THEN
    UPDATE player_login_challenge SET attempts = attempts + 1 WHERE id = found_challenge.id;
    RETURN QUERY SELECT 'wrong'::text, 2 - found_challenge.attempts, NULL::uuid;
    RETURN;
  END IF;

  SELECT p.id, p.status INTO owner, owner_status FROM player_contact pc JOIN player p ON p.id = pc.player_id
  WHERE (found_challenge.channel = 'phone' AND pc.phone_e164 = found_challenge.contact)
     OR (found_challenge.channel = 'email' AND pc.email = found_challenge.contact);
  IF owner IS NULL AND platform_marked(found_challenge.contact_fp) THEN
    DELETE FROM player_login_challenge WHERE id = found_challenge.id;
    RETURN QUERY SELECT 'banned'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  IF owner IS NULL THEN
    UPDATE player_login_challenge
    SET signup_hash = signup, signup_expires_at = now() + interval '15 minutes'
    WHERE id = found_challenge.id;
    RETURN QUERY SELECT 'new'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  DELETE FROM player_login_challenge WHERE id = found_challenge.id;
  IF owner_status <> 'active' THEN
    RETURN QUERY SELECT 'banned'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (owner, found_challenge.contact_fp)
  ON CONFLICT DO NOTHING;
  -- A returning player accepted the versions in force before the code was sent; record them too (once each).
  INSERT INTO player_acceptance (player_id, document, version, method, accepted_at)
  VALUES (owner, 'terms_of_use', found_challenge.terms_version, 'sign_in', found_challenge.created_at),
         (owner, 'privacy_policy', found_challenge.privacy_version, 'sign_in', found_challenge.created_at)
  ON CONFLICT DO NOTHING;
  PERFORM issue_player_tokens(owner, access_hash, refresh_hash, family);
  RETURN QUERY SELECT 'signed_in'::text, 0, owner;
END $$;

-- As 0017, plus the fingerprint, and a platform mark set after the code was checked ends the attempt.
CREATE OR REPLACE FUNCTION create_player(signup bytea, chosen_name text, born integer, chosen_avatar text, access_hash bytea,
                              refresh_hash bytea, family uuid)
  RETURNS TABLE (outcome text, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_challenge player_login_challenge%ROWTYPE;
  made            uuid;
  this_year       integer := extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer;
BEGIN
  SELECT * INTO found_challenge FROM player_login_challenge c
  WHERE c.signup_hash = signup AND c.signup_expires_at > now() AND c.cancelled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR platform_marked(found_challenge.contact_fp) THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid;
    RETURN;
  END IF;
  IF born IS NULL OR born < 1900 OR born > this_year THEN
    RETURN QUERY SELECT 'invalid_birth_year'::text, NULL::uuid;
    RETURN;
  END IF;
  IF this_year - born < 13 THEN
    DELETE FROM player_login_challenge WHERE id = found_challenge.id;
    RETURN QUERY SELECT 'too_young'::text, NULL::uuid;
    RETURN;
  END IF;
  IF username_blocked(chosen_name) THEN
    RETURN QUERY SELECT 'username_blocked'::text, NULL::uuid;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM player p WHERE username_fold(p.username) = username_fold(chosen_name)) THEN
    RETURN QUERY SELECT 'username_taken'::text, NULL::uuid;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO player (username, birth_year, avatar) VALUES (chosen_name, born, chosen_avatar) RETURNING id INTO made;
    INSERT INTO player_contact (player_id, phone_e164, email)
    VALUES (made,
            CASE WHEN found_challenge.channel = 'phone' THEN found_challenge.contact END,
            CASE WHEN found_challenge.channel = 'email' THEN found_challenge.contact END);
    INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (made, found_challenge.contact_fp);
    -- The terms and privacy the person accepted before their contact was ever stored (FR-1705), at the time they did.
    INSERT INTO player_acceptance (player_id, document, version, method, accepted_at)
    VALUES (made, 'terms_of_use', found_challenge.terms_version, 'signup', found_challenge.created_at),
           (made, 'privacy_policy', found_challenge.privacy_version, 'signup', found_challenge.created_at);
  EXCEPTION WHEN unique_violation THEN
    -- A name taken at the same moment, or the contact signed up in parallel: nothing of this attempt stays.
    IF EXISTS (SELECT 1 FROM player p WHERE username_fold(p.username) = username_fold(chosen_name)) THEN
      RETURN QUERY SELECT 'username_taken'::text, NULL::uuid;
    ELSE
      DELETE FROM player_login_challenge WHERE id = found_challenge.id;
      RETURN QUERY SELECT 'contact_taken'::text, NULL::uuid;
    END IF;
    RETURN;
  END;
  DELETE FROM player_login_challenge WHERE id = found_challenge.id;
  PERFORM issue_player_tokens(made, access_hash, refresh_hash, family);
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after)
  VALUES ('system', 'player.signup', 'player', made::text, jsonb_build_object('channel', found_challenge.channel, 'accepted',
                             jsonb_build_object('terms', found_challenge.terms_version,
                                                'privacy', found_challenge.privacy_version)));
  RETURN QUERY SELECT 'created'::text, made;
END $$;

DROP FUNCTION start_contact_change(uuid, bytea, text, text, bytea);
-- As 0020, plus the new contact's fingerprint.
CREATE FUNCTION start_contact_change(challenge uuid, token bytea, method text, contact_value text, code bytea,
                                     fp bytea)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  mine player_contact;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pc.* INTO mine FROM player_contact pc WHERE pc.player_id = me;
  IF (method = 'phone' AND mine.phone_e164 = contact_value) OR (method = 'email' AND mine.email = contact_value) THEN
    RETURN 'unchanged';
  END IF;
  INSERT INTO player_contact_challenge (id, player_id, token_hash, channel, contact, code_hash, expires_at, contact_fp)
  VALUES (challenge, me, token, method, contact_value, code, now() + interval '5 minutes', fp)
  ON CONFLICT (player_id) DO UPDATE
    SET id = EXCLUDED.id, token_hash = EXCLUDED.token_hash, channel = EXCLUDED.channel, contact = EXCLUDED.contact,
        code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now(),
        contact_fp = EXCLUDED.contact_fp;
  RETURN 'started';
END $$;
REVOKE ALL ON FUNCTION start_contact_change(uuid, bytea, text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_contact_change(uuid, bytea, text, text, bytea, bytea) TO questify_app;

-- As 0020, plus: a contact with a platform mark answers 'taken' (nothing tells a ban apart), and a confirmed contact's
-- fingerprint joins the account's.
CREATE OR REPLACE FUNCTION confirm_contact_change(token bytea, code bytea, request uuid)
  RETURNS TABLE (outcome text, attempts_left integer, channel text, kind text, previous text, other text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  found player_contact_challenge;
  mine player_contact;
  before_value text;
  other_value text;
BEGIN
  SELECT c.* INTO found FROM player_contact_challenge c
  WHERE c.token_hash = token AND c.player_id = me AND c.expires_at > now()
  FOR UPDATE;
  IF found.id IS NULL OR found.attempts >= 3
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RETURN QUERY SELECT 'expired'::text, 0, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  IF found.code_hash <> code THEN
    UPDATE player_contact_challenge SET attempts = attempts + 1 WHERE id = found.id;
    RETURN QUERY SELECT 'wrong'::text, 2 - found.attempts, NULL::text, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  DELETE FROM player_contact_challenge WHERE id = found.id;
  IF platform_marked(found.contact_fp) THEN
    RETURN QUERY SELECT 'taken'::text, 0, found.channel, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  SELECT pc.* INTO mine FROM player_contact pc WHERE pc.player_id = me FOR UPDATE;
  before_value := CASE WHEN found.channel = 'phone' THEN mine.phone_e164 ELSE mine.email END;
  other_value := CASE WHEN found.channel = 'phone' THEN mine.email ELSE mine.phone_e164 END;
  BEGIN
    IF mine.player_id IS NULL THEN
      INSERT INTO player_contact (player_id, phone_e164, email)
      VALUES (me, CASE WHEN found.channel = 'phone' THEN found.contact END,
              CASE WHEN found.channel = 'email' THEN found.contact END);
    ELSIF found.channel = 'phone' THEN
      UPDATE player_contact SET phone_e164 = found.contact WHERE player_id = me;
    ELSE
      UPDATE player_contact SET email = found.contact WHERE player_id = me;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'taken'::text, 0, found.channel, NULL::text, NULL::text, NULL::text;
    RETURN;
  END;
  INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (me, found.contact_fp) ON CONFLICT DO NOTHING;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.contact_change', 'player', me::text,
          jsonb_build_object('channel', found.channel,
                             'kind', CASE WHEN before_value IS NULL THEN 'added' ELSE 'replaced' END),
          request);
  RETURN QUERY SELECT 'changed'::text, 0, found.channel,
                      CASE WHEN before_value IS NULL THEN 'added' ELSE 'replaced' END, before_value, other_value;
END $$;

-- ================================================================ joins wait for a deletion, and honour ban marks
-- As 0036: the caller is read FOR KEY SHARE before any enrollment lock (erase_player locks the player FOR UPDATE
-- first), so a join in flight waits for a deletion and then finds no active player. A ban mark answers not_allowed,
-- as a ban on the enrollment does.
CREATE OR REPLACE FUNCTION join_event(code text, via text, card text, answers jsonb DEFAULT '{}'::jsonb,
                                      waitlist boolean DEFAULT false)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  target event;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR KEY SHARE;
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF via IS NULL OR via NOT IN ('code', 'qr', 'link', 'public_list') THEN
    RAISE EXCEPTION 'unknown way of joining' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO target FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
  FOR SHARE;
  IF target.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0, false;
    RETURN;
  END IF;
  IF erased_marked(me, target.id, 'banned') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target.id, NULL::text, 0, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM join_core(target, me, via, card, answers, waitlist);
END $$;

CREATE OR REPLACE FUNCTION join_invited(target uuid, card text, answers jsonb DEFAULT '{}'::jsonb,
                                        waitlist boolean DEFAULT false)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  found_event event;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR KEY SHARE;
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO found_event FROM event e WHERE e.id = target AND e.status NOT IN ('draft', 'archived') FOR SHARE;
  IF found_event.id IS NULL OR NOT player_invited(found_event.id, me) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0, false;
    RETURN;
  END IF;
  IF erased_marked(me, found_event.id, 'banned') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, found_event.id, NULL::text, 0, false;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM join_core(found_event, me, 'invite', card, answers, waitlist);
END $$;

-- As 0036, with the player read FOR KEY SHARE and the ban mark.
CREATE OR REPLACE FUNCTION enroll_operator(target_event uuid, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  ev event;
  assignment staff_assignment%ROWTYPE;
  row_found enrollment;
  free integer;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR KEY SHARE;
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event FOR SHARE;
  PERFORM ensure_rehearsal_wiped(target_event);
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me FOR SHARE;
  IF NOT FOUND OR NOT assignment.can_play OR erased_marked(me, target_event, 'banned') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
    RETURN;
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid;
    RETURN;
  END IF;
  free := free_seats(ev.id);
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me FOR UPDATE;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid;
    RETURN;
  END IF;
  IF row_found.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id;
    RETURN;
  END IF;
  IF row_found.id IS NOT NULL AND row_found.status NOT IN ('left', 'pending', 'declined') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
    RETURN;
  END IF;
  IF free IS NOT NULL AND free < 1 THEN
    RETURN QUERY SELECT 'full'::text, NULL::uuid;
    RETURN;
  END IF;
  IF row_found.id IS NOT NULL THEN
    UPDATE enrollment en SET status = 'active', waitlisted = false, card_version = card, joined_via = 'operator',
                             joined_at = now()
    WHERE en.id = row_found.id;
    RETURN QUERY SELECT 'joined'::text, row_found.id;
    RETURN;
  END IF;
  INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (ev.organizer_id, ev.id, me, 'active', card, 'operator')
  ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
  RETURNING en.* INTO row_found;
  IF row_found.id IS NOT NULL THEN
    RETURN QUERY SELECT 'joined'::text, row_found.id;
    RETURN;
  END IF;
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid;
  ELSIF row_found.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id;
  ELSE
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
  END IF;
END $$;

-- As 0032, with the player read FOR KEY SHARE (rehearsal accounts are test data: no ban mark here).
CREATE OR REPLACE FUNCTION join_rehearsal(rehearsal_code text, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid;
  target    uuid;
  ev        event%ROWTYPE;
  found_row event_rehearsal%ROWTYPE;
  mine      enrollment%ROWTYPE;
  made      uuid;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR KEY SHARE;
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.event_id INTO target FROM event_rehearsal r WHERE r.code = upper(rehearsal_code);
  IF target IS NULL THEN
    RETURN QUERY SELECT 'closed'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target FOR SHARE;
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target FOR UPDATE;
  IF found_row.code <> upper(rehearsal_code) OR found_row.live_wiped_at IS NOT NULL OR rehearsal_over(ev)
     OR ev.status NOT IN ('draft', 'scheduled') THEN
    PERFORM ensure_rehearsal_wiped(target);
    RETURN QUERY SELECT 'closed'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT n.* INTO mine FROM enrollment n WHERE n.event_id = target AND n.player_id = me FOR UPDATE;
  IF FOUND AND mine.joined_via IS DISTINCT FROM 'rehearsal' THEN
    RETURN QUERY SELECT 'already_player'::text, NULL::uuid, target;
    RETURN;
  END IF;
  IF FOUND AND mine.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, mine.id, target;
    RETURN;
  END IF;
  IF FOUND AND mine.status = 'left' THEN
    UPDATE enrollment n SET status = 'active', card_version = card, joined_at = now() WHERE n.id = mine.id;
    RETURN QUERY SELECT 'joined'::text, mine.id, target;
    RETURN;
  END IF;
  IF FOUND THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM enrollment n WHERE n.event_id = target AND n.joined_via = 'rehearsal') >= rehearsal_cap()
  THEN
    RETURN QUERY SELECT 'full'::text, NULL::uuid, target;
    RETURN;
  END IF;
  INSERT INTO enrollment AS n (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (ev.organizer_id, ev.id, me, 'active', card, 'rehearsal')
  RETURNING n.id INTO made;
  RETURN QUERY SELECT 'joined'::text, made, target;
END $$;

-- As 0032, plus: no welcome for a player whose fingerprint got this event's welcome on a deleted account.
CREATE OR REPLACE FUNCTION grant_welcome() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  amount integer;
  made bigint;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') OR NEW.joined_via = 'rehearsal' THEN
    RETURN NULL;
  END IF;
  SELECT e.welcome_points INTO amount FROM event e WHERE e.id = NEW.event_id;
  IF amount IS NULL OR erased_marked(NEW.player_id, NEW.event_id, 'welcomed') THEN
    RETURN NULL;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
  VALUES (NEW.organizer_id, NEW.event_id, NEW.id, 'welcome', amount, amount, 'system')
  ON CONFLICT (enrollment_id) WHERE kind = 'welcome' DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    INSERT INTO ranking_repair (event_id) VALUES (NEW.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  RETURN NULL;
END $$;

-- ================================================================ the deletion challenge (ADR-177)
-- A one-time code for deletion only: it can never sign in. player_id NULL when no account uses the contact (the
-- request answers the same and sends nothing). The contact itself is never stored. A right code sets the deletion
-- token's hash for 10 minutes; erase_player consumes it (erased_at, and clears player_id and contact_key so the used
-- row links the tombstone to no contact), and a repeat with it answers 'replayed'.
CREATE TABLE player_deletion_challenge (
  id                  uuid PRIMARY KEY,
  token_hash          bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  player_id           uuid REFERENCES player (id) ON DELETE CASCADE,
  contact_key         bytea CHECK (octet_length(contact_key) = 32),
  code_hash           bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  expires_at          timestamptz NOT NULL,
  deletion_hash       bytea UNIQUE CHECK (octet_length(deletion_hash) = 32),
  deletion_expires_at timestamptz,
  erased_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK ((deletion_hash IS NULL) = (deletion_expires_at IS NULL)),
  CHECK (erased_at IS NULL OR deletion_hash IS NOT NULL),
  CHECK ((contact_key IS NULL) = (erased_at IS NOT NULL))
);
CREATE INDEX player_deletion_challenge_contact_idx ON player_deletion_challenge (contact_key);
CREATE INDEX player_deletion_challenge_player_idx ON player_deletion_challenge (player_id);
ALTER TABLE player_deletion_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_deletion_challenge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_deletion_challenge FROM PUBLIC;

-- The signed-in player's own phone or email, to send their deletion code to (NULL: the account has none of that kind).
CREATE FUNCTION own_deletion_contact(method text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN method = 'phone' THEN pc.phone_e164 WHEN method = 'email' THEN pc.email END
  FROM player_contact pc JOIN player p ON p.id = pc.player_id
  WHERE pc.player_id = app_player_id() AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION own_deletion_contact(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_deletion_contact(text) TO questify_app;

-- Opens a deletion challenge for a contact; true when an account (active or platform-banned) uses it, so the API knows
-- whether to send the code. Always writes a row, so a known and an unknown contact cost the same. A new code for a
-- contact ends its earlier ones; rows an hour old are swept here.
CREATE FUNCTION start_deletion_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                         code bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner uuid;
BEGIN
  IF method IS NULL OR method NOT IN ('phone', 'email') THEN
    RAISE EXCEPTION 'unknown channel' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  DELETE FROM player_deletion_challenge
  WHERE greatest(expires_at, coalesce(deletion_expires_at, expires_at)) < now() - interval '1 hour'
     OR (contact_key = key AND deletion_hash IS NULL);
  SELECT p.id INTO owner FROM player_contact pc JOIN player p ON p.id = pc.player_id
  WHERE p.status IN ('active', 'banned')
    AND ((method = 'phone' AND pc.phone_e164 = contact_value) OR (method = 'email' AND pc.email = contact_value));
  INSERT INTO player_deletion_challenge (id, token_hash, player_id, contact_key, code_hash, expires_at)
  VALUES (challenge, token, owner, key, code, now() + interval '5 minutes');
  RETURN owner IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea) TO questify_app;

-- Checks a deletion code. Outcomes: verified (the deletion token is set for 10 minutes), wrong (attempts left; a
-- challenge with no account is always wrong, so it answers like a known one), expired.
CREATE FUNCTION verify_deletion_code(token bytea, code bytea, deletion bytea)
  RETURNS TABLE (outcome text, attempts_left integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held player_deletion_challenge%ROWTYPE;
BEGIN
  SELECT c.* INTO held FROM player_deletion_challenge c
  WHERE c.token_hash = token AND c.deletion_hash IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR held.attempts >= 3 THEN
    RETURN QUERY SELECT 'expired'::text, 0;
    RETURN;
  END IF;
  IF held.player_id IS NULL OR held.code_hash <> code THEN
    UPDATE player_deletion_challenge SET attempts = attempts + 1 WHERE id = held.id;
    RETURN QUERY SELECT 'wrong'::text, 2 - held.attempts;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM player p WHERE p.id = held.player_id AND p.status IN ('active', 'banned')) THEN
    DELETE FROM player_deletion_challenge WHERE id = held.id;
    RETURN QUERY SELECT 'expired'::text, 0;
    RETURN;
  END IF;
  UPDATE player_deletion_challenge
  SET deletion_hash = deletion, deletion_expires_at = now() + interval '10 minutes'
  WHERE id = held.id;
  RETURN QUERY SELECT 'verified'::text, 0;
END $$;
REVOKE ALL ON FUNCTION verify_deletion_code(bytea, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_deletion_code(bytea, bytea, bytea) TO questify_app;

-- The player behind a live, unused deletion token, or NULL.
CREATE FUNCTION deletion_holder(deletion bytea) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.player_id FROM player_deletion_challenge c
  WHERE c.deletion_hash = deletion AND c.deletion_expires_at > now() AND c.erased_at IS NULL
$$;
REVOKE ALL ON FUNCTION deletion_holder(bytea) FROM PUBLIC;

-- The handovers still pending for the token's player (FR-128): what the screen explains before anything happens.
CREATE FUNCTION deletion_pending(deletion bytea)
  RETURNS TABLE (redemption_id uuid, event_id uuid, event_ar text, event_en text, item_ar text, item_en text,
                 rank_prize boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, e.id, e.name_ar, e.name_en, coalesce(r.name_ar, k.name_ar), coalesce(r.name_en, k.name_en),
         d.rank_prize_id IS NOT NULL
  FROM redemption d
  JOIN enrollment n ON n.id = d.enrollment_id
  JOIN event e ON e.id = d.event_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  WHERE n.player_id = deletion_holder(deletion) AND d.status = 'reserved'
  ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION deletion_pending(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deletion_pending(bytea) TO questify_app;

-- ================================================================ erasing (ADR-175, ADR-178)
ALTER TABLE redemption DROP CONSTRAINT redemption_ended_by_check;
ALTER TABLE redemption ADD CONSTRAINT redemption_ended_by_check
  CHECK (ended_by IN ('player', 'timeout', 'delivery', 'handover', 'operator', 'erasure'));

-- The marks a deleted account leaves (ADR-176): every fingerprint it held, for each event it was banned from, each
-- event whose welcome reward it got (until the event ends), and the platform when the account itself was banned.
CREATE FUNCTION erase_marks(me player) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made integer;
  more integer;
BEGIN
  INSERT INTO erased_mark (fingerprint, event_id, kind)
  SELECT f.fingerprint, n.event_id, 'banned'
  FROM player_fingerprint f JOIN enrollment n ON n.player_id = f.player_id
  WHERE f.player_id = me.id AND n.status = 'banned'
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS made = ROW_COUNT;
  INSERT INTO erased_mark (fingerprint, event_id, kind, expires_at)
  SELECT f.fingerprint, n.event_id, 'welcomed', e.ends_at
  FROM player_fingerprint f
  JOIN enrollment n ON n.player_id = f.player_id
  JOIN event e ON e.id = n.event_id
  WHERE f.player_id = me.id AND e.ends_at > now()
    AND EXISTS (SELECT 1 FROM ledger_entry l WHERE l.enrollment_id = n.id AND l.kind = 'welcome')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS more = ROW_COUNT;
  made := made + more;
  IF me.status = 'banned' THEN
    INSERT INTO erased_mark (fingerprint, event_id, kind)
    SELECT f.fingerprint, NULL, 'banned' FROM player_fingerprint f WHERE f.player_id = me.id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS more = ROW_COUNT;
    made := made + more;
  END IF;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION erase_marks(player) FROM PUBLIC;

-- Removes and clears everything personal (the table in the T-217 plan). The ledger, completions, handed-over prizes,
-- result places, ban rows of the enrollments and the audit log stay; they name only the tombstone's id.
CREATE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
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
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid, uuid[], bytea) FROM PUBLIC;

-- Deletes the account behind a live deletion token, in one transaction. Lock order: the player FOR UPDATE, the
-- player's enrollments by id FOR NO KEY UPDATE, then end_reservation per pending item (enrollment, reward,
-- redemption), then the writes. Outcomes: erased (with the player and the events they were in), replayed (the
-- token was already used: the account is gone), handover_pending (a reserved prize or desk item, and no forfeit:
-- nothing changed, the token stays usable), expired.
CREATE FUNCTION erase_player(deletion bytea, forfeit boolean, request uuid)
  RETURNS TABLE (outcome text, player_id uuid, events uuid[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held     player_deletion_challenge%ROWTYPE;
  me       player%ROWTYPE;
  enrolled uuid[];
  boards   uuid[];
  pending  uuid[];
  item     uuid;
  marks    integer;
BEGIN
  SELECT c.* INTO held FROM player_deletion_challenge c WHERE c.deletion_hash = deletion FOR UPDATE;
  IF FOUND AND held.erased_at IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  IF NOT FOUND OR held.deletion_expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  SELECT p.* INTO me FROM player p WHERE p.id = held.player_id FOR UPDATE;
  IF me.status NOT IN ('active', 'banned') THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.player_id = me.id ORDER BY n.id FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(n.id ORDER BY n.id), '{}') INTO enrolled FROM enrollment n WHERE n.player_id = me.id;
  SELECT coalesce(array_agg(d.id ORDER BY d.id), '{}') INTO pending
  FROM redemption d WHERE d.enrollment_id = ANY (enrolled) AND d.status = 'reserved';
  IF cardinality(pending) > 0 AND NOT coalesce(forfeit, false) THEN
    RETURN QUERY SELECT 'handover_pending'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  FOREACH item IN ARRAY pending LOOP
    PERFORM end_reservation(item, 'cancelled', 'erasure', 'system', NULL);
  END LOOP;
  -- The boards the player was on, read before erase_rows ends the enrollments: each is rebuilt without them.
  SELECT coalesce(array_agg(DISTINCT n.event_id), '{}') INTO boards
  FROM enrollment n WHERE n.id = ANY (enrolled) AND n.status = 'active';
  marks := erase_marks(me);
  -- The used token first lets go of the player and the contact, so erase_rows can drop every other challenge of theirs.
  UPDATE player_deletion_challenge SET erased_at = now(), player_id = NULL, contact_key = NULL WHERE id = held.id;
  PERFORM erase_rows(me.id, enrolled, held.contact_key);
  INSERT INTO ranking_repair (event_id) SELECT unnest(boards)
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.delete', 'player', me.id::text,
          jsonb_build_object('events', cardinality(enrolled), 'forfeited', cardinality(pending), 'marks', marks),
          request);
  RETURN QUERY SELECT 'erased'::text, me.id,
                      coalesce((SELECT array_agg(DISTINCT n.event_id) FROM enrollment n WHERE n.id = ANY (enrolled)),
                               '{}');
END $$;
REVOKE ALL ON FUNCTION erase_player(bytea, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_player(bytea, boolean, uuid) TO questify_app;
