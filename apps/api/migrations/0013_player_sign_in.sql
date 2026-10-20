-- Player sign-in (T-107): one-time codes by SMS or email, account creation after the profile step, and sessions (a
-- short access token in player_session, a rotating refresh token). Every function that issues a session derives the
-- player from proof it consumes in the same transaction (a challenge token and its code, a signup token, a refresh
-- token); none takes a bare player id. The tables have no grant at all: definers only. Deny by default (docs/rules.md).

-- ================================================================ tables
ALTER TABLE player_session ADD COLUMN refresh_family uuid;
CREATE INDEX player_session_family_idx ON player_session (refresh_family) WHERE revoked_at IS NULL;

CREATE TABLE player_login_challenge (
  id                uuid PRIMARY KEY,
  token_hash        bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  channel           text NOT NULL CHECK (channel IN ('phone', 'email')),
  -- The phone (+966) or email the code went to: needed to send it again and to create the contact. Deleted with the
  -- row, which lives minutes.
  contact           text NOT NULL CHECK (length(contact) BETWEEN 3 AND 254),
  -- A keyed hash of the contact, to find a contact's earlier challenges without reading the contact.
  contact_key       bytea NOT NULL CHECK (octet_length(contact_key) = 32),
  code_hash         bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  resends           integer NOT NULL DEFAULT 0 CHECK (resends BETWEEN 0 AND 3),
  last_sent_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  cancelled_at      timestamptz,
  -- Set when a correct code proved a contact with no account: the profile step's proof, valid 15 minutes.
  signup_hash       bytea UNIQUE CHECK (octet_length(signup_hash) = 32),
  signup_expires_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- The same shapes player_contact accepts (0005), so a challenge can always become a contact.
  CHECK ((channel = 'phone' AND contact ~ '^\+9665[0-9]{8}$')
         OR (channel = 'email' AND contact = lower(contact) AND position('@' IN contact) > 1))
);
CREATE INDEX player_login_challenge_contact_idx ON player_login_challenge (contact_key) WHERE cancelled_at IS NULL;

CREATE TABLE player_refresh (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id   uuid NOT NULL REFERENCES player (id),
  family      uuid NOT NULL,
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  replaced_by uuid REFERENCES player_refresh (id),
  revoked_at  timestamptz
);
CREATE INDEX player_refresh_family_idx ON player_refresh (family);
CREATE INDEX player_refresh_player_idx ON player_refresh (player_id) WHERE revoked_at IS NULL;

ALTER TABLE player_login_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_login_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE player_refresh ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_refresh FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_login_challenge, player_refresh FROM PUBLIC;

