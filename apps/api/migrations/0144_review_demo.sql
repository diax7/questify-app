-- The App Review demo (T-710, FR-1406, FR-1407, FR-1736, ADR-009, ADR-560 to ADR-569; plan
-- docs/plans/2026-11-03-t-710-review-demo.md). One console-created row names the demo organizer and event, the reviewer
-- phone and the fixed code's hash; every account the demo makes is marked, and triggers keep demo accounts in the demo
-- event and everyone else out of it. The fixed code is decided here, in the sign-in and deletion functions: a challenge
-- is a reviewer one only when its contact is the reviewer's and the window is open, and a reviewer challenge signs in
-- only the reviewer account.
--
-- Lock order (ADR-561, plan review 84): the `review_demo` row first, then challenges, players and sessions. Every writer
-- of the row (create, set-contact, prepare, close, the tick) takes it FOR UPDATE; a reviewer verify reads the challenge's
-- flag unlocked, then locks the row (FOR UPDATE, it may provision; the deletion check FOR SHARE) before the challenge.
--
-- Deny by default: both tables have forced row-level security and no grant; every new function is revoked from PUBLIC
-- in this file, and only the console doors, the tick and the restated sign-in functions are granted to the API's role.
-- Restated functions are copied from their latest definitions (named at each) with the smallest change.
SET LOCAL lock_timeout = '10s';

