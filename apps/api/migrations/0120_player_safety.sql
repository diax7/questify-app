-- Safety tools (T-705, plan docs/plans/2026-11-02-t-704-t-705-player-safety.md section 4; FR-1415, FR-1416, FR-1417,
-- FR-1606, FR-1779): a platform ban an admin sets and lifts with a reason the player sees, a database wall that pays a
-- player who is not active nothing, a player's own block list that hides a blocked player from the blocker's reads,
-- and the console's editor of the username word lists and the retired names.
--
-- The wall (ADR-430) and the writers that pay more than one player in a statement (plan review BLOCKER). A catalog search
-- for `INSERT INTO ledger_entry|xp_entry|gem_entry` over every function finds twenty writers; three pay a set of players:
--   apply_past_points   the points change of a quest applied to its past completions (the adjust batch, 0098)
--   bulk_award          the group and bulk awards (0093), through bulk_award_eligible
--   pay_community_batch the community goal payout (0114)
-- Each now locks the paid players FOR SHARE, in id order, after the enrollments it already locks, and skips a player
-- who is not active, so one banned member never rolls a batch back. Every other writer pays one player and meets the
-- wall's PB423, which the API answers in one place.
--
-- Deny by default: the new table keeps row-level security forced with no grant; every new function is revoked from
-- PUBLIC in the group that creates it and only the doors are granted to questify_app. questify_app loses its UPDATE on
-- player.status: only admin_ban_player and admin_lift_ban change a standing now. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the ban (ADR-429)
ALTER TABLE player_admin_action DROP CONSTRAINT player_admin_action_kind_check;
ALTER TABLE player_admin_action ADD CONSTRAINT player_admin_action_kind_check
  CHECK (kind IN ('rename', 'reset_sign_in', 'contact_reveal', 'ban', 'lift_ban'));

-- The action row of the ban in force: its reason code is what the player is shown. Set and cleared by the two doors and
-- cleared by erasure; never written by the API's role.
ALTER TABLE player ADD COLUMN ban_action_id uuid REFERENCES player_admin_action (id);
ALTER TABLE player ADD CONSTRAINT player_ban_action_banned CHECK (ban_action_id IS NULL OR status = 'banned');
REVOKE UPDATE (status) ON player FROM questify_app;

-- As 0118, plus the ban's and the lift's codes. The ban's codes are shown to the player (FR-1417); the lift's are
-- internal.
CREATE OR REPLACE FUNCTION player_action_note(action_kind text, code text, note text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF code IS NULL OR NOT (code = ANY (CASE action_kind
       WHEN 'contact_reveal' THEN ARRAY['support_request', 'legal_request']
       WHEN 'rename' THEN ARRAY['offensive', 'impersonation', 'personal_data', 'spam', 'other']
       WHEN 'reset_sign_in' THEN ARRAY['lost_access', 'compromised', 'locked_out', 'other']
       WHEN 'ban' THEN ARRAY['cheating', 'abuse', 'spam', 'prize_fraud', 'terms']
       WHEN 'lift_ban' THEN ARRAY['appeal_upheld', 'mistake', 'other']
       ELSE ARRAY[]::text[] END)) THEN
    RAISE EXCEPTION 'unknown reason code for %', action_kind USING ERRCODE = 'PA400';
  END IF;
  IF note IS NULL OR char_length(btrim(note)) NOT BETWEEN 10 AND 300
     OR note ~ '[[:cntrl:]  ‪-‮⁦-⁩]' THEN
    RAISE EXCEPTION 'a note of 10 to 300 characters is required' USING ERRCODE = 'PA400';
  END IF;
  RETURN btrim(note);
END $$;
REVOKE ALL ON FUNCTION player_action_note(text, text, text) FROM PUBLIC;

-- Every event where the player holds an active membership gets its ranking repaired, so cached boards drop (or bring
-- back) the player at once (the 0019 pattern).
CREATE FUNCTION mark_player_rankings(target uuid) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  INSERT INTO ranking_repair (event_id)
  SELECT DISTINCT n.event_id FROM enrollment n WHERE n.player_id = target AND n.status = 'active'
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now()
$$;
REVOKE ALL ON FUNCTION mark_player_rankings(uuid) FROM PUBLIC;

-- Bans an account (FR-1416): never automatic, only this door sets `banned`. Locks the player row FOR NO KEY UPDATE, so
-- a payment that read the player FOR SHARE first commits before the ban and one that comes after is refused (PB423).
-- Ends every way in as the sign-in reset does (open codes, tokens, push devices, then the cutoff taken last), keeps
-- memberships, event bans, the ledger and history untouched, and repairs the rankings. Outcomes: banned,
-- already_banned. PA404 for an unknown id or a tombstone; PA400 for a bad reason.
CREATE FUNCTION admin_ban_player(target uuid, reason_code text, note text, request uuid)
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
  DELETE FROM player_login_challenge l
  WHERE l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = p.id);
  DELETE FROM player_contact_challenge WHERE player_id = p.id;
  DELETE FROM player_deletion_challenge WHERE player_id = p.id;
  UPDATE player_refresh SET revoked_at = now() WHERE player_id = p.id AND revoked_at IS NULL;
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

