-- FOLLOWUPS 0202 (plan docs/plans/2026-11-23-followups-0202.md, plan review 92): three function restates, no table,
-- index, trigger, grant or policy change.
--
-- 1. `reauth_at` only moves forward (FOLLOWUPS 2026-11-12 T-599c review). `now()` is the transaction's start, so an
--    older transaction could write an earlier time than a newer confirm already committed. On `player_sign_in_device`
--    (no guard trigger) that moved the time back: a contact change crossed with a newer re-authentication code
--    shortened the family's fresh window. On `staff_session` the guard (0155) would refuse it with 23514; that needs a
--    transaction that began before its code existed, so it is hardly reachable outside a test, but it gets the same
--    fix. Each write is `greatest(reauth_at, now())`, recomputed on the committed row after a lock wait, and the
--    confirm still returns the row. The kiosk touch (`device_session`, 0057) is unchanged: its CASE already reads the
--    committed row and `paired_device` has no backwards guard.
-- 2. `media_release` (0192) gives back only a slot still `reserved`, as `media_image_release` (0196) does for
--    organizers: a stored photo is the sweep's once nothing names it. The bytes live in the media database (0200);
--    the slot rows stay here.
-- 3. `raise_integrity_on_completion` (0198) reads `device_check` by its primary key before `system_paid` (0148:652,
--    PL/pgSQL with a SET clause: one `submission` read through `reviewer_paid`, 0148:634, and maybe a `quiz_attempt`
--    read), so a completion from an install with no failed check calls no function. Same outcome for every input; the
--    trigger itself is not touched.
--
-- Deny by default: every function keeps its signature, owner and ACL (CREATE OR REPLACE), is revoked from PUBLIC
-- again, and only the doors are granted to questify_app, as before. No lock on a table: in-flight calls finish on the
-- old body. Deployed migrations untouched; each restate says which it restates.
SET LOCAL lock_timeout = '10s';

-- ================================================================ 1. re-authentication time forward only
-- As 0155, with the device row's re-authentication time moved forward only.
CREATE OR REPLACE FUNCTION confirm_player_reauth(session bytea, token bytea, code bytea, request uuid)
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
  UPDATE player_sign_in_device SET reauth_at = greatest(reauth_at, now()) WHERE id = here.id RETURNING * INTO moved;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.reauth', 'player', here.player_id::text,
          jsonb_build_object('channel', found.channel), request);
  RETURN QUERY SELECT 'confirmed'::text, 0, player_device_fresh_until(moved);
END $$;
REVOKE ALL ON FUNCTION confirm_player_reauth(bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_player_reauth(bytea, bytea, bytea, uuid) TO questify_app;

-- As 0155, with the session's re-authentication time moved forward only (never a 23514 from the guard).
CREATE OR REPLACE FUNCTION confirm_staff_reauth(session bytea, token bytea, code bytea, request uuid)
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
  UPDATE staff_session SET reauth_at = greatest(reauth_at, now()) WHERE id = here.id RETURNING * INTO moved;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('staff', here.staff_user_id, 'staff.reauth', 'staff_session', here.id::text, request);
  RETURN QUERY SELECT 'confirmed'::text, 0, staff_session_fresh_until(moved);
END $$;
REVOKE ALL ON FUNCTION confirm_staff_reauth(bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_staff_reauth(bytea, bytea, bytea, uuid) TO questify_app;

-- As 0155, with the family's re-authentication time moved forward only.
CREATE OR REPLACE FUNCTION confirm_contact_change(session bytea, token bytea, code bytea, request uuid)
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
  -- The new contact's code is a fresh factor for this family (ADR-715), never earlier than one already recorded.
  UPDATE player_sign_in_device d SET reauth_at = greatest(d.reauth_at, now())
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

-- ================================================================ 2. the player gives back a reserved slot only
-- As 0192, for a slot still `reserved` only (as 0196 for organizers): a stored photo is the sweep's to delete once
-- nothing names it. Its key is queued like any other (a delete of an object never written is done at once).
CREATE OR REPLACE FUNCTION media_release(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM media_object m WHERE m.id = target AND m.uploaded_by_player = me AND m.state = 'reserved';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION media_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_release(uuid) TO questify_app;

-- ================================================================ 3. the integrity trigger: the key read first
-- As 0198, reordered: a manual award raises nothing, then one primary-key read, and `system_paid` only for an install
-- whose latest check failed. Never raises.
CREATE OR REPLACE FUNCTION raise_integrity_on_completion() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c device_check;
  n enrollment;
BEGIN
  IF NEW.method = 'manual' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM device_check d WHERE d.install_id = NEW.device_id AND d.verdict = 'failed';
  IF NOT FOUND OR system_paid(NEW.method, NEW.idempotency_key) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO n FROM enrollment e WHERE e.id = NEW.enrollment_id;
  PERFORM raise_integrity_flag(n, c);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION raise_integrity_on_completion() FROM PUBLIC;
