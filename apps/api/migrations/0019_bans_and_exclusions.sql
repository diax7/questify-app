-- Bans, the exclusion list and leaving (T-208). Organizers no longer read the player table: they see their players
-- through event_players, which returns what the join card discloses (PD-17), never a birth year or a contact. An
-- enrollment's status changes from the organizer seat only through set_enrollment_ban, which checks the owner and
-- writes the audit entry; the player keeps their own way out (leaving). The exclusion list takes players off the
-- boards (FR-319), in both forms of the ranking rule.

-- ================================================================ organizers read players through one definer only
DROP POLICY player_own ON player;
CREATE POLICY player_own ON player FOR ALL TO questify_app
  USING (id = app_player_id() OR app_is_admin())
  WITH CHECK (id = app_player_id() OR app_is_admin());

-- The event's players for its team (the dashboard's list): a member of the event's organizer within their event
-- limit; in join order, by a keyset over (joined_at, id) read here; an optional username prefix. Named columns only:
-- no player id (it would link a player across events), no birth year, no contact, and nothing about exclusions.
CREATE FUNCTION event_players(target uuid, after_id uuid, page integer, prefix text)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, status text, score bigint, joined_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT n.id, p.username, p.avatar, n.status, n.score, n.joined_at
  FROM event ev
  JOIN enrollment n ON n.event_id = ev.id
  JOIN player p ON p.id = n.player_id
  WHERE ev.id = target
    AND ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope())
    AND (prefix IS NULL OR username_fold(p.username) LIKE
         replace(replace(replace(username_fold(left(prefix, 30)), '\', '\\'), '%', '\%'), '_', '\_') || '%')
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM enrollment c WHERE c.id = after_id AND c.event_id = target)
         OR (n.joined_at, n.id) > (SELECT c.joined_at, c.id FROM enrollment c WHERE c.id = after_id AND c.event_id = target))
  ORDER BY n.joined_at, n.id
  LIMIT least(greatest(page, 1), 100)
$$;
REVOKE ALL ON FUNCTION event_players(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_players(uuid, uuid, integer, text) TO questify_app;

-- ================================================================ status changes: the player's own way out, else definers
CREATE OR REPLACE FUNCTION enrollment_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A wall for the API's own role; the owner connection (migrations, the staff CLI, definers, support work) is trusted.
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF app_is_admin() THEN
      RETURN NEW;
    END IF;
    IF OLD.player_id = app_player_id() AND OLD.status IN ('pending', 'active') AND NEW.status = 'left' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'this change of enrollment status is not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP POLICY enrollment_update ON enrollment;
CREATE POLICY enrollment_update ON enrollment FOR UPDATE TO questify_app
  USING (player_id = app_player_id() OR app_is_admin())
  WITH CHECK (player_id = app_player_id() OR app_is_admin());

-- Ban or lift a ban (FR-321, FR-1605), by the event organizer's owner. Outcomes: changed, unchanged (already so),
-- not_found (no such enrollment in this event, or not the caller's to see), not_owner, not_allowed (a removed player).
-- A player who left can be banned, so leaving never dodges a ban; a lift makes them active (the owner's lift is the
-- approval, for a private event too). The ledger is untouched: the record stays (FR-321).
CREATE FUNCTION set_enrollment_ban(target_event uuid, target uuid, banned boolean, request uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := app_organizer_id();
  row_found enrollment;
  wanted text;
BEGIN
  IF banned IS NULL THEN
    RAISE EXCEPTION 'banned must be true or false' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT n.* INTO row_found FROM enrollment n JOIN event ev ON ev.id = n.event_id
  WHERE n.id = target AND n.event_id = target_event
    AND ev.organizer_id = org AND in_event_scope(ev.id, app_event_scope())
  FOR UPDATE OF n;
  IF row_found.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT app_is_owner(org) THEN
    RETURN 'not_owner';
  END IF;
  IF row_found.status = 'removed' THEN
    RETURN 'not_allowed';
  END IF;
  wanted := CASE WHEN banned THEN 'banned' ELSE 'active' END;
  IF row_found.status = wanted OR (NOT banned AND row_found.status <> 'banned') THEN
    RETURN 'unchanged';
  END IF;
  UPDATE enrollment SET status = wanted WHERE id = row_found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), org, target_event,
          CASE WHEN banned THEN 'event.player_ban' ELSE 'event.player_unban' END, 'enrollment', target::text,
          jsonb_build_object('status', row_found.status), jsonb_build_object('status', wanted), request);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION set_enrollment_ban(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_enrollment_ban(uuid, uuid, boolean, uuid) TO questify_app;

-- ================================================================ the exclusion list (FR-319)
-- Phones (E.164, the Saudi mobiles sign-in takes) and email domains (exact: company.com does not cover
-- mail.company.com) that never appear on the event's boards; they still play (F-111). At most 500 an event.
CREATE TABLE event_exclusion (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('phone', 'email_domain')),
  value        text NOT NULL,
  -- Who added it is also in the audit entry, which outlives a deleted staff account.
  created_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, kind, value),
  CHECK (kind <> 'phone' OR value ~ '^\+9665[0-9]{8}$'),
  CHECK (kind <> 'email_domain'
         OR (value = lower(value) AND length(value) <= 253
             AND value ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$')),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE event_exclusion ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_exclusion FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_exclusion FROM PUBLIC;
CREATE POLICY event_exclusion_read ON event_exclusion FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
-- Read by the event's team; written only by the definers below.
GRANT SELECT ON event_exclusion TO questify_app;

-- Adds an entry (owner only); a duplicate answers the entry already there. Outcomes: added, existing, not_found,
-- not_owner, full. The event row is locked first, so two adds at 499 cannot both pass the cap. The audit entry names
-- the kind, never the value: a phone number is personal data.
CREATE FUNCTION add_exclusion(target_event uuid, entry_kind text, entry_value text, request uuid)
  RETURNS TABLE (outcome text, id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := app_organizer_id();
  found_event uuid;
  made uuid;
BEGIN
  SELECT ev.id INTO found_event FROM event ev
  WHERE ev.id = target_event AND ev.organizer_id = org AND in_event_scope(ev.id, app_event_scope())
  -- Serializes two adds without blocking the event's foreign-key inserts (scans and joins take FOR KEY SHARE).
  FOR NO KEY UPDATE;
  IF found_event IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid;
    RETURN;
  END IF;
  IF NOT app_is_owner(org) THEN
    RETURN QUERY SELECT 'not_owner'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT x.id INTO made FROM event_exclusion x
  WHERE x.event_id = target_event AND x.kind = entry_kind AND x.value = entry_value;
  IF made IS NOT NULL THEN
    RETURN QUERY SELECT 'existing'::text, made;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM event_exclusion x WHERE x.event_id = target_event) >= 500 THEN
    RETURN QUERY SELECT 'full'::text, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by)
  VALUES (org, target_event, entry_kind, entry_value, app_staff_user_id())
  RETURNING event_exclusion.id INTO made;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), org, target_event, 'event.exclusion_add', 'event_exclusion', made::text,
          jsonb_build_object('kind', entry_kind), request);
  RETURN QUERY SELECT 'added'::text, made;
END $$;
REVOKE ALL ON FUNCTION add_exclusion(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_exclusion(uuid, text, text, uuid) TO questify_app;

-- Removes an entry (owner only). Outcomes: removed, not_found (no such entry in this event, or not the caller's to
-- see: one answer), not_owner.
CREATE FUNCTION remove_exclusion(target_event uuid, target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := app_organizer_id();
  gone event_exclusion;
BEGIN
  SELECT x.* INTO gone FROM event_exclusion x
  WHERE x.id = target AND x.event_id = target_event
    AND x.organizer_id = org AND in_event_scope(x.event_id, app_event_scope());
  IF gone.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT app_is_owner(org) THEN
    RETURN 'not_owner';
  END IF;
  DELETE FROM event_exclusion WHERE id = gone.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES ('staff', app_staff_user_id(), org, target_event, 'event.exclusion_remove', 'event_exclusion', target::text,
          jsonb_build_object('kind', gone.kind), request);
  RETURN 'removed';
END $$;
REVOKE ALL ON FUNCTION remove_exclusion(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_exclusion(uuid, uuid, uuid) TO questify_app;

-- ================================================================ excluded players are not ranked
-- Whether a player's phone or email domain is on the event's list (the row form; the set form below inlines it).
CREATE FUNCTION excluded_from_event(target_event uuid, target_player uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM player_contact pc JOIN event_exclusion x ON x.event_id = target_event
    WHERE pc.player_id = target_player
      AND ((x.kind = 'phone' AND x.value = pc.phone_e164)
           OR (x.kind = 'email_domain' AND x.value = split_part(pc.email, '@', 2))))
$$;
REVOKE ALL ON FUNCTION excluded_from_event(uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION ranking_eligible(target enrollment) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT target.status = 'active' AND target.score > 0 AND target.score_version IS NOT NULL
    AND EXISTS (SELECT 1 FROM player p WHERE p.id = target.player_id AND p.status = 'active')
    AND target.player_id NOT IN (SELECT organizer_team_players(target.organizer_id))
    AND NOT excluded_from_event(target.event_id, target.player_id)
$$;

-- The event's excluded players are found by two equality joins (phone, email domain) that hash, then left-joined like
-- the team: 100 entries at 20,000 players cost about as much as the team test.
CREATE OR REPLACE FUNCTION ranked_enrollments(target uuid)
  RETURNS TABLE (id uuid, player_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE AS $$
  WITH listed AS (
    SELECT e.player_id, pc.phone_e164, split_part(pc.email, '@', 2) AS domain
    FROM enrollment e JOIN player_contact pc ON pc.player_id = e.player_id
    WHERE e.event_id = target AND e.score > 0 AND e.score_version IS NOT NULL
  ), excluded AS (
    SELECT l.player_id FROM listed l
    JOIN event_exclusion x ON x.event_id = target AND x.kind = 'phone' AND x.value = l.phone_e164
    UNION
    SELECT l.player_id FROM listed l
    JOIN event_exclusion x ON x.event_id = target AND x.kind = 'email_domain' AND x.value = l.domain
  )
  SELECT e.id, e.player_id, e.score, e.score_version,
         e.status = 'active' AND p.status = 'active' AND team.player_id IS NULL AND gone.player_id IS NULL
  FROM enrollment e
  JOIN player p ON p.id = e.player_id
  LEFT JOIN (SELECT DISTINCT t.player_id
             FROM event ev, LATERAL organizer_team_players(ev.organizer_id) AS t(player_id)
             WHERE ev.id = target) team ON team.player_id = e.player_id
  LEFT JOIN excluded gone ON gone.player_id = e.player_id
  WHERE e.event_id = target AND e.score > 0 AND e.score_version IS NOT NULL
$$;

-- A list change can move people on or off the board: mark the event. Triggers write the mark themselves:
-- mark_ranking_repair marks only for the system or a player, and these changes come from the organizer seat.
CREATE FUNCTION mark_ranking_on_exclusion() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- An event being deleted takes its list with it, and needs no mark.
  INSERT INTO ranking_repair (event_id)
  SELECT ev.id FROM event ev WHERE ev.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mark_ranking_on_exclusion() FROM PUBLIC;
CREATE TRIGGER mark_ranking_on_exclusion AFTER INSERT OR DELETE ON event_exclusion
  FOR EACH ROW EXECUTE FUNCTION mark_ranking_on_exclusion();

-- A status change marks its event whoever made it: through mark_ranking_repair, a ban from the organizer seat
-- (set_enrollment_ban) left no mark, and the board kept the name until the next backstop rebuild.
CREATE OR REPLACE FUNCTION mark_ranking_on_enrollment() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO ranking_repair (event_id) VALUES (NEW.event_id)
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN NEW;
END $$;

-- A changed phone can now move a rank too, not only a changed email.
DROP TRIGGER mark_ranking_on_contact ON player_contact;
CREATE TRIGGER mark_ranking_on_contact AFTER UPDATE OF email, phone_e164 ON player_contact
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email OR OLD.phone_e164 IS DISTINCT FROM NEW.phone_e164)
  EXECUTE FUNCTION mark_ranking_on_contact();
