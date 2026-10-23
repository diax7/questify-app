-- Passport quests (T-304b, ADR-203; plan docs/plans/2026-10-24-t-304b-passport-quests.md). A passport is a quest with
-- 1 to 30 steps, each its own signed code (the API signs and checks it; this file holds the step's version). A player
-- stamps steps in any order with stamp_step; the stamp that reaches the quest's `needed` pays the quest once through
-- pay_completion, under the enrollment lock every payer holds. Deny by default: passport_stamp has no grant; the
-- team writes passport_step under row-level security with column grants, as quests; the definers are the other doors.

-- ================================================================ the type
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known
  CHECK (type IN ('scan_qr', 'enter_code', 'submission', 'vote', 'quiz', 'challenge', 'survey', 'share', 'passport'));
-- Finished once, with a whole `needed` from 1 to 30 (the step cap).
ALTER TABLE quest ADD CONSTRAINT quest_passport_shape CHECK (
  type <> 'passport' OR (repeat_cap = 1 AND coalesce(jsonb_typeof(type_config -> 'needed') = 'number', false)
                         AND (type_config ->> 'needed')::numeric BETWEEN 1 AND 30
                         AND (type_config ->> 'needed')::numeric = trunc((type_config ->> 'needed')::numeric)));
ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport'));

-- ================================================================ the tables
CREATE TABLE passport_step (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizer (id),
  event_id     uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  quest_id     uuid NOT NULL,
  name_ar      text CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en      text CHECK (length(name_en) BETWEEN 1 AND 120),
  position     integer NOT NULL DEFAULT 0,
  -- The version its printed code carries; a regenerated code bumps it (FR-1711).
  qr_version   integer NOT NULL DEFAULT 1 CHECK (qr_version >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  UNIQUE (id, event_id),
  -- NO ACTION, so a draft event's delete cascades through its quests and steps in one statement.
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id)
);
CREATE INDEX passport_step_quest_order ON passport_step (quest_id, position, id);
CREATE INDEX passport_step_event ON passport_step (event_id);

-- One row per player and step. `completion_id` is set on the stamp that paid the passport (its replay reads it back).
-- `device_id` is the app's install id (FR-316): personal data, deleted with the account.
CREATE TABLE passport_stamp (
  organizer_id    uuid NOT NULL,
  event_id        uuid NOT NULL,
  enrollment_id   uuid NOT NULL,
  quest_id        uuid NOT NULL,
  step_id         uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  device_id       uuid,
  completion_id   bigint UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, step_id),
  UNIQUE (enrollment_id, idempotency_key),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (step_id, event_id) REFERENCES passport_step (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX passport_stamp_quest_idx ON passport_stamp (quest_id);
CREATE INDEX passport_stamp_step_idx ON passport_stamp (step_id);
CREATE INDEX passport_stamp_completion_idx ON passport_stamp (completion_id) WHERE completion_id IS NOT NULL;
ALTER TABLE passport_stamp ENABLE ROW LEVEL SECURITY;
ALTER TABLE passport_stamp FORCE ROW LEVEL SECURITY;
REVOKE ALL ON passport_stamp FROM PUBLIC;

-- ================================================================ who may do what with steps (as quests, 0010)
CREATE TRIGGER passport_step_organizer BEFORE INSERT ON passport_step
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();
CREATE TRIGGER passport_step_closed_guard BEFORE INSERT OR UPDATE OR DELETE ON passport_step
  FOR EACH ROW EXECUTE FUNCTION quest_closed_guard();
ALTER TABLE passport_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE passport_step FORCE ROW LEVEL SECURITY;
REVOKE ALL ON passport_step FROM PUBLIC;
GRANT SELECT, DELETE ON passport_step TO questify_app;
GRANT INSERT (event_id, quest_id, name_ar, name_en, position) ON passport_step TO questify_app;
GRANT UPDATE (name_ar, name_en, position, qr_version) ON passport_step TO questify_app;
CREATE POLICY passport_step_member ON passport_step FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- A step belongs to a passport of its own event, at most 30 per passport (QT422), counted under the event's lock.
CREATE FUNCTION passport_step_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('passport_step:' || NEW.quest_id, 0));
  -- A quest that is not there is left to the foreign key and the row-level policy.
  IF EXISTS (SELECT 1 FROM quest q WHERE q.id = NEW.quest_id AND q.type <> 'passport') THEN
    RAISE EXCEPTION 'steps belong to a passport quest' USING ERRCODE = 'QT422', DETAIL = 'passport';
  END IF;
  IF (SELECT count(*) FROM passport_step s WHERE s.quest_id = NEW.quest_id) >= 30 THEN
    RAISE EXCEPTION 'a passport has at most 30 steps' USING ERRCODE = 'QT422', DETAIL = 'steps';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION passport_step_check() FROM PUBLIC;
CREATE TRIGGER passport_step_check BEFORE INSERT ON passport_step
  FOR EACH ROW EXECUTE FUNCTION passport_step_check();

-- ================================================================ the passport's shape (ADR-203)
-- Once players stamped it, a passport's `needed` may rise but never fall (QL409): lowering it would leave players at
-- the new count unpaid, with nothing left to scan. The type is fixed by the column grants; this holds it for the owner.
CREATE FUNCTION quest_lock_passport() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.type IS DISTINCT FROM OLD.type AND EXISTS (SELECT 1 FROM passport_step s WHERE s.quest_id = OLD.id) THEN
    RAISE EXCEPTION 'a passport with steps stays a passport' USING ERRCODE = 'QL409';
  END IF;
  IF NEW.type = 'passport' AND (NEW.type_config ->> 'needed')::numeric < (OLD.type_config ->> 'needed')::numeric
     AND EXISTS (SELECT 1 FROM passport_stamp p WHERE p.quest_id = OLD.id) THEN
    RAISE EXCEPTION 'players stamped this passport: its needed count cannot fall' USING ERRCODE = 'QL409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_lock_passport() FROM PUBLIC;
CREATE TRIGGER quest_lock_passport BEFORE UPDATE OF type, type_config ON quest
  FOR EACH ROW WHEN (OLD.type = 'passport') EXECUTE FUNCTION quest_lock_passport();

-- A passport always has at least `needed` steps (so a visible one is never empty). Checked at commit, so a quest and
-- its steps are written in one transaction in any order, and a quest's delete takes its steps with it untroubled: a
-- quest no longer there passes.
CREATE FUNCTION passport_shape_check(target uuid) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM quest q
             WHERE q.id = target AND q.type = 'passport'
               AND (SELECT count(*) FROM passport_step s WHERE s.quest_id = q.id) < (q.type_config ->> 'needed')::numeric)
  THEN
    RAISE EXCEPTION 'a passport needs at least as many steps as it asks for' USING ERRCODE = 'QT422', DETAIL = 'needed';
  END IF;