-- ================================================================ sessions
-- Lifetimes live here, next to the rows they bound: access 1 hour, refresh 180 days (rotated on every use, so "stay
-- signed in until sign-out", FR-123, is the app refreshing in time), at most 10 live families per player.
CREATE FUNCTION issue_player_tokens(holder uuid, access_hash bytea, refresh_hash bytea, new_family uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
  VALUES (holder, new_family, refresh_hash, now() + interval '180 days');
  INSERT INTO player_session (player_id, token_hash, expires_at, refresh_family)
  VALUES (holder, access_hash, now() + interval '1 hour', new_family);
  -- Beyond 10 live families, the oldest go first: their refresh tokens and their access tokens end.
  WITH extra AS (
    SELECT r.family FROM player_refresh r
    WHERE r.player_id = holder AND r.revoked_at IS NULL
    GROUP BY r.family ORDER BY max(r.created_at) DESC OFFSET 10
  ), ended AS (
    UPDATE player_refresh p SET revoked_at = now()
    WHERE p.family IN (SELECT e.family FROM extra e) AND p.revoked_at IS NULL
    RETURNING p.family
  )
  UPDATE player_session s SET revoked_at = now()
  WHERE s.refresh_family IN (SELECT e.family FROM extra e) AND s.revoked_at IS NULL;
END $$;
-- Called only by the definers below, never by the API's role.
REVOKE ALL ON FUNCTION issue_player_tokens(uuid, bytea, bytea, uuid) FROM PUBLIC;

CREATE FUNCTION revoke_family(target uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE player_refresh SET revoked_at = now() WHERE family = target AND revoked_at IS NULL;
  UPDATE player_session SET revoked_at = now() WHERE refresh_family = target AND revoked_at IS NULL;
$$;
REVOKE ALL ON FUNCTION revoke_family(uuid) FROM PUBLIC;

-- ================================================================ challenges
-- A new code for a contact cancels that contact's earlier live challenges (one live code per contact).
CREATE FUNCTION start_player_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                       code bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE player_login_challenge SET cancelled_at = now()
  WHERE contact_key = key AND cancelled_at IS NULL;
  INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at)
  VALUES (challenge, token, method, contact_value, key, code, now() + interval '5 minutes');
END $$;
REVOKE ALL ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea) TO questify_app;

-- What the API needs to send a code again: only for a live challenge, and only when its token is known.
CREATE FUNCTION player_challenge_to_resend(token bytea)
  RETURNS TABLE (id uuid, channel text, contact text, resends integer, seconds_since_sent double precision)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.channel, c.contact, c.resends, extract(epoch FROM now() - c.last_sent_at)
  FROM player_login_challenge c
  WHERE c.token_hash = token AND c.cancelled_at IS NULL AND c.signup_hash IS NULL AND c.expires_at > now()
$$;
REVOKE ALL ON FUNCTION player_challenge_to_resend(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_challenge_to_resend(bytea) TO questify_app;

-- A new code for the same challenge: at most 3, 60 seconds apart; the tries start again.
CREATE FUNCTION resend_player_challenge(token bytea, code bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE player_login_challenge
  SET code_hash = code, resends = resends + 1, attempts = 0, last_sent_at = now(),
      expires_at = now() + interval '5 minutes'
  WHERE token_hash = token AND cancelled_at IS NULL AND signup_hash IS NULL AND expires_at > now()
    AND resends < 3 AND last_sent_at <= now() - interval '60 seconds';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;
REVOKE ALL ON FUNCTION resend_player_challenge(bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resend_player_challenge(bytea, bytea) TO questify_app;

-- The email fallback cancels the SMS code (FR-1812). An unknown or finished token changes nothing.
CREATE FUNCTION cancel_player_challenge(token bytea) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE player_login_challenge SET cancelled_at = now() WHERE token_hash = token AND cancelled_at IS NULL
$$;
REVOKE ALL ON FUNCTION cancel_player_challenge(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_player_challenge(bytea) TO questify_app;

-- ================================================================ verifying a code
-- Locks the challenge, so parallel guesses count one after the other (3 tries per code). Outcomes:
--   expired   no live challenge for this token (unknown, expired, cancelled, used up)
--   wrong     a wrong code; attempts_left says how many remain (0 ends the challenge)
--   banned    a right code for a player who is not active (banned; a deleted player's contact is gone, T-217): the
--             challenge is used up, nothing is issued
--   signed_in a right code for an active player: the challenge is used up and the tokens are issued
--   new       a right code for a contact with no account: the challenge now holds the signup token for 15 minutes
CREATE FUNCTION sign_in_player(token bytea, code bytea, access_hash bytea, refresh_hash bytea, family uuid,
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
  PERFORM issue_player_tokens(owner, access_hash, refresh_hash, family);
  RETURN QUERY SELECT 'signed_in'::text, 0, owner;
END $$;
REVOKE ALL ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea) TO questify_app;

-- ================================================================ creating the account (ADR-111)
-- Bound to the signup token a verified code produced. The year counts in Riyadh. Outcomes:
--   expired         no live signup for this token
--   invalid_birth_year  before 1900 or after this year (the token stays, to correct it)
--   too_young       under 13 by year (FR-119): nothing is created, and the token is used up
--   username_taken  the name is someone's, ignoring case (the token stays, to try another)
--   contact_taken   a parallel sign-up for the same contact won (the app signs in again and finds it)
--   created         the player, its contact and its tokens, with an audit entry
CREATE FUNCTION create_player(signup bytea, chosen_name text, born integer, access_hash bytea, refresh_hash bytea,
                              family uuid)
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
  IF NOT FOUND THEN
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
  IF EXISTS (SELECT 1 FROM player p WHERE lower(p.username) = lower(chosen_name)) THEN
    RETURN QUERY SELECT 'username_taken'::text, NULL::uuid;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO player (username, birth_year) VALUES (chosen_name, born) RETURNING id INTO made;
    INSERT INTO player_contact (player_id, phone_e164, email)
    VALUES (made,
            CASE WHEN found_challenge.channel = 'phone' THEN found_challenge.contact END,
            CASE WHEN found_challenge.channel = 'email' THEN found_challenge.contact END);
  EXCEPTION WHEN unique_violation THEN
    -- A name taken at the same moment, or the contact signed up in parallel: nothing of this attempt stays.
    IF EXISTS (SELECT 1 FROM player p WHERE lower(p.username) = lower(chosen_name)) THEN
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
  VALUES ('system', 'player.signup', 'player', made::text, jsonb_build_object('channel', found_challenge.channel));
  RETURN QUERY SELECT 'created'::text, made;
END $$;
REVOKE ALL ON FUNCTION create_player(bytea, text, integer, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_player(bytea, text, integer, bytea, bytea, uuid) TO questify_app;

-- ================================================================ refreshing and signing out
-- Rotates a refresh token (locked, so two retries at once are one after the other). Outcomes:
--   invalid   unknown, expired, revoked with its family ended, or its player is no longer active (the family is
--             revoked then)
--   rotated   a new pair in the same family; the family's earlier access tokens end
--   reused    an already-rotated token outside the 60-second retry grace, or whose successor was already used, or a
--             revoked token while its family still lives: a sign of theft, so the whole family ends (audited)
-- Within 60 seconds of a rotation whose successor was never used, a retry (the answer was lost on a weak network)
-- replaces that successor instead.
CREATE FUNCTION rotate_player_refresh(presented bytea, access_hash bytea, refresh_hash bytea)
  RETURNS TABLE (outcome text, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_refresh player_refresh%ROWTYPE;
  successor     player_refresh%ROWTYPE;
  owner_status  text;
BEGIN
  SELECT * INTO found_refresh FROM player_refresh r WHERE r.token_hash = presented FOR UPDATE;
  IF NOT FOUND OR found_refresh.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  -- A revoked token while its family still has a live one: someone else replayed a token within the grace and was
  -- given the live successor. End the family for both of them.
  IF found_refresh.revoked_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = found_refresh.family AND r.revoked_at IS NULL) THEN
      PERFORM revoke_family(found_refresh.family);
      INSERT INTO audit_log (actor_type, action, target_type, target_id)
      VALUES ('system', 'player.refresh_reuse', 'player', found_refresh.player_id::text);
      RETURN QUERY SELECT 'reused'::text, NULL::uuid;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT status INTO owner_status FROM player WHERE id = found_refresh.player_id;
  IF owner_status <> 'active' THEN
    PERFORM revoke_family(found_refresh.family);
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF found_refresh.used_at IS NOT NULL THEN
    SELECT * INTO successor FROM player_refresh r WHERE r.id = found_refresh.replaced_by FOR UPDATE;
    IF found_refresh.used_at > now() - interval '60 seconds' AND successor.used_at IS NULL
       AND successor.revoked_at IS NULL THEN
      UPDATE player_refresh SET revoked_at = now() WHERE id = successor.id;
    ELSE
      PERFORM revoke_family(found_refresh.family);
      INSERT INTO audit_log (actor_type, action, target_type, target_id)
      VALUES ('system', 'player.refresh_reuse', 'player', found_refresh.player_id::text);
      RETURN QUERY SELECT 'reused'::text, NULL::uuid;
      RETURN;
    END IF;
  END IF;
  UPDATE player_session SET revoked_at = now() WHERE refresh_family = found_refresh.family AND revoked_at IS NULL;
  PERFORM issue_player_tokens(found_refresh.player_id, access_hash, refresh_hash, found_refresh.family);
  UPDATE player_refresh
  SET used_at = coalesce(used_at, now()),
      replaced_by = (SELECT r.id FROM player_refresh r WHERE r.token_hash = refresh_hash)
  WHERE id = found_refresh.id;
  RETURN QUERY SELECT 'rotated'::text, found_refresh.player_id;
END $$;
REVOKE ALL ON FUNCTION rotate_player_refresh(bytea, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_player_refresh(bytea, bytea, bytea) TO questify_app;

-- Sign-out of this device: its whole family (refresh and access tokens) ends. By the refresh token, which the app
-- always holds, so a device whose access token already expired still signs out. An unknown token changes nothing.
CREATE FUNCTION sign_out_player(presented bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
BEGIN
  SELECT family INTO target FROM player_refresh WHERE token_hash = presented;
  IF target IS NOT NULL THEN
    PERFORM revoke_family(target);
  END IF;
END $$;
REVOKE ALL ON FUNCTION sign_out_player(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_out_player(bytea) TO questify_app;

-- ================================================================ retention
-- Challenges hold a phone or an email: gone an hour after they expire. Ended or used tokens: gone 7 days after.
CREATE FUNCTION sweep_player_sign_in() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM player_login_challenge
  WHERE greatest(expires_at, coalesce(signup_expires_at, expires_at)) < now() - interval '1 hour';
  DELETE FROM player_session
  WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days') OR expires_at < now() - interval '7 days';
  UPDATE player_refresh SET replaced_by = NULL
  WHERE replaced_by IN (SELECT id FROM player_refresh
                        WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
                           OR (used_at IS NOT NULL AND used_at < now() - interval '7 days')
                           OR expires_at < now() - interval '7 days');
  DELETE FROM player_refresh
  WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')
     OR (used_at IS NOT NULL AND used_at < now() - interval '7 days')
     OR expires_at < now() - interval '7 days';
$$;
REVOKE ALL ON FUNCTION sweep_player_sign_in() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_player_sign_in() TO questify_app;
