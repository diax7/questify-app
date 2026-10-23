-- Category rules and the completion bonus (T-304, ADR-200 to ADR-202; plan docs/plans/2026-10-24-t-304-category-rules.md).
-- A category may open at a set time, unlock after another category and hold its quests in order; the gates sit in
-- quest_open_check and bind every path but an owner's or editor's manual award. A category's bonus is paid once per
-- player by pay_category_bonus, called by record_completion, pay_completion and a zero-right quiz finish (the three
-- paths are disjoint: record_completion never calls pay_completion), under the enrollment lock each already holds.
-- Deny by default: category_bonus has no grant; the definers below are its only doors.

-- ================================================================ the category's settings
ALTER TABLE category
  ADD COLUMN order_mode text NOT NULL DEFAULT 'any' CHECK (order_mode IN ('any', 'in_order')),
  ADD COLUMN opens_at timestamptz,
  ADD COLUMN unlock_after uuid,
  ADD COLUMN completion_bonus integer NOT NULL DEFAULT 0 CHECK (completion_bonus BETWEEN 0 AND 100000),
  -- NO ACTION, so a draft event's delete cascades through its categories in one statement; deleting one category
  -- another unlocks after is refused (the API answers category_in_use first).
  ADD CONSTRAINT category_unlock_after_fkey FOREIGN KEY (unlock_after, event_id) REFERENCES category (id, event_id);
CREATE INDEX category_unlock_after_idx ON category (unlock_after) WHERE unlock_after IS NOT NULL;
GRANT UPDATE (order_mode, opens_at, unlock_after, completion_bonus) ON category TO questify_app;

-- No category unlocks after itself, directly or through others (CU422). The walk runs under the event's lock and stops
-- after 30 steps, the event's category cap: a longer chain can only be a cycle.
CREATE FUNCTION category_unlock_acyclic() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  at    uuid := NEW.unlock_after;
  steps integer := 0;
BEGIN
  IF NEW.unlock_after IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('category_unlock:' || NEW.event_id, 0));
  WHILE at IS NOT NULL LOOP
    IF at = NEW.id OR steps >= 30 THEN
      RAISE EXCEPTION 'a category cannot unlock after itself' USING ERRCODE = 'CU422';
    END IF;
    steps := steps + 1;
    SELECT c.unlock_after INTO at FROM category c WHERE c.id = at;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION category_unlock_acyclic() FROM PUBLIC;
CREATE TRIGGER category_unlock_acyclic BEFORE INSERT OR UPDATE OF unlock_after ON category
  FOR EACH ROW EXECUTE FUNCTION category_unlock_acyclic();

-- ================================================================ the ledger knows the bonus (ADR-202)
ALTER TABLE ledger_entry ADD COLUMN category_id uuid;
ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_category_fkey FOREIGN KEY (category_id, event_id) REFERENCES category (id, event_id)
    ON DELETE RESTRICT;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal', 'bonus'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_system_returns_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_system_returns_only
  CHECK (actor <> 'system' OR kind IN ('redeem_return', 'welcome', 'bonus'));
-- A bonus names its category, never a quest, completion or redemption; it moves the balance only while the shop is
-- open. A removal copies the category of the bonus it reverses; no other kind names one.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_bonus_shape
  CHECK (kind <> 'bonus' OR (category_id IS NOT NULL AND score_delta > 0 AND balance_delta IN (0, score_delta)
                             AND completion_id IS NULL AND quest_id IS NULL AND redemption_id IS NULL
                             AND actor = 'system'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_category_kinds
  CHECK (category_id IS NULL OR kind IN ('bonus', 'removal'));
-- A second guard against paying one category twice.
CREATE UNIQUE INDEX ledger_entry_bonus_key ON ledger_entry (enrollment_id, category_id) WHERE kind = 'bonus';
CREATE INDEX ledger_entry_category_idx ON ledger_entry (category_id) WHERE category_id IS NOT NULL;

-- As 0032, with the bonus: an operator not allowed to play earns none.
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal AND NEW.kind IN ('quest', 'redeem', 'award', 'bonus') AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- One row per player and category once its bonus is paid; never deleted by a removal (a removed bonus stays used, as
-- a removed quest does, ADR-152). `completion_id` is the completion that finished the category, NULL for a quiz
-- finished with no right answers. `entry_id` is set in the same transaction as the row.
CREATE TABLE category_bonus (
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  category_id   uuid NOT NULL,
  completion_id bigint REFERENCES quest_completion (id) ON DELETE RESTRICT,
  entry_id      bigint REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, category_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id, event_id) REFERENCES category (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX category_bonus_category_idx ON category_bonus (category_id);
CREATE INDEX category_bonus_completion_idx ON category_bonus (completion_id) WHERE completion_id IS NOT NULL;
CREATE INDEX category_bonus_entry_idx ON category_bonus (entry_id);
ALTER TABLE category_bonus ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_bonus FORCE ROW LEVEL SECURITY;
REVOKE ALL ON category_bonus FROM PUBLIC;

-- ================================================================ done, cleared and the gate (ADR-201)
-- A quest is done with a completion, or a quiz finished with no right answers (FR-208).
CREATE FUNCTION quest_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = member AND c.quest_id = target)
      OR EXISTS (SELECT 1 FROM quiz_attempt a
                 WHERE a.enrollment_id = member AND a.quest_id = target AND a.status = 'finished'
                   AND a.completion_id IS NULL)
$$;
REVOKE ALL ON FUNCTION quest_done(uuid, uuid) FROM PUBLIC;

-- Strict, for the bonus: the category has a visible quest and every visible quest is done.
CREATE FUNCTION category_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q WHERE q.category_id = target AND q.visible)
     AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.category_id = target AND q.visible AND NOT quest_done(member, q.id))