END $$;
REVOKE ALL ON FUNCTION passport_shape_check(uuid) FROM PUBLIC;

CREATE FUNCTION quest_passport_steps() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM passport_shape_check(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION quest_passport_steps() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER quest_passport_steps AFTER INSERT OR UPDATE OF type_config ON quest
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.type = 'passport') EXECUTE FUNCTION quest_passport_steps();

CREATE FUNCTION passport_step_shape() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM passport_shape_check(OLD.quest_id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION passport_step_shape() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER passport_step_shape AFTER DELETE ON passport_step
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION passport_step_shape();

-- ================================================================ the team's reads (builder guards)
-- Who played any of these quests (a completion aside): a submission, a quiz attempt or a passport stamp. As 0041.
CREATE OR REPLACE FUNCTION submitters_of(quests uuid[]) RETURNS TABLE (enrollment_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.enrollment_id FROM submission s WHERE s.quest_id = ANY (quests) AND s.organizer_id = app_organizer_id()
  UNION
  SELECT a.enrollment_id FROM quiz_attempt a WHERE a.quest_id = ANY (quests) AND a.organizer_id = app_organizer_id()
  UNION
  SELECT p.enrollment_id FROM passport_stamp p WHERE p.quest_id = ANY (quests) AND p.organizer_id = app_organizer_id()
$$;

-- The steps of this passport someone stamped (they cannot be deleted): the caller's own organizer's only. Ids only.
CREATE FUNCTION stamped_steps(target uuid) RETURNS TABLE (step_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT p.step_id FROM passport_stamp p WHERE p.quest_id = target AND p.organizer_id = app_organizer_id()
$$;
REVOKE ALL ON FUNCTION stamped_steps(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stamped_steps(uuid) TO questify_app;

-- ================================================================ stamping (FR-224, ADR-203)
-- The calling player stamps one step with its printed code's version (the API checked the signature and the step).
-- Steps pay nothing; the stamp that brings the player's stamps to `needed` pays the passport once through
-- pay_completion with the key 'pass:' || quest id. A step stamped before answers the progress with `stamped` false
-- and writes nothing. A replayed key answers as the first time, the paying stamp with its completion.
CREATE FUNCTION stamp_step(target uuid, proof_version integer, request_key text, device uuid)
  RETURNS TABLE (quest_id uuid, completion_id bigint, points bigint, stamped boolean, done integer, needed integer,
                 score bigint, balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  step_row  passport_step%ROWTYPE;
  quest_row quest%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  earlier   passport_stamp%ROWTYPE;
  wanted    integer;
  have      integer;
  paid      bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key LIKE 'sub:%'
     OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO step_row FROM passport_step s WHERE s.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = step_row.quest_id;
  IF quest_row.type <> 'passport' THEN
    RAISE EXCEPTION 'not a passport quest' USING ERRCODE = 'QT422', DETAIL = 'passport';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  wanted := (quest_row.type_config ->> 'needed')::integer;

  SELECT * INTO earlier FROM passport_stamp p WHERE p.enrollment_id = enrolled.id AND p.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.step_id <> target THEN
      RAISE EXCEPTION 'this key was used for another stamp' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT quest_row.id, earlier.completion_id,
                        (SELECT l.score_delta FROM ledger_entry l
                         WHERE l.completion_id = earlier.completion_id AND l.kind = 'quest'),
                        true,
                        (SELECT count(*)::int FROM passport_stamp p
                         WHERE p.enrollment_id = enrolled.id AND p.quest_id = quest_row.id),
                        wanted, n.score, n.balance, true
      FROM enrollment n WHERE n.id = enrolled.id;
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled);
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  IF EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = enrolled.id AND c.quest_id = quest_row.id) THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = '1';
  END IF;
  IF proof_version IS DISTINCT FROM step_row.qr_version THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
  END IF;
  SELECT count(*)::int INTO have FROM passport_stamp p
  WHERE p.enrollment_id = enrolled.id AND p.quest_id = quest_row.id;
  IF EXISTS (SELECT 1 FROM passport_stamp p WHERE p.enrollment_id = enrolled.id AND p.step_id = target) THEN
    RETURN QUERY SELECT quest_row.id, NULL::bigint, NULL::bigint, false, have, wanted, enrolled.score, enrolled.balance,
                        false;
    RETURN;
  END IF;

  have := have + 1;
  IF have >= wanted THEN
    paid := pay_completion(enrolled, quest_row.id, quest_row.points, 'passport', 'pass:' || quest_row.id, NULL, NULL);
  END IF;
  INSERT INTO passport_stamp (organizer_id, event_id, enrollment_id, quest_id, step_id, idempotency_key, device_id,
                              completion_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, quest_row.id, target, request_key, device, paid);
  RETURN QUERY SELECT quest_row.id, paid, CASE WHEN paid IS NOT NULL THEN quest_row.points::bigint END, true, have,
                      wanted, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION stamp_step(uuid, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION stamp_step(uuid, integer, text, uuid) TO questify_app;

-- A passport the caller may see (an active member, the quest visible and in their audience): how many steps it needs
-- and each step, in order, with whether they stamped it. No row otherwise. Never a step's code or version.
CREATE FUNCTION member_passport(target uuid)
  RETURNS TABLE (needed integer, step_id uuid, name_ar text, name_en text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM quest q
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    JOIN category c ON c.id = q.category_id
    WHERE q.id = target AND q.type = 'passport' AND q.visible
      AND in_audience(n.id, c.audience_kind, c.audience_field_id, c.audience_values)
  )
  SELECT (q.type_config ->> 'needed')::int, s.id, s.name_ar, s.name_en,
         EXISTS (SELECT 1 FROM passport_stamp p WHERE p.enrollment_id = me.id AND p.step_id = s.id)
  FROM me
  JOIN quest q ON q.id = target
  JOIN passport_step s ON s.quest_id = q.id
  ORDER BY s.position, s.id
$$;
REVOKE ALL ON FUNCTION member_passport(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_passport(uuid) TO questify_app;

-- ================================================================ the player's read
-- As 0044, with a passport's progress: the steps this player stamped and how many it needs (NULL for other
-- types). The output changed: DROP and CREATE, with the REVOKE and GRANT repeated.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         (SELECT count(*)::int FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification,
         c.order_mode, c.opens_at, c.unlock_after,
         CASE WHEN in_audience(me.id, u.audience_kind, u.audience_field_id, u.audience_values) THEN u.name_ar END,
         CASE WHEN in_audience(me.id, u.audience_kind, u.audience_field_id, u.audience_values) THEN u.name_en END,
         c.completion_bonus,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.category_id = c.id),
         EXISTS (SELECT 1 FROM category_bonus b WHERE b.enrollment_id = me.id AND b.category_id = c.id),
         category_lock(q, me.id),
         CASE WHEN q.type = 'passport' THEN (SELECT count(*)::int FROM passport_stamp p
                                             WHERE p.enrollment_id = me.id AND p.quest_id = q.id) END,
         CASE WHEN q.type = 'passport' THEN (q.type_config ->> 'needed')::int END
  FROM me
  JOIN category c ON c.event_id = target
    AND in_audience(me.id, c.audience_kind, c.audience_field_id, c.audience_values)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ 'pass:' is the passport's own key
-- As 0044, with 'pass:' reserved: only stamp_step pays under it.
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row     quest%ROWTYPE;
  enrolled      enrollment%ROWTYPE;
  earlier       quest_completion%ROWTYPE;
  earlier_by    uuid;
  earlier_staff uuid;
  done_count    integer;
  made          bigint;
  entry         bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
    RAISE EXCEPTION 'this key is reserved' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.event_id IS DISTINCT FROM expected_event THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment WHERE event_id = quest_row.event_id AND player_id = who FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;

  SELECT * INTO earlier FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.idempotency_key = request_key;
  IF FOUND THEN
    SELECT l.operator_id, l.staff_user_id INTO earlier_by, earlier_staff
    FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    IF earlier.quest_id <> target OR earlier.method <> proof_method OR earlier_by IS DISTINCT FROM operator
       OR earlier_staff IS DISTINCT FROM staff THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, l.score_delta, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled, proof_method = 'manual');
  -- A quiz in play pays itself at its end; a manual award now would pay the quest twice (T-302).
  IF proof_method = 'manual' AND quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target AND a.status = 'open') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr' AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'enter_code' AND proof_method = 'code')
            OR (quest_row.type = 'vote' AND proof_method = 'vote')
            OR (quest_row.type = 'survey' AND proof_method = 'survey')
            OR (quest_row.type = 'share' AND proof_method = 'share')) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
    END IF;
    IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
    END IF;
    IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
    END IF;
  END IF;

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
                            completion_id, quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff)
  RETURNING id INTO entry;
  IF proof_method = 'manual' THEN
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason)
    VALUES (entry, enrolled.organizer_id, enrolled.event_id, clean_reason(reason));
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);

  RETURN QUERY SELECT made, quest_row.points::bigint, done_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- As 0041, with 'pass:' reserved.