-- ================================================================ tables
CREATE TABLE review_demo (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  organizer_id uuid NOT NULL REFERENCES organizer (id) ON DELETE RESTRICT,
  event_id     uuid NOT NULL UNIQUE REFERENCES event (id) ON DELETE RESTRICT,
  -- Questify's own reviewer SIM (Q-520), in the player_contact shape. Never logged or audited.
  contact      text NOT NULL CHECK (contact ~ '^\+9665[0-9]{8}$'),
  contact_key  bytea NOT NULL CHECK (octet_length(contact_key) = 32),
  contact_fp   bytea NOT NULL CHECK (octet_length(contact_fp) = 32),
  player_id    uuid REFERENCES player (id),
  code_hash    bytea CHECK (octet_length(code_hash) = 32),
  window_until timestamptz,
  prepared_for text CHECK (length(prepared_for) BETWEEN 1 AND 20),
  prepared_at  timestamptz,
  prepared_by  uuid,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE review_demo ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_demo FORCE ROW LEVEL SECURITY;
REVOKE ALL ON review_demo FROM PUBLIC;

-- Every account the demo made, tombstones included, so a retired reviewer never ranks or joins anywhere.
CREATE TABLE review_demo_player (
  player_id  uuid PRIMARY KEY REFERENCES player (id),
  role       text NOT NULL CHECK (role IN ('reviewer', 'fictional')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE review_demo_player ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_demo_player FORCE ROW LEVEL SECURITY;
REVOKE ALL ON review_demo_player FROM PUBLIC;

ALTER TABLE player_login_challenge ADD COLUMN reviewer boolean NOT NULL DEFAULT false;
ALTER TABLE player_deletion_challenge ADD COLUMN reviewer boolean NOT NULL DEFAULT false;

-- ================================================================ internal rules (no grant)
-- Whether a contact key is the reviewer's while the window is open and a code is set.
CREATE FUNCTION review_demo_open(key bytea) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM review_demo d
                 WHERE d.contact_key = key AND d.window_until > now() AND d.code_hash IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION review_demo_open(bytea) FROM PUBLIC;

CREATE FUNCTION is_review_demo_player(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM review_demo_player r WHERE r.player_id = target)
$$;
REVOKE ALL ON FUNCTION is_review_demo_player(uuid) FROM PUBLIC;

-- A free username: `base` itself, else `base` plus 4 random digits.
CREATE FUNCTION review_demo_username(base text, numbered boolean) RETURNS text
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  name text := base;
BEGIN
  LOOP
    IF numbered THEN
      name := base || lpad(floor(random() * 10000)::integer::text, 4, '0');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM player p WHERE username_fold(p.username) = username_fold(name)) THEN
      RETURN name;
    END IF;
    numbered := true;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION review_demo_username(text, boolean) FROM PUBLIC;

-- Ends every session and refresh token of one account (the reviewer's at close, window end and number change).
CREATE FUNCTION review_demo_revoke(target uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE player_refresh SET revoked_at = now() WHERE player_id = target AND revoked_at IS NULL;
  UPDATE player_session SET revoked_at = now() WHERE player_id = target AND revoked_at IS NULL;
$$;
REVOKE ALL ON FUNCTION review_demo_revoke(uuid) FROM PUBLIC;

-- Cancels every open sign-in challenge of a contact key, the ones at the sign-up step included.
CREATE FUNCTION review_demo_cancel_challenges(key bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE player_login_challenge SET cancelled_at = now() WHERE contact_key = key AND cancelled_at IS NULL;
$$;
REVOKE ALL ON FUNCTION review_demo_cancel_challenges(bytea) FROM PUBLIC;

-- The reviewer account (ADR-562): the live one, or a new one with the reviewer phone, its fingerprint, the acceptances
-- in force, the reviewer mark and an operator assignment allowed to play in the demo event; the erased marks under the
-- reviewer fingerprint go, so the new account is welcomed again. The caller holds the review_demo row FOR UPDATE.
CREATE FUNCTION review_demo_provision() RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  demo review_demo;
  made uuid;
BEGIN
  SELECT d.* INTO demo FROM review_demo d FOR UPDATE;
  IF EXISTS (SELECT 1 FROM player p WHERE p.id = demo.player_id AND p.status <> 'deleted') THEN
    INSERT INTO player_contact (player_id, phone_e164) VALUES (demo.player_id, demo.contact)
    ON CONFLICT (player_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164;
    RETURN demo.player_id;
  END IF;
  INSERT INTO player (username, birth_year) VALUES (review_demo_username('Reviewer', true), 1990) RETURNING id INTO made;
  INSERT INTO review_demo_player (player_id, role) VALUES (made, 'reviewer');
  INSERT INTO player_contact (player_id, phone_e164) VALUES (made, demo.contact);
  INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (made, demo.contact_fp);
  INSERT INTO player_acceptance (player_id, document, version, method)
  SELECT made, f.document, f.version, 'sign_in' FROM legal_in_force_rows() f
  WHERE f.document IN ('terms_of_use', 'privacy_policy');
  INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play)
  VALUES (demo.organizer_id, demo.event_id, made, true);
  DELETE FROM erased_mark WHERE fingerprint = demo.contact_fp;
  UPDATE review_demo SET player_id = made;
  INSERT INTO audit_log (actor_type, organizer_id, action, target_type, target_id)
  VALUES ('system', demo.organizer_id, 'review_demo.provision', 'player', made::text);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION review_demo_provision() FROM PUBLIC;

-- ================================================================ confinement (ADR-563)
-- A demo account only in the demo event, and nobody else in it: one rule for every join and assignment path.
CREATE FUNCTION review_demo_member_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM review_demo d WHERE d.event_id = NEW.event_id)
     IS DISTINCT FROM EXISTS (SELECT 1 FROM review_demo_player r WHERE r.player_id = NEW.player_id) THEN
    RAISE EXCEPTION 'this event is not open to this account' USING ERRCODE = 'RD404';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION review_demo_member_guard() FROM PUBLIC;

CREATE TRIGGER enrollment_review_demo_guard BEFORE INSERT OR UPDATE OF event_id, player_id ON enrollment
  FOR EACH ROW EXECUTE FUNCTION review_demo_member_guard();
ALTER TABLE enrollment ENABLE ALWAYS TRIGGER enrollment_review_demo_guard;
CREATE TRIGGER staff_assignment_review_demo_guard BEFORE INSERT OR UPDATE OF event_id, player_id ON staff_assignment
  FOR EACH ROW EXECUTE FUNCTION review_demo_member_guard();
ALTER TABLE staff_assignment ENABLE ALWAYS TRIGGER staff_assignment_review_demo_guard;

-- The demo event stays live, public, unlisted and unlimited, and its end only moves later (ADR-567). Its natural end
-- (the lifecycle step, only if the tick stopped for 60 days) passes, so the lifecycle never fails on it.
CREATE FUNCTION event_review_demo_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM review_demo d WHERE d.event_id = OLD.id) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the review demo event cannot be deleted' USING ERRCODE = 'RD409';
  END IF;
  IF (NEW.status <> 'live' AND NEW.ends_at > now())
     OR 'public_list' = ANY (NEW.join_methods)
     OR NEW.access <> 'public'
     OR NEW.player_limit_mode <> 'none'
     OR NEW.ends_at IS NULL OR NEW.ends_at < OLD.ends_at THEN
    RAISE EXCEPTION 'the review demo event stays live, public and unlimited' USING ERRCODE = 'RD409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_review_demo_guard() FROM PUBLIC;

CREATE TRIGGER event_review_demo_guard BEFORE UPDATE OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION event_review_demo_guard();
ALTER TABLE event ENABLE ALWAYS TRIGGER event_review_demo_guard;

-- ================================================================ sign-in (ADR-561)
DROP FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea);
-- As 0038, plus the reviewer flag: set when the contact is the reviewer's phone and the window is open, and returned so
-- the API sends nothing for it.
CREATE FUNCTION start_player_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                       code bytea, terms text, privacy text, fp bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  flagged boolean := method = 'phone' AND review_demo_open(key);
BEGIN
  UPDATE player_login_challenge SET cancelled_at = now()
  WHERE contact_key = key AND cancelled_at IS NULL;
  INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                      terms_version, privacy_version, contact_fp, reviewer)
  VALUES (challenge, token, method, contact_value, key, code, now() + interval '5 minutes', terms, privacy, fp,
          flagged);
  RETURN flagged;
END $$;
REVOKE ALL ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea)
  TO questify_app;

