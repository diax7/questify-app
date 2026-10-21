-- Changing or adding a phone or email (T-108, FR-125, FR-139): a code goes to the new contact, and only the right code
-- sets it on the player's account, replacing that channel's old value or adding it. A challenge of its own, bound to
-- the player; nothing tells whether a contact belongs to another account before its code is entered (the unique index
-- decides at confirm). Every change is audited without the contact. The API's role can no longer insert or update
-- player_contact: every row comes from create_player and changes through confirm_contact_change.

-- ================================================================ the API's role writes no contact directly
REVOKE INSERT, UPDATE ON player_contact FROM questify_app;

-- ================================================================ the challenge
CREATE TABLE player_contact_challenge (
  id          uuid PRIMARY KEY,
  player_id   uuid NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  channel     text NOT NULL CHECK (channel IN ('phone', 'email')),
  -- The new phone or email, held minutes: the row is deleted when it is confirmed, replaced or swept.
  contact     text NOT NULL CHECK (length(contact) BETWEEN 3 AND 254),
  code_hash   bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts    integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- The shapes player_contact accepts (0005), so a confirmed challenge can always become the contact.
  CHECK ((channel = 'phone' AND contact ~ '^\+9665[0-9]{8}$')
         OR (channel = 'email' AND contact = lower(contact) AND position('@' IN contact) > 1))
);
-- One live challenge per player: a new request replaces the earlier one.
CREATE UNIQUE INDEX player_contact_challenge_player_key ON player_contact_challenge (player_id);
ALTER TABLE player_contact_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_contact_challenge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_contact_challenge FROM PUBLIC;
-- No grant to the API's role: the definers below are the only way in.

-- Starts a change for the calling player. Outcomes: started, unchanged (it is already this player's). Whether another
-- account has the contact is not said here: only someone holding it learns that, at confirm.
CREATE FUNCTION start_contact_change(challenge uuid, token bytea, method text, contact_value text, code bytea)
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
  -- One row per player, replaced in one statement: two starts at once leave one live challenge and no error, and the
  -- earlier token stops working because its hash is overwritten.
  INSERT INTO player_contact_challenge (id, player_id, token_hash, channel, contact, code_hash, expires_at)
  VALUES (challenge, me, token, method, contact_value, code, now() + interval '5 minutes')
  ON CONFLICT (player_id) DO UPDATE
    SET id = EXCLUDED.id, token_hash = EXCLUDED.token_hash, channel = EXCLUDED.channel, contact = EXCLUDED.contact,
        code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now();
  RETURN 'started';
END $$;
REVOKE ALL ON FUNCTION start_contact_change(uuid, bytea, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_contact_change(uuid, bytea, text, text, bytea) TO questify_app;

-- Confirms a change with its code, for the calling player only. Outcomes: changed (kind added or replaced, with the
-- channel's previous value and the other channel's value, for the notices), wrong (attempts left), expired, taken
-- (another account has it: the unique index decides, so a race is an answer, not an error). The audit entry names
-- the channel and the kind, never a contact.
CREATE FUNCTION confirm_contact_change(token bytea, code bytea, request uuid)
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
  SELECT pc.* INTO mine FROM player_contact pc WHERE pc.player_id = me FOR UPDATE;
  before_value := CASE WHEN found.channel = 'phone' THEN mine.phone_e164 ELSE mine.email END;
  other_value := CASE WHEN found.channel = 'phone' THEN mine.email ELSE mine.phone_e164 END;
  BEGIN
    IF mine.player_id IS NULL THEN
      -- Every player gets a contact row at sign-up; one made another way gets it here.
      INSERT INTO player_contact (player_id, phone_e164, email)
      VALUES (me, CASE WHEN found.channel = 'phone' THEN found.contact END,
              CASE WHEN found.channel = 'email' THEN found.contact END);
    ELSIF found.channel = 'phone' THEN
      UPDATE player_contact SET phone_e164 = found.contact WHERE player_id = me;
    ELSE
      UPDATE player_contact SET email = found.contact WHERE player_id = me;
    END IF;
  -- The contact's unique index: another account has it. (Two first confirms for a player made without a contact row
  -- would also land here, through the primary key; only seeds make such players.)
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'taken'::text, 0, found.channel, NULL::text, NULL::text, NULL::text;
    RETURN;
  END;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.contact_change', 'player', me::text,
          jsonb_build_object('channel', found.channel,
                             'kind', CASE WHEN before_value IS NULL THEN 'added' ELSE 'replaced' END),
          request);
  RETURN QUERY SELECT 'changed'::text, 0, found.channel,
                      CASE WHEN before_value IS NULL THEN 'added' ELSE 'replaced' END, before_value, other_value;
END $$;
REVOKE ALL ON FUNCTION confirm_contact_change(bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_contact_change(bytea, bytea, uuid) TO questify_app;

-- The sweep also removes contact challenges an hour after they expired.
CREATE OR REPLACE FUNCTION sweep_player_sign_in() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM player_login_challenge
  WHERE greatest(expires_at, coalesce(signup_expires_at, expires_at)) < now() - interval '1 hour';
  DELETE FROM player_contact_challenge WHERE expires_at < now() - interval '1 hour';
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