CREATE OR REPLACE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text)
  RETURNS TABLE (submission_id bigint, status text, points integer, completion_id bigint, score bigint,
                 balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  earlier    submission%ROWTYPE;
  made       submission%ROWTYPE;
  cleaned    text;
  done_count integer;
  paid       bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key LIKE 'sub:%'
     OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  cleaned := clean_submission_text(body);

  SELECT * INTO earlier FROM submission s WHERE s.enrollment_id = enrolled.id AND s.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.quest_id <> target OR earlier.body IS DISTINCT FROM cleaned THEN
      RAISE EXCEPTION 'this key was used for another submission' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.points, earlier.completion_id, n.score, n.balance, true
      FROM enrollment n WHERE n.id = enrolled.id;
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled);
  IF quest_row.type <> 'submission' THEN
    RAISE EXCEPTION 'not a submission quest' USING ERRCODE = 'SQ422';
  END IF;
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  IF guidelines IS NULL OR NOT EXISTS (
    SELECT 1 FROM player_acceptance a
    WHERE a.player_id = me AND a.document = 'community_guidelines' AND a.version = guidelines) THEN
    RAISE EXCEPTION 'accept the community guidelines first' USING ERRCODE = 'SG403';
  END IF;
  IF EXISTS (SELECT 1 FROM submission s
             WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'pending') THEN
    RAISE EXCEPTION 'a submission is already waiting' USING ERRCODE = 'SP409';
  END IF;
  IF coalesce((quest_row.type_config ->> 'resubmit')::boolean, false) IS FALSE AND EXISTS (
    SELECT 1 FROM submission s
    WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'rejected' AND NOT s.reason_system) THEN
    RAISE EXCEPTION 'closed after a rejection' USING ERRCODE = 'QD409', DETAIL = 'closed';
  END IF;
  SELECT (SELECT count(*) FROM quest_completion c WHERE c.enrollment_id = enrolled.id AND c.quest_id = target)
         + (SELECT count(*) FROM submission s
            WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'pending')
  INTO done_count;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, auto, marked,
                          idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, 'text', cleaned, quest_row.points, 'pending',
          coalesce((quest_row.type_config ->> 'autoApprove')::boolean, false), text_marked(cleaned), request_key)
  RETURNING * INTO made;
  IF made.auto THEN
    paid := pay_submission(made, NULL, NULL);
    UPDATE submission s SET status = 'approved', completion_id = paid, reviewed_at = now()
    WHERE s.id = made.id RETURNING * INTO made;
  END IF;
  RETURN QUERY SELECT made.id, made.status, made.points, made.completion_id, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;