DROP FUNCTION player_challenge_to_resend(bytea);
-- As 0013, plus the reviewer flag: a reviewer challenge is never sent again.
CREATE FUNCTION player_challenge_to_resend(token bytea)
  RETURNS TABLE (id uuid, channel text, contact text, resends integer, seconds_since_sent double precision,
                 reviewer boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.channel, c.contact, c.resends, extract(epoch FROM now() - c.last_sent_at), c.reviewer
  FROM player_login_challenge c
  WHERE c.token_hash = token AND c.cancelled_at IS NULL AND c.signup_hash IS NULL AND c.expires_at > now()
$$;
REVOKE ALL ON FUNCTION player_challenge_to_resend(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_challenge_to_resend(bytea) TO questify_app;

-- A reviewer challenge's code check. The caller locked the review_demo row (if any) and then the challenge. The window
-- is re-checked (closed or code rotated since the challenge opened: expired); the fixed code is compared with the row's
-- hash; a contact owner that is not the reviewer account answers expired, is audited and is never signed in or
-- provisioned; a missing or erased reviewer is provisioned. Never `new`; `banned` only for a reviewer account an admin
-- banned. Every reviewer sign-in is audited (no contact).
CREATE FUNCTION review_demo_sign_in(ch player_login_challenge, reviewer_code bytea, access_hash bytea,
                                    refresh_hash bytea, family uuid)
  RETURNS TABLE (outcome text, attempts_left integer, player_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  demo         review_demo;
  owner        uuid;
  owner_status text;
BEGIN
  SELECT d.* INTO demo FROM review_demo d
  WHERE d.contact_key = ch.contact_key AND d.window_until > now() AND d.code_hash IS NOT NULL;
  IF demo.id IS NULL THEN
    UPDATE player_login_challenge SET cancelled_at = now() WHERE id = ch.id;
    RETURN QUERY SELECT 'expired'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  IF demo.code_hash <> reviewer_code THEN
    UPDATE player_login_challenge SET attempts = attempts + 1 WHERE id = ch.id;
    RETURN QUERY SELECT 'wrong'::text, 2 - ch.attempts, NULL::uuid;
    RETURN;
  END IF;
  DELETE FROM player_login_challenge WHERE id = ch.id;
  SELECT p.id, p.status INTO owner, owner_status FROM player_contact pc JOIN player p ON p.id = pc.player_id
  WHERE pc.phone_e164 = ch.contact;
  IF owner IS NOT NULL AND owner IS DISTINCT FROM demo.player_id THEN
    INSERT INTO audit_log (actor_type, organizer_id, action, target_type, target_id)
    VALUES ('system', demo.organizer_id, 'review_demo.owner_mismatch', 'player', owner::text);
    RETURN QUERY SELECT 'expired'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  IF owner IS NULL THEN
    owner := review_demo_provision();
    SELECT p.status INTO owner_status FROM player p WHERE p.id = owner;
  END IF;
  IF owner_status <> 'active' THEN
    RETURN QUERY SELECT 'banned'::text, 0, owner;
    RETURN;
  END IF;
  INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (owner, ch.contact_fp) ON CONFLICT DO NOTHING;
  INSERT INTO player_acceptance (player_id, document, version, method, accepted_at)
  VALUES (owner, 'terms_of_use', ch.terms_version, 'sign_in', ch.created_at),
         (owner, 'privacy_policy', ch.privacy_version, 'sign_in', ch.created_at)
  ON CONFLICT DO NOTHING;
  PERFORM issue_player_tokens(owner, access_hash, refresh_hash, family);
  INSERT INTO audit_log (actor_type, organizer_id, action, target_type, target_id)
  VALUES ('system', demo.organizer_id, 'review_demo.signed_in', 'player', owner::text);
  RETURN QUERY SELECT 'signed_in'::text, 0, owner;
END $$;
REVOKE ALL ON FUNCTION review_demo_sign_in(player_login_challenge, bytea, bytea, bytea, uuid) FROM PUBLIC;

DROP FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea);
-- As 0120, plus `reviewer_code` (the reviewer hash of the typed code, passed on every verify): a reviewer challenge locks
-- the review_demo row before the challenge and is judged by review_demo_sign_in; any other challenge never reads it.
CREATE FUNCTION sign_in_player(token bytea, code bytea, access_hash bytea, refresh_hash bytea, family uuid,
                               signup bytea, reviewer_code bytea)
  RETURNS TABLE (outcome text, attempts_left integer, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_challenge player_login_challenge%ROWTYPE;
  owner           uuid;
  owner_status    text;
BEGIN
  IF signup IS NULL OR reviewer_code IS NULL THEN
    RAISE EXCEPTION 'sign_in_player needs a signup token hash and a reviewer code hash'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM player_login_challenge c WHERE c.token_hash = token AND c.reviewer) THEN
    PERFORM 1 FROM review_demo d FOR UPDATE;
  END IF;
  SELECT * INTO found_challenge FROM player_login_challenge c
  WHERE c.token_hash = token AND c.cancelled_at IS NULL AND c.signup_hash IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR found_challenge.attempts >= 3 THEN
    RETURN QUERY SELECT 'expired'::text, 0, NULL::uuid;
    RETURN;
  END IF;
  IF found_challenge.reviewer THEN
    RETURN QUERY SELECT * FROM review_demo_sign_in(found_challenge, reviewer_code, access_hash, refresh_hash, family);
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
    RETURN QUERY SELECT 'banned'::text, 0, owner;
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
REVOKE ALL ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea, bytea) TO questify_app;

-- As 0038, plus: the reviewer phone never becomes a new account (`expired`), so no real account ever holds it.
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
  IF NOT FOUND OR platform_marked(found_challenge.contact_fp)
     OR EXISTS (SELECT 1 FROM review_demo d WHERE d.contact = found_challenge.contact) THEN
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

-- As 0038, plus: a demo account's contact cannot change (`locked`, ADR-562, Q-523).
CREATE OR REPLACE FUNCTION start_contact_change(challenge uuid, token bytea, method text, contact_value text, code bytea,
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
  IF is_review_demo_player(me) THEN
    RETURN 'locked';
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

-- As 0038, plus: the reviewer phone answers `taken`, as a marked contact does.
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
  IF platform_marked(found.contact_fp) OR EXISTS (SELECT 1 FROM review_demo d WHERE d.contact = found.contact) THEN
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

-- ================================================================ account deletion (ADR-562)
DROP FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea);
-- As 0038, plus the reviewer flag (the sign-in rule), returned beside `known` so the API sends nothing for it.
CREATE FUNCTION start_deletion_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                         code bytea) RETURNS TABLE (known boolean, reviewer boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner   uuid;
  flagged boolean := method = 'phone' AND review_demo_open(key);
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
  INSERT INTO player_deletion_challenge (id, token_hash, player_id, contact_key, code_hash, expires_at, reviewer)
  VALUES (challenge, token, owner, key, code, now() + interval '5 minutes', flagged);
  RETURN QUERY SELECT owner IS NOT NULL, flagged;
END $$;
REVOKE ALL ON FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea) TO questify_app;

