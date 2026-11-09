-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 38). Comments only, no table, no grant beyond the restated
-- ones: the two comments of 0120 that said more than the lock gives now say what ADR-430 holds (FOLLOWUPS batch 7
-- restated the guarantee there). `ledger_player_guard` (diffed against 0120, its only definition) and
-- `admin_ban_player` (diffed against 0155) are restated with only that comment changed: same body, signature, owner
-- and grants, and no trigger is touched (CREATE OR REPLACE keeps `ledger_player_guard`'s trigger). The third comment
-- the line named, 0120's "the app shows Hidden player" above the masked reads, sits outside every function body, so
-- no database object holds it and no restatement changes it: the copy is "Hidden name" (ADR-431). Nothing here
-- changes what any function does. 0186 and earlier untouched; 0156 stays reserved.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the wall's comments (ADR-430)
-- As 0120, with only the comment on the membership lock changed.
CREATE OR REPLACE FUNCTION ledger_player_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid;
BEGIN
  IF NEW.kind IN ('redeem_return', 'removal')
     OR (NEW.kind = 'adjust' AND NEW.score_delta <= 0 AND NEW.balance_delta <= 0) THEN
    RETURN NEW;
  END IF;
  -- ADR-430: the paid membership's lock is taken before the standing is read, so a ban that holds it is waited for and
  -- then read as banned (PB423); a backstop for a writer that does not lock the membership before its insert. A
  -- membership made while a ban runs is not in the ban's lock set, so one payment to it can still commit just after.
  SELECT n.player_id INTO who FROM enrollment n WHERE n.id = NEW.enrollment_id FOR NO KEY UPDATE;
  PERFORM player_may_be_paid(who);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_player_guard() FROM PUBLIC;

-- As 0155, with only the comment on the membership locks changed.
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
  -- ADR-430: every membership that exists now is locked (in id order) before the standing changes, so a ledger payment
  -- that holds one first commits first, and one that waits reads banned. Not covered by this lock: a membership made
  -- while the ban runs, and XP or gems written outside a ledger payment (the ended sessions stop those), each at most
  -- one transaction past the commit.
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
