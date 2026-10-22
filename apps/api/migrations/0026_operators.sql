-- Operators, My QR and the station scan (T-204, T-205; ADR-057, ADR-137). An operator is a player with an assignment
-- in one event. Owners invite them by a personal QR or by email; the invite token is signed by the API and never
-- stored. Every write goes through a definer: forced row-level security and read grants only. One completion engine:
-- `record_completion` serves the player's own scan and the operator's station scan.

-- ================================================================ quest verification methods (FR-301)
-- A scan quest is completed by the player scanning the quest's QR, by staff scanning the player's My QR, or both; a
-- typed-code quest has its code and no method here.
ALTER TABLE quest ADD COLUMN verification text[];
UPDATE quest SET verification = CASE WHEN type = 'scan_qr' THEN ARRAY['quest_qr'] ELSE ARRAY[]::text[] END;

CREATE FUNCTION quest_verification_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification IS NULL THEN
    NEW.verification := CASE WHEN NEW.type = 'scan_qr' THEN ARRAY['quest_qr'] ELSE ARRAY[]::text[] END;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_verification_default() FROM PUBLIC;
CREATE TRIGGER quest_verification_default BEFORE INSERT ON quest
  FOR EACH ROW EXECUTE FUNCTION quest_verification_default();

ALTER TABLE quest ALTER COLUMN verification SET NOT NULL;
ALTER TABLE quest ADD CONSTRAINT quest_verification_known CHECK (
  verification <@ ARRAY['quest_qr', 'my_qr']
  AND (type <> 'scan_qr' OR cardinality(verification) >= 1)
  AND (type = 'scan_qr' OR cardinality(verification) = 0));
GRANT INSERT (verification), UPDATE (verification) ON quest TO questify_app;

-- ================================================================ My QR (ADR-137): a fixed code with a version
-- The code is the player id and this version, signed by the API. A reset raises the version: every earlier code stops.
ALTER TABLE player ADD COLUMN my_qr_version integer NOT NULL DEFAULT 1 CHECK (my_qr_version >= 1);