-- Lifts a ban: exactly what was there comes back (the account active, its memberships ranked again); the cutoff stays,
-- so tokens from before the ban stay dead and the player signs in afresh. Outcomes: lifted, not_banned.
CREATE FUNCTION admin_lift_ban(target uuid, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, action_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  clean  text := player_action_note('lift_ban', reason_code, note);
  p      player := player_for_admin(target, true);
  action uuid;
BEGIN
  IF p.status <> 'banned' THEN
    RETURN QUERY SELECT 'not_banned'::text, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (p.id, me, 'lift_ban', reason_code, clean) RETURNING id INTO action;
  UPDATE player SET status = 'active', ban_action_id = NULL WHERE id = p.id;
  PERFORM mark_player_rankings(p.id);
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.lift_ban', 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code), request);
  RETURN QUERY SELECT 'lifted'::text, action;
END $$;
REVOKE ALL ON FUNCTION admin_lift_ban(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_lift_ban(uuid, text, text, uuid) TO questify_app;

-- What a banned player is shown after the right code (FR-1417, FR-1606): the ban's reason code and the address appeals
-- go to, configuration data (`platform_setting` key `moderation`, ADR-423); null when no address is stored, and the API
-- then answers its sending address. The reason is null for a ban recorded before this migration or a contact kept off
-- after an erasure. Only sign-in calls it, with the player id sign_in_player found.
CREATE FUNCTION ban_notice(target uuid) RETURNS TABLE (reason text, appeal_email text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (SELECT a.reason_code FROM player p JOIN player_admin_action a ON a.id = p.ban_action_id
          WHERE p.id = target AND p.status = 'banned'),
         (SELECT s.value ->> 'appealEmail' FROM platform_setting s WHERE s.key = 'moderation')
$$;
REVOKE ALL ON FUNCTION ban_notice(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ban_notice(uuid) TO questify_app;

-- As 0118 (via 0013 and 0038), with the banned account's id in the answer of `banned` so the API can read the ban's
-- notice; the outcome still comes only after the right code (no oracle), and nothing is issued.
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
REVOKE ALL ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sign_in_player(bytea, bytea, bytea, bytea, uuid, bytea) TO questify_app;

-- ================================================================ the wall (ADR-430)
-- A player who is not active (banned, or erased) is paid nothing: no points, balance, XP or gems. What passes: a refund
-- of a reservation (`redeem_return`, so a live reservation expires and pays back), a removal, and a points change that
-- only lowers (an adjust with no positive delta). A prize handover is refused too, so the reservation expires. Reads
-- the player FOR SHARE: a ban (FOR NO KEY UPDATE) and a payment run one after the other.
CREATE FUNCTION player_may_be_paid(target uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  standing text;
BEGIN
  SELECT p.status INTO standing FROM player p WHERE p.id = target FOR SHARE;
  IF standing IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'this player cannot receive points' USING ERRCODE = 'PB423';
  END IF;
END $$;
REVOKE ALL ON FUNCTION player_may_be_paid(uuid) FROM PUBLIC;

CREATE FUNCTION ledger_player_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind IN ('redeem_return', 'removal')
     OR (NEW.kind = 'adjust' AND NEW.score_delta <= 0 AND NEW.balance_delta <= 0) THEN
    RETURN NEW;
  END IF;
  PERFORM player_may_be_paid((SELECT n.player_id FROM enrollment n WHERE n.id = NEW.enrollment_id));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_player_guard() FROM PUBLIC;
CREATE TRIGGER ledger_player_guard BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_player_guard();

-- XP: only a removal (negative) passes. Gems: only a purchase (negative) passes.
CREATE FUNCTION wallet_player_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.delta > 0 THEN
    PERFORM player_may_be_paid(NEW.player_id);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION wallet_player_guard() FROM PUBLIC;
CREATE TRIGGER xp_player_guard BEFORE INSERT ON xp_entry
  FOR EACH ROW EXECUTE FUNCTION wallet_player_guard();
CREATE TRIGGER gem_player_guard BEFORE INSERT ON gem_entry
  FOR EACH ROW EXECUTE FUNCTION wallet_player_guard();

-- As 0093 (group and bulk awards), plus: the candidates' players locked FOR SHARE in id order, and only active players
-- eligible, so a banned member is skipped (counted in `skipped`) instead of failing the batch. VOLATILE for the lock.
CREATE OR REPLACE FUNCTION bulk_award_eligible(ev event, candidates uuid[], rehearsing boolean) RETURNS SETOF uuid
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player p
  WHERE p.id IN (SELECT n.player_id FROM enrollment n WHERE n.id = ANY (candidates) AND n.event_id = ev.id)
  ORDER BY p.id FOR SHARE;
  RETURN QUERY
  SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
  WHERE n.id = ANY (candidates) AND n.event_id = ev.id AND n.status = 'active' AND p.status = 'active'
    AND (n.joined_via IS NOT DISTINCT FROM 'rehearsal') = rehearsing
    AND member_may_play(ev, n)
  ORDER BY n.id;
END $$;
REVOKE ALL ON FUNCTION bulk_award_eligible(event, uuid[], boolean) FROM PUBLIC;

-- As 0114, plus the paid players locked FOR SHARE in id order after their memberships (it already skipped a player who
-- is not active as `inactive`; the lock makes that read hold until the payment commits).
CREATE OR REPLACE FUNCTION pay_community_batch(size integer, only_event uuid)
  RETURNS TABLE (step_id uuid, paid integer, skipped integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  picked     community_payout%ROWTYPE;
  ev         event%ROWTYPE;
  amount     integer;
  ids        uuid[];
  balance_on boolean;
  final      boolean;
  n_paid     integer;
  n_skipped  integer;
BEGIN
  PERFORM community_system_only();
  IF only_event IS NOT NULL THEN
    PERFORM ensure_rehearsal_wiped(only_event);
  END IF;
  SELECT p.* INTO picked FROM community_payout p
  WHERE p.status = 'due' AND (only_event IS NULL OR p.event_id = only_event) AND NOT event_suspended(p.event_id)
  ORDER BY p.created_at, p.step_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF only_event IS NULL THEN
    PERFORM ensure_rehearsal_wiped(picked.event_id);
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = picked.event_id FOR KEY SHARE;
  ids := ARRAY(
    WITH taken AS (
      SELECT p.enrollment_id FROM community_payout p
      WHERE p.step_id = picked.step_id AND p.status = 'due'
      ORDER BY p.enrollment_id LIMIT least(greatest(coalesce(size, 500), 1), 1000)
      FOR UPDATE SKIP LOCKED
    )
    SELECT taken.enrollment_id FROM taken ORDER BY taken.enrollment_id);
  IF cardinality(ids) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = ANY (ids) ORDER BY n.id FOR NO KEY UPDATE;
  PERFORM 1 FROM player pl WHERE pl.id IN (SELECT n.player_id FROM enrollment n WHERE n.id = ANY (ids))
  ORDER BY pl.id FOR SHARE;
  SELECT s.points INTO amount FROM community_step s WHERE s.id = picked.step_id;
  final := EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id);
  balance_on := shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) <> 'closed';

  WITH verdict AS (
    SELECT n.id,
           CASE WHEN final THEN 'results_final'
                WHEN n.status <> 'active' OR pl.status <> 'active' THEN 'inactive'
                WHEN EXISTS (SELECT 1 FROM staff_assignment sa
                             WHERE sa.event_id = n.event_id AND sa.player_id = n.player_id AND NOT sa.can_play)
                  THEN 'no_play' END AS why
    FROM enrollment n JOIN player pl ON pl.id = n.player_id
    WHERE n.id = ANY (ids)
  ), made AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              community_step_id)
    SELECT ev.organizer_id, ev.id, v.id, 'community', amount, CASE WHEN balance_on THEN amount ELSE 0 END, 'system',
           picked.step_id
    FROM verdict v WHERE v.why IS NULL ORDER BY v.id
    RETURNING id, enrollment_id
  ), paid_rows AS (
    UPDATE community_payout p SET status = 'paid', entry_id = m.id, done_at = now()
    FROM made m WHERE p.step_id = picked.step_id AND p.enrollment_id = m.enrollment_id
    RETURNING 1
  ), skipped_rows AS (
    UPDATE community_payout p SET status = 'skipped', skip_reason = v.why, done_at = now()
    FROM verdict v WHERE v.why IS NOT NULL AND p.step_id = picked.step_id AND p.enrollment_id = v.id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM paid_rows), (SELECT count(*) FROM skipped_rows) INTO n_paid, n_skipped;
  IF n_paid > 0 THEN
    PERFORM mark_ranking_repair(ev.id);
  END IF;
  RETURN QUERY SELECT picked.step_id, n_paid, n_skipped;
END $$;
REVOKE ALL ON FUNCTION pay_community_batch(integer, uuid) FROM PUBLIC;

-- As 0098 (the points change applied to past completions), plus: the completions' players locked FOR SHARE in id
-- order after their memberships, and a raise skipped for a player who is not active (a lowering still applies, the
-- wall lets it through), so one banned member never fails the change.
CREATE OR REPLACE FUNCTION apply_past_points(target_event uuid, target_quest uuid, from_points integer, request_key text,
                                  request uuid, batch_limit integer DEFAULT 2000, part integer DEFAULT 1)
  RETURNS TABLE (change_id uuid, completions integer, players integer, raised integer, lowered integer,
                 clamped integer, replayed boolean, more boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  me        uuid := app_staff_user_id();
  earlier   quest_points_change%ROWTYPE;
  quest_row quest%ROWTYPE;
  made      uuid := gen_random_uuid();
  part_key  text;
  most      integer := greatest(coalesce(batch_limit, 2000), 1);
  shop_shut boolean;
  w_done    bigint[];
  w_who     uuid[];
  w_ds      bigint[];
  w_db      bigint[];
  n_done    integer;
  n_players integer;
  n_up      integer;
  n_down    integer;
  n_short   integer;
  left_over boolean;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 240 OR part IS NULL OR part < 1 THEN
    RAISE EXCEPTION 'an idempotency key of 1 to 240 characters is required' USING ERRCODE = 'AK422';
  END IF;
  part_key := CASE WHEN part = 1 THEN request_key ELSE request_key || '#' || part END;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT k.* INTO earlier FROM quest_points_change k
  WHERE k.event_id = ev.id AND k.staff_user_id = me AND k.idempotency_key = part_key;
  IF FOUND THEN
    IF earlier.quest_id <> target_quest
       OR earlier.to_points IS DISTINCT FROM (SELECT q.points FROM quest q WHERE q.id = target_quest) THEN
      RAISE EXCEPTION 'this key was used for another change' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.completions, earlier.players, earlier.raised, earlier.lowered,
                        earlier.clamped, true, false;
    RETURN;
  END IF;
  quest_row := edited_quest(ev, target_quest);
  IF NOT past_points_type(quest_row.type) THEN
    RAISE EXCEPTION 'this type pays its own amounts' USING ERRCODE = 'PX422', DETAIL = quest_row.type;
  END IF;
  shop_shut := shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed';
  -- The quest is held FOR UPDATE, so its completions are fixed: lock their players, then read the rows once.
  PERFORM 1 FROM enrollment n
  WHERE n.id IN (SELECT c.enrollment_id FROM quest_completion c WHERE c.quest_id = quest_row.id)
  ORDER BY n.id FOR NO KEY UPDATE;
  PERFORM 1 FROM player p
  WHERE p.id IN (SELECT n.player_id FROM enrollment n
                 WHERE n.id IN (SELECT c.enrollment_id FROM quest_completion c WHERE c.quest_id = quest_row.id))
  ORDER BY p.id FOR SHARE;
  SELECT array_agg(w.completion_id ORDER BY w.ord), array_agg(w.enrollment_id ORDER BY w.ord),
         array_agg(w.ds ORDER BY w.ord), array_agg(w.db ORDER BY w.ord)
  INTO w_done, w_who, w_ds, w_db
  FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w
  WHERE (w.ds <> 0 OR w.db <> 0)
    AND ((w.ds <= 0 AND w.db <= 0)
         OR EXISTS (SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id
                    WHERE n.id = w.enrollment_id AND p.status = 'active'));
  IF NOT app_is_owner(ev.organizer_id) AND EXISTS (SELECT 1 FROM unnest(w_ds) d WHERE d > ev.award_cap_each) THEN
    RAISE EXCEPTION 'over the cap per award' USING ERRCODE = 'AC409', DETAIL = 'each',
      HINT = ev.award_cap_each || ',' || ev.award_cap_day;
  END IF;

  -- Each player's running score (and balance) held at zero: level k = sum k - least(lowest sum up to k, 0), and the
  -- entry is level k - level k-1. Every row is clamped; the first `most` that still move something are written.
  WITH wanted AS (
    SELECT u.ord, u.completion_id, u.enrollment_id, u.ds, u.db, n.score, n.balance
    FROM unnest(w_done, w_who, w_ds, w_db) WITH ORDINALITY AS u(completion_id, enrollment_id, ds, db, ord)
    JOIN enrollment n ON n.id = u.enrollment_id
  ),
  running AS (
    SELECT w.*, w.score + sum(w.ds) OVER mine AS s_sum, w.balance + sum(w.db) OVER mine AS b_sum
    FROM wanted w WINDOW mine AS (PARTITION BY w.enrollment_id ORDER BY w.ord ROWS UNBOUNDED PRECEDING)
  ),
  held AS (
    SELECT r.*, r.s_sum - least(min(r.s_sum) OVER mine, 0) AS s_level,
           r.b_sum - least(min(r.b_sum) OVER mine, 0) AS b_level
    FROM running r WINDOW mine AS (PARTITION BY r.enrollment_id ORDER BY r.ord ROWS UNBOUNDED PRECEDING)
  ),
  step AS (
    SELECT h.ord, h.completion_id, h.enrollment_id, h.ds, h.db,
           (h.s_level - lag(h.s_level, 1, h.score::numeric) OVER mine)::bigint AS es,
           (h.b_level - lag(h.b_level, 1, h.balance::numeric) OVER mine)::bigint AS eb
    FROM held h WINDOW mine AS (PARTITION BY h.enrollment_id ORDER BY h.ord)
  ),
  written AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                              quest_id, actor, staff_user_id, points_change_id)
    SELECT ev.organizer_id, ev.id, s.enrollment_id, 'adjust', s.es, s.eb, s.completion_id, quest_row.id, 'staff', me,
           made
    FROM (SELECT * FROM step WHERE es <> 0 OR eb <> 0 ORDER BY ord LIMIT most) s
    ORDER BY s.ord
    RETURNING score_delta, balance_delta
  )
  SELECT (SELECT count(*)::integer FROM written),
         (SELECT count(*)::integer FROM written w
          WHERE w.score_delta > 0 OR (w.score_delta = 0 AND w.balance_delta > 0)),
         (SELECT count(*)::integer FROM written w
          WHERE w.score_delta < 0 OR (w.score_delta = 0 AND w.balance_delta < 0)),
         CASE WHEN part = 1 THEN (SELECT count(DISTINCT s.enrollment_id)::integer FROM step s
                                  WHERE s.es <> 0 OR s.eb <> 0) ELSE 0 END,
         CASE WHEN part = 1 THEN (SELECT count(DISTINCT s.enrollment_id)::integer FROM step s
                                  WHERE s.es <> s.ds OR s.eb <> s.db) ELSE 0 END,
         (SELECT count(*) FROM step s WHERE s.es <> 0 OR s.eb <> 0) > most
  INTO n_done, n_up, n_down, n_players, n_short, left_over;

  INSERT INTO quest_points_change (id, organizer_id, event_id, quest_id, staff_user_id, from_points, to_points,
                                   completions, players, raised, lowered, clamped, idempotency_key, request_id)
  VALUES (made, ev.organizer_id, ev.id, quest_row.id, me, greatest(coalesce(from_points, 0), 0), quest_row.points,
          n_done, n_players, n_up, n_down, n_short, part_key, request);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'quest.points_past', 'quest', quest_row.id::text,
          jsonb_build_object('points', greatest(coalesce(from_points, 0), 0)),
          jsonb_build_object('points', quest_row.points, 'change', made, 'completions', n_done, 'players', n_players,
                             'raised', n_up, 'lowered', n_down, 'clamped', n_short),
          request);
  IF n_done > 0 THEN
    PERFORM ranking_repair_mark(ev.id);
  END IF;
  RETURN QUERY SELECT made, n_done, n_players, n_up, n_down, n_short, false, left_over;
