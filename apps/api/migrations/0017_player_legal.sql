-- Player legal steps (T-110): the terms and the privacy policy are accepted before any contact is stored (FR-1705),
-- carried on the sign-in challenge and recorded with the player; a returning player's acceptance at sign-in counts too;
-- re-acceptance and the community guidelines (FR-1706) are recorded through one definer. No backfill: players created
-- before this have no acceptance and are asked for one.

-- ================================================================ what was accepted, and when
CREATE TABLE player_acceptance (
  player_id   uuid NOT NULL REFERENCES player (id) ON DELETE RESTRICT,
  document    text NOT NULL CHECK (document IN ('terms_of_use', 'privacy_policy', 'community_guidelines')),
  version     text NOT NULL CHECK (version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  -- How it was given: at sign-up, at a returning sign-in, re-accepting a new version, or before a first submission.
  method      text NOT NULL CHECK (method IN ('signup', 'sign_in', 'reaccept', 'submission')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, document, version)
);
ALTER TABLE player_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_acceptance FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_acceptance FROM PUBLIC;
CREATE POLICY player_acceptance_own ON player_acceptance FOR SELECT TO questify_app
  USING (player_id = app_player_id());
-- Read by the player (GET /v1/me); written only by the definers below.
GRANT SELECT ON player_acceptance TO questify_app;

-- Append-only for every role, like the username history: erasure (T-217) deletes under app.erasure.
CREATE FUNCTION player_acceptance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'acceptances can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION player_acceptance_append_only() FROM PUBLIC;
CREATE TRIGGER player_acceptance_no_change BEFORE UPDATE OR DELETE ON player_acceptance
  FOR EACH ROW EXECUTE FUNCTION player_acceptance_append_only();
CREATE TRIGGER player_acceptance_no_truncate BEFORE TRUNCATE ON player_acceptance
  FOR EACH STATEMENT EXECUTE FUNCTION player_acceptance_append_only();
ALTER TABLE player_acceptance ENABLE ALWAYS TRIGGER player_acceptance_no_change;
ALTER TABLE player_acceptance ENABLE ALWAYS TRIGGER player_acceptance_no_truncate;

-- ================================================================ the challenge carries the accepted versions
-- Live challenges are minutes old and nothing is launched: start clean so the columns can be required.
DELETE FROM player_login_challenge;
ALTER TABLE player_login_challenge
  ADD COLUMN terms_version text NOT NULL CHECK (terms_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  ADD COLUMN privacy_version text NOT NULL CHECK (privacy_version ~ '^[0-9]+(\.[0-9]+){0,2}$');

DROP FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea);
-- A new code for a contact cancels that contact's earlier live challenges (one live code per contact). The versions are
-- the terms and privacy the person accepted on the sign-in screen; the API checks they are the ones in force.
CREATE FUNCTION start_player_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                       code bytea, terms text, privacy text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE player_login_challenge SET cancelled_at = now()
  WHERE contact_key = key AND cancelled_at IS NULL;
  INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                      terms_version, privacy_version)
  VALUES (challenge, token, method, contact_value, key, code, now() + interval '5 minutes', terms, privacy);
END $$;
REVOKE ALL ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text) TO questify_app;

-- ================================================================ sign-in and sign-up record them
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
  -- A returning player accepted the versions in force before the code was sent; record them too (once each).
  INSERT INTO player_acceptance (player_id, document, version, method, accepted_at)
  VALUES (owner, 'terms_of_use', found_challenge.terms_version, 'sign_in', found_challenge.created_at),
         (owner, 'privacy_policy', found_challenge.privacy_version, 'sign_in', found_challenge.created_at)
  ON CONFLICT DO NOTHING;
  PERFORM issue_player_tokens(owner, access_hash, refresh_hash, family);
  RETURN QUERY SELECT 'signed_in'::text, 0, owner;
END $$;
REVOKE ALL ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea) TO questify_app;

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
REVOKE ALL ON FUNCTION create_player(bytea, text, integer, text, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_player(bytea, text, integer, text, bytea, bytea, uuid) TO questify_app;

-- ================================================================ re-accepting, and the guidelines (FR-1705, FR-1706)
-- The caller's own acceptance of the given documents ({document, version} pairs; the API passes only the versions in
-- force). Accepting a version twice changes nothing. The method is 'reaccept' or 'submission': sign-up and sign-in are
-- recorded only by their own functions. Raises for a caller who is not an active player.
CREATE FUNCTION accept_player_documents(documents jsonb, how text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
BEGIN
  IF how IS NULL OR how NOT IN ('reaccept', 'submission') THEN
    RAISE EXCEPTION 'accept_player_documents records only reaccept or submission'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT id INTO me FROM player WHERE id = app_player_id() AND status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO player_acceptance (player_id, document, version, method)
  SELECT me, item ->> 'document', item ->> 'version', how FROM jsonb_array_elements(documents) item
  ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION accept_player_documents(jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_player_documents(jsonb, text) TO questify_app;