-- ================================================================ operators
CREATE TABLE staff_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  player_id    uuid NOT NULL REFERENCES player (id),
  -- FR-908: all on by default; the owner turns any off.
  abilities    text[] NOT NULL DEFAULT ARRAY['scan_quests', 'award', 'hand_over', 'review', 'help_desk', 'write_nfc',
                                             'show_rotating_qr']
    CONSTRAINT staff_assignment_abilities_known CHECK (abilities <@ ARRAY['scan_quests', 'award', 'hand_over',
                                                                          'review', 'help_desk', 'write_nfc',
                                                                          'show_rotating_qr']),
  -- FR-906: an operator plays the event they staff only when the owner allows it.
  can_play     boolean NOT NULL DEFAULT false,
  invite_id    uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, player_id),
  UNIQUE (id, event_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX staff_assignment_player_idx ON staff_assignment (player_id);

-- FR-909: the quests an operator is limited to. No rows: every quest.
CREATE TABLE staff_assignment_quest (
  assignment_id uuid NOT NULL,
  event_id      uuid NOT NULL,
  quest_id      uuid NOT NULL,
  PRIMARY KEY (assignment_id, quest_id),
  FOREIGN KEY (assignment_id, event_id) REFERENCES staff_assignment (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE
);
CREATE INDEX staff_assignment_quest_quest_idx ON staff_assignment_quest (quest_id);

-- Personal QRs for one named person (FR-902), batches with a preset (FR-1720) and email invites (FR-901, email only).
-- The token is the API's signature over the id: nothing secret is stored, so a personal QR prints again.
CREATE TABLE operator_invite (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('personal', 'email')),
  label        text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  -- Personal data: cleared when the invite is claimed, revoked or expired.
  email        text CHECK (email = lower(email) AND position('@' IN email) > 1 AND length(email) <= 254),
  abilities    text[] NOT NULL CHECK (cardinality(abilities) >= 1 AND abilities <@ ARRAY['scan_quests', 'award',
                                      'hand_over', 'review', 'help_desk', 'write_nfc', 'show_rotating_qr']),
  batch_id     uuid,
  created_by   uuid NOT NULL REFERENCES staff_user (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  claimed_by   uuid REFERENCES player (id),
  claimed_at   timestamptz,
  revoked_at   timestamptz,
  CHECK (kind = 'email' OR email IS NULL),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CHECK (claimed_at IS NULL OR revoked_at IS NULL),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX operator_invite_event_idx ON operator_invite (event_id, created_at);
CREATE INDEX operator_invite_open_email_idx ON operator_invite (expires_at) WHERE email IS NOT NULL;

ALTER TABLE staff_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_assignment_quest ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_assignment_quest FORCE ROW LEVEL SECURITY;
ALTER TABLE operator_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_invite FORCE ROW LEVEL SECURITY;
REVOKE ALL ON staff_assignment, staff_assignment_quest, operator_invite FROM PUBLIC;
GRANT SELECT ON staff_assignment, staff_assignment_quest, operator_invite TO questify_app;

CREATE POLICY staff_assignment_read ON staff_assignment FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR app_is_admin() OR player_id = app_player_id());
CREATE POLICY staff_assignment_quest_read ON staff_assignment_quest FOR SELECT TO questify_app
  USING (assignment_id IN (SELECT id FROM staff_assignment));
CREATE POLICY operator_invite_read ON operator_invite FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- ================================================================ the ledger learns operators
ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check CHECK (method IN ('qr', 'code', 'my_qr'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_actor_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_actor_check CHECK (actor IN ('player', 'system', 'operator'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_operator_named CHECK ((actor = 'operator') = (operator_id IS NOT NULL));
-- Operators only scan quests here; manual awards (T-207) widen this.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_operator_quests_only CHECK (actor <> 'operator' OR kind = 'quest');
-- The station's counts and the repeat-scan guard.
CREATE INDEX ledger_entry_operator_idx ON ledger_entry (operator_id, quest_id, created_at) WHERE operator_id IS NOT NULL;

-- FR-906 in one place: an operator the owner has not allowed to play earns and spends nothing in that event, whoever
-- scans and whatever the path (their own scan, a colleague's station, the shop).
CREATE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind IN ('quest', 'redeem') AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_operator_play_guard() FROM PUBLIC;
CREATE TRIGGER ledger_operator_play_guard BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_operator_play_guard();

-- ================================================================ operators are off every board (FR-318)
CREATE OR REPLACE FUNCTION ranking_eligible(target enrollment) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT target.status = 'active' AND target.score > 0 AND target.score_version IS NOT NULL
    AND EXISTS (SELECT 1 FROM player p WHERE p.id = target.player_id AND p.status = 'active')
    AND target.player_id NOT IN (SELECT organizer_team_players(target.organizer_id))
    AND NOT excluded_from_event(target.event_id, target.player_id)
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                    WHERE sa.event_id = target.event_id AND sa.player_id = target.player_id)
$$;

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
           AND staff.player_id IS NULL
  FROM enrollment e
  JOIN player p ON p.id = e.player_id
  LEFT JOIN (SELECT DISTINCT t.player_id
             FROM event ev, LATERAL organizer_team_players(ev.organizer_id) AS t(player_id)
             WHERE ev.id = target) team ON team.player_id = e.player_id
  LEFT JOIN excluded gone ON gone.player_id = e.player_id
  LEFT JOIN staff_assignment staff ON staff.event_id = target AND staff.player_id = e.player_id
  WHERE e.event_id = target AND e.score > 0 AND e.score_version IS NOT NULL
$$;

CREATE FUNCTION mark_ranking_on_assignment() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- An event being deleted takes its operators with it, and needs no mark.
  INSERT INTO ranking_repair (event_id)
  SELECT ev.id FROM event ev WHERE ev.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.event_id ELSE NEW.event_id END
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mark_ranking_on_assignment() FROM PUBLIC;
CREATE TRIGGER mark_ranking_on_assignment AFTER INSERT OR DELETE ON staff_assignment
  FOR EACH ROW EXECUTE FUNCTION mark_ranking_on_assignment();

-- ================================================================ one completion engine
-- Every rule of a completion, for `who`, under a lock on their enrollment. Not executable by questify_app: it is
-- reached only through complete_quest (the player's own scan) and operator_complete_quest (the station). `operator`
-- is the scanning operator's player id, or NULL. Refusals raise:
--   QC404 quest not found or not enrolled            QK422 the key was used for another quest, method or operator
--   QC403 enrollment not active (DETAIL: its status) QN403 quest not open (DETAIL: event_not_live|hidden|not_started|ended)
--   QV422 bad proof (DETAIL: wrong_method|old|wrong_code)  QD409 cap reached, or the same operator scanned this player
--   QP403 (the ledger guard) an operator who may not play     at this quest under 10 seconds ago (DETAIL: the cap)
CREATE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer, typed_code text,
                                  request_key text, device uuid, operator uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row  quest%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  earlier    quest_completion%ROWTYPE;
  earlier_by uuid;
  status_now text;
  done_count integer;
  made       bigint;
BEGIN
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO enrolled FROM enrollment WHERE event_id = quest_row.event_id AND player_id = who FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;

  SELECT * INTO earlier FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.idempotency_key = request_key;
  IF FOUND THEN
    SELECT l.operator_id INTO earlier_by FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    IF earlier.quest_id <> target OR earlier.method <> proof_method OR earlier_by IS DISTINCT FROM operator THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, l.score_delta, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    RETURN;
  END IF;

  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT event_status_now(e.status, e.starts_at, e.ends_at) INTO status_now FROM event e WHERE e.id = quest_row.event_id;
  IF status_now <> 'live' THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF NOT quest_row.visible THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  IF quest_row.opens_at IS NOT NULL AND quest_row.opens_at > now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_started';
  END IF;
  IF quest_row.closes_at IS NOT NULL AND quest_row.closes_at <= now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'ended';
  END IF;

  -- FR-301, FR-302: a completion only through a method the quest has.
  IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr' AND 'quest_qr' = ANY (quest_row.verification))
          OR (quest_row.type = 'scan_qr' AND proof_method = 'my_qr' AND 'my_qr' = ANY (quest_row.verification))
          OR (quest_row.type = 'enter_code' AND proof_method = 'code')) THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
  END IF;
  IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
  END IF;
  IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
  END IF;

  -- A fixed My QR held up at a station is read again and again: one completion per operator, player and quest in any
  -- 10 seconds, whatever the repeat cap (the app also ignores the same code for 5 seconds).
  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, done_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NULL THEN 'player' ELSE 'operator' END, operator);

  RETURN QUERY SELECT made, quest_row.points::bigint, done_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION record_completion(uuid, uuid, text, integer, text, text, uuid, uuid) FROM PUBLIC;

-- The player's own scan or typed code: the caller is the request's player, never an argument.
CREATE OR REPLACE FUNCTION complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
                                          request_key text, device uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- My QR is the operator's method only.
  IF proof_method IS NULL OR proof_method NOT IN ('qr', 'code') THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
  END IF;
  RETURN QUERY SELECT * FROM record_completion(target, me, proof_method, proof_version, typed_code, request_key, device,
                                               NULL);
END $$;

-- The station scan (FR-923): the caller is an operator of the quest's event with the scan ability, inside their quest
-- limit; the scanned code names the player and their My QR version. The assignment is read FOR SHARE, so a removal
-- waits for a scan in flight and every later scan is refused (FR-905). The station phone is not the player's device:
-- no device id is stored; the ledger's operator_id says who scanned. Refusals beyond record_completion's:
--   OP403 not an operator of this event   OA403 the scan ability is off   OS403 outside the quest limit
--   OY409 the operator's own code         OM422 not the player's current My QR version
--   OQ404 no such quest (QC404 then means the scanned player is not in the event)
CREATE FUNCTION operator_complete_quest(target uuid, scanned uuid, scanned_version integer, request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  assignment staff_assignment%ROWTYPE;
  current    integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'OQ404';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = quest_row.event_id AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id)
     AND NOT EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id AND q.quest_id = target)
  THEN
    RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
  END IF;
  IF scanned = me THEN
    RAISE EXCEPTION 'an operator cannot scan their own code' USING ERRCODE = 'OY409';
  END IF;
  SELECT p.my_qr_version INTO current FROM player p WHERE p.id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF current IS DISTINCT FROM scanned_version THEN
    RAISE EXCEPTION 'an earlier My QR' USING ERRCODE = 'OM422';
  END IF;
  RETURN QUERY SELECT * FROM record_completion(target, scanned, 'my_qr', NULL, NULL, request_key, NULL, me);
END $$;
REVOKE ALL ON FUNCTION operator_complete_quest(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_complete_quest(uuid, uuid, integer, text) TO questify_app;

-- Who the station just scanned, for its result screen: only for an operator of the quest's event, and only a player
-- who joined that event (any status). Nobody else's name leaves this function.
CREATE FUNCTION operator_scan_subject(target uuid, scanned uuid)
  RETURNS TABLE (username text, avatar text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.username, p.avatar
  FROM quest q
  JOIN staff_assignment sa ON sa.event_id = q.event_id AND sa.player_id = app_player_id()
  JOIN enrollment e ON e.event_id = q.event_id AND e.player_id = scanned
  JOIN player p ON p.id = scanned
  WHERE q.id = target
$$;
REVOKE ALL ON FUNCTION operator_scan_subject(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_scan_subject(uuid, uuid) TO questify_app;

-- ================================================================ My QR for the caller
CREATE FUNCTION my_qr_version() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.my_qr_version FROM player p WHERE p.id = app_player_id() AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION my_qr_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_qr_version() TO questify_app;

-- The reset count below reads only this.
CREATE INDEX audit_log_qr_reset_idx ON audit_log (target_id, at) WHERE action = 'player.qr_reset';

-- A leaked code stops working (ADR-137): at most 5 resets a day. Returns the new version, or NULL at the limit.
CREATE FUNCTION reset_my_qr(request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  made integer;
BEGIN
  PERFORM 1 FROM player p WHERE p.id = me AND p.status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no active player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (SELECT count(*) FROM audit_log a
      WHERE a.action = 'player.qr_reset' AND a.target_id = me::text AND a.at > now() - interval '1 day') >= 5 THEN
    RETURN NULL;
  END IF;
  UPDATE player SET my_qr_version = my_qr_version + 1 WHERE id = me RETURNING my_qr_version INTO made;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.qr_reset', 'player', me::text, jsonb_build_object('version', made), request);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION reset_my_qr(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_my_qr(uuid) TO questify_app;

-- ================================================================ invites (owner; ADR-057, ADR-138)
-- The event of the caller's organizer within their event limit, or NULL.
CREATE FUNCTION operator_event_of(target_event uuid) RETURNS event
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT ev.* FROM event ev
  WHERE ev.id = target_event AND ((ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope()))
                                  OR app_is_admin())
$$;
REVOKE ALL ON FUNCTION operator_event_of(uuid) FROM PUBLIC;

-- Creates `how_many` invites (1 for an email invite, 1 to 100 for personal QRs) and returns their ids. Refusals:
--   ON404 no such event for the caller   OO403 not the owner   OE409 the event has ended or is archived
--   OI409 more than 500 open invites in the event
CREATE FUNCTION create_operator_invites(target_event uuid, invite_kind text, invite_label text, invite_email text,
                                        invite_abilities text[], how_many integer, request uuid)
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
  IF NOT (app_is_owner(target.organizer_id) OR app_is_admin()) THEN
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
  VALUES (CASE WHEN app_is_admin() THEN 'admin' ELSE 'staff' END, app_staff_user_id(), target.organizer_id, target.id,
          'operator.invite', 'event', target.id::text,
          jsonb_build_object('kind', invite_kind, 'count', how_many, 'abilities', to_jsonb(invite_abilities)), request);
END $$;
REVOKE ALL ON FUNCTION create_operator_invites(uuid, text, text, text, text[], integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_operator_invites(uuid, text, text, text, text[], integer, uuid) TO questify_app;

-- Outcomes: revoked, not_found, not_owner, not_open (already claimed, revoked or expired).
CREATE FUNCTION revoke_operator_invite(target_event uuid, target uuid, request uuid) RETURNS text
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
  IF NOT (app_is_owner(target_ev.organizer_id) OR app_is_admin()) THEN
    RETURN 'not_owner';
  END IF;
  IF found_invite.claimed_at IS NOT NULL OR found_invite.revoked_at IS NOT NULL OR found_invite.expires_at <= now() THEN
    RETURN 'not_open';
  END IF;
  UPDATE operator_invite SET revoked_at = now(), email = NULL WHERE id = found_invite.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES (CASE WHEN app_is_admin() THEN 'admin' ELSE 'staff' END, app_staff_user_id(), target_ev.organizer_id,
          target_ev.id, 'operator.invite_revoke', 'operator_invite', target::text, request);
  RETURN 'revoked';
END $$;
REVOKE ALL ON FUNCTION revoke_operator_invite(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_operator_invite(uuid, uuid, uuid) TO questify_app;

-- What the caller may do with an invite: ok, not_found (unknown or revoked), used, expired (or the event closed),
-- email_mismatch (an email invite for another address), already_operator.
CREATE FUNCTION operator_invite_state(found_invite operator_invite, me uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN found_invite.id IS NULL OR found_invite.revoked_at IS NOT NULL THEN 'not_found'
    WHEN found_invite.claimed_at IS NOT NULL THEN 'used'
    WHEN found_invite.expires_at <= now() OR (SELECT event_status_now(ev.status, ev.starts_at, ev.ends_at)
                                              FROM event ev WHERE ev.id = found_invite.event_id)
                                             NOT IN ('draft', 'scheduled', 'live') THEN 'expired'
    WHEN found_invite.kind = 'email' AND NOT EXISTS (
      SELECT 1 FROM player_contact pc WHERE pc.player_id = me AND pc.email = found_invite.email) THEN 'email_mismatch'
    WHEN EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = found_invite.event_id AND sa.player_id = me)
      THEN 'already_operator'
    ELSE 'ok'
  END
$$;
REVOKE ALL ON FUNCTION operator_invite_state(operator_invite, uuid) FROM PUBLIC;

-- FR-903's confirm screen: the event and the abilities, nothing written.
CREATE FUNCTION preview_operator_invite(target uuid)
  RETURNS TABLE (outcome text, event_id uuid, name_ar text, name_en text, abilities text[])
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  found_invite operator_invite;
  state text;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO found_invite FROM operator_invite i WHERE i.id = target;
  state := operator_invite_state(found_invite, me);
  IF state IN ('not_found', 'used', 'expired') THEN
    RETURN QUERY SELECT state, NULL::uuid, NULL::text, NULL::text, NULL::text[];
    RETURN;
  END IF;
  RETURN QUERY SELECT state, ev.id, ev.name_ar, ev.name_en, found_invite.abilities
    FROM event ev WHERE ev.id = found_invite.event_id;
END $$;
REVOKE ALL ON FUNCTION preview_operator_invite(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION preview_operator_invite(uuid) TO questify_app;

-- The caller becomes an operator of the invite's event (FR-903). One claim per invite: the row lock makes a second
-- claimer see it used. Already an operator there: the invite stays open for someone else.
CREATE FUNCTION claim_operator_invite(target uuid, request uuid)
  RETURNS TABLE (outcome text, event_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  found_invite operator_invite;
  state text;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO found_invite FROM operator_invite i WHERE i.id = target FOR UPDATE;
  state := operator_invite_state(found_invite, me);
  IF state <> 'ok' THEN
    RETURN QUERY SELECT state, CASE WHEN state IN ('email_mismatch', 'already_operator') THEN found_invite.event_id END;
    RETURN;
  END IF;
  INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, invite_id)
  VALUES (found_invite.organizer_id, found_invite.event_id, me, found_invite.abilities, found_invite.id)
  ON CONFLICT ON CONSTRAINT staff_assignment_event_id_player_id_key DO NOTHING;
  -- Two invites of one event claimed at once by one person: the second leaves its invite open.
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'already_operator'::text, found_invite.event_id;
    RETURN;
  END IF;
  UPDATE operator_invite SET claimed_by = me, claimed_at = now(), email = NULL WHERE id = found_invite.id;
  INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('system', found_invite.organizer_id, found_invite.event_id, 'operator.claim', 'operator_invite',
          found_invite.id::text, jsonb_build_object('player', me), request);
  RETURN QUERY SELECT 'claimed'::text, found_invite.event_id;
END $$;
REVOKE ALL ON FUNCTION claim_operator_invite(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_operator_invite(uuid, uuid) TO questify_app;

-- Expired invites keep no email (personal data).
CREATE FUNCTION sweep_operator_invites() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH cleared AS (
    UPDATE operator_invite SET email = NULL WHERE email IS NOT NULL AND expires_at <= now() RETURNING 1
  ) SELECT count(*)::integer FROM cleared
$$;
REVOKE ALL ON FUNCTION sweep_operator_invites() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_operator_invites() TO questify_app;

-- ================================================================ managing operators (owner)
-- Outcomes: changed, unchanged, not_found, not_owner, bad_quest (a quest of another event).
CREATE FUNCTION set_operator(target_event uuid, target uuid, new_abilities text[], new_can_play boolean,
                             new_quests uuid[], request uuid) RETURNS text
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
  IF NOT (app_is_owner(target_ev.organizer_id) OR app_is_admin()) THEN
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
  VALUES (CASE WHEN app_is_admin() THEN 'admin' ELSE 'staff' END, app_staff_user_id(), target_ev.organizer_id,
          target_ev.id, 'operator.update', 'staff_assignment', found.id::text,
          jsonb_build_object('abilities', to_jsonb(found.abilities), 'canPlay', found.can_play, 'quests',
                             to_jsonb(old_quests)),
          jsonb_build_object('abilities', to_jsonb(new_abilities), 'canPlay', new_can_play, 'quests', to_jsonb(wanted)),
          request);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION set_operator(uuid, uuid, text[], boolean, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_operator(uuid, uuid, text[], boolean, uuid[], uuid) TO questify_app;

-- FR-905: removal at once. Outcomes: removed, not_found, not_owner. The points they earned or gave stay.
CREATE FUNCTION remove_operator(target_event uuid, target uuid, request uuid) RETURNS text
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
  IF NOT (app_is_owner(target_ev.organizer_id) OR app_is_admin()) THEN
    RETURN 'not_owner';
  END IF;
  DELETE FROM staff_assignment WHERE id = found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES (CASE WHEN app_is_admin() THEN 'admin' ELSE 'staff' END, app_staff_user_id(), target_ev.organizer_id,
          target_ev.id, 'operator.remove', 'staff_assignment', found.id::text,
          jsonb_build_object('player', found.player_id, 'abilities', to_jsonb(found.abilities)), request);
  RETURN 'removed';
END $$;
REVOKE ALL ON FUNCTION remove_operator(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_operator(uuid, uuid, uuid) TO questify_app;

-- The organizer's list (members read): each operator with their player's username.
CREATE FUNCTION event_operators(target_event uuid)
  RETURNS TABLE (id uuid, player_id uuid, username text, avatar text, abilities text[], can_play boolean,
                 quest_ids uuid[], invite_id uuid, created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT sa.id, sa.player_id, p.username, p.avatar, sa.abilities, sa.can_play,
         coalesce((SELECT array_agg(q.quest_id ORDER BY q.quest_id) FROM staff_assignment_quest q
                   WHERE q.assignment_id = sa.id), '{}'),
         sa.invite_id, sa.created_at
  FROM staff_assignment sa JOIN player p ON p.id = sa.player_id
  WHERE sa.event_id = (operator_event_of(target_event)).id
  ORDER BY sa.created_at, sa.id
$$;
REVOKE ALL ON FUNCTION event_operators(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_operators(uuid) TO questify_app;

-- Claimed invites name who claimed them (FR-904), for members.
CREATE FUNCTION event_operator_invites(target_event uuid)
  RETURNS TABLE (id uuid, kind text, label text, email text, abilities text[], batch_id uuid, created_at timestamptz,
                 expires_at timestamptz, claimed_at timestamptz, revoked_at timestamptz, claimed_by_username text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id, i.kind, i.label, i.email, i.abilities, i.batch_id, i.created_at, i.expires_at, i.claimed_at,
         i.revoked_at, p.username
  FROM operator_invite i LEFT JOIN player p ON p.id = i.claimed_by
  WHERE i.event_id = (operator_event_of(target_event)).id
  ORDER BY i.created_at DESC, i.label
$$;
REVOKE ALL ON FUNCTION event_operator_invites(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_operator_invites(uuid) TO questify_app;

-- ================================================================ the operator's own view
-- The caller's assignments in events that are not archived.
CREATE FUNCTION operator_events()
  RETURNS TABLE (event_id uuid, name_ar text, name_en text, status_now text, starts_at timestamptz,
                 ends_at timestamptz, timezone text, abilities text[], can_play boolean, quest_ids uuid[],
                 enrollment_status text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT ev.id, ev.name_ar, ev.name_en, event_status_now(ev.status, ev.starts_at, ev.ends_at), ev.starts_at,
         ev.ends_at, ev.timezone, sa.abilities, sa.can_play,
         coalesce((SELECT array_agg(q.quest_id ORDER BY q.quest_id) FROM staff_assignment_quest q
                   WHERE q.assignment_id = sa.id), '{}'),
         (SELECT e.status FROM enrollment e WHERE e.event_id = ev.id AND e.player_id = sa.player_id)
  FROM staff_assignment sa JOIN event ev ON ev.id = sa.event_id
  WHERE sa.player_id = app_player_id() AND ev.status <> 'archived'
  ORDER BY ev.starts_at NULLS LAST, ev.id
$$;
REVOKE ALL ON FUNCTION operator_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_events() TO questify_app;

-- FR-921: the stations the caller may pick (scan quests with My QR, inside their limit) and how many players this
-- operator completed at each, today (the event's day, FR-1714) and in all. Raises OP403 for a non-operator.
CREATE FUNCTION operator_stations(target_event uuid)
  RETURNS TABLE (quest_id uuid, title_ar text, title_en text, points integer, visible boolean, done_today bigint,
                 done_total bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
  ev event;
  day_offset interval;
BEGIN
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event;
  day_offset := make_interval(hours => ev.day_start_hour);
  RETURN QUERY
  SELECT q.id, q.title_ar, q.title_en, q.points, q.visible,
         count(l.id) FILTER (WHERE ((l.created_at AT TIME ZONE ev.timezone) - day_offset)::date
                                   = ((now() AT TIME ZONE ev.timezone) - day_offset)::date),
         count(l.id)
  FROM quest q
  LEFT JOIN category c ON c.id = q.category_id
  LEFT JOIN ledger_entry l ON l.operator_id = me AND l.quest_id = q.id AND l.kind = 'quest'
  WHERE q.event_id = target_event AND q.type = 'scan_qr' AND 'my_qr' = ANY (q.verification)
    AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
         OR q.id IN (SELECT s.quest_id FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id))
  GROUP BY q.id, c.position
  ORDER BY c.position NULLS LAST, q.position, q.id;
END $$;
REVOKE ALL ON FUNCTION operator_stations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_stations(uuid) TO questify_app;

-- FR-907: an operator the owner allows to play joins as an active player, whatever the event's access type (the owner
-- chose them). Outcomes: joined, already, not_allowed (may not play, or a banned or removed record), ended.
ALTER TABLE enrollment DROP CONSTRAINT enrollment_joined_via_check;
ALTER TABLE enrollment ADD CONSTRAINT enrollment_joined_via_check
  CHECK (joined_via IN ('code', 'qr', 'link', 'public_list', 'operator'));

CREATE FUNCTION enroll_operator(target_event uuid, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  ev event;
  assignment staff_assignment%ROWTYPE;
  row_found enrollment;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me FOR SHARE;
  IF NOT FOUND OR NOT assignment.can_play THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (ev.organizer_id, ev.id, me, 'active', card, 'operator')
  ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
  RETURNING en.* INTO row_found;
  IF row_found.id IS NOT NULL THEN
    RETURN QUERY SELECT 'joined'::text, row_found.id;
    RETURN;
  END IF;
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me FOR UPDATE;
  IF row_found.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id;
  ELSIF row_found.status IN ('left', 'pending') THEN
    UPDATE enrollment en SET status = 'active', card_version = card, joined_via = 'operator', joined_at = now()
    WHERE en.id = row_found.id;
    RETURN QUERY SELECT 'joined'::text, row_found.id;
  ELSE
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION enroll_operator(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enroll_operator(uuid, text) TO questify_app;

-- ================================================================ the Quests tab shows how each quest is verified
-- A quest staff verify by scanning My QR tells the player to show their code (T-205). The return type changes, so the
-- function is dropped and created again, with the same guard, columns and grants as 0022.
DROP FUNCTION member_event_quests(uuid);

CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         (SELECT count(*)::int FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification
  FROM me
  JOIN category c ON c.event_id = target
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;
