-- T-701b: the owner email change (FR-1784) and urgent reports with the team alert (FR-1732); plan
-- docs/plans/2026-11-03-t-701b-owner-email-urgent.md, ADR-490 to ADR-496, Q-450 to Q-453.
-- An admin starts a change of an organizer owner's sign-in email; the owner confirms it from the new mailbox with the
-- emailed code and the current password (or, without the password, the change waits 24 hours); the old address can stop
-- it. A report that arrives while its event is live is urgent and due in 1 hour; the first urgent report of a target
-- queues one ids-only `team_alert` row that a worker mails to Questify's own address as a digest.
-- Deny by default: `staff_email_change` and `team_alert` keep row-level security forced with no grant; every new
-- function is revoked from PUBLIC in the group that creates it; only the doors are granted to questify_app (trigger
-- functions and helpers none). Addresses live only in the change row (erased 180 days after it closes), never in
-- audit_log. Deployed migrations untouched: `console_reports`, `console_report`, `admin_report_resolve` and
-- `admin_unpublish` (0121, undeployed) are restated with CREATE OR REPLACE.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the owner email change (FR-1784, ADR-490..492)
-- One row per change. `old_email` and `new_email` are NULL only after the 180-day erasure. `pending` waits for the code
-- (60 minutes); `held` waits until `applies_at` (the owner did not give the password). `disputed_at`: the old address
-- pressed Stop after the change completed (support is alerted). A deleted account takes its rows with it.
CREATE TABLE staff_email_change (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id  uuid NOT NULL REFERENCES staff_user (id) ON DELETE CASCADE,
  organizer_id   uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  requested_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  identity_check text NOT NULL CHECK (identity_check IN ('known_phone', 'id_document', 'contract_contact', 'other')),
  reason         text NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 300),
  old_email      text CHECK (old_email = lower(old_email) AND position('@' IN old_email) > 1
                             AND length(old_email) <= 254),
  new_email      text CHECK (new_email = lower(new_email) AND position('@' IN new_email) > 1
                             AND length(new_email) <= 254),
  token_hash     bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  stop_hash      bytea NOT NULL UNIQUE CHECK (octet_length(stop_hash) = 32),
  code_hash      bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  resends        integer NOT NULL DEFAULT 0 CHECK (resends BETWEEN 0 AND 3),
  last_sent_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  applies_at     timestamptz,
  state          text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'held', 'confirmed', 'cancelled',
                                                                  'stopped', 'expired', 'send_failed', 'email_taken')),
  completed_how  text CHECK (completed_how IN ('password', 'waited')),
  disputed_at    timestamptz,
  closed_at      timestamptz,
  CONSTRAINT staff_email_change_expiry CHECK (expires_at = created_at + interval '60 minutes'),
  CONSTRAINT staff_email_change_open CHECK ((state IN ('pending', 'held')) = (closed_at IS NULL)),
  CONSTRAINT staff_email_change_held CHECK (state <> 'held' OR applies_at IS NOT NULL),
  CONSTRAINT staff_email_change_how CHECK ((state = 'confirmed') = (completed_how IS NOT NULL)),
  CONSTRAINT staff_email_change_dispute CHECK (disputed_at IS NULL OR state = 'confirmed'),
  CONSTRAINT staff_email_change_addresses CHECK (closed_at IS NOT NULL OR (old_email IS NOT NULL AND new_email IS NOT NULL))
);
CREATE UNIQUE INDEX staff_email_change_one_open ON staff_email_change (staff_user_id) WHERE state IN ('pending', 'held');
CREATE INDEX staff_email_change_account ON staff_email_change (staff_user_id, created_at);
CREATE INDEX staff_email_change_organizer ON staff_email_change (organizer_id, created_at DESC);
CREATE INDEX staff_email_change_due ON staff_email_change (applies_at) WHERE state = 'held';
CREATE INDEX staff_email_change_closed ON staff_email_change (closed_at) WHERE old_email IS NOT NULL AND closed_at IS NOT NULL;
ALTER TABLE staff_email_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_email_change FORCE ROW LEVEL SECURITY;
REVOKE ALL ON staff_email_change FROM PUBLIC, questify_app;

-- One audit entry of a change, with ids and states only (never an address). `actor` NULL: the system (the owner's
-- confirm, the old address's stop, a due apply).
CREATE FUNCTION owner_email_audit(c staff_email_change, actor uuid, verb text, extra jsonb, request uuid) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, after, request_id)
  VALUES (CASE WHEN actor IS NULL THEN 'system' ELSE 'admin' END, actor, c.organizer_id, 'owner_email.' || verb,
          'staff_user', c.staff_user_id::text, jsonb_build_object('changeId', c.id) || coalesce(extra, '{}'::jsonb),
          request)
$$;
REVOKE ALL ON FUNCTION owner_email_audit(staff_email_change, uuid, text, jsonb, uuid) FROM PUBLIC;