$$;
REVOKE ALL ON FUNCTION category_done(uuid, uuid) FROM PUBLIC;

-- Looser, for the gates (no dead ends): nothing visible and not yet closed is left undone. An empty category, or one
-- whose undone quests all closed, is cleared.
CREATE FUNCTION category_cleared(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND (q.closes_at IS NULL OR q.closes_at > now())
                       AND NOT quest_done(member, q.id))
$$;
REVOKE ALL ON FUNCTION category_cleared(uuid, uuid) FROM PUBLIC;

-- Why the category keeps this quest shut for this member now, or NULL: `category_not_started` before the category
-- opens; `category_locked` while the category it unlocks after is in the member's audience and not cleared;
-- `order_locked` in an in-order category while an earlier visible quest that has not closed is not done (a pending
-- submission is not done).
CREATE FUNCTION category_lock(quest_row quest, member uuid) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  group_row category%ROWTYPE;
  first_row category%ROWTYPE;
BEGIN
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF group_row.opens_at IS NOT NULL AND group_row.opens_at > now() THEN
    RETURN 'category_not_started';
  END IF;
  IF group_row.unlock_after IS NOT NULL THEN
    SELECT * INTO first_row FROM category c WHERE c.id = group_row.unlock_after;
    IF in_audience(member, first_row.audience_kind, first_row.audience_field_id, first_row.audience_values)
       AND NOT category_cleared(member, first_row.id) THEN
      RETURN 'category_locked';
    END IF;
  END IF;
  IF group_row.order_mode = 'in_order' AND EXISTS (
    SELECT 1 FROM quest q
    WHERE q.category_id = group_row.id AND q.visible AND (q.position, q.id) < (quest_row.position, quest_row.id)
      AND (q.closes_at IS NULL OR q.closes_at > now()) AND NOT quest_done(member, q.id)) THEN
    RETURN 'order_locked';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION category_lock(quest, uuid) FROM PUBLIC;

-- As 0040, with the category's gates unless `skip_category` (an owner's or editor's manual award only).
CREATE FUNCTION quest_open_check(quest_row quest, enrolled enrollment, skip_category boolean) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev        event%ROWTYPE;
  group_row category%ROWTYPE;
  shut      text;
BEGIN
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF play_phase(ev, enrolled) IS NULL THEN
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
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF NOT in_audience(enrolled.id, group_row.audience_kind, group_row.audience_field_id,
                     group_row.audience_values) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_for_you';
  END IF;
  IF NOT skip_category THEN
    shut := category_lock(quest_row, enrolled.id);
    IF shut IS NOT NULL THEN
      RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = shut;
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION quest_open_check(quest, enrollment, boolean) FROM PUBLIC;

-- The two-argument form every player path already calls (play_enter, the submission send): the gates apply.
CREATE OR REPLACE FUNCTION quest_open_check(quest_row quest, enrolled enrollment) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM quest_open_check(quest_row, enrolled, false);
END $$;

-- ================================================================ the bonus (FR-231, ADR-202)
-- Pays the category's bonus once when the member's last visible quest in it is done, at the bonus set now; answers the
-- ledger entry, or NULL when nothing was paid (no bonus set, not done yet, or already paid: ON CONFLICT, never an
-- error). The caller holds the enrollment FOR NO KEY UPDATE. The balance moves only while the shop is open.
CREATE FUNCTION pay_category_bonus(enrolled enrollment, target_category uuid, completion bigint) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  group_row category%ROWTYPE;
  ev        event%ROWTYPE;
  entry     bigint;