DROP FUNCTION verify_deletion_code(bytea, bytea, bytea);
-- As 0038, plus `reviewer_code`: a reviewer challenge locks the review_demo row (FOR SHARE) before the challenge,
-- answers expired unless the window is still open and the challenge's account is the reviewer account, and compares
-- the fixed code's hash; any other challenge never reads it.
CREATE FUNCTION verify_deletion_code(token bytea, code bytea, deletion bytea, reviewer_code bytea)
  RETURNS TABLE (outcome text, attempts_left integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held player_deletion_challenge%ROWTYPE;
  demo review_demo;
BEGIN
  IF EXISTS (SELECT 1 FROM player_deletion_challenge c WHERE c.token_hash = token AND c.reviewer) THEN
    SELECT d.* INTO demo FROM review_demo d FOR SHARE;
  END IF;
  SELECT c.* INTO held FROM player_deletion_challenge c
  WHERE c.token_hash = token AND c.deletion_hash IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR held.attempts >= 3 THEN
    RETURN QUERY SELECT 'expired'::text, 0;
    RETURN;
  END IF;
  IF held.reviewer AND (demo.id IS NULL OR demo.contact_key IS DISTINCT FROM held.contact_key
                        OR demo.window_until IS NULL OR demo.window_until <= now() OR demo.code_hash IS NULL
                        OR held.player_id IS DISTINCT FROM demo.player_id) THEN
    DELETE FROM player_deletion_challenge WHERE id = held.id;
    RETURN QUERY SELECT 'expired'::text, 0;
    RETURN;
  END IF;
  IF held.player_id IS NULL
     OR (CASE WHEN held.reviewer THEN demo.code_hash <> reviewer_code ELSE held.code_hash <> code END) THEN
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
REVOKE ALL ON FUNCTION verify_deletion_code(bytea, bytea, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_deletion_code(bytea, bytea, bytea, bytea) TO questify_app;

-- ================================================================ never public, never Questify-wide (ADR-563)
-- As 0114, plus: the demo event is never listed.
CREATE OR REPLACE FUNCTION public_events(after_id uuid, page integer)
  RETURNS TABLE (id uuid, join_code text, name_ar text, name_en text, venue_ar text, venue_en text, kind text,
                 timezone text, starts_at timestamptz, ends_at timestamptz, status_now text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.join_code, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at)
  FROM event e
  WHERE e.access = 'public' AND 'public_list' = ANY (e.join_methods)
    AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    AND NOT event_suspended(e.id)
    AND NOT EXISTS (SELECT 1 FROM review_demo d WHERE d.event_id = e.id)
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM event c WHERE c.id = after_id)
         OR (e.starts_at, e.id) > (SELECT c.starts_at, c.id FROM event c WHERE c.id = after_id))
  ORDER BY e.starts_at, e.id
  LIMIT least(greatest(page, 1), 100)