-- Closes an open change in a final state.
CREATE FUNCTION owner_email_close(change uuid, final text) RETURNS staff_email_change
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  UPDATE staff_email_change SET state = final, closed_at = now() WHERE id = change RETURNING *
$$;
REVOKE ALL ON FUNCTION owner_email_close(uuid, text) FROM PUBLIC;

-- The admin starts a change for an organizer's owner. EC422 (DETAIL identity, reason, email, inactive), EC404 (no
-- owner), EC403 (DETAIL own_account, owner_is_admin), EC409 (DETAIL same_email, email_taken, email_change_pending),
-- EC429 (the fourth start for one account in a day). The API made the change id, the token, the stop token and the
-- code; only their hashes arrive here. Answers what the two emails need.
CREATE FUNCTION admin_owner_email_start(change uuid, org uuid, new_address text, identity text, why text, token bytea,
                                        stop bytea, code bytea, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := btrim(why);
  addr  text := lower(btrim(new_address));
  u     staff_user%ROWTYPE;
  c     staff_email_change%ROWTYPE;
BEGIN
  IF identity IS NULL OR identity NOT IN ('known_phone', 'id_document', 'contract_contact', 'other') THEN
    RAISE EXCEPTION 'an identity check from the list' USING ERRCODE = 'EC422', DETAIL = 'identity';
  END IF;
  IF clean IS NULL OR char_length(clean) NOT BETWEEN 10 AND 300 OR clean ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'a reason of 10 to 300 characters' USING ERRCODE = 'EC422', DETAIL = 'reason';
  END IF;
  IF addr IS NULL OR length(addr) > 254 OR addr !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'an email address' USING ERRCODE = 'EC422', DETAIL = 'email';
  END IF;
  SELECT s.* INTO u FROM organizer_member m JOIN staff_user s ON s.id = m.staff_user_id
  WHERE m.organizer_id = org AND m.role = 'owner'
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no owner here' USING ERRCODE = 'EC404';
  END IF;
  IF u.id = me THEN
    RAISE EXCEPTION 'not your own account' USING ERRCODE = 'EC403', DETAIL = 'own_account';
  END IF;
  IF u.platform_role = 'admin' THEN
    RAISE EXCEPTION 'an admin changes only through the owner connection' USING ERRCODE = 'EC403',
      DETAIL = 'owner_is_admin';
  END IF;
  IF u.status <> 'active' THEN
    RAISE EXCEPTION 'the account is not active' USING ERRCODE = 'EC422', DETAIL = 'inactive';
  END IF;
  IF addr = u.email THEN
    RAISE EXCEPTION 'the same address' USING ERRCODE = 'EC409', DETAIL = 'same_email';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_user s WHERE s.email = addr) THEN
    RAISE EXCEPTION 'another account has this address' USING ERRCODE = 'EC409', DETAIL = 'email_taken';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_email_change x WHERE x.staff_user_id = u.id AND x.state IN ('pending', 'held')) THEN
    RAISE EXCEPTION 'a change is already open' USING ERRCODE = 'EC409', DETAIL = 'email_change_pending';
  END IF;
  IF (SELECT count(*) FROM staff_email_change x
      WHERE x.staff_user_id = u.id AND x.created_at > now() - interval '1 day') >= 3 THEN
    RAISE EXCEPTION 'three changes a day at most' USING ERRCODE = 'EC429';
  END IF;
  INSERT INTO staff_email_change (id, staff_user_id, organizer_id, requested_by, identity_check, reason, old_email,
                                  new_email, token_hash, stop_hash, code_hash, expires_at)
  VALUES (change, u.id, org, me, identity, clean, u.email, addr, token, stop, code, now() + interval '60 minutes')
  RETURNING * INTO c;
  PERFORM owner_email_audit(c, me, 'start', jsonb_build_object('identityCheck', identity, 'reason', clean), request);
  RETURN jsonb_build_object('changeId', c.id, 'expiresAt', c.expires_at, 'oldEmail', c.old_email,
                            'newEmail', c.new_email,
                            'organizerName', (SELECT o.name FROM organizer o WHERE o.id = org));
