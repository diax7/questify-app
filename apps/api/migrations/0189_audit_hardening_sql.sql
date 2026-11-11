-- Audit hardening, the SQL walls (security audit run 1: hunter-tenant 1, 2, 4 and 5; plan
-- docs/plans/2026-11-11-audit-hardening-sql.md). No table, grant, route or string. Each object is restated from its
-- latest definition with its signature, owner and grants unchanged (CREATE OR REPLACE and ALTER POLICY keep them):
--   submitters_of(uuid[])        from 0050  PL/pgSQL now (docs/rules.md), each of its four branches in the event scope
--   stamped_steps(uuid)          from 0045  PL/pgSQL now, in the event scope
--   policy feature_request_read  from 0141  a scoped editor reads its own events' rows only (as event_read, 0008)
--   add_reward_codes             from 0157  the admin branch needs an active admin account (app_admin_id)
--   end_event_early              from 0009  the same, in the gate and the audit's actor; now
--                                           SET search_path = public, pg_temp
--   operator_event_of            from 0026  the same (stays LANGUAGE sql; not a definer)
--   create_operator_invites, revoke_operator_invite, set_operator, remove_operator
--                                from 0026  the same, in the owner gate and the audit's actor
--   preview_device               from 0057  an operator needs `scan_quests` or `show_rotating_qr` (OA403; ADR-824)
--   operator_scan_subject        from 0109  the scanned player only for an operator who may scan this quest: the
--                                           `scan_quests` ability and the quest limit, written as device_paused (0057)
-- 0188 and earlier untouched; 0156 stays reserved.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the builder's guards in the event scope
-- As 0050 (hunter-tenant 1), in PL/pgSQL with the caller's organizer and event scope read once: a scoped editor learns
-- nothing of an event outside the scope.
CREATE OR REPLACE FUNCTION submitters_of(quests uuid[]) RETURNS TABLE (enrollment_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  org   uuid := app_organizer_id();
  scope uuid[] := app_event_scope();
BEGIN
  IF org IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT s.enrollment_id FROM submission s
  WHERE s.quest_id = ANY (quests) AND s.organizer_id = org AND in_event_scope(s.event_id, scope)
  UNION
  SELECT a.enrollment_id FROM quiz_attempt a
  WHERE a.quest_id = ANY (quests) AND a.organizer_id = org AND in_event_scope(a.event_id, scope)
  UNION
  SELECT p.enrollment_id FROM passport_stamp p
  WHERE p.quest_id = ANY (quests) AND p.organizer_id = org AND in_event_scope(p.event_id, scope)
  UNION
  SELECT g.enrollment_id FROM game_round g
  WHERE g.quest_id = ANY (quests) AND g.organizer_id = org AND in_event_scope(g.event_id, scope);
END $$;

-- As 0045, the same way.
CREATE OR REPLACE FUNCTION stamped_steps(target uuid) RETURNS TABLE (step_id uuid)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  org   uuid := app_organizer_id();
  scope uuid[] := app_event_scope();
BEGIN
  IF org IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT DISTINCT p.step_id FROM passport_stamp p
  WHERE p.quest_id = target AND p.organizer_id = org AND in_event_scope(p.event_id, scope);
END $$;

-- ================================================================ Ask Questify requests in the event scope
-- As 0141 (hunter-tenant 2), with the event scope beside the organizer, as event_read (0008).
ALTER POLICY feature_request_read ON feature_request
  USING (app_admin_id() IS NOT NULL
         OR (organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())));