$$;

-- As 0124, plus: a demo account never gets a board row, so no Questify-wide ranking reader ever sees one.
CREATE OR REPLACE FUNCTION xp_apply(who uuid, made bigint, delta integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
  month text := xp_month_of(made);
  target text;
BEGIN
  IF month IS NULL THEN
    RAISE EXCEPTION 'XP entry % does not exist', made USING ERRCODE = 'internal_error';
  END IF;
  UPDATE player_xp x SET xp = x.xp + delta, level = xp_level_of(x.xp + delta), updated_at = now()
  WHERE x.player_id = who
  RETURNING x.xp INTO total;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'player % has no XP row', who USING ERRCODE = 'internal_error';
  END IF;
  IF delta > 0 THEN
    PERFORM levels_reach(who, made, total);
  END IF;
  IF is_review_demo_player(who) THEN
    RETURN;
  END IF;
  FOREACH target IN ARRAY ARRAY['all', month] LOOP
    UPDATE xp_board b SET xp = b.xp + delta, xp_version = greatest(b.xp_version, made)
    WHERE b.board = target AND b.player_id = who;
    IF NOT FOUND THEN
      INSERT INTO xp_board (board, player_id, xp, xp_version) VALUES (target, who, delta, made);
    END IF;
  END LOOP;
END $$;

-- As 0073, plus: no demo account is ever in a promotion's pool (the marketing audience and invitation candidates read
-- through it).
CREATE OR REPLACE FUNCTION promo_pool(ch text, in_city text, any_of text[])
  RETURNS TABLE (player_id uuid, phone text, language text)
  LANGUAGE sql STABLE AS $$
  SELECT s.player_id, c.phone_e164, s.language
  FROM public.marketing_state s
  JOIN public.player p ON p.id = s.player_id AND p.status = 'active' AND public.marketing_adult(p.birth_year)
  LEFT JOIN public.player_contact c ON c.player_id = s.player_id
  LEFT JOIN public.player_preference f ON f.player_id = s.player_id
  WHERE s.channel = ch AND s.opted_in
    AND (ch <> 'sms' OR c.phone_e164 IS NOT NULL)
    AND (in_city IS NULL OR f.city_id = in_city)
    AND (any_of IS NULL OR cardinality(any_of) = 0 OR f.interests && any_of)
    AND NOT EXISTS (SELECT 1 FROM public.review_demo_player r WHERE r.player_id = s.player_id)
$$;

-- As 0073, plus: the demo event takes no invitation (`not_public`), at the request, the approval and every claim.
CREATE OR REPLACE FUNCTION invitation_event_ok(ev event, from_claim boolean) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN ev.id IS NULL OR ev.access <> 'public' THEN 'not_public'
    WHEN EXISTS (SELECT 1 FROM review_demo d WHERE d.event_id = ev.id) THEN 'not_public'
    WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN 'not_running'
    WHEN NOT from_claim AND ev.ends_at < now() + interval '24 hours' THEN 'ends_soon'
    WHEN NOT ('link' = ANY (ev.join_methods)) THEN 'link_off'
    WHEN ev.guest_list_only THEN 'guest_list_only'
    WHEN cardinality(ev.email_domains) > 0 THEN 'email_domains'
  END
$$;