END $$;
REVOKE ALL ON FUNCTION admin_owner_email_start(uuid, uuid, text, text, text, bytea, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_owner_email_start(uuid, uuid, text, text, text, bytea, bytea, bytea, uuid)
  TO questify_app;

-- An open change of an admin door, locked. EC404 when unknown.
CREATE FUNCTION owner_email_locked(change uuid) RETURNS staff_email_change
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  c staff_email_change%ROWTYPE;
BEGIN
  SELECT x.* INTO c FROM staff_email_change x WHERE x.id = change FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such change' USING ERRCODE = 'EC404';
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION owner_email_locked(uuid) FROM PUBLIC;

-- The code email could not be sent: the change closes (`send_failed`).
CREATE FUNCTION admin_owner_email_send_failed(change uuid, request uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
  c  staff_email_change%ROWTYPE := owner_email_locked(change);
BEGIN
  IF c.state = 'pending' THEN
    c := owner_email_close(change, 'send_failed');
    PERFORM owner_email_audit(c, me, 'send_failed', NULL, request);
  END IF;
END $$;
REVOKE ALL ON FUNCTION admin_owner_email_send_failed(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_owner_email_send_failed(uuid, uuid) TO questify_app;

-- A new code for a pending change (the link stays; the attempts are not reset). EC409 (DETAIL not_pending, too_soon),
-- EC429 (DETAIL resends) after 3 resends.
CREATE FUNCTION admin_owner_email_resend(change uuid, code bytea, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
  c  staff_email_change%ROWTYPE := owner_email_locked(change);
BEGIN
  IF c.state <> 'pending' OR c.expires_at <= now() THEN
    RAISE EXCEPTION 'the change is not waiting for its code' USING ERRCODE = 'EC409', DETAIL = 'not_pending';
  END IF;
  IF c.resends >= 3 THEN
    RAISE EXCEPTION 'three resends at most' USING ERRCODE = 'EC429', DETAIL = 'resends';
  END IF;
  IF c.last_sent_at > now() - interval '60 seconds' THEN
    RAISE EXCEPTION 'wait a minute between codes' USING ERRCODE = 'EC409', DETAIL = 'too_soon';
  END IF;
  UPDATE staff_email_change SET code_hash = code, resends = resends + 1, last_sent_at = now()
  WHERE id = change RETURNING * INTO c;
  PERFORM owner_email_audit(c, me, 'resend', jsonb_build_object('resends', c.resends), request);
  RETURN jsonb_build_object('newEmail', c.new_email, 'expiresAt', c.expires_at,
                            'organizerName', (SELECT o.name FROM organizer o WHERE o.id = c.organizer_id));
END $$;
REVOKE ALL ON FUNCTION admin_owner_email_resend(uuid, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_owner_email_resend(uuid, bytea, uuid) TO questify_app;

-- The admin cancels a pending or held change. EC409 (DETAIL not_pending) once it is closed.
CREATE FUNCTION admin_owner_email_cancel(change uuid, request uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
  c  staff_email_change%ROWTYPE := owner_email_locked(change);
BEGIN
  IF c.state NOT IN ('pending', 'held') THEN
    RAISE EXCEPTION 'the change is already closed' USING ERRCODE = 'EC409', DETAIL = 'not_pending';
  END IF;
  c := owner_email_close(change, 'cancelled');
  PERFORM owner_email_audit(c, me, 'cancel', NULL, request);
END $$;
REVOKE ALL ON FUNCTION admin_owner_email_cancel(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_owner_email_cancel(uuid, uuid) TO questify_app;

-- The organizer's open change, else its latest one, for the console's owner card (with the addresses: the admin already
-- sees the owner's email on that page). NULL when there was never one.
CREATE FUNCTION console_owner_email_change(org uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
BEGIN
  RETURN (SELECT jsonb_build_object('id', c.id, 'state', c.state, 'oldEmail', c.old_email, 'newEmail', c.new_email,
                                    'createdAt', c.created_at, 'expiresAt', c.expires_at, 'appliesAt', c.applies_at,
                                    'closedAt', c.closed_at, 'resends', c.resends, 'lastSentAt', c.last_sent_at,
                                    'completedHow', c.completed_how, 'disputedAt', c.disputed_at)
          FROM staff_email_change c WHERE c.organizer_id = org
          ORDER BY c.closed_at IS NULL DESC, c.created_at DESC, c.id LIMIT 1);
END $$;
REVOKE ALL ON FUNCTION console_owner_email_change(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_owner_email_change(uuid) TO questify_app;

-- What the confirm page shows for a pending change, with the account (the API reads its password hash to check the
-- password the owner types); NULL for an unknown, expired or closed link alike.
CREATE FUNCTION owner_email_view(token bytea) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('changeId', c.id, 'staffUserId', c.staff_user_id, 'newEmail', c.new_email,
                            'expiresAt', c.expires_at, 'organizerName', o.name)
  FROM staff_email_change c JOIN organizer o ON o.id = c.organizer_id
  WHERE c.token_hash = token AND c.state = 'pending' AND c.expires_at > now()
$$;
REVOKE ALL ON FUNCTION owner_email_view(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_email_view(bytea) TO questify_app;

-- Applies a change in one transaction (the password path and a hold that ran out): every guard again, the email, every
-- session ended, the sign-in challenges and reset links deleted, the old address's pending organizer invites deleted and
-- its open operator invites revoked. A guard that fails closes the change `cancelled`; an address taken meanwhile
-- closes it `email_taken` (the unique violation is caught here, so the close commits).
CREATE FUNCTION owner_email_apply(change uuid, how text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  c     staff_email_change%ROWTYPE := owner_email_locked(change);
  u     staff_user%ROWTYPE;
  ended integer;
BEGIN
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
REVOKE ALL ON FUNCTION owner_email_apply(uuid, text, uuid) FROM PUBLIC;

-- The owner's confirm by link. Every try is counted first (5 per change, resends included), wrong code and wrong password
-- alike (the API passes whether the password matched; NULL: "I don't know my password", which holds the change 24
-- hours). Outcomes: invalid (unknown, expired or closed link), locked, wrong (with attempts left), held, confirmed,
-- cancelled, email_taken. Never raises, so a counted try always commits.
CREATE FUNCTION owner_email_confirm(token bytea, code bytea, password_ok boolean, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c staff_email_change%ROWTYPE;
BEGIN
  SELECT x.* INTO c FROM staff_email_change x WHERE x.token_hash = token FOR UPDATE;
  IF NOT FOUND OR c.state <> 'pending' OR c.expires_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  IF c.attempts >= 5 THEN
    RETURN jsonb_build_object('outcome', 'locked');
  END IF;
  UPDATE staff_email_change SET attempts = attempts + 1 WHERE id = c.id RETURNING * INTO c;
  IF code IS NULL OR c.code_hash <> code OR password_ok IS FALSE THEN
    RETURN jsonb_build_object('outcome', 'wrong', 'attemptsLeft', 5 - c.attempts);
  END IF;
  IF password_ok IS NULL THEN
    UPDATE staff_email_change SET state = 'held', applies_at = now() + interval '24 hours'
    WHERE id = c.id RETURNING * INTO c;
    PERFORM owner_email_audit(c, NULL, 'hold', NULL, request);
    RETURN jsonb_build_object('outcome', 'held', 'changeId', c.id, 'appliesAt', c.applies_at,
                              'oldEmail', c.old_email, 'newEmail', c.new_email);
  END IF;
  RETURN owner_email_apply(c.id, 'password', request);
END $$;
REVOKE ALL ON FUNCTION owner_email_confirm(bytea, bytea, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_email_confirm(bytea, bytea, boolean, uuid) TO questify_app;

-- Held changes whose 24 hours passed, applied one by one (the team-alert worker mails the notices of each). Reads across
-- organizers on purpose (a scheduled step, rules.md).
CREATE FUNCTION owner_email_apply_due(batch integer) RETURNS SETOF jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due uuid;
BEGIN
  FOR due IN SELECT c.id FROM staff_email_change c WHERE c.state = 'held' AND c.applies_at <= now()
             ORDER BY c.applies_at, c.id LIMIT least(greatest(coalesce(batch, 50), 1), 50)
             FOR UPDATE SKIP LOCKED LOOP
    RETURN NEXT owner_email_apply(due, 'waited', NULL);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION owner_email_apply_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_email_apply_due(integer) TO questify_app;

-- ================================================================ the team alert outbox (FR-1732, ADR-494)
-- Ids only: no address, no text. One row per target episode (`urgent:` + the report id) or per disputed email change
-- (`dispute:` + the change id). `attempts` counts sends; a refused one is retried until 3. No foreign keys: a row
-- outlives what it names until it is deleted 30 days after it finished.
CREATE TABLE team_alert (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('urgent_report', 'email_change_dispute')),
  target_kind  text,
  target_id    uuid,
  event_id     uuid,
  report_id    uuid,
  change_id    uuid,
  organizer_id uuid,
  dedupe       text NOT NULL UNIQUE CHECK (char_length(dedupe) <= 100),
  state        text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'sending', 'sent', 'failed', 'uncertain',
                                                                'skipped')),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease        uuid,
  lease_until  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  CONSTRAINT team_alert_shape CHECK (
    (kind = 'urgent_report' AND target_kind IS NOT NULL AND target_id IS NOT NULL AND report_id IS NOT NULL)
    OR (kind = 'email_change_dispute' AND change_id IS NOT NULL AND organizer_id IS NOT NULL)),
  CONSTRAINT team_alert_lease CHECK ((state = 'sending') = (lease IS NOT NULL))
);
CREATE INDEX team_alert_waiting ON team_alert (id) WHERE state IN ('queued', 'failed');
CREATE INDEX team_alert_finished ON team_alert (finished_at) WHERE finished_at IS NOT NULL;
ALTER TABLE team_alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_alert FORCE ROW LEVEL SECURITY;
REVOKE ALL ON team_alert FROM PUBLIC, questify_app;

-- The old address's Stop link. While the change is open it stops it; within 7 days after it completed it marks it
-- disputed and queues one team alert (support calls the organizer). Outcomes: stopped, reported, none (unknown, too old
-- or otherwise closed).
CREATE FUNCTION owner_email_stop(stop bytea, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c staff_email_change%ROWTYPE;
BEGIN
  SELECT x.* INTO c FROM staff_email_change x WHERE x.stop_hash = stop FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  IF c.state IN ('pending', 'held') THEN
    c := owner_email_close(c.id, 'stopped');
    PERFORM owner_email_audit(c, NULL, 'stop', NULL, request);
    RETURN 'stopped';
  END IF;
  IF c.state <> 'confirmed' OR c.closed_at <= now() - interval '7 days' THEN
    RETURN 'none';
  END IF;
  IF c.disputed_at IS NULL THEN
    UPDATE staff_email_change SET disputed_at = now() WHERE id = c.id RETURNING * INTO c;
    INSERT INTO team_alert (kind, change_id, organizer_id, dedupe)
    VALUES ('email_change_dispute', c.id, c.organizer_id, 'dispute:' || c.id);
    PERFORM owner_email_audit(c, NULL, 'dispute', NULL, request);
  END IF;
  RETURN 'reported';
END $$;
REVOKE ALL ON FUNCTION owner_email_stop(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_email_stop(bytea, uuid) TO questify_app;

-- The lifecycle step: a pending change past its hour expires (audited), and a closed change's addresses are erased 180
-- days after it closed (ids and states stay). Answers how many rows changed.
CREATE FUNCTION owner_email_purge(batch integer) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  size    integer := least(greatest(coalesce(batch, 1000), 1), 1000);
  c       staff_email_change%ROWTYPE;
  expired integer := 0;
  erased  integer;
BEGIN
  FOR c IN SELECT x.* FROM staff_email_change x WHERE x.state = 'pending' AND x.expires_at <= now()
           ORDER BY x.expires_at, x.id LIMIT size FOR UPDATE SKIP LOCKED LOOP
    c := owner_email_close(c.id, 'expired');
    PERFORM owner_email_audit(c, NULL, 'expire', NULL, NULL);
    expired := expired + 1;
  END LOOP;
  WITH due AS (
    SELECT x.id FROM staff_email_change x
    WHERE x.closed_at IS NOT NULL AND x.old_email IS NOT NULL AND x.closed_at <= now() - interval '180 days'
    ORDER BY x.closed_at, x.id LIMIT size FOR UPDATE SKIP LOCKED)
  UPDATE staff_email_change x SET old_email = NULL, new_email = NULL FROM due WHERE x.id = due.id;
  GET DIAGNOSTICS erased = ROW_COUNT;
  DELETE FROM team_alert t WHERE t.id IN (
    SELECT a.id FROM team_alert a WHERE a.finished_at <= now() - interval '30 days' LIMIT size);
  RETURN expired + erased;
END $$;
REVOKE ALL ON FUNCTION owner_email_purge(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION owner_email_purge(integer) TO questify_app;

-- ================================================================ urgent reports (FR-1732, ADR-493)
ALTER TABLE content_report ADD COLUMN urgent boolean NOT NULL DEFAULT false;
ALTER TABLE content_report ADD COLUMN due_at timestamptz;
UPDATE content_report SET due_at = created_at + interval '24 hours';
ALTER TABLE content_report ALTER COLUMN due_at SET NOT NULL;
CREATE INDEX content_report_open_due ON content_report (urgent DESC, due_at) WHERE status = 'open';
CREATE INDEX content_report_open_urgent ON content_report (target_kind, target_id) WHERE status = 'open' AND urgent;

-- One transaction lock per reported target: the alert trigger, unpublishing and resolving take it before they read or
-- close the target's open reports, so "the first urgent report of an open episode" is exact.
CREATE FUNCTION report_target_lock(target_kind text, target uuid) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('report_target:' || target_kind || ':' || target, 0))
$$;
REVOKE ALL ON FUNCTION report_target_lock(text, uuid) FROM PUBLIC;

-- Urgency is the database's, fixed at arrival: urgent while the report's event is live (Q-452), due in 1 hour, else
-- 24 hours. Any value a writer passes is ignored.
CREATE FUNCTION report_urgency() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.urgent := NEW.event_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM event e WHERE e.id = NEW.event_id AND e.status = 'live');
  NEW.due_at := NEW.created_at + CASE WHEN NEW.urgent THEN interval '1 hour' ELSE interval '24 hours' END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION report_urgency() FROM PUBLIC;
CREATE TRIGGER report_urgency BEFORE INSERT ON content_report FOR EACH ROW EXECUTE FUNCTION report_urgency();

-- The first urgent report of a target's open episode queues one team alert (after the reporter's own lock, always in
-- that order).
CREATE FUNCTION report_team_alert() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.urgent THEN
    RETURN NULL;
  END IF;
  PERFORM report_target_lock(NEW.target_kind, NEW.target_id);
  IF NOT EXISTS (SELECT 1 FROM content_report r
                 WHERE r.target_kind = NEW.target_kind AND r.target_id = NEW.target_id AND r.status = 'open'
                   AND r.urgent AND r.id <> NEW.id) THEN
    INSERT INTO team_alert (kind, target_kind, target_id, event_id, report_id, dedupe)
    VALUES ('urgent_report', NEW.target_kind, NEW.target_id, NEW.event_id, NEW.id, 'urgent:' || NEW.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION report_team_alert() FROM PUBLIC;
CREATE TRIGGER report_team_alert AFTER INSERT ON content_report FOR EACH ROW EXECUTE FUNCTION report_team_alert();

-- What one alert row says in the digest: for a target, its event and organizer names, the open report count, the open
-- reasons and the earliest due time (NULL once nothing is open: the row is skipped); for a dispute, the organizer.
CREATE FUNCTION team_alert_doc(a team_alert) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN a.kind = 'email_change_dispute' THEN
    jsonb_build_object('kind', a.kind, 'organizerId', a.organizer_id,
                       'organizer', (SELECT o.name FROM organizer o WHERE o.id = a.organizer_id))
  ELSE (
    SELECT jsonb_build_object('kind', a.kind, 'targetKind', a.target_kind, 'targetId', a.target_id,
                              'reports', count(*), 'reasons', jsonb_agg(DISTINCT r.reason), 'dueAt', min(r.due_at),
                              'event', (SELECT report_pair(e.name_ar, e.name_en, 120) FROM event e
                                        WHERE e.id = a.event_id),
                              'organizer', (SELECT o.name FROM event e JOIN organizer o ON o.id = e.organizer_id
                                            WHERE e.id = a.event_id))
    FROM content_report r
    WHERE r.target_kind = a.target_kind AND r.target_id = a.target_id AND r.status = 'open'
    HAVING count(*) > 0)
  END
$$;
REVOKE ALL ON FUNCTION team_alert_doc(team_alert) FROM PUBLIC;

-- The worker's claim: rows whose lease ran out become `uncertain` (never resent); waiting rows (queued, or failed with
-- sends left) are leased for 60 seconds, at most `size`, each with its digest line; a target with nothing open any more
-- is closed `skipped`.
CREATE FUNCTION team_alert_claim(lease uuid, size integer) RETURNS TABLE (id bigint, doc jsonb)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a    team_alert%ROWTYPE;
  line jsonb;
BEGIN
  UPDATE team_alert t SET state = 'uncertain', lease = NULL, lease_until = NULL, finished_at = now()
  WHERE t.state = 'sending' AND t.lease_until <= now();
  FOR a IN SELECT t.* FROM team_alert t WHERE t.state IN ('queued', 'failed') AND t.attempts < 3
           ORDER BY t.id LIMIT least(greatest(coalesce(size, 50), 1), 50) FOR UPDATE SKIP LOCKED LOOP
    line := team_alert_doc(a);
    IF line IS NULL THEN
      UPDATE team_alert t SET state = 'skipped', finished_at = now() WHERE t.id = a.id;
      CONTINUE;
    END IF;
    UPDATE team_alert t SET state = 'sending', lease = team_alert_claim.lease,
                            lease_until = now() + interval '60 seconds', attempts = t.attempts + 1
    WHERE t.id = a.id;
    id := a.id;
    doc := line;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION team_alert_claim(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_alert_claim(uuid, integer) TO questify_app;

-- The worker's answer for the rows of one lease: sent, uncertain and skipped finish; failed waits for the next digest
-- while sends are left. Answers how many rows it settled.
CREATE FUNCTION team_alert_ack(ids bigint[], lease uuid, outcome text) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  done integer;
BEGIN
  IF outcome IS NULL OR outcome NOT IN ('sent', 'failed', 'uncertain', 'skipped') THEN
    RAISE EXCEPTION 'an outcome from the list' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE team_alert t
  SET state = outcome, lease = NULL, lease_until = NULL,
      finished_at = CASE WHEN outcome = 'failed' AND t.attempts < 3 THEN NULL ELSE now() END
  WHERE t.id = ANY (ids) AND t.lease = team_alert_ack.lease AND t.state = 'sending';
  GET DIAGNOSTICS done = ROW_COUNT;
  RETURN done;
END $$;
REVOKE ALL ON FUNCTION team_alert_ack(bigint[], uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_alert_ack(bigint[], uuid, text) TO questify_app;

-- ================================================================ the moderation addresses (ADR-495)
-- The alert and appeal addresses of the `moderation` key: each an address or NULL (the sending address). Merged under
-- the row's lock, audited before and after (Questify's own role addresses, not personal data). QE403 for a non-admin;
-- MA422 for a value that is not an address.
CREATE FUNCTION admin_set_moderation_addresses(alert text, appeal text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  a      text := nullif(lower(btrim(alert)), '');
  b      text := nullif(lower(btrim(appeal)), '');
  before jsonb;
  after  jsonb;
BEGIN
  IF (a IS NOT NULL AND (length(a) > 254 OR a !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
     OR (b IS NOT NULL AND (length(b) > 254 OR b !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')) THEN
    RAISE EXCEPTION 'an email address or nothing' USING ERRCODE = 'MA422';
  END IF;
  SELECT s.value INTO before FROM platform_setting s WHERE s.key = 'moderation' FOR UPDATE;
  after := jsonb_strip_nulls(coalesce(before, '{}'::jsonb) - 'alertEmail' - 'appealEmail'
                             || jsonb_build_object('alertEmail', a, 'appealEmail', b));
  INSERT INTO platform_setting (key, value, updated_at, updated_by) VALUES ('moderation', after, now(), me)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), updated_by = me;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after, request_id)
  VALUES ('admin', me, 'platform_settings.update', 'platform_setting', 'moderation', before, after, request);
  RETURN after;
END $$;
REVOKE ALL ON FUNCTION admin_set_moderation_addresses(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_set_moderation_addresses(text, text, uuid) TO questify_app;

-- ================================================================ the console's queue, restated (0121)
-- Restates 0121: per open target `urgent` (any open report urgent) and `dueAt` (the earliest due), `overdue` past it;
-- urgent first, then the earliest due, then the target id; `urgentTotal` counts the open urgent targets.
CREATE OR REPLACE FUNCTION console_reports(only_kind text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
           'targets', coalesce(jsonb_agg(jsonb_build_object(
             'kind', g.target_kind, 'targetId', g.target_id, 'reports', g.n, 'firstAt', g.first_at,
             'lastAt', g.last_at, 'urgent', g.urgent, 'dueAt', g.due_at, 'overdue', g.due_at < now(),
             'snapshot', (SELECT r.snapshot FROM content_report r
                          WHERE r.target_kind = g.target_kind AND r.target_id = g.target_id AND r.status = 'open'
                          ORDER BY r.created_at DESC, r.id DESC LIMIT 1),
             'event', CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
                        'id', e.id, 'name', report_pair(e.name_ar, e.name_en, 120), 'organizer', o.name) END)
             ORDER BY g.urgent DESC, g.due_at, g.target_id), '[]'::jsonb),
           'total', (SELECT count(*) FROM (SELECT 1 FROM content_report r
                                           WHERE r.status = 'open' AND (only_kind IS NULL OR r.target_kind = only_kind)
                                           GROUP BY r.target_kind, r.target_id) x),
           'urgentTotal', (SELECT count(*) FROM (SELECT 1 FROM content_report r
                                                 WHERE r.status = 'open' AND r.urgent
                                                 GROUP BY r.target_kind, r.target_id) y))
  INTO result
  FROM (SELECT r.target_kind, r.target_id, count(*) AS n, min(r.created_at) AS first_at, max(r.created_at) AS last_at,
               bool_or(r.urgent) AS urgent, min(r.due_at) AS due_at,
               (array_agg(r.event_id ORDER BY r.created_at DESC))[1] AS event_id
        FROM content_report r
        WHERE r.status = 'open' AND (only_kind IS NULL OR r.target_kind = only_kind)
        GROUP BY r.target_kind, r.target_id
        ORDER BY bool_or(r.urgent) DESC, min(r.due_at), r.target_id
        LIMIT 100) g
  LEFT JOIN event e ON e.id = g.event_id
  LEFT JOIN organizer o ON o.id = e.organizer_id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, after, request_id)
  VALUES ('admin', me, 'console.reports_read', 'content_report',
          jsonb_build_object('kind', only_kind, 'shown', jsonb_array_length(result -> 'targets')), request);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION console_reports(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_reports(text, uuid) TO questify_app;

-- Restates 0121, adding each report's `urgent` and `dueAt`.
CREATE OR REPLACE FUNCTION console_report(target_kind text, target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  ev_id  uuid;
  result jsonb;
BEGIN
  SELECT r.event_id INTO ev_id FROM content_report r
  WHERE r.target_kind = console_report.target_kind AND r.target_id = target
  ORDER BY r.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no reports for this target' USING ERRCODE = 'QA404';
  END IF;
  SELECT jsonb_build_object(
    'kind', target_kind, 'targetId', target,
    'current', report_snapshot(target_kind, target),
    'player', CASE WHEN target_kind = 'username' THEN
                (SELECT jsonb_build_object('id', p.id, 'status', p.status) FROM player p WHERE p.id = target) END,
    'event', (SELECT jsonb_build_object('id', e.id, 'name', report_pair(e.name_ar, e.name_en, 120),
                                        'organizer', o.name, 'suspended', event_suspended(e.id))
              FROM event e JOIN organizer o ON o.id = e.organizer_id WHERE e.id = coalesce(ev_id,
                report_event(target_kind, target))),
    'hold', (SELECT jsonb_build_object('id', h.id, 'reasonCode', h.reason_code, 'note', h.note, 'heldAt', h.held_at)
             FROM content_hold h WHERE h.kind = target_kind AND h.target_id = target AND h.released_at IS NULL),
    'reports', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id, 'reason', x.reason, 'note', x.note, 'marked', x.marked, 'status', x.status,
               'outcome', x.outcome, 'createdAt', x.created_at, 'handledAt', x.handled_at, 'snapshot', x.snapshot,
               'urgent', x.urgent, 'dueAt', x.due_at,
               'reporter', (SELECT p.username FROM player p WHERE p.id = x.reporter_id))
             ORDER BY x.created_at DESC, x.id DESC)
      FROM (SELECT r.* FROM content_report r
            WHERE r.target_kind = console_report.target_kind AND r.target_id = target
            ORDER BY r.created_at DESC, r.id DESC LIMIT 200) x), '[]'::jsonb))
  INTO result;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'console.report_read',
          target_kind, target::text, request);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION console_report(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_report(text, uuid, uuid) TO questify_app;

-- Restates 0121, taking the target's lock first (the alert trigger's episode check).
CREATE OR REPLACE FUNCTION admin_report_resolve(target_kind text, target uuid, resolution text, request uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  closed integer;
  ev_id  uuid;
BEGIN
  IF resolution IS NULL OR resolution NOT IN ('dismissed', 'unpublished', 'event_suspended', 'username_changed',
                                              'player_banned') THEN
    RAISE EXCEPTION 'an outcome from the list' USING ERRCODE = 'RP422';
  END IF;
  PERFORM report_target_lock(admin_report_resolve.target_kind, target);
  WITH done AS (
    UPDATE content_report r
    SET status = CASE WHEN resolution = 'dismissed' THEN 'dismissed' ELSE 'actioned' END, outcome = resolution,
        handled_by = me, handled_at = now()
    WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target AND r.status = 'open'
    RETURNING r.event_id)
  SELECT count(*), max(d.event_id::text)::uuid INTO closed, ev_id FROM done d;
  IF closed > 0 THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'report.resolve', target_kind,
            target::text, jsonb_build_object('outcome', resolution, 'closed', closed), request);
  END IF;
  RETURN closed;
END $$;
REVOKE ALL ON FUNCTION admin_report_resolve(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_report_resolve(text, uuid, text, uuid) TO questify_app;

-- Restates 0121, taking the target's lock before it closes the target's open reports.
CREATE OR REPLACE FUNCTION admin_unpublish(hold_kind text, target uuid, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, hold_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := hold_note(note);
  t     record;
  live  uuid;
  made  uuid;
BEGIN
  IF reason_code IS NULL OR reason_code NOT IN ('offensive', 'hateful', 'sexual', 'spam', 'misleading', 'other') THEN
    RAISE EXCEPTION 'unknown reason code' USING ERRCODE = 'HD400';
  END IF;
  t := hold_target(hold_kind, target);
  SELECT h.id INTO live FROM content_hold h
  WHERE h.kind = hold_kind AND h.target_id = target AND h.released_at IS NULL;
  IF live IS NOT NULL THEN
    RETURN QUERY SELECT 'already_unpublished'::text, live;
    RETURN;
  END IF;
  INSERT INTO content_hold (kind, target_id, organizer_id, event_id, reason_code, note, was_visible, held_by)
  VALUES (hold_kind, target, t.org_id, t.ev_id, reason_code, clean, CASE WHEN hold_kind = 'quest' THEN t.shown END, me)
  RETURNING id INTO made;
  IF hold_kind = 'quest' AND t.shown THEN
    PERFORM set_config('app.content_hold', 'on', true);
    UPDATE quest SET visible = false WHERE id = target;
    PERFORM set_config('app.content_hold', '', true);
  ELSIF hold_kind = 'reward' THEN
    UPDATE reward SET held_at = now() WHERE id = target;
  END IF;
  PERFORM report_target_lock(hold_kind, target);
  UPDATE content_report r SET status = 'actioned', outcome = 'unpublished', handled_by = me, handled_at = now()
  WHERE r.target_kind = hold_kind AND r.target_id = target AND r.status = 'open';
  PERFORM alert_enqueue(t.org_id, t.ev_id, 'content_unpublished', 'hold:' || made);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, t.org_id, t.ev_id, 'content.unpublish', hold_kind, target::text,
          jsonb_build_object('holdId', made, 'reasonCode', reason_code), request);
  RETURN QUERY SELECT 'unpublished'::text, made;
END $$;
REVOKE ALL ON FUNCTION admin_unpublish(text, uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_unpublish(text, uuid, text, text, uuid) TO questify_app;

-- The console menu's count: open targets and open urgent targets, counts only (not audited, as the ticket counts).
CREATE FUNCTION console_report_counts() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
BEGIN
  RETURN (SELECT jsonb_build_object('open', count(*), 'urgent', count(*) FILTER (WHERE x.urgent))
          FROM (SELECT bool_or(r.urgent) AS urgent FROM content_report r WHERE r.status = 'open'
                GROUP BY r.target_kind, r.target_id) x);
END $$;
REVOKE ALL ON FUNCTION console_report_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_report_counts() TO questify_app;
