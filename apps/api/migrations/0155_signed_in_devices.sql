-- T-810c (plan docs/plans/2026-11-05-t-810c-signed-in-devices.md, review 84; ADR-710 to ADR-716; Q-661, Q-680, Q-681;
-- ASVS V7.4.3, V7.4.5, V7.5.2): signed-in devices for players, a fresh factor before ending other sessions for players
-- and staff, and the console's "end every session" of one staff account.
--
-- A player device is one refresh family (0013) with its own row, player_sign_in_device: a label the app sends at sign-in
-- (platform, expo-device model; never an IP, a location, a user agent or an install id), when it signed in, when a
-- fresh code was typed on it, and when it ended. Every way a family ends goes through end_family, which locks the
-- device row first; rotate_player_refresh takes the same lock first and answers `invalid` for an ended family or one
-- with no row, so a rotation running beside an end either finishes first (and its new tokens are ended with the rest)
-- or sees the end (ADR-712). revoke_family is dropped: end_family replaces it.
--
-- Fresh (ADR-711, Q-681): a sign-in, a re-authentication code or (players) a contact-change code on this family or this
-- staff session in the last 10 minutes. Ending another device or session checks it here, not only in the API. On
-- staff_session the API role keeps UPDATE only on the row of the token being looked up (the session check's touch and
-- lapse) and loses INSERT: opening a session, changing the password and ending a session are definers (review item 5).
--
-- Rollout: the backfill gives a device row to every family that holds a live, unexpired refresh token, so nobody is
-- signed out. confirm_contact_change gains the session hash and its 3-argument version is dropped (ADR-715): between this
-- migration and the new API instance a contact change on the old instance answers 500, and the app's retry with the
-- same Idempotency-Key recovers it (RUNBOOK). The staff session writes move to definers in the same way: an old API
-- instance's sign-in fails for the deploy's minute and the person signs in again.
--
-- Deny by default: the three new tables are RLS-forced with no policy and no grant (definers only), revoked from PUBLIC.
-- Every function created or replaced here is revoked from PUBLIC next to it; only the doors the API calls are granted.
SET LOCAL lock_timeout = '10s';

-- ================================================================ tables
CREATE TABLE player_sign_in_device (
  -- What the app sees. Never the family, which push devices and refresh rows key on.
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    uuid NOT NULL REFERENCES player (id),
  family       uuid NOT NULL UNIQUE,
  platform     text CHECK (platform IN ('ios', 'android')),
  model        text CHECK (model ~ '^[A-Za-z0-9 ._()+-]{1,40}$'),
  signed_in_at timestamptz NOT NULL,
  reauth_at    timestamptz,
  ended_at     timestamptz
);
CREATE INDEX player_sign_in_device_live_idx ON player_sign_in_device (player_id) WHERE ended_at IS NULL;

