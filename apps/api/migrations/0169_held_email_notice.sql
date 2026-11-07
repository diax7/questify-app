-- The held email change's notice (T-701b, ADR-815, plan docs/plans/2026-11-07-staff-first-password.md). On the no-password
-- path the notice to the old address is the only guard, so a hold now applies only with that notice on record: a failed send
-- closes the change, and a change with no record (a crash, a lost write, a row held before this migration) closes at its due
-- time instead of applying. One column, one new door, owner_email_apply restated with the same arguments, so it keeps its
-- owner and stays closed to the API role. Nothing here changes the password path. No backfill: nobody can say those notices
-- went out. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

ALTER TABLE staff_email_change ADD COLUMN hold_notice_at timestamptz;

-- ================================================================ apply needs the notice
-- As 0130, with the first IF added: `owner_email_confirm` and `owner_email_apply_due` call this, so every waited apply is
-- covered here.
CREATE OR REPLACE FUNCTION owner_email_apply(change uuid, how text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  c     staff_email_change%ROWTYPE := owner_email_locked(change);
  u     staff_user%ROWTYPE;
  ended integer;
BEGIN
  IF how = 'waited' AND c.hold_notice_at IS NULL THEN
    c := owner_email_close(change, 'send_failed');
    PERFORM owner_email_audit(c, NULL, 'send_failed', jsonb_build_object('step', 'hold_notice', 'why', 'unrecorded'), request);
    RETURN jsonb_build_object('outcome', 'send_failed', 'changeId', c.id);
  END IF;
  SELECT s.* INTO u FROM staff_user s WHERE s.id = c.staff_user_id FOR UPDATE;
  IF u.status <> 'active' OR u.platform_role = 'admin' OR u.email <> c.old_email
     OR NOT EXISTS (SELECT 1 FROM organizer_member m
                    WHERE m.organizer_id = c.organizer_id AND m.staff_user_id = u.id AND m.role = 'owner') THEN
    c := owner_email_close(change, 'cancelled');
    PERFORM owner_email_audit(c, NULL, 'cancel', jsonb_build_object('why', 'guard'), request);
    RETURN jsonb_build_object('outcome', 'cancelled');
  END IF;
  BEGIN
    UPDATE staff_user SET email = c.new_email WHERE id = u.id;
  EXCEPTION WHEN unique_violation THEN
    c := owner_email_close(change, 'email_taken');
    PERFORM owner_email_audit(c, NULL, 'email_taken', NULL, request);
    RETURN jsonb_build_object('outcome', 'email_taken');
  END;
  UPDATE staff_session SET revoked_at = now() WHERE staff_user_id = u.id AND revoked_at IS NULL;
  GET DIAGNOSTICS ended = ROW_COUNT;
  DELETE FROM staff_login_challenge WHERE staff_user_id = u.id;
  DELETE FROM staff_password_reset WHERE staff_user_id = u.id;
  DELETE FROM organizer_invite WHERE email = c.old_email;
  UPDATE operator_invite SET revoked_at = now(), email = NULL
  WHERE email = c.old_email AND claimed_at IS NULL AND revoked_at IS NULL;
  UPDATE staff_email_change SET state = 'confirmed', completed_how = how, closed_at = now()
  WHERE id = change RETURNING * INTO c;
  PERFORM owner_email_audit(c, NULL, 'confirm', jsonb_build_object('how', how, 'sessionsEnded', ended), request);
  RETURN jsonb_build_object('outcome', 'confirmed', 'changeId', c.id, 'oldEmail', c.old_email,
                            'newEmail', c.new_email);
END $$;

-- ================================================================ the notice's door
-- The API reports how the hold's notice went. Bound to the link's token hash, as owner_email_confirm is, so the API role
-- cannot mark a change by its id alone. Outcomes: noticed (recorded now or before), closed (the send failed: `send_failed`),
-- gone (unknown, or no longer held). Never raises.
CREATE FUNCTION owner_email_hold_notice(token bytea, sent boolean, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c staff_email_change%ROWTYPE;
BEGIN
  SELECT x.* INTO c FROM staff_email_change x WHERE x.token_hash = token FOR UPDATE;
  IF NOT FOUND OR c.state <> 'held' THEN
    RETURN 'gone';
  END IF;
  IF c.hold_notice_at IS NOT NULL THEN
    RETURN 'noticed';
  END IF;
  IF sent IS TRUE THEN
    UPDATE staff_email_change SET hold_notice_at = now() WHERE id = c.id RETURNING * INTO c;
    PERFORM owner_email_audit(c, NULL, 'hold_notice', NULL, request);
    RETURN 'noticed';
  END IF;
  c := owner_email_close(c.id, 'send_failed');
  PERFORM owner_email_audit(c, NULL, 'send_failed', jsonb_build_object('step', 'hold_notice', 'why', 'send'), request);
  RETURN 'closed';
END $$;
REVOKE ALL ON FUNCTION owner_email_hold_notice(bytea, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_email_hold_notice(bytea, boolean, uuid) TO questify_app;