-- ================================================================ the admin flag re-checked (hunter-tenant 4)
-- As 0157, with app_admin_id() IS NOT NULL for app_is_admin(), and the gate read as false when it is NULL: a staff
-- context with no organizer made `item.organizer_id = app_organizer_id()` NULL, and `IF NOT FOUND OR NULL` let it
-- through, so a staff id with no organizer added codes to any reward (true of 0157 too; found while building 0189).
CREATE OR REPLACE FUNCTION add_reward_codes(target uuid, ciphers bytea[], hashes bytea[],
                                            prior_hashes bytea[] DEFAULT '{}')
  RETURNS TABLE (added integer, duplicates integer, stock_total integer, stock_left integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  most     CONSTANT integer := 100000;
  given    integer := coalesce(array_length(ciphers, 1), 0);
  priors   integer := coalesce(array_length(prior_hashes, 1), 0);
  item     reward%ROWTYPE;
  inserted integer;
BEGIN
  IF given = 0 OR given <> coalesce(array_length(hashes, 1), 0) OR (priors <> 0 AND priors <> given) THEN
    RAISE EXCEPTION 'codes, hashes and prior hashes must pair up' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(prior_hashes) AS p (mark) WHERE p.mark IS NULL OR length(p.mark) <> 32) THEN
    RAISE EXCEPTION 'every prior hash is 32 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target;
  IF NOT FOUND OR NOT coalesce(app_admin_id() IS NOT NULL
                               OR (item.organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
                                   AND in_event_scope(item.event_id, app_event_scope())), false) THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  IF item.status <> 'active' THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF item.kind <> 'digital' THEN
    RAISE EXCEPTION 'not a digital reward' USING ERRCODE = 'RD409';
  END IF;
  WITH given_codes AS (
    SELECT u.cipher, u.hash, CASE WHEN priors = 0 THEN NULL ELSE prior_hashes[u.n] END AS prior
      FROM unnest(ciphers, hashes) WITH ORDINALITY AS u (cipher, hash, n)
  ), fresh AS (
    INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
    SELECT item.organizer_id, item.event_id, item.id, g.cipher, g.hash FROM given_codes g
     WHERE g.prior IS NULL
        OR NOT EXISTS (SELECT 1 FROM reward_code c WHERE c.event_id = item.event_id AND c.code_hash = g.prior)
    ON CONFLICT (event_id, code_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM fresh;
  IF item.stock_total + inserted > most THEN
    RAISE EXCEPTION 'too many codes' USING ERRCODE = 'RC422', DETAIL = (most - item.stock_total)::text;
  END IF;
  UPDATE reward r SET stock_total = r.stock_total + inserted WHERE r.id = target;
  RETURN QUERY SELECT inserted, given - inserted, item.stock_total + inserted,
                      item.stock_total + inserted - item.units_out;
END $$;

-- As 0009, with app_admin_id() IS NOT NULL for app_is_admin() in the gate and the audit's actor, and pg_temp last on
-- the search path as every later definer.
CREATE OR REPLACE FUNCTION end_event_early(target uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_event event%ROWTYPE;
BEGIN
  SELECT * INTO found_event FROM event WHERE id = target FOR UPDATE;
  IF NOT FOUND OR NOT (app_admin_id() IS NOT NULL OR (app_is_owner(found_event.organizer_id)
                                                     AND found_event.organizer_id = app_organizer_id())) THEN
    RAISE EXCEPTION 'only the owner of this event''s organizer can end it' USING ERRCODE = 'QE403';
  END IF;
  IF event_status_now(found_event.status, found_event.starts_at, found_event.ends_at) <> 'live' THEN
    RAISE EXCEPTION 'only a live event can be ended early' USING ERRCODE = 'QE409';
  END IF;
  UPDATE event SET status = 'ended', ends_at = now() WHERE id = target;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES (CASE WHEN app_admin_id() IS NOT NULL THEN 'admin' ELSE 'staff' END,
          app_staff_user_id(), found_event.organizer_id,
          target, 'event.end', 'event', target::text,
          jsonb_build_object('status', found_event.status, 'endsAt', found_event.ends_at),
          jsonb_build_object('status', 'ended', 'endsAt', now()), request);
END $$;

-- As 0026, the same change; the first gate of the four operator definers below and of event_operators and
-- event_operator_invites.
CREATE OR REPLACE FUNCTION operator_event_of(target_event uuid) RETURNS event
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT ev.* FROM event ev
  WHERE ev.id = target_event AND ((ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope()))
                                  OR app_admin_id() IS NOT NULL)
$$;

-- As 0026, the same change in the owner gate and the audit's actor.
CREATE OR REPLACE FUNCTION create_operator_invites(target_event uuid, invite_kind text, invite_label text,
                                                   invite_email text, invite_abilities text[], how_many integer,
                                                   request uuid)
  RETURNS SETOF uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target event;
  batch uuid;
  expiry timestamptz;
  open_count integer;
BEGIN
  target := operator_event_of(target_event);
  IF target.id IS NULL THEN
    RAISE EXCEPTION 'event not found' USING ERRCODE = 'ON404';
  END IF;
  IF NOT (app_is_owner(target.organizer_id) OR app_admin_id() IS NOT NULL) THEN
    RAISE EXCEPTION 'owner only' USING ERRCODE = 'OO403';
  END IF;
  IF event_status_now(target.status, target.starts_at, target.ends_at) NOT IN ('draft', 'scheduled', 'live') THEN
    RAISE EXCEPTION 'event closed' USING ERRCODE = 'OE409';
  END IF;
  IF (invite_kind = 'email') <> (invite_email IS NOT NULL) THEN
    RAISE EXCEPTION 'an email invite needs an email, and only it' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF how_many IS NULL OR how_many < 1 OR how_many > 100 OR (invite_kind = 'email' AND how_many <> 1) THEN
    RAISE EXCEPTION 'how many invites: 1 to 100, one per email' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Serializes invite creation per event so the cap holds.
  PERFORM 1 FROM event WHERE id = target.id FOR NO KEY UPDATE;
  SELECT count(*) INTO open_count FROM operator_invite i
  WHERE i.event_id = target.id AND i.claimed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now();
  IF open_count + how_many > 500 THEN
    RAISE EXCEPTION 'too many open invites' USING ERRCODE = 'OI409';
  END IF;
  expiry := coalesce(target.ends_at, now() + interval '90 days');
  IF invite_kind = 'email' THEN
    expiry := least(expiry, now() + interval '7 days');
  END IF;
  batch := CASE WHEN how_many > 1 THEN gen_random_uuid() END;

  RETURN QUERY
  INSERT INTO operator_invite (organizer_id, event_id, kind, label, email, abilities, batch_id, created_by, expires_at)
  SELECT target.organizer_id, target.id, invite_kind,
         CASE WHEN how_many > 1 THEN btrim(invite_label) || ' ' || n ELSE btrim(invite_label) END,
         invite_email, invite_abilities, batch, app_staff_user_id(), expiry
  FROM generate_series(1, how_many) AS n
  RETURNING id;

  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES (CASE WHEN app_admin_id() IS NOT NULL THEN 'admin' ELSE 'staff' END,
          app_staff_user_id(), target.organizer_id, target.id,
          'operator.invite', 'event', target.id::text,
          jsonb_build_object('kind', invite_kind, 'count', how_many, 'abilities', to_jsonb(invite_abilities)), request);
END $$;

-- As 0026, the same change.
CREATE OR REPLACE FUNCTION revoke_operator_invite(target_event uuid, target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target_ev event;
  found_invite operator_invite;
BEGIN
  target_ev := operator_event_of(target_event);
  IF target_ev.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  SELECT * INTO found_invite FROM operator_invite i WHERE i.id = target AND i.event_id = target_ev.id FOR UPDATE;
  IF found_invite.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT (app_is_owner(target_ev.organizer_id) OR app_admin_id() IS NOT NULL) THEN
    RETURN 'not_owner';
  END IF;
  IF found_invite.claimed_at IS NOT NULL OR found_invite.revoked_at IS NOT NULL OR found_invite.expires_at <= now() THEN
    RETURN 'not_open';
  END IF;
  UPDATE operator_invite SET revoked_at = now(), email = NULL WHERE id = found_invite.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES (CASE WHEN app_admin_id() IS NOT NULL THEN 'admin' ELSE 'staff' END,
          app_staff_user_id(), target_ev.organizer_id,
          target_ev.id, 'operator.invite_revoke', 'operator_invite', target::text, request);
  RETURN 'revoked';
END $$;

-- As 0026, the same change.
CREATE OR REPLACE FUNCTION set_operator(target_event uuid, target uuid, new_abilities text[],
                                        new_can_play boolean, new_quests uuid[], request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target_ev event;
  found staff_assignment;
  old_quests uuid[];
  wanted uuid[];
BEGIN
  target_ev := operator_event_of(target_event);
  IF target_ev.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  SELECT * INTO found FROM staff_assignment sa WHERE sa.id = target AND sa.event_id = target_ev.id FOR UPDATE;
  IF found.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT (app_is_owner(target_ev.organizer_id) OR app_admin_id() IS NOT NULL) THEN
    RETURN 'not_owner';
  END IF;
  IF new_abilities IS NULL OR new_can_play IS NULL OR new_quests IS NULL THEN
    RAISE EXCEPTION 'abilities, may play and quests are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT coalesce(array_agg(DISTINCT q ORDER BY q), '{}') INTO wanted FROM unnest(new_quests) AS q;
  IF (SELECT count(*) FROM quest WHERE id = ANY (wanted) AND event_id = target_ev.id) <> cardinality(wanted) THEN
    RETURN 'bad_quest';
  END IF;
  SELECT coalesce(array_agg(quest_id ORDER BY quest_id), '{}') INTO old_quests
  FROM staff_assignment_quest WHERE assignment_id = found.id;
  IF found.abilities @> new_abilities AND found.abilities <@ new_abilities AND found.can_play = new_can_play
     AND old_quests = wanted THEN
    RETURN 'unchanged';
  END IF;
  UPDATE staff_assignment SET abilities = (SELECT coalesce(array_agg(DISTINCT a ORDER BY a), '{}')
                                           FROM unnest(new_abilities) AS a),
                              can_play = new_can_play
  WHERE id = found.id;
  DELETE FROM staff_assignment_quest WHERE assignment_id = found.id;
  INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id)
  SELECT found.id, target_ev.id, q FROM unnest(wanted) AS q;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES (CASE WHEN app_admin_id() IS NOT NULL THEN 'admin' ELSE 'staff' END,
          app_staff_user_id(), target_ev.organizer_id,
          target_ev.id, 'operator.update', 'staff_assignment', found.id::text,
          jsonb_build_object('abilities', to_jsonb(found.abilities), 'canPlay', found.can_play, 'quests',
                             to_jsonb(old_quests)),
          jsonb_build_object('abilities', to_jsonb(new_abilities), 'canPlay', new_can_play, 'quests', to_jsonb(wanted)),
          request);
  RETURN 'changed';
END $$;

-- As 0026, the same change.
CREATE OR REPLACE FUNCTION remove_operator(target_event uuid, target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target_ev event;
  found staff_assignment;
BEGIN
  target_ev := operator_event_of(target_event);
  IF target_ev.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  SELECT * INTO found FROM staff_assignment sa WHERE sa.id = target AND sa.event_id = target_ev.id FOR UPDATE;
  IF found.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT (app_is_owner(target_ev.organizer_id) OR app_admin_id() IS NOT NULL) THEN
    RETURN 'not_owner';
  END IF;
  DELETE FROM staff_assignment WHERE id = found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES (CASE WHEN app_admin_id() IS NOT NULL THEN 'admin' ELSE 'staff' END,
          app_staff_user_id(), target_ev.organizer_id,
          target_ev.id, 'operator.remove', 'staff_assignment', found.id::text,
          jsonb_build_object('player', found.player_id, 'abilities', to_jsonb(found.abilities)), request);
  RETURN 'removed';
END $$;

-- ================================================================ seeing needs the ability acting needs (ADR-824)
-- hunter-tenant 5.
-- As 0057, an operator previews a code only with an ability that pairs something (`scan_quests` a kiosk,
-- `show_rotating_qr` a station): OA403 otherwise. The claim still checks the kind's own ability.
CREATE OR REPLACE FUNCTION preview_device(code bytea, target_event uuid)
  RETURNS TABLE (kind text, client text, expires_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event%ROWTYPE;
  req device_request%ROWTYPE;
BEGIN
  IF app_player_id() IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM staff_assignment sa
                   WHERE sa.event_id = target_event AND sa.player_id = app_player_id()) THEN
      RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM staff_assignment sa
                   WHERE sa.event_id = target_event AND sa.player_id = app_player_id()
                     AND sa.abilities && ARRAY['scan_quests', 'show_rotating_qr']) THEN
      RAISE EXCEPTION 'pairing is off for this operator' USING ERRCODE = 'OA403';
    END IF;
    SELECT * INTO ev FROM event e WHERE e.id = target_event;
  ELSE
    ev := award_event_of(target_event);
  END IF;
  req := device_request_of(code, ev, false);
  RETURN QUERY SELECT req.kind, req.client, req.expires_at;
END $$;

-- As 0109, the scanned player only for an operator who may scan this quest: the `scan_quests` ability, and the quest
-- within their limit when they have one (as device_paused, 0057). A refused ability_off or outside_station scan shows
-- no subject. Stays LANGUAGE sql (its allowlist entry stays).
CREATE OR REPLACE FUNCTION operator_scan_subject(target uuid, scanned uuid)
  RETURNS TABLE (username text, avatar text, full_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.username, p.avatar, staff_full_name(q.event_id, scanned)
  FROM quest q
  JOIN staff_assignment sa ON sa.event_id = q.event_id AND sa.player_id = app_player_id()
                          AND 'scan_quests' = ANY (sa.abilities)
                          AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest l WHERE l.assignment_id = sa.id)
                               OR EXISTS (SELECT 1 FROM staff_assignment_quest l
                                          WHERE l.assignment_id = sa.id AND l.quest_id = q.id))
  JOIN enrollment e ON e.event_id = q.event_id AND e.player_id = scanned
  JOIN player p ON p.id = scanned
  WHERE q.id = target
$$;