END $$;

-- ================================================================ blocking a player (FR-1415, ADR-431)
-- A player's own list of players they never want to see. Nothing tells the blocked player: no read answers who blocked
-- whom except own_blocks for the blocker. At most 500 per player.
CREATE TABLE player_block (
  blocker_id uuid NOT NULL REFERENCES player (id),
  blocked_id uuid NOT NULL REFERENCES player (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX player_block_blocked_idx ON player_block (blocked_id);
ALTER TABLE player_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_block FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_block FROM PUBLIC;

-- Whether the player of this request blocked `other`. Used inside the masked reads (definers); false with no player.
CREATE FUNCTION blocked_by_me(other uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM player_block b WHERE b.blocker_id = app_player_id() AND b.blocked_id = other)
$$;
REVOKE ALL ON FUNCTION blocked_by_me(uuid) FROM PUBLIC;

-- The caller, refused without a player (42501).
CREATE FUNCTION block_caller() RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN me;
END $$;
REVOKE ALL ON FUNCTION block_caller() FROM PUBLIC;

-- The account a name belongs to now, active or banned; null for an unknown name, a tombstone or the caller.
CREATE FUNCTION block_target(me uuid, chosen_name text) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.id FROM player p
  WHERE username_fold(p.username) = username_fold(chosen_name) AND p.status <> 'deleted' AND p.id <> me
$$;
REVOKE ALL ON FUNCTION block_target(uuid, text) FROM PUBLIC;

-- Blocks a player by username. The caller's row is locked so the cap of 500 holds under concurrent blocks. Outcomes:
-- blocked (also when already blocked), not_found (unknown, erased, or the caller), limit.
CREATE FUNCTION block_player(chosen_name text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := block_caller();
  other uuid;
BEGIN
  other := block_target(me, chosen_name);
  IF other IS NULL THEN
    RETURN 'not_found';
  END IF;
  PERFORM 1 FROM player p WHERE p.id = me FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM player_block b WHERE b.blocker_id = me AND b.blocked_id = other) THEN
    RETURN 'blocked';
  END IF;
  IF (SELECT count(*) FROM player_block b WHERE b.blocker_id = me) >= 500 THEN
    RETURN 'limit';
  END IF;
  INSERT INTO player_block (blocker_id, blocked_id) VALUES (me, other);
  RETURN 'blocked';
END $$;
REVOKE ALL ON FUNCTION block_player(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION block_player(text) TO questify_app;

-- Unblocks a player by username. Outcomes: unblocked (also when not blocked), not_found.
CREATE FUNCTION unblock_player(chosen_name text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := block_caller();
  other uuid;
BEGIN
  other := block_target(me, chosen_name);
  IF other IS NULL THEN
    RETURN 'not_found';
  END IF;
  DELETE FROM player_block b WHERE b.blocker_id = me AND b.blocked_id = other;
  RETURN 'unblocked';
END $$;
REVOKE ALL ON FUNCTION unblock_player(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unblock_player(text) TO questify_app;

-- The caller's blocks, newest first: each player's current username and avatar (an erased account's row is gone).
CREATE FUNCTION own_blocks() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('username', p.username, 'avatar', p.avatar, 'blockedAt', b.created_at)
                            ORDER BY b.created_at DESC, p.username), '[]'::jsonb)
  FROM player_block b JOIN player p ON p.id = b.blocked_id
  WHERE b.blocker_id = block_caller() AND p.username IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_blocks() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_blocks() TO questify_app;

-- ================================================================ the reads a block masks (ADR-431)
-- A blocked player keeps their place and points in every board the blocker reads; their username, avatar, equipment
-- and full name are left out (the app shows "Hidden player"), so ranks stay true and the top 10 keeps 10 rows. Their
-- public profile answers nothing. Ranked players always have a username, so a null username is the mask.

-- As 0063, plus the blocker's mask.
CREATE OR REPLACE FUNCTION ranking_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, CASE WHEN NOT hide.v THEN p.username END, CASE WHEN NOT hide.v THEN p.avatar END,
         CASE WHEN NOT hide.v THEN jsonb_build_object('character', item_json(eq.character_id),
                                                      'frame', item_json(eq.frame_id),
                                                      'title', item_json(eq.title_id)) END,
         r.score, r.score_version
  FROM reader, ranked_enrollments(target) r JOIN player p ON p.id = r.player_id
  LEFT JOIN player_equipment eq ON eq.player_id = p.id, LATERAL (SELECT blocked_by_me(p.id) AS v) hide
  WHERE reader.id IS NOT NULL AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;

-- As 0063, plus the blocker's mask.
CREATE OR REPLACE FUNCTION ranking_day_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, CASE WHEN NOT hide.v THEN p.username END, CASE WHEN NOT hide.v THEN p.avatar END,
         CASE WHEN NOT hide.v THEN jsonb_build_object('character', item_json(eq.character_id),
                                                      'frame', item_json(eq.frame_id),
                                                      'title', item_json(eq.title_id)) END,
         r.score, r.score_version
  FROM reader, event ev,
       LATERAL ranked_day(target, event_day(now(), ev)) r JOIN player p ON p.id = r.player_id
       LEFT JOIN player_equipment eq ON eq.player_id = p.id, LATERAL (SELECT blocked_by_me(p.id) AS v) hide
  WHERE reader.id IS NOT NULL AND ev.id = target AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;

-- As 0063, plus the blocker's mask (the row stays ranked, without its name).
CREATE OR REPLACE FUNCTION ranking_rows(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, ranked boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT e.id, CASE WHEN shown.v THEN p.username END, CASE WHEN shown.v THEN p.avatar END,
           CASE WHEN shown.v THEN jsonb_build_object('character', item_json(eq.character_id),
                                                     'frame', item_json(eq.frame_id),
                                                     'title', item_json(eq.title_id)) END,
           rule.ok
    FROM enrollment e JOIN player p ON p.id = e.player_id LEFT JOIN player_equipment eq ON eq.player_id = p.id,
         LATERAL (SELECT ranking_eligible(e) AS ok) rule,
         LATERAL (SELECT rule.ok AND NOT blocked_by_me(p.id) AS v) shown
    WHERE e.id = ANY (ids) AND e.event_id = target;
END $$;

-- As 0109, plus the blocker's mask: no full name for a blocked player.
CREATE OR REPLACE FUNCTION ranking_names(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, full_name text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT n.id, x.name
    FROM enrollment n, LATERAL (SELECT public_full_name(n.id) AS name) x
    WHERE n.id = ANY (ids) AND n.event_id = target AND x.name IS NOT NULL AND NOT blocked_by_me(n.player_id);
END $$;

-- As 0109, plus `hidden`: a place of a player the reader blocked keeps its rank, score and prize without a username,
-- avatar or full name.
DROP FUNCTION event_results(uuid);
CREATE FUNCTION event_results(target uuid)
  RETURNS TABLE (rank integer, username text, avatar text, score bigint, prize_kind text, prize_name_ar text,
                 prize_name_en text, mine boolean, redemption_id uuid, redemption_status text,
                 claim_until timestamptz, full_name text, names text, hidden boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT x.rank, CASE WHEN NOT hide.v THEN p.username END, CASE WHEN NOT hide.v THEN p.avatar END, x.score, k.kind,
         k.name_ar, k.name_en, x.enrollment_id = me.id,
         CASE WHEN x.enrollment_id = me.id THEN d.id END, CASE WHEN x.enrollment_id = me.id THEN d.status END,
         res.claim_until, CASE WHEN NOT hide.v THEN public_full_name(n.id) END, event_player_names(ev), hide.v
  FROM me
  JOIN event ev ON ev.id = target
  JOIN event_result res ON res.event_id = target AND res.revealed_at IS NOT NULL
  JOIN result_place x ON x.event_id = res.event_id
  JOIN enrollment n ON n.id = x.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN rank_prize k ON k.id = x.rank_prize_id
  LEFT JOIN redemption d ON d.id = x.redemption_id
  CROSS JOIN LATERAL (SELECT blocked_by_me(p.id) AS v) hide
  ORDER BY x.rank
$$;
REVOKE ALL ON FUNCTION event_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_results(uuid) TO questify_app;

-- As 0065, and a profile of a player the reader blocked is not found.
CREATE OR REPLACE FUNCTION public_player_profile(chosen_name text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('username', p.username,
    'character', coalesce(item_json(e.character_id), jsonb_build_object('starter', p.avatar)),
    'frame', item_json(e.frame_id), 'title', item_json(e.title_id),
    'level', jsonb_build_object('number', x.level, 'title', jsonb_build_object('ar', t.name_ar, 'en', t.name_en)),
    'achievements', public_achievements(p.id), 'passport', public_passport(p.id))
  FROM player p JOIN player_xp x ON x.player_id = p.id LEFT JOIN player_equipment e ON e.player_id = p.id
  LEFT JOIN LATERAL level_title_of(x.level) t ON true
  WHERE profile_player() IS NOT NULL AND username_fold(p.username) = username_fold(chosen_name) AND p.status = 'active'
    AND NOT blocked_by_me(p.id)
$$;

-- As 0072, plus the blocker's mask on the rows (the reader's own row is never masked). The admin's season views read
-- with no player, so nothing is masked there.
CREATE OR REPLACE FUNCTION xp_board_json(target_board text, reader uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH ranked AS NOT MATERIALIZED (
    SELECT b.player_id, b.xp, b.xp_version
    FROM xp_board b JOIN player p ON p.id = b.player_id
    WHERE b.board = target_board AND b.xp > 0 AND p.status = 'active'
  ),
  top AS (
    SELECT r.player_id, r.xp, row_number() OVER (ORDER BY r.xp DESC, r.xp_version) AS place
    FROM (SELECT * FROM ranked ORDER BY xp DESC, xp_version LIMIT 10) r
  ),
  mine AS (
    SELECT m.player_id, m.xp,
           1 + (SELECT count(*) FROM xp_board a WHERE a.board = target_board AND a.xp > 0 AND a.xp > m.xp)
             + (SELECT count(*) FROM xp_board a
                WHERE a.board = target_board AND a.xp > 0 AND a.xp = m.xp AND a.xp_version < m.xp_version)
             - (SELECT count(*) FROM player p
                CROSS JOIN LATERAL (SELECT a.xp, a.xp_version FROM xp_board a
                                    WHERE a.board = target_board AND a.player_id = p.id LIMIT 1) a
                WHERE p.status <> 'active' AND a.xp > 0
                  AND (a.xp > m.xp OR (a.xp = m.xp AND a.xp_version < m.xp_version))) AS place
    FROM ranked m WHERE m.player_id = reader
  )
  SELECT jsonb_build_object(
    'board', target_board,
    'rows', coalesce((SELECT jsonb_agg(xp_board_row(t.player_id, t.place, t.xp)
                                       || jsonb_build_object('isMe', coalesce(t.player_id = reader, false))
                                       || CASE WHEN blocked_by_me(t.player_id)
                                               THEN jsonb_build_object('username', NULL, 'avatar', NULL,
                                                                       'equipment', NULL, 'hidden', true)
                                               ELSE '{}'::jsonb END
                                       ORDER BY t.place)
                      FROM top t), '[]'::jsonb),
    'me', (SELECT xp_board_row(m.player_id, m.place, m.xp) FROM mine m))
$$;

-- ================================================================ word lists and retired names (FR-1779, ADR-432)
-- The console's editor. Every door is for an active admin (QE403 otherwise). A word is folded here (the API folds it
-- first and refuses what cannot be one); the table's CHECK refuses anything but folded letters (WL400). Changes apply at
-- once to sign-up, rename and the marking of player text (FR-1628), which read the same table; adding a word never
-- renames anyone. The audit holds the word (a list entry, not personal data); an un-retire holds no name, since a
-- retired name was a player's.

-- One page of the lists (50, by word), filtered by a folded part of the word, the language and the match.
CREATE FUNCTION console_words(search text, only_language text, only_match text, after_word text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  part text := username_fold(coalesce(btrim(search), ''));
BEGIN
  RETURN jsonb_build_object(
    'words', coalesce((
      SELECT jsonb_agg(jsonb_build_object('word', w.word, 'match', w.match, 'language', w.language,
                                          'addedAt', w.created_at) ORDER BY w.word)
      FROM (SELECT x.* FROM username_word x
            WHERE (part = '' OR position(part IN x.word) > 0)
              AND (only_language IS NULL OR x.language = only_language)
              AND (only_match IS NULL OR x.match = only_match)
              AND (after_word IS NULL OR x.word > after_word)
            ORDER BY x.word LIMIT 50) w), '[]'::jsonb),
    'total', (SELECT count(*) FROM username_word x
              WHERE (part = '' OR position(part IN x.word) > 0)
                AND (only_language IS NULL OR x.language = only_language)
                AND (only_match IS NULL OR x.match = only_match)));
END $$;
REVOKE ALL ON FUNCTION console_words(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_words(text, text, text, text) TO questify_app;

-- Adds a word. Outcomes: added, exists. WL400 for a word the table refuses, a match or a language not in its lists.
CREATE FUNCTION admin_word_add(new_word text, word_match text, word_language text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  folded text := username_fold(btrim(coalesce(new_word, '')));
BEGIN
  BEGIN
    INSERT INTO username_word (word, match, language) VALUES (folded, word_match, word_language);
  EXCEPTION
    WHEN unique_violation THEN
      RETURN 'exists';
    WHEN check_violation OR not_null_violation THEN
      RAISE EXCEPTION 'not a word for the lists' USING ERRCODE = 'WL400';
  END;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'username_word.add', 'username_word', folded,
          jsonb_build_object('match', word_match, 'language', word_language), request);
  RETURN 'added';
END $$;
REVOKE ALL ON FUNCTION admin_word_add(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_word_add(text, text, text, uuid) TO questify_app;

-- Removes a word. Outcomes: removed, not_found.
CREATE FUNCTION admin_word_remove(old_word text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  gone username_word;
BEGIN
  DELETE FROM username_word w WHERE w.word = username_fold(btrim(coalesce(old_word, ''))) RETURNING w.* INTO gone;
  IF gone.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, request_id)
  VALUES ('admin', me, 'username_word.remove', 'username_word', gone.word,
          jsonb_build_object('match', gone.match, 'language', gone.language), request);
  RETURN 'removed';
END $$;
REVOKE ALL ON FUNCTION admin_word_remove(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_word_remove(text, uuid) TO questify_app;

-- One page of the retired names (50, newest first), filtered by a folded part.
CREATE FUNCTION console_retired_usernames(search text, before_fold text) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  part text := username_fold(coalesce(btrim(search), ''));
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('fold', r.fold, 'retiredAt', r.retired_at) ORDER BY r.fold)
    FROM (SELECT x.* FROM username_retired x
          WHERE (part = '' OR position(part IN x.fold) > 0) AND (before_fold IS NULL OR x.fold > before_fold)
          ORDER BY x.fold LIMIT 50) r), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION console_retired_usernames(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_retired_usernames(text, text) TO questify_app;

-- Lets a retired name be taken again. Outcomes: unretired, not_found.
CREATE FUNCTION admin_unretire_username(retired text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
BEGIN
  DELETE FROM username_retired r WHERE r.fold = username_fold(btrim(coalesce(retired, '')));
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, request_id)
  VALUES ('admin', me, 'username_retired.remove', 'username_retired', request);
  RETURN 'unretired';
END $$;
REVOKE ALL ON FUNCTION admin_unretire_username(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_unretire_username(text, uuid) TO questify_app;

-- As 0049, plus: a blocked pair, in either direction, cannot meet; the scanner gets the same not_for_them as for any
-- other reason of the shown player, so nobody learns of a block. Checked before already_met, whose hint names the other.
CREATE OR REPLACE FUNCTION meet_refusal(pass meet_pass, mine enrollment, theirs enrollment, quest_row quest) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  why text;
BEGIN
  IF pass.ended_at IS NOT NULL AND EXISTS (SELECT 1 FROM meeting m WHERE m.pass_id = pass.id) THEN
    RAISE EXCEPTION 'code used' USING ERRCODE = 'QM422', DETAIL = 'used';
  END IF;
  IF pass.ended_at IS NOT NULL OR pass.expires_at <= now() THEN
    RAISE EXCEPTION 'code expired' USING ERRCODE = 'QM422', DETAIL = 'expired';
  END IF;
  PERFORM meet_may_play(mine, quest_row);
  -- The shown player's checks in their own block: whatever fails, only not_for_them leaves it, never their reason.
  BEGIN
    PERFORM meet_may_play(theirs, quest_row);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'not open for the shown player' USING ERRCODE = 'QM403', DETAIL = 'not_for_them';
  END;
  IF EXISTS (SELECT 1 FROM player_block b
             WHERE (b.blocker_id = mine.player_id AND b.blocked_id = theirs.player_id)
                OR (b.blocker_id = theirs.player_id AND b.blocked_id = mine.player_id)) THEN
    RAISE EXCEPTION 'not open for the shown player' USING ERRCODE = 'QM403', DETAIL = 'not_for_them';
  END IF;
  IF EXISTS (SELECT 1 FROM meeting m
             WHERE m.quest_id = quest_row.id
               AND least(m.scanner_enrollment, m.shown_enrollment) = least(mine.id, theirs.id)
               AND greatest(m.scanner_enrollment, m.shown_enrollment) = greatest(mine.id, theirs.id)) THEN
    RAISE EXCEPTION 'already met' USING ERRCODE = 'QM409', DETAIL = 'already_met',
      HINT = coalesce((SELECT p.username FROM player p WHERE p.id = theirs.player_id), '');
  END IF;
  why := meet_caps(mine, quest_row);
  IF why = 'daily_cap' THEN
    RAISE EXCEPTION 'cap reached' USING ERRCODE = 'QM409', DETAIL = why,
      HINT = quest_row.type_config ->> 'dailyCap';
  ELSIF why IS NOT NULL THEN
    RAISE EXCEPTION 'cap reached' USING ERRCODE = 'QM409', DETAIL = why;
  END IF;
  why := meet_caps(theirs, quest_row);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'their cap reached' USING ERRCODE = 'QM409', DETAIL = 'their_' || why;
  END IF;
END $$;
REVOKE ALL ON FUNCTION meet_refusal(meet_pass, enrollment, enrollment, quest) FROM PUBLIC;

-- ================================================================ erasure
-- As 0118, plus the account's blocks in both directions, and the ban's pointer cleared before the action rows go.
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