-- ================================================================ console doors (ADR-560, ADR-564, ADR-568)
-- What the demo event holds against the readiness checklist (TypeScript lays the registries over it).
CREATE FUNCTION review_demo_readiness(ev uuid, org uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'questTypes', (SELECT coalesce(jsonb_agg(DISTINCT q.type), '[]'::jsonb) FROM quest q WHERE q.event_id = ev),
    'verifications', (SELECT coalesce(jsonb_agg(DISTINCT v.kind), '[]'::jsonb)
                      FROM quest q CROSS JOIN LATERAL unnest(q.verification) AS v(kind) WHERE q.event_id = ev),
    'rewards', (SELECT count(*) FROM reward w WHERE w.event_id = ev AND w.status = 'active'),
    'livePoll', EXISTS (SELECT 1 FROM quest q WHERE q.event_id = ev AND q.type = 'vote' AND q.type_config ? 'live'),
    'communityGoal', EXISTS (SELECT 1 FROM community_goal g WHERE g.event_id = ev),
    'flashQuest', EXISTS (SELECT 1 FROM quest q WHERE q.event_id = ev AND q.flash),
    'boost', EXISTS (SELECT 1 FROM boost b WHERE b.event_id = ev),
    'nfcTag', EXISTS (SELECT 1 FROM nfc_tag t WHERE t.event_id = ev),
    'station', EXISTS (SELECT 1 FROM paired_device d
                       WHERE d.event_id = ev AND d.kind = 'station' AND d.status = 'active'),
    'sessions', EXISTS (SELECT 1 FROM event_session s WHERE s.event_id = ev),
    'overrides', (SELECT coalesce(jsonb_object_agg(o.feature, o.enabled), '{}'::jsonb)
                  FROM organizer_feature_override o WHERE o.organizer_id = org))
$$;
REVOKE ALL ON FUNCTION review_demo_readiness(uuid, uuid) FROM PUBLIC;

-- The console page's state: `{"exists": false}` before Create. The reviewer phone is Questify's own number (Q-520),
-- shown to admins only; the code never leaves the database.
CREATE FUNCTION console_review_demo() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  demo review_demo;
BEGIN
  PERFORM console_admin();
  SELECT d.* INTO demo FROM review_demo d;
  IF demo.id IS NULL THEN
    RETURN jsonb_build_object('exists', false);
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'exists', true,
      'organizerId', demo.organizer_id,
      'eventId', e.id,
      'joinCode', e.join_code,
      'eventName', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
      'endsAt', e.ends_at,
      'contact', demo.contact,
      'reviewer', (SELECT jsonb_build_object(
                     'id', p.id, 'username', p.username, 'status', p.status,
                     'lastSignInAt', (SELECT max(s.created_at) FROM player_session s WHERE s.player_id = p.id))
                   FROM player p WHERE p.id = demo.player_id AND p.status <> 'deleted'),
      'windowUntil', CASE WHEN demo.window_until > now() THEN demo.window_until END,
      'codeSet', demo.code_hash IS NOT NULL,
      'preparedFor', demo.prepared_for,
      'preparedAt', demo.prepared_at,
      'fictionalPlayers', (SELECT count(*) FROM review_demo_player r WHERE r.role = 'fictional'),
      'readiness', review_demo_readiness(e.id, demo.organizer_id))
    FROM event e WHERE e.id = demo.event_id);
END $$;
REVOKE ALL ON FUNCTION console_review_demo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_review_demo() TO questify_app;

-- Refuses a reviewer phone that is malformed (RD400) or held by an account the demo did not make (RD409 contact_held).
CREATE FUNCTION review_demo_check_contact(phone text) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF phone IS NULL OR phone !~ '^\+9665[0-9]{8}$' THEN
    RAISE EXCEPTION 'the reviewer phone must be a Saudi mobile' USING ERRCODE = 'RD400', DETAIL = 'contact';
  END IF;
  IF EXISTS (SELECT 1 FROM player_contact pc WHERE pc.phone_e164 = phone AND NOT is_review_demo_player(pc.player_id)) THEN
    RAISE EXCEPTION 'this phone belongs to an account' USING ERRCODE = 'RD409', DETAIL = 'contact_held';
  END IF;
END $$;
REVOKE ALL ON FUNCTION review_demo_check_contact(text) FROM PUBLIC;

-- The 12 fictional players (no contact: they can never sign in), enrolled in the demo event with seeded points paid by
-- the creating admin as an ordinary award.
CREATE FUNCTION review_demo_seed_players(org uuid, ev uuid, admin uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  names   text[] := ARRAY['Noura_K', 'Faisal_A', 'Lama_S', 'Omar_H', 'Reem_T', 'Khalid_B', 'Dana_M', 'Yousef_R',
                          'Hessa_F', 'Turki_N', 'Maha_J', 'Saad_W'];
  avatars text[] := ARRAY['falcon', 'fox', 'camel', 'owl', 'lantern', 'explorer-hat'];
  made    uuid;
  joined  uuid;
BEGIN
  FOR i IN 1 .. cardinality(names) LOOP
    INSERT INTO player (username, birth_year, avatar)
    VALUES (review_demo_username(names[i], false), 1985 + i, avatars[1 + (i - 1) % cardinality(avatars)])
    RETURNING id INTO made;
    INSERT INTO review_demo_player (player_id, role) VALUES (made, 'fictional');
    INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES (org, ev, made, 'code')
    RETURNING id INTO joined;
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              staff_user_id)
    VALUES (org, ev, joined, 'award', 520 - 40 * i, 520 - 40 * i, 'staff', admin);
  END LOOP;
  PERFORM ranking_repair_mark(ev);