-- ================================================================ cleanup
-- As 0044, with the rehearsal's stamps deleted before the completions they name.
CREATE OR REPLACE FUNCTION wipe_rehearsal(target uuid, reason text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row event_rehearsal%ROWTYPE;
  accounts  uuid[];
  counts    jsonb;
  first_at  timestamptz;
  entries   integer;
BEGIN
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target FOR UPDATE;
  IF NOT FOUND OR found_row.live_wiped_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  accounts := ARRAY(
    WITH locked AS (
      SELECT n.id FROM enrollment n WHERE n.event_id = target AND n.joined_via = 'rehearsal' ORDER BY n.id FOR UPDATE
    )
    SELECT locked.id FROM locked ORDER BY locked.id);
  SELECT min(l.created_at) FILTER (WHERE l.kind = 'quest'),
         jsonb_build_object(
           'accounts', cardinality(accounts),
           'completions', count(*) FILTER (WHERE l.kind = 'quest'),
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal', 'bonus')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)),
           'submissions', (SELECT count(*) FROM submission s WHERE s.enrollment_id = ANY (accounts)),
           'votes', (SELECT count(*) FROM quest_vote v WHERE v.enrollment_id = ANY (accounts)),
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)),
           'surveys', (SELECT count(*) FROM survey_response r WHERE r.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  DELETE FROM category_bonus b WHERE b.enrollment_id = ANY (accounts);
  PERFORM set_config('questify.rehearsal_wipe', target::text, true);
  DELETE FROM ledger_note t WHERE t.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM manual_award_key k
  WHERE k.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal AND l.reverses IS NOT NULL;
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;
  GET DIAGNOSTICS entries = ROW_COUNT;
  PERFORM set_config('questify.rehearsal_wipe', '', true);
  IF EXISTS (SELECT 1 FROM reward_code c JOIN redemption d ON d.id = c.redemption_id
             WHERE d.enrollment_id = ANY (accounts)) THEN
    RAISE EXCEPTION 'a rehearsal reservation holds a real code' USING ERRCODE = 'RX500';
  END IF;
  DELETE FROM redemption d WHERE d.enrollment_id = ANY (accounts);
  DELETE FROM submission s WHERE s.enrollment_id = ANY (accounts);
  DELETE FROM quest_vote v WHERE v.enrollment_id = ANY (accounts);
  DELETE FROM survey_response r WHERE r.enrollment_id = ANY (accounts);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (accounts);
  DELETE FROM quiz_attempt t WHERE t.enrollment_id = ANY (accounts);
  DELETE FROM passport_stamp p WHERE p.enrollment_id = ANY (accounts);
  DELETE FROM quest_completion c WHERE c.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- Stock from what remains (FR-1722): every reservation still holding a unit.
  UPDATE reward r SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.reward_id = r.id AND d.status IN ('reserved', 'handed_over', 'delivered'))
  WHERE r.event_id = target;

  UPDATE event_rehearsal r
  SET erased_at = now(), erase_counts = counts, first_play_at = coalesce(r.first_play_at, first_at),
      live_wiped_at = CASE WHEN reason = 'go_live' THEN now() END
  WHERE r.event_id = target;
  INSERT INTO ranking_repair (event_id) VALUES (target) ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES (CASE WHEN reason = 'go_live' THEN 'system' ELSE 'staff' END,
          CASE WHEN reason = 'go_live' THEN NULL ELSE app_staff_user_id() END,
          found_row.organizer_id, target, 'event.rehearsal_erased', 'event', target::text,
          counts || jsonb_build_object('reason', reason, 'entries', entries), request);
  RETURN counts;
END $$;

-- As 0044, plus: the account's stamps are deleted (they hold its device id; the completions and ledger stay).
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM player_fingerprint WHERE player_id = me;
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
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