BEGIN
  SELECT * INTO group_row FROM category c WHERE c.id = target_category;
  IF NOT FOUND OR group_row.completion_bonus = 0 OR NOT category_done(enrolled.id, group_row.id) THEN
    RETURN NULL;
  END IF;
  INSERT INTO category_bonus (organizer_id, event_id, enrollment_id, category_id, completion_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, group_row.id, completion)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, category_id, actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'bonus', group_row.completion_bonus,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE group_row.completion_bonus END,
          group_row.id, 'system')
  RETURNING id INTO entry;
  UPDATE category_bonus b SET entry_id = entry WHERE b.enrollment_id = enrolled.id AND b.category_id = group_row.id;
  RETURN entry;
END $$;
REVOKE ALL ON FUNCTION pay_category_bonus(enrollment, uuid, bigint) FROM PUBLIC;

-- As 0041, plus the category's bonus after the payment.
CREATE OR REPLACE FUNCTION pay_completion(enrolled enrollment, quest uuid, points bigint, method text,
                                          completion_key text, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  done_count integer;
  made       bigint;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = quest;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, quest, done_count + 1, method, completion_key)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', points,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE points END,
          made, quest,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff);
  PERFORM pay_category_bonus(enrolled, (SELECT q.category_id FROM quest q WHERE q.id = pay_completion.quest), made);
  RETURN made;
END $$;

-- As 0042, with the category's gates (a manual award passes them) and the category's bonus after the payment.
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
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' THEN
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

-- As 0041, plus: a quiz finished with no right answers that makes its category done pays the bonus, under the same
-- conditions as a paid finish, and marks the ranking for repair (no completion moves it through the API).
CREATE OR REPLACE FUNCTION finish_quiz(attempt quiz_attempt) RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  st       text;
  paid     bigint;
  payable  boolean;
BEGIN
  UPDATE quiz_answer a SET closed = true
  WHERE a.attempt_id = attempt.id AND a.answered_at IS NULL AND NOT a.closed;
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = attempt.enrollment_id;
  SELECT * INTO ev FROM event e WHERE e.id = attempt.event_id;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  payable := NOT (enrolled.status <> 'active'
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = enrolled.player_id AND p.status = 'active')
     OR (CASE WHEN enrolled.joined_via = 'rehearsal' THEN st NOT IN ('draft', 'scheduled')
              ELSE st NOT IN ('live', 'ended') END)
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id)
     OR (enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
           SELECT 1 FROM staff_assignment sa
           WHERE sa.event_id = ev.id AND sa.player_id = enrolled.player_id AND NOT sa.can_play)));
  IF attempt.right_count = 0 THEN
    UPDATE quiz_attempt a SET status = 'finished', finished_at = now() WHERE a.id = attempt.id;
    IF payable AND pay_category_bonus(enrolled, (SELECT q.category_id FROM quest q WHERE q.id = attempt.quest_id),
                                      NULL) IS NOT NULL THEN
      PERFORM mark_ranking_repair(ev.id);
    END IF;
    RETURN 'finished';
  END IF;
  IF NOT payable THEN
    UPDATE quiz_attempt a SET status = 'void', finished_at = now() WHERE a.id = attempt.id;
    RETURN 'void';
  END IF;
  paid := pay_completion(enrolled, attempt.quest_id, attempt.right_count::bigint * attempt.points_each, 'quiz',
                         'quiz:' || attempt.id, NULL, NULL);
  UPDATE quiz_attempt a SET status = 'finished', completion_id = paid, finished_at = now() WHERE a.id = attempt.id;
  RETURN 'paid';
END $$;