END $$;
REVOKE ALL ON FUNCTION review_demo_seed_players(uuid, uuid, uuid) FROM PUBLIC;

-- Create, once (RD409 `review_demo_exists`): the organizer (the admin its owner, the documents in force accepted), an
-- override On for every feature the API names, the live event with no activation request, the fictional players and
-- the reviewer account. The reviewer phone's open sign-in challenges are cancelled. `features` is the registry's
-- overridable list (TypeScript), so nothing here drifts from it.
CREATE FUNCTION console_review_demo_create(phone text, key bytea, fp bytea, features text[], request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me  uuid := console_admin();
  org uuid;
  ev  uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('review-demo', 0));
  IF EXISTS (SELECT 1 FROM review_demo) THEN
    RAISE EXCEPTION 'the review demo exists' USING ERRCODE = 'RD409', DETAIL = 'review_demo_exists';
  END IF;
  PERFORM review_demo_check_contact(phone);
  org := insert_organizer(me, 'Questify Review Demo', 'questify-review-demo-' || substr(md5(random()::text), 1, 6),
                          (SELECT f.version FROM legal_in_force_rows() f WHERE f.document = 'organizer_terms'),
                          (SELECT f.version FROM legal_in_force_rows() f WHERE f.document = 'organizer_dpa'),
                          (SELECT f.version FROM legal_in_force_rows() f WHERE f.document = 'organizer_content_rules'),
                          request);
  INSERT INTO organizer_feature_override (organizer_id, feature, enabled, set_by)
  SELECT org, f, true, me FROM unnest(features) AS f;
  INSERT INTO event (organizer_id, join_code, name_ar, name_en, venue_ar, venue_en, status, access, join_methods,
                     starts_at, ends_at, activated_at, activated_by)
  VALUES (org, 'DEMO' || upper(substr(md5(random()::text), 1, 6)), 'عرض مراجعة التطبيق', 'App Review Demo',
          'قاعة العرض', 'Demo hall', 'live', 'public', ARRAY['code', 'qr', 'link'], now(), now() + interval '60 days',
          now(), me)
  RETURNING id INTO ev;
  INSERT INTO review_demo (organizer_id, event_id, contact, contact_key, contact_fp, created_by)
  VALUES (org, ev, phone, key, fp, me);
  PERFORM review_demo_seed_players(org, ev, me);
  PERFORM review_demo_cancel_challenges(key);
  PERFORM review_demo_provision();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, org, ev, 'review_demo.create', 'review_demo', ev::text, request);
  RETURN console_review_demo();