-- One live code a family: a new request replaces it. No contact column: the definer reads it from player_contact.
CREATE TABLE player_reauth_challenge (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  uuid NOT NULL REFERENCES player (id),
  family     uuid NOT NULL UNIQUE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  channel    text NOT NULL CHECK (channel IN ('phone', 'email')),
  code_hash  bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts   integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Written only by definers: it is not in the API's column UPDATE grant (0002 grants last_seen_at and revoked_at).
ALTER TABLE staff_session ADD COLUMN reauth_at timestamptz;

-- Bound to one session, so a code asked on one session cannot be confirmed from another.
CREATE TABLE staff_reauth_challenge (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL UNIQUE REFERENCES staff_session (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  code_hash    bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  resends      integer NOT NULL DEFAULT 0 CHECK (resends BETWEEN 0 AND 3),
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE player_sign_in_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_sign_in_device FORCE ROW LEVEL SECURITY;
ALTER TABLE player_reauth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_reauth_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_reauth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_reauth_challenge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_sign_in_device, player_reauth_challenge, staff_reauth_challenge FROM PUBLIC;

-- Every family with a live, unexpired refresh token gets its row; the platform of its push device when it has one.
INSERT INTO player_sign_in_device (player_id, family, platform, signed_in_at)
SELECT r.player_id, r.family,
       (SELECT d.platform FROM push_device d WHERE d.family = r.family ORDER BY d.id LIMIT 1),
       min(r.family_started_at)
FROM player_refresh r
WHERE r.revoked_at IS NULL AND r.expires_at > now()
GROUP BY r.player_id, r.family;

-- ================================================================ staff_session: the API writes only the looked-up row
DROP POLICY session_update ON staff_session;
CREATE POLICY session_update ON staff_session FOR UPDATE TO questify_app
  USING (token_hash = app_session_token_hash())
  WITH CHECK (token_hash = app_session_token_hash());
DROP POLICY session_insert_own ON staff_session;
REVOKE INSERT ON staff_session FROM questify_app;

-- As 0002, plus: a re-authentication time never moves backwards or goes away.
CREATE OR REPLACE FUNCTION staff_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revoked session cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'last_seen_at cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.reauth_at IS NOT NULL AND (NEW.reauth_at IS NULL OR NEW.reauth_at < OLD.reauth_at) THEN
    RAISE EXCEPTION 'reauth_at cannot move backwards' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION staff_session_guard() FROM PUBLIC;

-- ================================================================ ending a family (the one way)
-- Locks the family's device row, marks it ended, then ends its refresh and access tokens, its re-authentication code,
-- its push device and that device's queued sends. A family with no device row (none after the backfill) still has its
-- tokens ended. True when the device row was live.
CREATE FUNCTION end_family(ending uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  was_live boolean;
BEGIN
  SELECT d.ended_at IS NULL INTO was_live FROM player_sign_in_device d WHERE d.family = ending FOR UPDATE;
  UPDATE player_sign_in_device SET ended_at = now() WHERE family = ending AND ended_at IS NULL;
  UPDATE player_refresh SET revoked_at = now() WHERE family = ending AND revoked_at IS NULL;
  UPDATE player_session SET revoked_at = now() WHERE refresh_family = ending AND revoked_at IS NULL;
  DELETE FROM player_reauth_challenge WHERE family = ending;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.family = ending;
  DELETE FROM push_device WHERE family = ending;
  RETURN coalesce(was_live, false);
END $$;
REVOKE ALL ON FUNCTION end_family(uuid) FROM PUBLIC;

-- Ends every family of a player that still has a device row or a live refresh token, in device-id order (rows without
-- a device row last), so two ends of overlapping families never lock in opposite orders. Answers how many families
-- held a live refresh token.
CREATE FUNCTION end_player_families(holder uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  fam   record;
  live  integer;
BEGIN
  SELECT count(DISTINCT r.family)::integer INTO live FROM player_refresh r
  WHERE r.player_id = holder AND r.revoked_at IS NULL;
  FOR fam IN
    SELECT f.family FROM (
      SELECT d.family FROM player_sign_in_device d WHERE d.player_id = holder AND d.ended_at IS NULL
      UNION
      SELECT r.family FROM player_refresh r WHERE r.player_id = holder AND r.revoked_at IS NULL) f
    LEFT JOIN player_sign_in_device x ON x.family = f.family
    ORDER BY x.id NULLS LAST, f.family
  LOOP
    PERFORM end_family(fam.family);
  END LOOP;
  RETURN live;
END $$;
REVOKE ALL ON FUNCTION end_player_families(uuid) FROM PUBLIC;
DROP FUNCTION revoke_family(uuid);

-- ================================================================ issuing, rotating, signing out
-- As 0154, plus: a new family gets its device row, and the 10-family cap ends the oldest through end_family, in
-- device-id order. A sign-in that has to wait for an oldest family's rotation ends it once the rotation commits, its
-- new tokens included (end_family's updates run after the lock, on a fresh snapshot).
CREATE OR REPLACE FUNCTION issue_player_tokens(holder uuid, access_hash bytea, refresh_hash bytea, new_family uuid)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  started    timestamptz;
  family_end timestamptz;
  extra      record;
BEGIN
  started := coalesce((SELECT min(r.family_started_at) FROM player_refresh r WHERE r.family = new_family), now());
  family_end := started + interval '365 days';
  INSERT INTO player_sign_in_device (player_id, family, signed_in_at)
  VALUES (holder, new_family, started)
  ON CONFLICT (family) DO NOTHING;
  INSERT INTO player_refresh (player_id, family, token_hash, expires_at, family_started_at)
  VALUES (holder, new_family, refresh_hash, least(now() + interval '180 days', family_end), started);
  INSERT INTO player_session (player_id, token_hash, expires_at, refresh_family)
  VALUES (holder, access_hash, least(now() + interval '1 hour', family_end), new_family);
  -- Beyond 10 live families, the oldest go first.
  FOR extra IN
    SELECT e.family FROM (
      SELECT r.family FROM player_refresh r
      WHERE r.player_id = holder AND r.revoked_at IS NULL
      GROUP BY r.family ORDER BY max(r.created_at) DESC OFFSET 10) e
    LEFT JOIN player_sign_in_device d ON d.family = e.family
    ORDER BY d.id NULLS LAST, e.family
  LOOP
    PERFORM end_family(extra.family);
  END LOOP;
END $$;
-- Called only by the definers that issue a session, never by the API's role.
REVOKE ALL ON FUNCTION issue_player_tokens(uuid, bytea, bytea, uuid) FROM PUBLIC;

-- As 0118, plus the lock order of ADR-712: the presented token's family is read without a lock, its device row is
-- locked, and an ended family or one with no device row answers `invalid`; only then is the refresh row locked.
CREATE OR REPLACE FUNCTION rotate_player_refresh(presented bytea, access_hash bytea, refresh_hash bytea)
  RETURNS TABLE (outcome text, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  fam           uuid;
  device_ended  timestamptz;
  found_refresh player_refresh%ROWTYPE;
  successor     player_refresh%ROWTYPE;
  owner_status  text;
  cutoff        timestamptz;
BEGIN
  SELECT r.family INTO fam FROM player_refresh r WHERE r.token_hash = presented;
  SELECT d.ended_at INTO device_ended FROM player_sign_in_device d WHERE d.family = fam FOR UPDATE;
  IF NOT FOUND OR device_ended IS NOT NULL THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO found_refresh FROM player_refresh r WHERE r.token_hash = presented FOR UPDATE;
  IF NOT FOUND OR found_refresh.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF found_refresh.revoked_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = found_refresh.family AND r.revoked_at IS NULL) THEN
      PERFORM end_family(found_refresh.family);
      INSERT INTO audit_log (actor_type, action, target_type, target_id)
      VALUES ('system', 'player.refresh_reuse', 'player', found_refresh.player_id::text);
      RETURN QUERY SELECT 'reused'::text, NULL::uuid;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT p.status, p.tokens_valid_after INTO owner_status, cutoff FROM player p WHERE p.id = found_refresh.player_id;
  IF owner_status <> 'active' OR found_refresh.created_at <= coalesce(cutoff, '-infinity'::timestamptz) THEN
    PERFORM end_family(found_refresh.family);
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF found_refresh.used_at IS NOT NULL THEN
    SELECT * INTO successor FROM player_refresh r WHERE r.id = found_refresh.replaced_by FOR UPDATE;
    IF found_refresh.used_at > now() - interval '60 seconds' AND successor.used_at IS NULL
       AND successor.revoked_at IS NULL THEN
      UPDATE player_refresh SET revoked_at = now() WHERE id = successor.id;
    ELSE
      PERFORM end_family(found_refresh.family);
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

-- As 0013: sign-out of this device ends its whole family, now through end_family.
CREATE OR REPLACE FUNCTION sign_out_player(presented bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
BEGIN
  SELECT family INTO target FROM player_refresh WHERE token_hash = presented;
  IF target IS NOT NULL THEN
    PERFORM end_family(target);
  END IF;
END $$;
REVOKE ALL ON FUNCTION sign_out_player(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_out_player(bytea) TO questify_app;

-- As 0144: every session of the reviewer account ends, now family by family.
CREATE OR REPLACE FUNCTION review_demo_revoke(target uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM end_player_families(target);
  UPDATE player_session SET revoked_at = now() WHERE player_id = target AND revoked_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION review_demo_revoke(uuid) FROM PUBLIC;

-- As 0020, plus: device rows ended more than 7 days ago or whose family has no refresh row left, and expired
-- re-authentication codes (an hour after they expire, as the other codes).
CREATE OR REPLACE FUNCTION sweep_player_sign_in() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM player_login_challenge
  WHERE greatest(expires_at, coalesce(signup_expires_at, expires_at)) < now() - interval '1 hour';
  DELETE FROM player_contact_challenge WHERE expires_at < now() - interval '1 hour';
  DELETE FROM player_reauth_challenge WHERE expires_at < now() - interval '1 hour';
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
  DELETE FROM player_sign_in_device d
  WHERE d.ended_at < now() - interval '7 days'
     OR NOT EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = d.family);
$$;
REVOKE ALL ON FUNCTION sweep_player_sign_in() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_player_sign_in() TO questify_app;

-- ================================================================ the player's devices (the calling player)
-- Fresh: signed in, or a re-authentication or contact-change code typed, on this family in the last 10 minutes.
CREATE FUNCTION player_device_fresh_until(d player_sign_in_device) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN greatest(d.signed_in_at, coalesce(d.reauth_at, '-infinity'::timestamptz)) + interval '10 minutes'
                   > now()
              THEN greatest(d.signed_in_at, coalesce(d.reauth_at, '-infinity'::timestamptz)) + interval '10 minutes'
         END
$$;
REVOKE ALL ON FUNCTION player_device_fresh_until(player_sign_in_device) FROM PUBLIC;

-- The device row of the request's own sign-in (push_session_family, 0076: PN401 unless a live access session of the
-- calling active player). No lock.
CREATE FUNCTION player_current_device(session bytea) RETURNS player_sign_in_device
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  fam uuid := push_session_family(session);
  hit player_sign_in_device;
BEGIN
  SELECT d.* INTO hit FROM player_sign_in_device d WHERE d.family = fam AND d.ended_at IS NULL;
  IF hit.id IS NULL THEN
    RAISE EXCEPTION 'a live session of the calling player is required' USING ERRCODE = 'PN401';
  END IF;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION player_current_device(bytea) FROM PUBLIC;

-- Labels the family of a refresh token just issued (the proof: only its holder has it), once, while unlabelled.
-- A dead or unknown token, or a labelled family, changes nothing.
CREATE FUNCTION label_player_device(refresh_hash bytea, plat text, device_model text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  changed integer;
BEGIN
  UPDATE player_sign_in_device d SET platform = plat, model = device_model
  FROM player_refresh r
  WHERE r.token_hash = refresh_hash AND r.revoked_at IS NULL AND r.used_at IS NULL AND r.expires_at > now()
    AND d.family = r.family AND d.ended_at IS NULL AND d.platform IS NULL AND d.model IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END $$;
REVOKE ALL ON FUNCTION label_player_device(bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION label_player_device(bytea, text, text) TO questify_app;

-- The calling player's devices whose family still holds a live, unexpired refresh token (at most 10): this device
-- first, then by last use. last_used_at is the family's latest rotation; fresh_until only for this device.
CREATE FUNCTION player_devices(session bytea)
  RETURNS TABLE (id uuid, platform text, model text, signed_in_at timestamptz, last_used_at timestamptz,
                 is_current boolean, fresh_until timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here player_sign_in_device := player_current_device(session);
BEGIN
  RETURN QUERY
  SELECT d.id, d.platform, d.model, d.signed_in_at, l.last_used, d.id = here.id,
         CASE WHEN d.id = here.id THEN player_device_fresh_until(d) END
  FROM player_sign_in_device d
  CROSS JOIN LATERAL (SELECT max(r.created_at) AS last_used FROM player_refresh r
                      WHERE r.family = d.family AND r.revoked_at IS NULL AND r.expires_at > now()) l
  WHERE d.player_id = here.player_id AND d.ended_at IS NULL AND l.last_used IS NOT NULL
  ORDER BY d.id = here.id DESC, l.last_used DESC, d.id
  LIMIT 10;
END $$;
REVOKE ALL ON FUNCTION player_devices(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_devices(bytea) TO questify_app;

-- A re-authentication code for this family to the account's own phone or email. no_contact when the account has none
-- on that channel; else the family's code is replaced and the contact returned (the API sends it, masked for the
-- answer). The code is stored only as its keyed hash.
CREATE FUNCTION start_player_reauth(session bytea, method text, token bytea, code bytea)
  RETURNS TABLE (outcome text, contact text, masked text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here  player_sign_in_device := player_current_device(session);
  value text;
BEGIN
  IF method IS NULL OR method NOT IN ('phone', 'email') THEN
    RAISE EXCEPTION 'unknown channel' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT CASE WHEN method = 'phone' THEN pc.phone_e164 ELSE pc.email END INTO value
  FROM player_contact pc WHERE pc.player_id = here.player_id;
  IF value IS NULL THEN
    RETURN QUERY SELECT 'no_contact'::text, NULL::text, NULL::text;
    RETURN;
  END IF;
  INSERT INTO player_reauth_challenge (player_id, family, token_hash, channel, code_hash, expires_at)
  VALUES (here.player_id, here.family, token, method, code, now() + interval '5 minutes')
  ON CONFLICT (family) DO UPDATE
    SET id = gen_random_uuid(), token_hash = EXCLUDED.token_hash, channel = EXCLUDED.channel,
        code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now();
  RETURN QUERY SELECT 'started'::text, value,
                      CASE WHEN method = 'phone' THEN contact_masked(value, NULL) ->> 'phone'
                           ELSE contact_masked(NULL, value) ->> 'email' END;
END $$;
REVOKE ALL ON FUNCTION start_player_reauth(bytea, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_player_reauth(bytea, text, bytea, bytea) TO questify_app;

-- Confirms this family's code: expired (unknown, used up or asked from another family), wrong (tries left), or
-- confirmed (reauth_at set, the code gone, audited). Lock order: the device row, then the code.
CREATE FUNCTION confirm_player_reauth(session bytea, token bytea, code bytea, request uuid)
  RETURNS TABLE (outcome text, attempts_left integer, fresh_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here  player_sign_in_device := player_current_device(session);
  found player_reauth_challenge;
  moved player_sign_in_device;
BEGIN
  PERFORM 1 FROM player_sign_in_device d WHERE d.id = here.id FOR UPDATE;
  SELECT c.* INTO found FROM player_reauth_challenge c
  WHERE c.token_hash = token AND c.family = here.family AND c.expires_at > now()
  FOR UPDATE;
  IF found.id IS NULL OR found.attempts >= 3 THEN
    RETURN QUERY SELECT 'expired'::text, 0, NULL::timestamptz;
    RETURN;
  END IF;
  IF found.code_hash <> code THEN
    UPDATE player_reauth_challenge SET attempts = attempts + 1 WHERE id = found.id;
    RETURN QUERY SELECT 'wrong'::text, 2 - found.attempts, NULL::timestamptz;
    RETURN;
  END IF;
  DELETE FROM player_reauth_challenge WHERE id = found.id;
  UPDATE player_sign_in_device SET reauth_at = now() WHERE id = here.id RETURNING * INTO moved;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.reauth', 'player', here.player_id::text,
          jsonb_build_object('channel', found.channel), request);
  RETURN QUERY SELECT 'confirmed'::text, 0, player_device_fresh_until(moved);
END $$;
REVOKE ALL ON FUNCTION confirm_player_reauth(bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_player_reauth(bytea, bytea, bytea, uuid) TO questify_app;

-- Ends another device of the calling player: not_found (unknown or someone else's: one answer), current (that is this
-- device: sign out instead), already_ended (still the caller's), reauth_required, or ended (audited).
CREATE FUNCTION end_player_device(session bytea, target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here player_sign_in_device := player_current_device(session);
  hit  player_sign_in_device;
BEGIN
  SELECT d.* INTO hit FROM player_sign_in_device d WHERE d.id = target AND d.player_id = here.player_id;
  IF hit.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF hit.id = here.id THEN
    RETURN 'current';
  END IF;
  IF hit.ended_at IS NOT NULL THEN
    RETURN 'already_ended';
  END IF;
  IF player_device_fresh_until(here) IS NULL THEN
    RETURN 'reauth_required';
  END IF;
  IF NOT end_family(hit.family) THEN
    RETURN 'already_ended';
  END IF;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.device.end', 'player', here.player_id::text, jsonb_build_object('deviceId', hit.id),
          request);
  RETURN 'ended';
END $$;
REVOKE ALL ON FUNCTION end_player_device(bytea, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_player_device(bytea, uuid, uuid) TO questify_app;

-- Ends every other live device of the calling player after the fresh check: the rows it locks, in id order, and only
-- those (a sign-in that commits after the lock stays live). Ending none answers ended 0.
CREATE FUNCTION end_other_player_devices(session bytea, request uuid)
  RETURNS TABLE (outcome text, ended integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here  player_sign_in_device := player_current_device(session);
  other record;
  n     integer := 0;
BEGIN
  IF player_device_fresh_until(here) IS NULL THEN
    RETURN QUERY SELECT 'reauth_required'::text, 0;
    RETURN;
  END IF;
  FOR other IN
    SELECT d.family FROM player_sign_in_device d
    WHERE d.player_id = here.player_id AND d.id <> here.id AND d.ended_at IS NULL
    ORDER BY d.id FOR UPDATE
  LOOP
    IF end_family(other.family) THEN
      n := n + 1;
    END IF;
  END LOOP;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.devices.end_others', 'player', here.player_id::text, jsonb_build_object('ended', n),
          request);
  RETURN QUERY SELECT 'ended'::text, n;
END $$;
REVOKE ALL ON FUNCTION end_other_player_devices(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_other_player_devices(bytea, uuid) TO questify_app;

-- ================================================================ staff sessions (the calling staff member)
-- Opens a session for the calling staff member (sign-in and sign-up, after their proofs) and ends the oldest live ones
-- beyond 10, newest first. Answers the new session's id and how many older ones ended.
CREATE FUNCTION open_staff_session(token bytea, agent text, address text)
  RETURNS TABLE (session_id uuid, ended integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me  uuid := app_staff_user_id();
  sid uuid;
  n   integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'a staff user is required' USING ERRCODE = 'SS401';
  END IF;
  INSERT INTO staff_session (staff_user_id, token_hash, user_agent, ip)
  VALUES (me, token, left(agent, 300), left(address, 64)) RETURNING id INTO sid;
  UPDATE staff_session SET revoked_at = now()
  WHERE id IN (SELECT s.id FROM staff_session s WHERE s.staff_user_id = me AND s.revoked_at IS NULL
               ORDER BY s.created_at DESC, s.id = sid DESC, s.id OFFSET 10);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN QUERY SELECT sid, n;
END $$;
REVOKE ALL ON FUNCTION open_staff_session(bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_staff_session(bytea, text, text) TO questify_app;

-- Sets the calling staff member's new password hash and ends every other live session (all of them when keep is
-- NULL: a reset by link). Ending them this way takes a password change. Answers how many ended.
CREATE FUNCTION set_staff_password(new_hash text, keep uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_staff_user_id();
  n  integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'a staff user is required' USING ERRCODE = 'SS401';
  END IF;
  UPDATE staff_user SET password_hash = new_hash WHERE id = me;
  UPDATE staff_session SET revoked_at = now()
  WHERE staff_user_id = me AND revoked_at IS NULL AND id IS DISTINCT FROM keep;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION set_staff_password(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_staff_password(text, uuid) TO questify_app;

-- The live session of the request's own token (its hash, passed in) of the calling staff member. SS401 otherwise.
CREATE FUNCTION staff_current_session(session bytea) RETURNS staff_session
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  hit staff_session;
BEGIN
  SELECT s.* INTO hit FROM staff_session s
  WHERE s.token_hash = session AND s.staff_user_id = app_staff_user_id() AND s.revoked_at IS NULL;
  IF hit.id IS NULL THEN
    RAISE EXCEPTION 'a live session of the calling staff member is required' USING ERRCODE = 'SS401';
  END IF;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION staff_current_session(bytea) FROM PUBLIC;

-- Fresh: signed in (password and code) or a re-authentication code typed on this session in the last 10 minutes.
CREATE FUNCTION staff_session_fresh_until(s staff_session) RETURNS timestamptz
  LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN greatest(s.created_at, coalesce(s.reauth_at, '-infinity'::timestamptz)) + interval '10 minutes'
                   > now()
              THEN greatest(s.created_at, coalesce(s.reauth_at, '-infinity'::timestamptz)) + interval '10 minutes'
         END
$$;
REVOKE ALL ON FUNCTION staff_session_fresh_until(staff_session) FROM PUBLIC;

-- A re-authentication code for this session (the API emails it to the account's own address). While a code lives it
-- is replaced at most 3 times, 60 seconds apart, and keeps its 10-minute end: wait (seconds) or too_many otherwise.
CREATE FUNCTION start_staff_reauth(session bytea, token bytea, code bytea)
  RETURNS TABLE (outcome text, retry_after integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here  staff_session := staff_current_session(session);
  found staff_reauth_challenge;
BEGIN
  SELECT c.* INTO found FROM staff_reauth_challenge c WHERE c.session_id = here.id FOR UPDATE;
  IF found.id IS NOT NULL AND found.expires_at > now() THEN
    IF found.last_sent_at > now() - interval '60 seconds' THEN
      RETURN QUERY SELECT 'wait'::text,
                          greatest(1, ceil(60 - extract(epoch FROM now() - found.last_sent_at)))::integer;
      RETURN;
    END IF;
    IF found.resends >= 3 THEN
      RETURN QUERY SELECT 'too_many'::text, greatest(1, ceil(extract(epoch FROM found.expires_at - now())))::integer;
      RETURN;
    END IF;
    UPDATE staff_reauth_challenge
    SET token_hash = token, code_hash = code, resends = resends + 1, attempts = 0, last_sent_at = now()
    WHERE id = found.id;
  ELSE
    DELETE FROM staff_reauth_challenge WHERE session_id = here.id;
    INSERT INTO staff_reauth_challenge (session_id, token_hash, code_hash, expires_at)
    VALUES (here.id, token, code, now() + interval '10 minutes');
  END IF;
  RETURN QUERY SELECT 'started'::text, 0;
END $$;
REVOKE ALL ON FUNCTION start_staff_reauth(bytea, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_staff_reauth(bytea, bytea, bytea) TO questify_app;

-- Confirms this session's code: expired (unknown, used up, or asked on another session), wrong (tries left of 5), or
-- confirmed (reauth_at set, the code gone, audited). Lock order: the session row, then the code.
CREATE FUNCTION confirm_staff_reauth(session bytea, token bytea, code bytea, request uuid)
  RETURNS TABLE (outcome text, attempts_left integer, fresh_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here  staff_session := staff_current_session(session);
  found staff_reauth_challenge;
  moved staff_session;
BEGIN
  PERFORM 1 FROM staff_session s WHERE s.id = here.id FOR UPDATE;
  SELECT c.* INTO found FROM staff_reauth_challenge c
  WHERE c.token_hash = token AND c.session_id = here.id AND c.expires_at > now()
  FOR UPDATE;
  IF found.id IS NULL OR found.attempts >= 5 THEN
    RETURN QUERY SELECT 'expired'::text, 0, NULL::timestamptz;
    RETURN;
  END IF;
  IF found.code_hash <> code THEN
    UPDATE staff_reauth_challenge SET attempts = attempts + 1 WHERE id = found.id;
    RETURN QUERY SELECT 'wrong'::text, 4 - found.attempts, NULL::timestamptz;
    RETURN;
  END IF;
  DELETE FROM staff_reauth_challenge WHERE id = found.id;
  UPDATE staff_session SET reauth_at = now() WHERE id = here.id RETURNING * INTO moved;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('staff', here.staff_user_id, 'staff.reauth', 'staff_session', here.id::text, request);
  RETURN QUERY SELECT 'confirmed'::text, 0, staff_session_fresh_until(moved);
END $$;
REVOKE ALL ON FUNCTION confirm_staff_reauth(bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_staff_reauth(bytea, bytea, bytea, uuid) TO questify_app;

-- Ends one of the caller's own sessions: this one is a sign-out (no code); another needs this session fresh.
-- Outcomes: ended (audited), not_found (not live or not theirs), reauth_required.
CREATE FUNCTION end_own_staff_session(session bytea, target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here staff_session := staff_current_session(session);
  hit  staff_session;
BEGIN
  SELECT s.* INTO hit FROM staff_session s
  WHERE s.id = target AND s.staff_user_id = here.staff_user_id AND s.revoked_at IS NULL
  FOR UPDATE;
  IF hit.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF hit.id <> here.id AND staff_session_fresh_until(here) IS NULL THEN
    RETURN 'reauth_required';
  END IF;
  UPDATE staff_session SET revoked_at = now() WHERE id = hit.id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('staff', here.staff_user_id, 'staff.session.end', 'staff_session', hit.id::text, request);
  RETURN 'ended';
END $$;
REVOKE ALL ON FUNCTION end_own_staff_session(bytea, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_own_staff_session(bytea, uuid, uuid) TO questify_app;

-- Ends every other live session of the caller after the fresh check, locked in id order. Ending none answers 0.
CREATE FUNCTION end_other_staff_sessions(session bytea, request uuid)
  RETURNS TABLE (outcome text, ended integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here staff_session := staff_current_session(session);
  n    integer;
BEGIN
  IF staff_session_fresh_until(here) IS NULL THEN
    RETURN QUERY SELECT 'reauth_required'::text, 0;
    RETURN;
  END IF;
  PERFORM 1 FROM staff_session s
  WHERE s.staff_user_id = here.staff_user_id AND s.id <> here.id AND s.revoked_at IS NULL
  ORDER BY s.id FOR UPDATE;
  UPDATE staff_session SET revoked_at = now()
  WHERE staff_user_id = here.staff_user_id AND id <> here.id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', here.staff_user_id, 'staff.sessions.end_others', 'staff_user', here.staff_user_id::text,
          jsonb_build_object('ended', n), request);
  RETURN QUERY SELECT 'ended'::text, n;
END $$;
REVOKE ALL ON FUNCTION end_other_staff_sessions(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_other_staff_sessions(bytea, uuid) TO questify_app;

-- ================================================================ the console: one staff account's sessions (FR-141)
-- Ends every live session of one staff account (an organizer member or an admin) at once. Not the caller's own account
-- (QA422: their own sessions are ended from their sessions page); QA404 for an unknown account; the reason is 10 to
-- 300 characters (SU400). The audit entry holds the reason and the count, never a token, an IP or a user agent.
-- Ending sessions does not stop someone who knows the password (RUNBOOK: send a password reset too).
CREATE FUNCTION admin_end_staff_sessions(target uuid, reason text, request uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := suspension_reason_clean(reason);
  n     integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM staff_user u WHERE u.id = target) THEN
    RAISE EXCEPTION 'no such staff account' USING ERRCODE = 'QA404';
  END IF;
  IF target = me THEN
    RAISE EXCEPTION 'an admin ends their own sessions from their sessions page' USING ERRCODE = 'QA422';
  END IF;
  PERFORM 1 FROM staff_session s WHERE s.staff_user_id = target AND s.revoked_at IS NULL ORDER BY s.id FOR UPDATE;
  UPDATE staff_session SET revoked_at = now() WHERE staff_user_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'staff.session.end_all', 'staff_user', target::text,
          jsonb_build_object('reason', clean, 'ended', n), request);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION admin_end_staff_sessions(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_end_staff_sessions(uuid, text, uuid) TO questify_app;

-- ================================================================ the player-wide ends, family by family
-- As 0118: the sign-in reset, now ending each family through end_family (device rows included).
CREATE OR REPLACE FUNCTION admin_reset_player_sign_in(target uuid, reason_code text, note text, request uuid)
  RETURNS TABLE (action_id uuid, ended integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := console_admin();
  clean    text := player_action_note('reset_sign_in', reason_code, note);
  p        player := player_for_admin(target, true);
  action   uuid;
  families integer;
BEGIN
  DELETE FROM player_login_challenge l
  WHERE l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = p.id);
  DELETE FROM player_contact_challenge WHERE player_id = p.id;
  DELETE FROM player_deletion_challenge WHERE player_id = p.id;
  families := end_player_families(p.id);
  UPDATE player_session SET revoked_at = now() WHERE player_id = p.id AND revoked_at IS NULL;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = p.id;
  DELETE FROM push_device WHERE player_id = p.id;
  UPDATE player SET tokens_valid_after = clock_timestamp() WHERE id = p.id;
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (p.id, me, 'reset_sign_in', reason_code, clean) RETURNING id INTO action;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.reset_sign_in', 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code, 'endedFamilies', families), request);
  RETURN QUERY SELECT action, families;
END $$;
REVOKE ALL ON FUNCTION admin_reset_player_sign_in(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_reset_player_sign_in(uuid, text, text, uuid) TO questify_app;

-- As 0120: the ban, now ending each family through end_family.
CREATE OR REPLACE FUNCTION admin_ban_player(target uuid, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, action_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  clean  text := player_action_note('ban', reason_code, note);
  p      player := player_for_admin(target, true);
  action uuid;
BEGIN
  IF p.status = 'banned' THEN
    RETURN QUERY SELECT 'already_banned'::text, NULL::uuid;
    RETURN;
  END IF;
  -- The wall's serialization point: a payment holding a membership commits first; one that comes after sees the ban.
  PERFORM 1 FROM enrollment n WHERE n.player_id = p.id ORDER BY n.id FOR NO KEY UPDATE;
  DELETE FROM player_login_challenge l
  WHERE l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = p.id);
  DELETE FROM player_contact_challenge WHERE player_id = p.id;
  DELETE FROM player_deletion_challenge WHERE player_id = p.id;
  PERFORM end_player_families(p.id);
  UPDATE player_session SET revoked_at = now() WHERE player_id = p.id AND revoked_at IS NULL;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = p.id;
  DELETE FROM push_device WHERE player_id = p.id;
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (p.id, me, 'ban', reason_code, clean) RETURNING id INTO action;
  UPDATE player SET status = 'banned', ban_action_id = action, tokens_valid_after = clock_timestamp() WHERE id = p.id;
  PERFORM mark_player_rankings(p.id);
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.ban', 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code), request);
  RETURN QUERY SELECT 'banned'::text, action;
END $$;
REVOKE ALL ON FUNCTION admin_ban_player(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_ban_player(uuid, text, text, uuid) TO questify_app;

-- ================================================================ a contact change marks this family fresh
-- As 0144, plus the request's access-token hash: a change made here marks this family fresh (ADR-715). The
-- 3-argument version is dropped (replace, not deprecate; RUNBOOK deploy note).
DROP FUNCTION confirm_contact_change(bytea, bytea, uuid);
CREATE FUNCTION confirm_contact_change(session bytea, token bytea, code bytea, request uuid)
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
  -- The new contact's code is a fresh factor for this family (ADR-715).
  UPDATE player_sign_in_device d SET reauth_at = now()
  FROM player_session s
  WHERE s.token_hash = session AND s.player_id = me AND s.revoked_at IS NULL AND s.expires_at > now()
    AND d.family = s.refresh_family AND d.player_id = me AND d.ended_at IS NULL;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.contact_change', 'player', me::text,
          jsonb_build_object('channel', found.channel,
                             'kind', CASE WHEN before_value IS NULL THEN 'added' ELSE 'replaced' END),
          request);
  RETURN QUERY SELECT 'changed'::text, 0, found.channel,
                      CASE WHEN before_value IS NULL THEN 'added' ELSE 'replaced' END, before_value, other_value;
END $$;
REVOKE ALL ON FUNCTION confirm_contact_change(bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_contact_change(bytea, bytea, bytea, uuid) TO questify_app;

-- ================================================================ erasure and the export (ADR-716)
-- erase_rows(uuid, uuid[], bytea), as 0121, plus the account's device rows and re-authentication codes.
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
  DELETE FROM souvenir_receipt WHERE player_id = me;
  PERFORM set_config('app.erasure','',true);
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  -- The ban's action row is deleted below; the player row stops pointing at it first (plan review).
  UPDATE player SET ban_action_id = NULL WHERE id = me AND ban_action_id IS NOT NULL;
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  DELETE FROM marketing_consent WHERE player_id = me;
  DELETE FROM player_admin_action WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM marketing_state WHERE player_id = me;
  DELETE FROM player_preference WHERE player_id = me;
  DELETE FROM invitation_recipient WHERE player_id = me;
  DELETE FROM notice WHERE player_id = me;
  DELETE FROM notification WHERE player_id = me;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = me;
  DELETE FROM push_device WHERE player_id = me;
  DELETE FROM push_topic_mute WHERE player_id = me;
  DELETE FROM push_topic_on WHERE player_id = me;
  DELETE FROM player_fingerprint WHERE player_id = me;
  DELETE FROM player_block WHERE blocker_id = me OR blocked_id = me;
  DELETE FROM content_report WHERE target_kind = 'username' AND target_id = me;
  UPDATE content_report SET reporter_id = NULL, note = NULL, marked = false WHERE reporter_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_reauth_challenge WHERE player_id = me;
  DELETE FROM player_sign_in_device WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM ticket WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  -- After the assignment delete and the enrollment update: the order accept_desk_sale locks in (T-612).
  UPDATE desk_sale s SET status = 'withdrawn', ended_at = now() WHERE s.operator_id = me AND s.status = 'offered';
  DELETE FROM desk_sale s WHERE s.enrollment_id = ANY (enrolled);
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
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  -- Last: the staff_assignment delete above enqueues while the enrollments are still active (enqueue_souvenir_on_staff).
  DELETE FROM souvenir_work WHERE enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid,uuid[],bytea) FROM PUBLIC;

-- As 0129, plus the live signed-in devices (platform, model, signed in, last used; never a family id).
CREATE OR REPLACE FUNCTION data_export_account(p player) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'account', jsonb_build_object(
      'username', p.username, 'birthYear', p.birth_year, 'avatar', p.avatar, 'status', p.status,
      'createdAt', data_export_time(p.created_at),
      'level', coalesce((SELECT xp_level_of(x.xp) FROM player_xp x WHERE x.player_id = p.id), 1),
      'xp', coalesce((SELECT x.xp FROM player_xp x WHERE x.player_id = p.id), 0),
      'gems', coalesce((SELECT x.gems FROM player_xp x WHERE x.player_id = p.id), 0)),
    'contacts', coalesce((SELECT jsonb_build_object('phone', c.phone_e164, 'email', c.email)
                          FROM player_contact c WHERE c.player_id = p.id),
                         jsonb_build_object('phone', NULL, 'email', NULL)),
    'usernames', coalesce((SELECT jsonb_agg(jsonb_build_object('username', h.username, 'reason', h.reason,
                                                               'changedAt', data_export_time(h.changed_at))
                                            ORDER BY h.changed_at, h.id)
                           FROM username_history h WHERE h.player_id = p.id), '[]'),
    'acceptances', coalesce((SELECT jsonb_agg(jsonb_build_object('document', a.document, 'version', a.version,
                                                                 'method', a.method,
                                                                 'acceptedAt', data_export_time(a.accepted_at))
                                              ORDER BY a.accepted_at, a.document)
                             FROM player_acceptance a WHERE a.player_id = p.id), '[]'),
    'marketing', jsonb_build_object(
      'consents', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', m.channel, 'granted', m.granted,
                                                                'method', m.method, 'textVersion', m.text_version,
                                                                'language', m.language,
                                                                'at', data_export_time(m.created_at))
                                             ORDER BY m.created_at, m.id)
                            FROM marketing_consent m WHERE m.player_id = p.id), '[]'),
      'state', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', m.channel, 'optedIn', m.opted_in,
                                                             'language', m.language,
                                                             'changedAt', data_export_time(m.changed_at))
                                          ORDER BY m.channel)
                         FROM marketing_state m WHERE m.player_id = p.id), '[]')),
    'preferences', (SELECT jsonb_build_object('cityId', f.city_id, 'interests', to_jsonb(f.interests),
                                              'updatedAt', data_export_time(f.updated_at))
                    FROM player_preference f WHERE f.player_id = p.id),
    'pushTopics', jsonb_build_object(
      'muted', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', t.topic, 'at', data_export_time(t.muted_at))
                                          ORDER BY t.topic)
                         FROM push_topic_mute t WHERE t.player_id = p.id), '[]'),
      'on', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', t.topic, 'at', data_export_time(t.chosen_at))
                                       ORDER BY t.topic)
                      FROM push_topic_on t WHERE t.player_id = p.id), '[]')),
    'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', d.platform, 'language', d.language,
                                                             'appVersion', d.app_version,
                                                             'createdAt', data_export_time(d.token_set_at),
                                                             'lastSeenAt', data_export_time(d.seen_at))
                                          ORDER BY d.token_set_at, d.id)
                         FROM push_device d WHERE d.player_id = p.id), '[]'),
    'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object('createdAt', data_export_time(s.created_at),
                                                              'expiresAt', data_export_time(s.expires_at),
                                                              'endedAt', data_export_time(s.revoked_at))
                                           ORDER BY s.created_at, s.id)
                          FROM player_session s WHERE s.player_id = p.id), '[]'),
    'signedInDevices', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', d.platform, 'model', d.model,
                                                                     'signedInAt', data_export_time(d.signed_in_at),
                                                                     'lastUsedAt', data_export_time(l.last_used))
                                                  ORDER BY d.signed_in_at, d.id)
                                 FROM player_sign_in_device d
                                 CROSS JOIN LATERAL (SELECT max(r.created_at) AS last_used FROM player_refresh r
                                                     WHERE r.family = d.family AND r.revoked_at IS NULL
                                                       AND r.expires_at > now()) l
                                 WHERE d.player_id = p.id AND d.ended_at IS NULL AND l.last_used IS NOT NULL), '[]'),
    'invitations', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', i.channel, 'state', i.state,
                                                                 'createdAt', data_export_time(i.created_at),
                                                                 'sentAt', data_export_time(i.sent_at),
                                                                 'openedAt', data_export_time(i.opened_at),
                                                                 'joinedAt', data_export_time(i.joined_at))
                                              ORDER BY i.created_at, i.id)
                             FROM invitation_recipient i WHERE i.player_id = p.id), '[]'))
$$;
REVOKE ALL ON FUNCTION data_export_account(player) FROM PUBLIC;