-- ================================================================ what the player reads
-- The bonus a completion paid, for the player who made it (the answer of a scan, a code, a vote, a survey, a share).
CREATE FUNCTION own_bonus(completion bigint)
  RETURNS TABLE (category_id uuid, points bigint, name_ar text, name_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.category_id, l.score_delta, c.name_ar, c.name_en
  FROM category_bonus b
  JOIN enrollment n ON n.id = b.enrollment_id AND n.player_id = app_player_id()
  JOIN ledger_entry l ON l.id = b.entry_id
  JOIN category c ON c.id = b.category_id
  WHERE b.completion_id = completion
$$;
REVOKE ALL ON FUNCTION own_bonus(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_bonus(bigint) TO questify_app;

-- The bonus the caller's quiz attempt on this quest paid: through its completion, or, finished with no right answers,
-- the row with no completion written as the attempt finished. created_at = finished_at holds because both take now() in
-- the one transaction that finishes the attempt and pays the bonus (finish_quiz); a bonus row written in any
-- other transaction would not match.
CREATE FUNCTION own_category_bonus(target uuid)
  RETURNS TABLE (category_id uuid, points bigint, name_ar text, name_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.category_id, l.score_delta, c.name_ar, c.name_en
  FROM quest q
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id()
  JOIN quiz_attempt a ON a.enrollment_id = n.id AND a.quest_id = q.id AND a.status = 'finished'
  JOIN category_bonus b ON b.enrollment_id = n.id AND b.category_id = q.category_id
    AND (b.completion_id = a.completion_id
         OR (a.completion_id IS NULL AND b.completion_id IS NULL AND b.created_at = a.finished_at))
  JOIN ledger_entry l ON l.id = b.entry_id
  JOIN category c ON c.id = b.category_id
  WHERE q.id = target
$$;
REVOKE ALL ON FUNCTION own_category_bonus(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_category_bonus(uuid) TO questify_app;

-- As 0041, with each category's rules and the caller's bonus, and each quest's lock. bonus_settled: the bonus row
-- exists (paid, or since removed or withheld), so it is never paid again. An unlock category's name is shown only to a
-- player in its audience. The output changed: DROP and
-- CREATE, with the REVOKE and GRANT repeated.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text)
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
         category_lock(q, me.id)
  FROM me
  JOIN category c ON c.event_id = target
    AND in_audience(me.id, c.audience_kind, c.audience_field_id, c.audience_values)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- As 0034, with a bonus titled by its category.
CREATE OR REPLACE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, g.name_ar), coalesce(q.title_en, r.name_en, k.name_en, g.name_en)
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN category g ON g.id = l.category_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;

-- ================================================================ the team's record and removal (ADR-152, ADR-202)
-- As 0030, with a bonus removable on its own and titled by its category.
CREATE OR REPLACE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, g.name_ar), coalesce(q.title_en, w.name_en, g.name_en),
         coalesce(n.reason, b.reason),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id)
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;

-- As 0040, with a bonus removable on its own: the removal copies its category; its quests stay, and a removed quest
-- leaves the bonus (ADR-202).
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
  why      text;
  take_s   bigint;
  take_b   bigint;
  made     bigint;
  st       text;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT k.* INTO earlier FROM manual_award_key k
  WHERE k.event_id = ev.id AND k.staff_user_id = me AND k.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.kind <> 'removal' OR earlier.reverses <> target_entry THEN
      RAISE EXCEPTION 'this key was used for another removal' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true FROM ledger_entry l WHERE l.id = earlier.entry_id;
    RETURN;
  END IF;

  -- The event first, then the enrollment (confirm_results takes the event FOR UPDATE): a confirm in flight waits
  -- for this removal to commit, or this removal sees the frozen results.
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
  END IF;
  why := clean_reason(reason);
  SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = target_entry AND l.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such entry in this event' USING ERRCODE = 'AE404';
  END IF;
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus') THEN
    RAISE EXCEPTION 'only an award can be removed' USING ERRCODE = 'AT422';
  END IF;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  IF (CASE WHEN credit.rehearsal THEN st NOT IN ('draft', 'scheduled') ELSE st NOT IN ('live', 'ended') END) THEN
    RAISE EXCEPTION 'the event is not live or ended' USING ERRCODE = 'AS409';
  END IF;
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = credit.enrollment_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM ledger_entry l WHERE l.reverses = credit.id AND l.kind = 'removal') THEN
    RAISE EXCEPTION 'already removed' USING ERRCODE = 'AD409';
  END IF;
  take_s := least(credit.score_delta, enrolled.score);
  take_b := least(credit.balance_delta, enrolled.balance);
  IF (take_s < credit.score_delta OR take_b < credit.balance_delta)
     AND EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved') THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, category_id, actor, staff_user_id, reverses)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, 'staff', me, credit.id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, made);
  IF credit.kind = 'quest' THEN
    UPDATE submission s SET status = 'removed', reason = why, removed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.completion_id = credit.completion_id AND s.status = 'approved';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false;
END $$;

-- ================================================================ rehearsal and erasure
-- As 0032, with the bonus among the points the rehearsal earned.
CREATE OR REPLACE FUNCTION rehearsal_card(target_event uuid)
  RETURNS TABLE (code text, status_now text, accounts integer, completions integer, points bigint, reservations integer,
                 flags integer, first_play_at timestamptz, erased_at timestamptz, erase_counts jsonb,
                 live_wiped_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT r.code, event_status_now(ev.status, ev.starts_at, ev.ends_at),
         (SELECT count(*)::integer FROM enrollment n WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM ledger_entry l WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest'),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.event_id = ev.id AND l.rehearsal AND l.kind IN ('quest', 'award', 'removal', 'bonus')),
         (SELECT count(*)::integer FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM flag f JOIN enrollment n ON n.id = f.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         coalesce(r.first_play_at, (SELECT min(l.created_at) FROM ledger_entry l
                                    WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest')),
         r.erased_at, r.erase_counts, r.live_wiped_at
  FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
END $$;

-- As 0042, with the bonus among the points counted and the bonus rows deleted before the ledger rows they name.
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

-- As 0042, plus: the account's bonus rows are deleted (the ledger entries stay, as the completions do).
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
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