END $$;
REVOKE ALL ON FUNCTION console_review_demo_create(text, bytea, bytea, text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_review_demo_create(text, bytea, bytea, text[], uuid) TO questify_app;

-- Change reviewer number: closes the window and clears the code, ends the reviewer's sessions, cancels the old and new
-- number's open challenges, and moves the reviewer account to the new number.
CREATE FUNCTION console_review_demo_set_contact(phone text, key bytea, fp bytea, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  demo review_demo;
BEGIN
  SELECT d.* INTO demo FROM review_demo d FOR UPDATE;
  IF demo.id IS NULL THEN
    RAISE EXCEPTION 'no review demo' USING ERRCODE = 'RD404';
  END IF;
  PERFORM review_demo_check_contact(phone);
  UPDATE review_demo
  SET contact = phone, contact_key = key, contact_fp = fp, code_hash = NULL, window_until = NULL;
  PERFORM review_demo_cancel_challenges(demo.contact_key);
  PERFORM review_demo_cancel_challenges(key);
  IF demo.player_id IS NOT NULL THEN
    PERFORM review_demo_revoke(demo.player_id);
    UPDATE player_contact SET phone_e164 = phone WHERE player_id = demo.player_id;
    IF FOUND THEN
      INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (demo.player_id, fp) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, demo.organizer_id, 'review_demo.set_contact', 'review_demo', demo.event_id::text, request);
  RETURN console_review_demo();
END $$;
REVOKE ALL ON FUNCTION console_review_demo_set_contact(text, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_review_demo_set_contact(text, bytea, bytea, uuid) TO questify_app;

-- Prepare for review (ADR-564): `phone` must still be the reviewer phone (RD409 `stale`, the key and fingerprint were
-- computed from it, so a rotated auth secret is caught up here) and no real account may hold it (RD409 `contact_held`);
-- the current reviewer is erased (held prizes
-- forfeited) and a fresh one provisioned; the code, window and version are stored; the phone's open challenges end.
-- Audited with the version and the window's end, never the code.
CREATE FUNCTION console_review_demo_prepare(phone text, key bytea, fp bytea, code bytea, days integer, version text,
                                            request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  demo   review_demo;
  target player;
BEGIN
  IF days IS NULL OR days NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'a review window is 1 to 30 days' USING ERRCODE = 'RD400', DETAIL = 'days';
  END IF;
  IF version IS NULL OR length(btrim(version)) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'the version is 1 to 20 characters' USING ERRCODE = 'RD400', DETAIL = 'version';
  END IF;
  IF code IS NULL OR octet_length(code) <> 32 THEN
    RAISE EXCEPTION 'a code hash is required' USING ERRCODE = 'RD400', DETAIL = 'code';
  END IF;
  SELECT d.* INTO demo FROM review_demo d FOR UPDATE;
  IF demo.id IS NULL THEN
    RAISE EXCEPTION 'no review demo' USING ERRCODE = 'RD404';
  END IF;
  IF phone IS DISTINCT FROM demo.contact THEN
    RAISE EXCEPTION 'the reviewer number changed' USING ERRCODE = 'RD409', DETAIL = 'stale';
  END IF;
  PERFORM review_demo_check_contact(demo.contact);
  IF demo.player_id IS NOT NULL THEN
    target := erase_target(demo.player_id);
    IF target.status <> 'deleted' THEN
      PERFORM erase_account(target, demo.contact_key, true, NULL);
    END IF;
  END IF;
  UPDATE review_demo
  SET contact_key = key, contact_fp = fp, code_hash = code, window_until = now() + make_interval(days => days),
      prepared_for = btrim(version), prepared_at = now(), prepared_by = me;
  PERFORM review_demo_cancel_challenges(demo.contact_key);
  PERFORM review_demo_cancel_challenges(key);
  PERFORM review_demo_provision();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, demo.organizer_id, 'review_demo.prepare', 'review_demo', demo.event_id::text,
          jsonb_build_object('version', btrim(version), 'windowUntil', now() + make_interval(days => days)), request);
  RETURN console_review_demo();
END $$;
REVOKE ALL ON FUNCTION console_review_demo_prepare(text, bytea, bytea, bytea, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_review_demo_prepare(text, bytea, bytea, bytea, integer, text, uuid) TO questify_app;

-- Close window: the fixed code stops at once and the reviewer's sessions end.
CREATE FUNCTION console_review_demo_close(request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  demo review_demo;
BEGIN
  SELECT d.* INTO demo FROM review_demo d FOR UPDATE;
  IF demo.id IS NULL THEN
    RAISE EXCEPTION 'no review demo' USING ERRCODE = 'RD404';
  END IF;
  UPDATE review_demo SET window_until = NULL;
  IF demo.player_id IS NOT NULL THEN
    PERFORM review_demo_revoke(demo.player_id);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, demo.organizer_id, 'review_demo.close', 'review_demo', demo.event_id::text, request);
  RETURN console_review_demo();
END $$;
REVOKE ALL ON FUNCTION console_review_demo_close(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_review_demo_close(uuid) TO questify_app;

-- The lifecycle tick's step (ADR-567), system context only (RD403): the demo event's end rolls to 90 days ahead when
-- it comes within 60, and a window past its end closes with the reviewer's sessions ended. Answers what it changed.
CREATE FUNCTION review_demo_tick() RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  demo  review_demo;
  moved integer := 0;
BEGIN
  IF NOT ranking_system() THEN
    RAISE EXCEPTION 'the review demo tick runs in the system context only' USING ERRCODE = 'RD403';
  END IF;
  SELECT d.* INTO demo FROM review_demo d FOR UPDATE SKIP LOCKED;
  IF demo.id IS NULL THEN
    RETURN 0;
  END IF;
  UPDATE event SET ends_at = now() + interval '90 days'
  WHERE id = demo.event_id AND ends_at < now() + interval '60 days';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF demo.window_until IS NOT NULL AND demo.window_until <= now() THEN
    UPDATE review_demo SET window_until = NULL;
    IF demo.player_id IS NOT NULL THEN
      PERFORM review_demo_revoke(demo.player_id);
    END IF;
    INSERT INTO audit_log (actor_type, organizer_id, action, target_type, target_id)
    VALUES ('system', demo.organizer_id, 'review_demo.window_closed', 'review_demo', demo.event_id::text);
    moved := moved + 1;
  END IF;
  RETURN moved;
END $$;
REVOKE ALL ON FUNCTION review_demo_tick() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_demo_tick() TO questify_app;
