-- Flash quests and double-point boosts (T-307, F-102, FR-251, FR-252, ADR-231 to ADR-233; plan
-- docs/plans/2026-10-24-t-307-flash-quests-boosts.md). A flash quest is shown to players only inside its window,
-- launched now or scheduled, and stays out of every category rule. A boost doubles what one category's quests pay for
-- its window; the doubled amount and the boost are written into the quest's ledger entry, so the score, the ranking,
-- removals and results need no change. Deny by default: the boost table has row-level security forced, PUBLIC revoked
-- and no grant; every new function is closed to PUBLIC here, and only the team and player doors are granted.

-- ================================================================ the flash quest's shape (ADR-231)
-- `flash` is the builder's (column grant); `flash_launched_at` is launch_flash's and the rehearsal wipe's only. A
-- shown flash quest has both times and lasts at most 1,440 minutes; the 1-minute minimum is launch's and the
-- builder's refusal (End now and a launch clamped to the event's end may leave less, CTO 1).
ALTER TABLE quest
  ADD COLUMN flash boolean NOT NULL DEFAULT false,
  ADD COLUMN flash_launched_at timestamptz,
  -- is_live_poll's rule written out: a CHECK runs as the writer, and the API's role can not call the helper.
  ADD CONSTRAINT quest_flash_not_live_poll
    CHECK (NOT flash OR NOT (type = 'vote' AND coalesce(type_config ? 'live', false))),
  ADD CONSTRAINT quest_flash_window CHECK (
    NOT flash OR NOT visible
    OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND closes_at > opens_at
        AND closes_at - opens_at <= interval '1440 minutes')),
  ADD CONSTRAINT quest_flash_launched CHECK (flash_launched_at IS NULL OR flash);
CREATE INDEX quest_flash_idx ON quest (event_id) WHERE flash;
GRANT INSERT (flash), UPDATE (flash) ON quest TO questify_app;

-- The API's seat only (the definers, the wipe and the migration owner pass), as the live poll's guard: once a flash
-- quest is launched, or a scheduled one's window has started, its visible, opens_at and closes_at are launch's and End
-- now's. FL409 window.
CREATE FUNCTION quest_flash_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF (OLD.flash_launched_at IS NOT NULL OR (OLD.visible AND OLD.opens_at <= now()))
     AND (NEW.visible, NEW.opens_at, NEW.closes_at) IS DISTINCT FROM (OLD.visible, OLD.opens_at, OLD.closes_at) THEN
    RAISE EXCEPTION 'a running flash quest''s window is set by Launch and End now' USING ERRCODE = 'FL409',
      DETAIL = 'window';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_flash_guard() FROM PUBLIC;
CREATE TRIGGER quest_flash_guard BEFORE UPDATE ON quest
  FOR EACH ROW WHEN (OLD.flash) EXECUTE FUNCTION quest_flash_guard();

-- ================================================================ the boost (ADR-232)
-- One category of the event doubled from `starts_at` to `ends_at`. `multiplier` is what the entries it names were
-- computed with. `rehearsal` marks a boost saved during the rehearsal before the event's start: it pays and shows to
-- rehearsal accounts only and is deleted by the rehearsal wipe. A category with a boost cannot be deleted (RESTRICT).
-- The 1-minute minimum is save_boost's refusal (a Stop may leave less). Written only by its definers.
CREATE TABLE boost (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  category_id  uuid NOT NULL,
  multiplier   integer NOT NULL DEFAULT 2 CHECK (multiplier = 2),
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  rehearsal    boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '1440 minutes'),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (category_id, event_id) REFERENCES category (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX boost_category_idx ON boost (category_id, starts_at);
CREATE INDEX boost_event_idx ON boost (event_id, starts_at);
ALTER TABLE boost ENABLE ROW LEVEL SECURITY;
ALTER TABLE boost FORCE ROW LEVEL SECURITY;
REVOKE ALL ON boost FROM PUBLIC;

-- ================================================================ the ledger entry names its boost (ADR-233)
-- A boosted quest entry carries the doubled amount and its boost; its removal copies the boost.
ALTER TABLE ledger_entry
  ADD COLUMN boost_id uuid REFERENCES boost (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ledger_entry_boost_kinds CHECK (boost_id IS NULL OR kind IN ('quest', 'removal'));
CREATE INDEX ledger_entry_boost_idx ON ledger_entry (boost_id) WHERE boost_id IS NOT NULL;

-- As 0032, plus (CTO 9): a real account's entry never names a rehearsal boost (every payer runs the go-live wipe
-- first, which deletes them; this is the second wall). LB500.
CREATE OR REPLACE FUNCTION ledger_stamp_rehearsal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.rehearsal := EXISTS (SELECT 1 FROM enrollment n WHERE n.id = NEW.enrollment_id AND n.joined_via = 'rehearsal');
  IF NEW.boost_id IS NOT NULL AND NOT NEW.rehearsal
     AND EXISTS (SELECT 1 FROM boost b WHERE b.id = NEW.boost_id AND b.rehearsal) THEN
    RAISE EXCEPTION 'a live entry names a rehearsal boost' USING ERRCODE = 'LB500';
  END IF;
  RETURN NEW;
END $$;

-- As 0054, plus the event's boosts: a draft event's delete would reach its categories (RESTRICT from a boost) before
-- its boosts.
CREATE OR REPLACE FUNCTION event_delete_goals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM community_goal g WHERE g.event_id = OLD.id;
  DELETE FROM boost b WHERE b.event_id = OLD.id;
  RETURN OLD;
END $$;

-- ================================================================ the switches and the one rule (internal)
-- Flash quests are on for the event unless its own switch (`config.features.flashQuests`) or the platform's
-- (`platform_setting` features.flashQuests.enabled) is false: off, every flash quest is hidden and refused at once.
CREATE FUNCTION flash_on(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> 'flashQuests' <> 'false'::jsonb, true)
     AND coalesce((SELECT s.value -> 'flashQuests' -> 'enabled' <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION flash_on(event) FROM PUBLIC;

-- Boosts pay unless the event's own switch (`config.features.boosts`) is false. The platform's switch is the API's:
-- no new boost is saved, running ones finish (ADR-233).
CREATE FUNCTION boosts_on(ev event) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> 'boosts' <> 'false'::jsonb, true)
$$;
REVOKE ALL ON FUNCTION boosts_on(event) FROM PUBLIC;

-- Whether players may see a quest now as a flash quest: any quest that is not flash; a flash quest only inside its
-- window, with the switches on, and a launched one only while the event's sent polls may be shown (a rehearsal launch
-- stays hidden between go-live and the wipe that puts it back to draft). Callers check `visible` themselves.
CREATE FUNCTION flash_shown(quest_row quest) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN NOT quest_row.flash THEN true
              ELSE coalesce(quest_row.opens_at <= now() AND quest_row.closes_at > now(), false)
                   AND EXISTS (SELECT 1 FROM event e
                               WHERE e.id = quest_row.event_id AND flash_on(e)
                                 AND (quest_row.flash_launched_at IS NULL OR polls_shown(e))) END
$$;
REVOKE ALL ON FUNCTION flash_shown(quest) FROM PUBLIC;

-- The one rule (CTO 3) for which boost applies to a member at a time: the category's boost in force at `at`, the
-- event's switch on, a rehearsal boost only for a rehearsal account and a real one only for a real account; NULL
-- otherwise. One index probe, no lock. Every payer and every reader that shows a boost calls it.
CREATE FUNCTION boost_in_force(target_category uuid, enrolled enrollment, at timestamptz) RETURNS boost
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT b.* FROM boost b JOIN event e ON e.id = b.event_id
  WHERE b.category_id = target_category AND b.starts_at <= at AND b.ends_at > at
    AND b.rehearsal = (enrolled.joined_via IS NOT DISTINCT FROM 'rehearsal') AND boosts_on(e)
  ORDER BY b.starts_at DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION boost_in_force(uuid, enrollment, timestamptz) FROM PUBLIC;

-- The boost of the quest's category at `at`, read with the quest as it is at payment (CTO 8).
CREATE FUNCTION quest_boost(quest_row quest, enrolled enrollment, at timestamptz) RETURNS boost
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT boost_in_force(quest_row.category_id, enrolled, at)
$$;
REVOKE ALL ON FUNCTION quest_boost(quest, enrollment, timestamptz) FROM PUBLIC;

-- ================================================================ every door (ADR-231)
-- As 0046, plus: a flash quest while flash quests are switched off is not open (QN403 switched_off). The window is
-- the quest's own opens_at and closes_at, refused below as for any quest. The visibility and the window are read from
-- the quest as it is now (CTO code review 1): a door may have read its quest before its own call ran the go-live wipe,
-- which puts a rehearsal launch or send back to draft; a quest whose launch or send changed since that read is hidden.
CREATE OR REPLACE FUNCTION quest_open_check(quest_row quest, enrolled enrollment, skip_category boolean) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev        event%ROWTYPE;
  group_row category%ROWTYPE;
  shut      text;
  stored    quest%ROWTYPE;
BEGIN
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF play_phase(ev, enrolled) IS NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  SELECT * INTO stored FROM quest q WHERE q.id = quest_row.id;
  IF NOT FOUND OR NOT stored.visible
     OR (stored.flash_launched_at, stored.poll_sent_at)
        IS DISTINCT FROM (quest_row.flash_launched_at, quest_row.poll_sent_at) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  IF stored.flash AND NOT flash_on(ev) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'switched_off';
  END IF;
  IF stored.opens_at IS NOT NULL AND stored.opens_at > now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_started';
  END IF;
  IF stored.closes_at IS NOT NULL AND stored.closes_at <= now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'ended';
  END IF;
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF NOT (CASE WHEN skip_category
               THEN in_audience(enrolled.id, group_row.audience_kind, group_row.audience_field_id,
                                group_row.audience_values)
               ELSE sees_category(enrolled.id, group_row) END) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_for_you';
  END IF;
  IF NOT skip_category THEN
    shut := category_lock(quest_row, enrolled.id);
    IF shut IS NOT NULL THEN
      RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = shut;
    END IF;
  END IF;
END $$;

-- ================================================================ flash quests stay out of the category rules
-- As 0054, with flash quests left out both ways, as live polls: a flash quest missed never holds a category's bonus,
-- its successor or a later in-order quest, and doing one never counts toward the bonus.
CREATE OR REPLACE FUNCTION category_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.category_id = target AND q.visible AND NOT q.flash AND NOT is_live_poll(q.type, q.type_config)
                   AND NOT quest_lock_missed(q))
     AND NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND NOT q.flash
                       AND NOT is_live_poll(q.type, q.type_config) AND NOT quest_lock_missed(q)
                       AND NOT quest_done(member, q.id))
$$;

CREATE OR REPLACE FUNCTION category_cleared(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND (q.closes_at IS NULL OR q.closes_at > now())
                       AND NOT q.flash AND NOT is_live_poll(q.type, q.type_config) AND NOT quest_lock_missed(q)
                       AND NOT quest_done(member, q.id))
$$;

CREATE OR REPLACE FUNCTION category_rule_lock(quest_row quest, member uuid) RETURNS text
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
    IF sees_category(member, first_row) AND NOT category_cleared(member, first_row.id) THEN
      RETURN 'category_locked';
    END IF;
  END IF;
  IF group_row.order_mode = 'in_order' AND NOT quest_row.flash
     AND NOT is_live_poll(quest_row.type, quest_row.type_config) AND EXISTS (
    SELECT 1 FROM quest q
    WHERE q.category_id = group_row.id AND q.visible AND (q.position, q.id) < (quest_row.position, quest_row.id)
      AND (q.closes_at IS NULL OR q.closes_at > now()) AND NOT q.flash AND NOT is_live_poll(q.type, q.type_config)
      AND NOT quest_lock_missed(q) AND NOT quest_done(member, q.id)) THEN
    RETURN 'order_locked';
  END IF;
  RETURN NULL;
END $$;

-- ================================================================ the payers (ADR-232, ADR-233)
-- As 0054, plus the boost: every completion but a manual award pays the quest's points times the boost of its
-- category in force now, and its entry names the boost. `balance_delta` is written as 0054 wrote it (CTO nit).
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row      quest%ROWTYPE;
  enrolled       enrollment%ROWTYPE;
  earlier        quest_completion%ROWTYPE;
  earlier_by     uuid;
  earlier_staff  uuid;
  lifetime_count integer;
  made           bigint;
  entry          bigint;
  boosted        boost%ROWTYPE;
  paid           bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%'
     OR request_key LIKE 'meet:%' OR request_key LIKE 'game:%' THEN
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
  -- Read again after the wipe: a rehearsal launch of this flash quest is a draft again.
  SELECT * INTO quest_row FROM quest WHERE id = target;

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
  IF proof_method = 'manual' AND operator IS NOT NULL AND quest_community_lock(quest_row) IS NOT NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'community_locked';
  END IF;
  -- A quiz in play pays itself at its end; a manual award now would pay the quest twice (T-302).
  IF proof_method = 'manual' AND quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target AND a.status = 'open') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type IN ('scan_qr', 'location') AND proof_method = 'qr'
             AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'location' AND proof_method = 'location')
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
    IF proof_method = 'location' THEN
      PERFORM check_in_check(quest_row, reading);
    END IF;
  END IF;

  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  -- Both counts are read under the enrollment lock taken above.
  IF period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  SELECT count(*) INTO lifetime_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  PERFORM lock_quest_items(quest_row);
  -- Staff award the quest's own points: a manual award is never boosted (ADR-232).
  IF proof_method <> 'manual' THEN
    boosted := quest_boost(quest_row, enrolled, now());
  END IF;
  paid := quest_row.points::bigint * coalesce(boosted.multiplier, 1);

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id, boost_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', paid, paid, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff, boosted.id)
  RETURNING id INTO entry;
  IF proof_method = 'manual' THEN
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason)
    VALUES (entry, enrolled.organizer_id, enrolled.event_id, clean_reason(reason));
    INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
    SELECT enrolled.organizer_id, enrolled.event_id, enrolled.id, c.id
    FROM category c WHERE c.id = quest_row.category_id AND c.hidden
    ON CONFLICT DO NOTHING;
  END IF;
  IF lifetime_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);

  RETURN QUERY SELECT made, paid, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- As 0049, plus the boost of the quest's category at `fixed_at`, the time the points were fixed (ADR-233). Neither
-- `fixed_at` nor `device` has a default (CTO 2): every caller says when, so one forgotten fails at its first run.
DROP FUNCTION pay_completion(enrollment, uuid, bigint, text, text, uuid, uuid, uuid);
CREATE FUNCTION pay_completion(enrolled enrollment, quest uuid, points bigint, method text, completion_key text,
                               operator uuid, staff uuid, device uuid, fixed_at timestamptz) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  quest_row  quest%ROWTYPE;
  done_count integer;
  made       bigint;
  boosted    boost%ROWTYPE;
  paid       bigint;
BEGIN
  IF fixed_at IS NULL THEN
    RAISE EXCEPTION 'pay_completion needs the time the points were fixed' USING ERRCODE = '22004';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = pay_completion.quest;
  PERFORM lock_quest_items(quest_row);
  boosted := quest_boost(quest_row, enrolled, fixed_at);
  paid := points * coalesce(boosted.multiplier, 1);
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = pay_completion.quest;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key,
                                device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, pay_completion.quest, done_count + 1, method,
          completion_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id, boost_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', paid,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE paid END,
          made, pay_completion.quest,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff, boosted.id);
  IF done_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION pay_completion(enrollment, uuid, bigint, text, text, uuid, uuid, uuid, timestamptz) FROM PUBLIC;

-- As 0041, judged at the send (ADR-233). Its own callers (the auto-approve in submit_quest, the reviews) pass nothing
-- more: the time is the submission's own.
CREATE OR REPLACE FUNCTION pay_submission(sub submission, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
BEGIN
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = sub.enrollment_id;
  RETURN pay_completion(enrolled, sub.quest_id, sub.points, 'submission', 'sub:' || sub.id, operator, staff, NULL,
                        sub.created_at);
END $$;

-- As 0044, judged at the quiz's start (also when confirm_results finishes it).
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
                         'quiz:' || attempt.id, NULL, NULL, NULL, attempt.started_at);
  UPDATE quiz_attempt a SET status = 'finished', completion_id = paid, finished_at = now() WHERE a.id = attempt.id;
  RETURN 'paid';
END $$;

-- As 0050, judged at the round's issue.
CREATE OR REPLACE FUNCTION finish_game_round(target bigint, result_key text, given_verdict text, given_result jsonb,
                                             given_reason text, given_unlikely boolean, last_input_ms integer)
  RETURNS TABLE (verdict text, completion_id bigint, points bigint, score bigint, balance bigint,
                 attempts_left integer, replayed boolean, result jsonb, reason text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  played    game_round%ROWTYPE;
  earlier   game_round%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  quest_row quest%ROWTYPE;
  outcome   text := given_verdict;
  why       text := given_reason;
  paid      bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF finish_game_round.result_key IS NULL OR length(finish_game_round.result_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF outcome IS NULL OR outcome NOT IN ('passed', 'short', 'refused') OR (outcome = 'refused') <> (why IS NOT NULL)
     OR last_input_ms IS NULL OR last_input_ms < 0 THEN
    RAISE EXCEPTION 'not a verdict' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO played FROM game_round r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.player_id = me WHERE r.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO earlier FROM game_round r
  WHERE r.enrollment_id = played.enrollment_id AND r.result_key = finish_game_round.result_key;
  IF FOUND THEN
    IF earlier.id <> played.id THEN
      RAISE EXCEPTION 'this key was used for another round' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT * FROM game_answer(earlier, true);
    RETURN;
  END IF;

  PERFORM ensure_rehearsal_wiped(played.event_id);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = played.enrollment_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO played FROM game_round r WHERE r.id = played.id FOR UPDATE;
  -- The rehearsal wipe deleted it while this waited on the locks.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  -- A duplicate that waited on the first result's locks answers it, never `finished`.
  IF played.result_key IS NOT DISTINCT FROM finish_game_round.result_key THEN
    RETURN QUERY SELECT * FROM game_answer(played, true);
    RETURN;
  END IF;
  IF played.status = 'expired' OR (played.status = 'open' AND played.deadline_at <= now()) THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'expired';
  END IF;
  IF played.status <> 'open' THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'finished';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = played.quest_id;
  PERFORM meet_may_play(enrolled, quest_row);

  IF last_input_ms > floor(extract(epoch FROM now() - played.issued_at) * 1000) + 3000 THEN
    outcome := 'refused';
    why := 'clock';
  END IF;
  IF outcome = 'passed' AND period_count(enrolled.id, quest_row) = 0 THEN
    paid := pay_completion(enrolled, quest_row.id, played.points, 'game', 'game:' || played.id, NULL, NULL,
                           played.device_id, played.issued_at);
  END IF;
  UPDATE game_round r
  SET status = outcome, finished_at = now(), result_key = finish_game_round.result_key,
      result = CASE WHEN outcome = 'refused' THEN NULL ELSE given_result END,
      reason = CASE WHEN outcome = 'refused' THEN why END,
      unlikely = outcome <> 'refused' AND coalesce(given_unlikely, false), completion_id = paid
  WHERE r.id = played.id
  RETURNING * INTO played;
  IF outcome = 'refused' THEN
    PERFORM raise_game_flag(played, why);
  ELSIF outcome = 'passed' AND played.unlikely THEN
    PERFORM raise_game_flag(played, 'unlikely');
  END IF;
  IF outcome <> 'passed' THEN
    PERFORM game_last_attempt(enrolled, quest_row);
  END IF;
  RETURN QUERY SELECT * FROM game_answer(played, false);
END $$;

-- As 0045, paid now; the answer's points are the entry's (the boosted amount).
CREATE OR REPLACE FUNCTION stamp_step(target uuid, proof_version integer, request_key text, device uuid)
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
  SELECT * INTO quest_row FROM quest q WHERE q.id = step_row.quest_id;
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
    -- A `needed` lowered while a stamp was in flight leaves the player at the count, unpaid (no completion: checked
    -- above). Re-scanning a stamped step pays then, on that stamp, which takes this key so a retry replays the payment.
    IF have >= wanted THEN
      paid := pay_completion(enrolled, quest_row.id, quest_row.points, 'passport', 'pass:' || quest_row.id, NULL, NULL,
                             NULL, now());
      UPDATE passport_stamp p SET completion_id = paid, idempotency_key = request_key
      WHERE p.enrollment_id = enrolled.id AND p.step_id = target;
      RETURN QUERY SELECT quest_row.id, paid, l.score_delta, true, have, wanted, n.score, n.balance, false
        FROM enrollment n, ledger_entry l WHERE n.id = enrolled.id AND l.completion_id = paid AND l.kind = 'quest';
      RETURN;
    END IF;
    RETURN QUERY SELECT quest_row.id, NULL::bigint, NULL::bigint, false, have, wanted, enrolled.score, enrolled.balance,
                        false;
    RETURN;
  END IF;

  have := have + 1;
  IF have >= wanted THEN
    paid := pay_completion(enrolled, quest_row.id, quest_row.points, 'passport', 'pass:' || quest_row.id, NULL, NULL,
                           NULL, now());
  END IF;
  INSERT INTO passport_stamp (organizer_id, event_id, enrollment_id, quest_id, step_id, idempotency_key, device_id,
                              completion_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, quest_row.id, target, request_key, device, paid);
  RETURN QUERY SELECT quest_row.id, paid,
                      (SELECT l.score_delta FROM ledger_entry l WHERE l.completion_id = paid AND l.kind = 'quest'),
                      true, have, wanted, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;

-- As 0049, both sides paid now (each by its own account's boost: a rehearsal pair meets only in rehearsal).
CREATE OR REPLACE FUNCTION pay_meeting(pass meet_pass, mine enrollment, theirs enrollment, quest_row quest, key text,
                                       device uuid, reading jsonb) RETURNS meeting
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  lock_key   bigint;
  scanner_id bigint;
  shown_id   bigint;
  met        meeting%ROWTYPE;
BEGIN
  PERFORM lock_quest_items(quest_row);
  FOR lock_key IN
    SELECT DISTINCT hashtextextended('device:' || pass.event_id || ':' || d, 0)
    FROM unnest(ARRAY[device, pass.device_id]) d WHERE d IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(lock_key);
  END LOOP;
  IF mine.player_id < theirs.player_id THEN
    scanner_id := pay_completion(mine, quest_row.id, quest_row.points, 'meet_scan', 'meet:' || pass.id, NULL, NULL,
                                 device, now());
    shown_id := pay_completion(theirs, quest_row.id, quest_row.points, 'meet_shown', 'meet:' || pass.id, NULL, NULL,
                               pass.device_id, now());
  ELSE
    shown_id := pay_completion(theirs, quest_row.id, quest_row.points, 'meet_shown', 'meet:' || pass.id, NULL, NULL,
                               pass.device_id, now());
    scanner_id := pay_completion(mine, quest_row.id, quest_row.points, 'meet_scan', 'meet:' || pass.id, NULL, NULL,
                                 device, now());
  END IF;
  PERFORM keep_position(scanner_id, mine, reading);
  INSERT INTO meeting (organizer_id, event_id, quest_id, scanner_enrollment, shown_enrollment, pass_id, request_key,
                       scanner_completion, shown_completion)
  VALUES (pass.organizer_id, pass.event_id, quest_row.id, mine.id, theirs.id, pass.id, key, scanner_id, shown_id)
  RETURNING * INTO met;
  UPDATE meet_pass p SET ended_at = now() WHERE p.id = pass.id;
  RETURN met;
END $$;

-- The multiplier of the calling player's own completion's entry (granted), NULL when it was not boosted or is not
-- theirs (an operator scanning a player's QR gets NULL: the player's answer carries it).
CREATE FUNCTION completion_boost(completion bigint) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.multiplier
  FROM ledger_entry l
  JOIN enrollment n ON n.id = l.enrollment_id AND n.player_id = app_player_id()
  JOIN boost b ON b.id = l.boost_id
  WHERE l.completion_id = completion AND l.kind = 'quest'
$$;
REVOKE ALL ON FUNCTION completion_boost(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION completion_boost(bigint) TO questify_app;

-- ================================================================ pending points show what approval pays (CTO 4)
-- As 0040, with each pending submission's points times the boost in force when it was sent (what approval pays).
CREATE OR REPLACE FUNCTION own_pending_points(target_event uuid) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(s.points::bigint * coalesce((quest_boost(q, n, s.created_at)).multiplier, 1)), 0)::bigint
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN submission s ON s.enrollment_id = n.id AND s.status = 'pending'
  JOIN quest q ON q.id = s.quest_id
  WHERE n.event_id = target_event AND n.player_id = app_player_id()
$$;

-- As 0040, with `points` what the submission paid (its entry) or will pay (times the boost at its send).
CREATE OR REPLACE FUNCTION own_submissions(target_event uuid)
  RETURNS TABLE (id bigint, quest_id uuid, status text, points integer, body text, reason text, reason_system boolean,
                 resubmit boolean, created_at timestamptz, reviewed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.quest_id, s.status,
         coalesce((SELECT l.score_delta::integer FROM ledger_entry l WHERE l.completion_id = s.completion_id
                     AND l.kind = 'quest'),
                  s.points * coalesce((quest_boost(q, n, s.created_at)).multiplier, 1)),
         s.body, s.reason, s.reason_system,
         coalesce((q.type_config ->> 'resubmit')::boolean, false), s.created_at, s.reviewed_at
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN submission s ON s.enrollment_id = n.id
  JOIN quest q ON q.id = s.quest_id
  WHERE n.event_id = target_event AND n.player_id = app_player_id()
  ORDER BY s.id DESC
  LIMIT 200
$$;

-- ================================================================ removing a boosted completion
-- As 0053, with the boost copied onto the removal; the amounts reversed are the entry's own (the doubled ones).
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean, item text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
  given    redemption%ROWTYPE;
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
    SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = earlier.reverses;
    given := credit_item(credit);
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true, credit_item_state(given)
      FROM ledger_entry l WHERE l.id = earlier.entry_id;
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus', 'community') THEN
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
     AND EXISTS (SELECT 1 FROM redemption d
                 WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved' AND d.price > 0) THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, category_id, community_step_id, actor, staff_user_id, reverses, boost_id)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, credit.community_step_id, 'staff', me, credit.id, credit.boost_id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, made);
  IF credit.kind = 'quest' THEN
    UPDATE submission s SET status = 'removed', reason = why, removed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.completion_id = credit.completion_id AND s.status = 'approved';
  END IF;
  given := credit_item(credit);
  IF given.status = 'reserved' THEN
    PERFORM end_reservation(given.id, 'cancelled', 'removal', 'staff', NULL);
    given := credit_item(credit);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b,
                             'item', credit_item_state(given)),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false, credit_item_state(given);
END $$;

-- ================================================================ the activity says ×2 (CTO 6)
-- As 0053, with each row's `multiplier` (its boost's, NULL when none). The output changed: DROP and CREATE.
DROP FUNCTION member_activity(uuid, bigint, integer);
CREATE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, multiplier integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, r.name_en, k.name_en, i.name_en, g.name_en, cg.title_en),
         bo.multiplier
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;
REVOKE ALL ON FUNCTION member_activity(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_activity(uuid, bigint, integer) TO questify_app;

-- As 0053, with each row's `multiplier`. The output changed: DROP and CREATE.
DROP FUNCTION member_ledger(uuid, uuid, bigint, integer);
CREATE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean, multiplier integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en, cg.title_en),
         coalesce(n.reason, b.reason),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus', 'community')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         bo.multiplier
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION member_ledger(uuid, uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_ledger(uuid, uuid, bigint, integer) TO questify_app;

-- ================================================================ the readers show a flash quest only in its window
-- As 0054, for a quest shown now (flash_shown). A live poll is never flash (the table's CHECK), so member_poll and
-- poll_results are unchanged.
CREATE OR REPLACE FUNCTION member_vote(target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, mine boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, q.type_config FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'vote' AND q.visible AND sees_category(n.id, c) AND quest_community_lock(q) IS NULL
      AND flash_shown(q)
  )
  SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
         EXISTS (SELECT 1 FROM quest_vote v WHERE v.enrollment_id = me.id AND v.quest_id = target
                   AND v.option_id = o ->> 'id')
  FROM me, jsonb_array_elements(me.type_config -> 'options') WITH ORDINALITY AS t(o, i)
  ORDER BY i
$$;

-- As 0054, for a quest shown now, and `earned` what the quiz paid (its entry) or will pay (times the boost at its
-- start).
CREATE OR REPLACE FUNCTION member_quiz(target uuid)
  RETURNS TABLE (status text, total integer, points_each integer, timer_seconds integer, right_count integer,
                 earned bigint, completion_id bigint, server_now timestamptz, current jsonb, answered jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id AS enrollment_id, n AS enrolled, q AS quest_row, q.id AS quest_id, q.points, q.type_config
    FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'quiz' AND q.visible AND sees_category(n.id, c) AND quest_community_lock(q) IS NULL
      AND flash_shown(q)
  ), served AS (
    SELECT a.*, t.timer_seconds, quiz_question(me.type_config, a.position) AS asked,
           a.answered_at IS NULL AND NOT a.closed AND NOT quiz_overdue(a.served_at, t.timer_seconds) AS open_now
    FROM me
    JOIN quiz_attempt t ON t.enrollment_id = me.enrollment_id AND t.quest_id = me.quest_id
    JOIN quiz_answer a ON a.attempt_id = t.id
  )
  SELECT coalesce(t.status, 'none'),
         jsonb_array_length(me.type_config -> 'questions'),
         coalesce(t.points_each, me.points),
         coalesce(t.timer_seconds, (me.type_config ->> 'timerSeconds')::integer),
         coalesce(t.right_count, 0),
         coalesce((SELECT l.score_delta FROM ledger_entry l
                   WHERE l.completion_id = t.completion_id AND l.kind = 'quest'),
                  t.right_count::bigint * t.points_each
                    * coalesce((quest_boost(me.quest_row, me.enrolled, t.started_at)).multiplier, 1),
                  0),
         t.completion_id,
         now(),
         (SELECT jsonb_build_object(
                   'position', r.position, 'id', r.question_id, 'text', r.asked -> 'text',
                   'choices', (SELECT jsonb_agg(jsonb_build_object('id', c -> 'id', 'text', c -> 'text') ORDER BY j)
                               FROM jsonb_array_elements(r.asked -> 'choices') WITH ORDINALITY AS u(c, j)),
                   'servedAt', r.served_at,
                   'closesAt', CASE WHEN r.timer_seconds IS NOT NULL
                                    THEN r.served_at + make_interval(secs => r.timer_seconds) END)
          FROM served r WHERE r.open_now),
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'position', r.position, 'id', r.question_id, 'text', r.asked -> 'text',
                     'choices', (SELECT jsonb_agg(jsonb_build_object('id', c -> 'id', 'text', c -> 'text') ORDER BY j)
                                 FROM jsonb_array_elements(r.asked -> 'choices') WITH ORDINALITY AS u(c, j)),
                     'choiceId', r.choice_id, 'rightChoiceId', r.asked -> 'right', 'right', r.correct,
                     'closed', r.answered_at IS NULL) ORDER BY r.position)
                   FROM served r WHERE NOT r.open_now), '[]'::jsonb)
  FROM me
  LEFT JOIN quiz_attempt t ON t.enrollment_id = me.enrollment_id AND t.quest_id = me.quest_id
$$;

CREATE OR REPLACE FUNCTION member_survey(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'questions', q.type_config -> 'questions',
           'answered', EXISTS (SELECT 1 FROM survey_response r WHERE r.enrollment_id = n.id AND r.quest_id = q.id))
  FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type = 'survey' AND q.visible AND sees_category(n.id, c) AND quest_community_lock(q) IS NULL
    AND flash_shown(q)
$$;

CREATE OR REPLACE FUNCTION member_share(target uuid)
  RETURNS TABLE (event_id uuid, message_ar text, message_en text, link text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.event_id, q.type_config -> 'message' ->> 'ar', q.type_config -> 'message' ->> 'en', q.type_config ->> 'link',
         EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = n.id AND qc.quest_id = q.id)
  FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type = 'share' AND q.visible AND share_quests_on(q.event_id) AND sees_category(n.id, c)
    AND quest_community_lock(q) IS NULL AND flash_shown(q)
$$;

CREATE OR REPLACE FUNCTION member_passport(target uuid)
  RETURNS TABLE (needed integer, step_id uuid, name_ar text, name_en text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM quest q
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    JOIN category c ON c.id = q.category_id
    WHERE q.id = target AND q.type = 'passport' AND q.visible AND sees_category(n.id, c)
      AND quest_community_lock(q) IS NULL AND flash_shown(q)
  )
  SELECT (q.type_config ->> 'needed')::int, s.id, s.name_ar, s.name_en,
         EXISTS (SELECT 1 FROM passport_stamp p WHERE p.enrollment_id = me.id AND p.step_id = s.id)
  FROM me
  JOIN quest q ON q.id = target
  JOIN passport_step s ON s.quest_id = q.id
  ORDER BY s.position, s.id
$$;

-- As 0054; a flash quest outside its window answers QN403 hidden (its reader expects one row, as the lock).
CREATE OR REPLACE FUNCTION member_game(target uuid)
  RETURNS TABLE (game text, level text, params jsonb, attempts integer, cooldown_minutes integer, used integer,
                 attempts_left integer, passed boolean, done boolean, retry_at timestamptz, open_round bigint,
                 open_deadline timestamptz, last_verdict text, last_result jsonb, server_now timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE := play_quest(target, 'game');
  member    uuid;
BEGIN
  IF quest_community_lock(quest_row) IS NOT NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'community_locked';
  END IF;
  IF NOT flash_shown(quest_row) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  SELECT n.id INTO member FROM enrollment n WHERE n.event_id = quest_row.event_id AND n.player_id = app_player_id();
  RETURN QUERY
  SELECT quest_row.type_config ->> 'game', quest_row.type_config ->> 'level',
         game_level(quest_row.type_config ->> 'game', quest_row.type_config ->> 'level'),
         (quest_row.type_config ->> 'attempts')::integer, (quest_row.type_config ->> 'cooldownMinutes')::integer,
         a.used, game_left(member, quest_row), a.passed, quest_done(member, quest_row.id),
         CASE WHEN jsonb_typeof(quest_row.type_config -> 'attempts') = 'null' AND a.last_issue IS NOT NULL
              THEN a.last_issue + make_interval(mins => (quest_row.type_config ->> 'cooldownMinutes')::integer) END,
         a.open_round, o.deadline_at,
         CASE WHEN f.status = 'passed' AND f.completion_id IS NULL THEN 'done' ELSE f.status END, f.result, now()
  FROM game_attempts(member, quest_row) a
  LEFT JOIN game_round o ON o.id = a.open_round
  LEFT JOIN LATERAL (SELECT r.status, r.completion_id, r.result FROM game_round r
                     WHERE r.enrollment_id = member AND r.quest_id = quest_row.id
                       AND r.status IN ('passed', 'short', 'refused')
                     ORDER BY r.finished_at DESC, r.id DESC LIMIT 1) f ON true;
END $$;

-- As 0054, never a flash quest: a surprise drop is not advertised.
CREATE OR REPLACE FUNCTION public_event_quests(code text)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, opens_at timestamptz, closes_at timestamptz, quest_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.opens_at, q.closes_at, q.position
  FROM event e
  JOIN category c ON c.event_id = e.id AND c.audience_kind IS NULL AND NOT c.hidden
  JOIN quest q ON q.category_id = c.id AND q.event_id = e.id AND q.visible AND NOT q.flash
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND e.access <> 'private'
    AND quest_community_lock(q) IS NULL
  ORDER BY c.position, c.id, q.position, q.id
$$;

-- As 0054, with a flash quest only while shown.
CREATE OR REPLACE FUNCTION operator_award_quests(target_event uuid)
  RETURNS TABLE (quest_id uuid, title_ar text, title_en text, points integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.id, q.title_ar, q.title_en, q.points
  FROM staff_assignment sa
  JOIN quest q ON q.event_id = sa.event_id
  LEFT JOIN category c ON c.id = q.category_id
  WHERE sa.event_id = target_event AND sa.player_id = app_player_id() AND 'award' = ANY (sa.abilities)
    AND q.visible AND (q.opens_at IS NULL OR q.opens_at <= now()) AND (q.closes_at IS NULL OR q.closes_at > now())
    AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = sa.id)
         OR q.id IN (SELECT s.quest_id FROM staff_assignment_quest s WHERE s.assignment_id = sa.id))
    AND quest_community_lock(q) IS NULL AND flash_shown(q)
  ORDER BY c.position NULLS LAST, q.position, q.id
$$;

-- ================================================================ the player's quest list
-- As 0054, with flash quests only while shown, `flash_closes_at` (a flash quest's end, NULL for any other) and
-- `boost` (the running boost of the quest's category for this member, by boost_in_force, computed once per category:
-- `{boostId, multiplier, endsAt}`, NULL when none). The output changed: DROP and CREATE.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz,
                 item_ar text, item_en text, bonus_item_ar text, bonus_item_en text, place_lat numeric,
                 place_lng numeric, place_radius_m integer, daily_cap integer, met_today integer,
                 game_left integer, game_passed boolean, community_lock jsonb, category_community_lock jsonb,
                 flash_closes_at timestamptz, boost jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, n AS enrolled FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         period_count(me.id, q)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL)
           + CASE WHEN q.type = 'game' AND period_count(me.id, q) = 0 AND game_spent(me.id, q) THEN 1 ELSE 0 END,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification,
         c.order_mode, c.opens_at, c.unlock_after,
         CASE WHEN sees_category(me.id, u) THEN u.name_ar END,
         CASE WHEN sees_category(me.id, u) THEN u.name_en END,
         c.completion_bonus,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.category_id = c.id),
         EXISTS (SELECT 1 FROM category_bonus b
                 WHERE b.enrollment_id = me.id AND b.category_id = c.id
                   AND b.period_start >= category_period_start(c, e)),
         CASE WHEN k.step IS NOT NULL THEN 'community_locked' ELSE category_rule_lock(q, me.id) END,
         CASE WHEN q.type = 'passport' THEN (SELECT count(*)::int FROM passport_stamp p
                                             WHERE p.enrollment_id = me.id AND p.quest_id = q.id) END,
         CASE WHEN q.type = 'passport' THEN (q.type_config ->> 'needed')::int END,
         c.refresh,
         category_resets_at(c, e),
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_ar END,
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_en END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_ar END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_en END,
         CASE WHEN q.type = 'location' THEN q.place_lat END,
         CASE WHEN q.type = 'location' THEN q.place_lng END,
         CASE WHEN q.type = 'location' THEN q.place_radius_m END,
         CASE WHEN q.type = 'meet' THEN (q.type_config ->> 'dailyCap')::int END,
         CASE WHEN q.type = 'meet' THEN meet_today(me.id, q) END,
         CASE WHEN q.type = 'game' THEN game_left(me.id, q) END,
         CASE WHEN q.type = 'game' THEN (SELECT a.passed FROM game_attempts(me.id, q) a) END,
         community_lock_note(k.step),
         community_lock_note(k.category_step),
         CASE WHEN q.flash THEN q.closes_at END,
         CASE WHEN (cb.running).id IS NOT NULL
              THEN jsonb_build_object('boostId', (cb.running).id, 'multiplier', (cb.running).multiplier,
                                      'endsAt', (cb.running).ends_at) END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  CROSS JOIN LATERAL (SELECT boost_in_force(c.id, me.enrolled, now()) AS running) cb
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible AND flash_shown(q)
  CROSS JOIN LATERAL (SELECT category_community_lock(c.id) AS category_step) kc
  CROSS JOIN LATERAL (SELECT coalesce(
                        (SELECT s.id FROM community_step s
                         WHERE s.unlock_quest_id = q.id
                           AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)),
                        kc.category_step) AS step, kc.category_step) k
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ live (until T-501's push)
-- As 0054, plus `flash` (the flash quests open now that the member may play, with their titles: their window, a
-- category they see, no rule lock, not done) and `boosts` (the running boosts of the categories they see, with the
-- category's name, by boost_in_force, so a rehearsal boost is never shown to a real player and a hidden category's never to one
-- who has not found it). A member who may not play gets neither.
CREATE OR REPLACE FUNCTION live_state(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  playing  boolean;
BEGIN
  SELECT n.* INTO enrolled FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL, 'flash', '[]'::jsonb,
                              'boosts', '[]'::jsonb);
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target;
  IF NOT polls_shown(ev) THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL, 'flash', '[]'::jsonb,
                              'boosts', '[]'::jsonb);
  END IF;
  playing := play_phase(ev, enrolled) IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target AND sa.player_id = enrolled.player_id AND NOT sa.can_play);
  RETURN jsonb_build_object(
    'polls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id, 'closesAt', least(q.closes_at, ev.ends_at))
                       ORDER BY q.opens_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE playing AND q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.opens_at <= now() AND q.closes_at > now() AND (ev.ends_at IS NULL OR ev.ends_at > now())
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = enrolled.id AND qc.quest_id = q.id)),
      '[]'::jsonb),
    'closed', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id) ORDER BY q.closes_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.type_config -> 'live' ->> 'results' = 'at_close'
        AND least(q.closes_at, ev.ends_at) <= now() AND least(q.closes_at, ev.ends_at) > now() - interval '15 minutes'
        AND sees_category(enrolled.id, c) AND quest_community_lock(q) IS NULL),
      '[]'::jsonb),
    'community', member_community(ev, enrolled.id),
    'flash', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id,
                                          'title', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
                                          'closesAt', q.closes_at) ORDER BY q.opens_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE playing AND q.event_id = target AND q.flash AND q.visible AND flash_shown(q)
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT quest_done(enrolled.id, q.id)),
      '[]'::jsonb),
    'boosts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('boostId', (r.running).id, 'categoryId', c.id,
                                          'category', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
                                          'multiplier', (r.running).multiplier, 'endsAt', (r.running).ends_at)
                       ORDER BY (r.running).starts_at, (r.running).id)
      FROM category c
      CROSS JOIN LATERAL (SELECT boost_in_force(c.id, enrolled, now()) AS running) r
      WHERE playing AND c.event_id = target AND (r.running).id IS NOT NULL AND sees_category(enrolled.id, c)),
      '[]'::jsonb));
END $$;

-- As 0053, also true for 15 minutes after a flash quest opens or a boost starts (CTO 8), as the polls' tail: the
-- cards are learned in that tail, and the quest list carries the badge for the rest of the window.
CREATE OR REPLACE FUNCTION event_has_live(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
                   AND q.closes_at > now() - interval '15 minutes')
      OR EXISTS (SELECT 1 FROM community_goal g
                 WHERE g.event_id = event_has_live.target AND g.settled_until IS NOT NULL
                   AND (g.final_at IS NULL OR g.final_at > now() - interval '30 minutes'))
      OR EXISTS (SELECT 1 FROM quest q
                 WHERE q.event_id = target AND q.flash AND q.visible AND q.opens_at <= now()
                   AND q.opens_at > now() - interval '15 minutes' AND q.closes_at > now())
      OR EXISTS (SELECT 1 FROM boost b
                 WHERE b.event_id = event_has_live.target AND b.starts_at <= now()
                   AND b.starts_at > now() - interval '15 minutes' AND b.ends_at > now())
$$;

-- ================================================================ Launch and End now (owners and editors, ADR-231)
-- The flash quest of this event to launch or end, locked, or AN404 (another organizer's, outside the caller's event
-- limit, or no such quest) and FN422 (not a flash quest). Internal.
CREATE FUNCTION team_flash(ev event, target_quest uuid) RETURNS quest
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AN404';
  END IF;
  IF NOT quest_row.flash THEN
    RAISE EXCEPTION 'not a flash quest' USING ERRCODE = 'FN422';
  END IF;
  RETURN quest_row;
END $$;
REVOKE ALL ON FUNCTION team_flash(event, uuid) FROM PUBLIC;

-- Launches a draft flash quest now for 1 to 1,440 minutes, never past the event's end (FR-251). As send_poll: in a
-- live event the go-live wipe runs first; before go-live only while a rehearsal is open (a rehearsal launch, put back
-- to draft by the wipe); otherwise FE409 event_not_live. FF403 feature_off while flash quests are switched off.
-- FL409: already_launched once a launch has closed (a second launch while open answers the first, `replayed`),
-- scheduled (a visible flash quest with its own window), community_locked, too_late (less than a minute left).
-- Audited `quest.flash_launch`.
CREATE FUNCTION launch_flash(target_event uuid, target_quest uuid, minutes integer, request uuid)
  RETURNS TABLE (opens_at timestamptz, closes_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  phase     text := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  -- Milliseconds, so the builder's read and write back of a launched quest leaves its window exactly as it was.
  at        timestamptz := date_trunc('milliseconds', now());
  quest_row quest%ROWTYPE;
  ends      timestamptz;
BEGIN
  IF minutes IS NULL OR minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'minutes are 1 to 1,440' USING ERRCODE = '22023';
  END IF;
  IF phase = 'live' THEN
    PERFORM ensure_rehearsal_wiped(ev.id);
  ELSIF phase NOT IN ('draft', 'scheduled') OR NOT EXISTS (
    SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL) THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'FE409', DETAIL = 'event_not_live';
  END IF;
  quest_row := team_flash(ev, target_quest);
  IF NOT flash_on(ev) THEN
    RAISE EXCEPTION 'flash quests are switched off' USING ERRCODE = 'FF403', DETAIL = 'feature_off';
  END IF;
  IF quest_row.flash_launched_at IS NOT NULL THEN
    IF quest_row.closes_at > now() THEN
      RETURN QUERY SELECT quest_row.opens_at, quest_row.closes_at, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'this flash quest ran and has ended' USING ERRCODE = 'FL409', DETAIL = 'already_launched';
  END IF;
  IF quest_row.visible THEN
    RAISE EXCEPTION 'this flash quest runs at its own times' USING ERRCODE = 'FL409', DETAIL = 'scheduled';
  END IF;
  IF quest_community_lock(quest_row) IS NOT NULL THEN
    RAISE EXCEPTION 'this quest is locked by a community goal' USING ERRCODE = 'FL409', DETAIL = 'community_locked';
  END IF;
  ends := date_trunc('milliseconds', least(at + make_interval(mins => minutes), ev.ends_at));
  IF ends < at + interval '1 minute' THEN
    RAISE EXCEPTION 'less than a minute is left' USING ERRCODE = 'FL409', DETAIL = 'too_late';
  END IF;
  UPDATE quest q SET visible = true, opens_at = at, closes_at = ends, flash_launched_at = at WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'quest.flash_launch', 'quest', quest_row.id::text,
          jsonb_build_object('opensAt', at, 'closesAt', ends, 'rehearsal', phase <> 'live'), request);
  RETURN QUERY SELECT at, ends, false;
END $$;
REVOKE ALL ON FUNCTION launch_flash(uuid, uuid, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION launch_flash(uuid, uuid, integer, uuid) TO questify_app;

-- Ends a running flash quest now, launched or scheduled, whatever is left. FL409 not_started for a draft or a
-- scheduled one whose window has not started (the builder edits or hides it instead, CTO 10); an ended one changes
-- nothing (`replayed`). Audited `quest.flash_end`.
CREATE FUNCTION end_flash(target_event uuid, target_quest uuid, request uuid)
  RETURNS TABLE (opens_at timestamptz, closes_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  at        timestamptz := date_trunc('milliseconds', now());
  quest_row quest%ROWTYPE;
  ends      timestamptz;
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  quest_row := team_flash(ev, target_quest);
  IF NOT quest_row.visible OR quest_row.opens_at > now() THEN
    RAISE EXCEPTION 'this flash quest has not started' USING ERRCODE = 'FL409', DETAIL = 'not_started';
  END IF;
  IF quest_row.closes_at <= now() THEN
    RETURN QUERY SELECT quest_row.opens_at, quest_row.closes_at, true;
    RETURN;
  END IF;
  ends := greatest(at, quest_row.opens_at + interval '1 millisecond');
  UPDATE quest q SET closes_at = ends WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'quest.flash_end', 'quest', quest_row.id::text,
          jsonb_build_object('closesAt', quest_row.closes_at), jsonb_build_object('closesAt', ends), request);
  RETURN QUERY SELECT quest_row.opens_at, ends, false;
END $$;
REVOKE ALL ON FUNCTION end_flash(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_flash(uuid, uuid, uuid) TO questify_app;

-- ================================================================ the boost builder (owners and editors, ADR-232)
-- The boost of this event, locked FOR UPDATE (it waits for a payer holding its key), and refused once it is frozen:
-- less than a minute before its start on the clock, or named by any entry (CTO 7). BN404, BO409 boost_started.
CREATE FUNCTION boost_editable(ev event, target_boost uuid) RETURNS boost
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  old boost%ROWTYPE;
BEGIN
  SELECT b.* INTO old FROM boost b WHERE b.id = target_boost AND b.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such boost in this event' USING ERRCODE = 'BN404';
  END IF;
  IF old.starts_at <= clock_timestamp() + interval '1 minute'
     OR EXISTS (SELECT 1 FROM ledger_entry l WHERE l.boost_id = old.id) THEN
    RAISE EXCEPTION 'a started boost can only be stopped' USING ERRCODE = 'BO409', DETAIL = 'boost_started';
  END IF;
  RETURN old;
END $$;
REVOKE ALL ON FUNCTION boost_editable(event, uuid) FROM PUBLIC;

-- Saves a new boost (`target_boost` NULL) or edits a scheduled one: its category, a start (NULL or up to 60 s ago is
-- now) and 1 to 1,440 minutes. While the rehearsal is open, a boost starting before the event's start (or any boost
-- while the event has none) is a rehearsal boost, which must end by the start when there is one; every other boost
-- sits inside the event's window. Refusals: BN404, BO409 (boost_started, event_ended, limit_reached at 100 an event,
-- boost_overlap with a boost of the same category and kind, checked under the event's advisory lock), BO422 (category,
-- startsAt, minutes, outside_event). Audited `boost.create` / `boost.update`. Answers the boost's id.
CREATE FUNCTION save_boost(target_event uuid, target_boost uuid, target_category uuid, starts timestamptz,
                           minutes integer, request uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  old        boost%ROWTYPE;
  begins     timestamptz := date_trunc('milliseconds', coalesce(starts, now()));
  ends       timestamptz;
  rehearsing boolean;
  practice   boolean;
  saved      uuid;
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT * INTO ev FROM event e WHERE e.id = ev.id;
  PERFORM pg_advisory_xact_lock(hashtextextended('boost:' || ev.id, 0));
  IF target_boost IS NOT NULL THEN
    old := boost_editable(ev, target_boost);
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'BO409', DETAIL = 'event_ended';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM category c WHERE c.id = target_category AND c.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such category in this event' USING ERRCODE = 'BO422', DETAIL = 'category';
  END IF;
  IF minutes IS NULL OR minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'minutes are 1 to 1,440' USING ERRCODE = 'BO422', DETAIL = 'minutes';
  END IF;
  IF begins < date_trunc('milliseconds', now()) - interval '60 seconds' THEN
    RAISE EXCEPTION 'the start is more than a minute ago' USING ERRCODE = 'BO422', DETAIL = 'startsAt';
  END IF;
  begins := greatest(begins, date_trunc('milliseconds', now()));
  ends := begins + make_interval(mins => minutes);
  rehearsing := event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('draft', 'scheduled')
    AND EXISTS (SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL);
  practice := rehearsing AND (ev.starts_at IS NULL OR begins < ev.starts_at);
  IF (practice AND ev.starts_at IS NOT NULL AND ends > ev.starts_at)
     OR (NOT practice
         AND (ev.starts_at IS NULL OR ev.ends_at IS NULL OR begins < ev.starts_at OR ends > ev.ends_at)) THEN
    RAISE EXCEPTION 'the boost is outside the event' USING ERRCODE = 'BO422', DETAIL = 'outside_event';
  END IF;
  IF target_boost IS NULL AND (SELECT count(*) FROM boost b WHERE b.event_id = ev.id) >= 100 THEN
    RAISE EXCEPTION 'an event has at most 100 boosts' USING ERRCODE = 'BO409', DETAIL = 'limit_reached';
  END IF;
  IF EXISTS (SELECT 1 FROM boost b
             WHERE b.category_id = target_category AND b.rehearsal = practice AND b.id IS DISTINCT FROM target_boost
               AND tstzrange(b.starts_at, b.ends_at) && tstzrange(begins, ends)) THEN
    RAISE EXCEPTION 'another boost runs on this category at that time' USING ERRCODE = 'BO409',
      DETAIL = 'boost_overlap';
  END IF;

  IF target_boost IS NULL THEN
    INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at, rehearsal, created_by)
    VALUES (ev.organizer_id, ev.id, target_category, begins, ends, practice, app_staff_user_id())
    RETURNING id INTO saved;
  ELSE
    UPDATE boost b SET category_id = target_category, starts_at = begins, ends_at = ends, rehearsal = practice
    WHERE b.id = old.id;
    saved := old.id;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id,
          CASE WHEN target_boost IS NULL THEN 'boost.create' ELSE 'boost.update' END, 'boost', saved::text,
          CASE WHEN target_boost IS NOT NULL
               THEN jsonb_build_object('categoryId', old.category_id, 'startsAt', old.starts_at, 'endsAt', old.ends_at)
          END,
          jsonb_build_object('categoryId', target_category, 'startsAt', begins, 'endsAt', ends, 'rehearsal', practice),
          request);
  RETURN saved;
END $$;
REVOKE ALL ON FUNCTION save_boost(uuid, uuid, uuid, timestamptz, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_boost(uuid, uuid, uuid, timestamptz, integer, uuid) TO questify_app;

-- Deletes a boost until a minute before its start, never once an entry names it. Audited `boost.delete`.
CREATE FUNCTION delete_boost(target_event uuid, target_boost uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  old boost%ROWTYPE;
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  old := boost_editable(ev, target_boost);
  DELETE FROM boost b WHERE b.id = old.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'boost.delete', 'boost', old.id::text,
          jsonb_build_object('categoryId', old.category_id, 'startsAt', old.starts_at, 'endsAt', old.ends_at), request);
END $$;
REVOKE ALL ON FUNCTION delete_boost(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_boost(uuid, uuid, uuid) TO questify_app;

-- Stops a running boost now (`ends_at`, a no-key update: a payer holding the boost's key never waits). BN404; BO409
-- not_started before its start (Delete until a minute before it); a stopped or ended boost changes nothing
-- (`replayed`). Audited `boost.end`.
CREATE FUNCTION end_boost(target_event uuid, target_boost uuid, request uuid)
  RETURNS TABLE (starts_at timestamptz, ends_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  at  timestamptz := date_trunc('milliseconds', now());
  old boost%ROWTYPE;
  ends timestamptz;
BEGIN
  SELECT b.* INTO old FROM boost b WHERE b.id = target_boost AND b.event_id = ev.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such boost in this event' USING ERRCODE = 'BN404';
  END IF;
  IF old.starts_at > now() THEN
    RAISE EXCEPTION 'the boost has not started' USING ERRCODE = 'BO409', DETAIL = 'not_started';
  END IF;
  IF old.ends_at <= now() THEN
    RETURN QUERY SELECT old.starts_at, old.ends_at, true;
    RETURN;
  END IF;
  ends := greatest(at, old.starts_at + interval '1 millisecond');
  UPDATE boost b SET ends_at = ends WHERE b.id = old.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'boost.end', 'boost', old.id::text,
          jsonb_build_object('endsAt', old.ends_at), jsonb_build_object('endsAt', ends), request);
  RETURN QUERY SELECT old.starts_at, ends, false;
END $$;
REVOKE ALL ON FUNCTION end_boost(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_boost(uuid, uuid, uuid) TO questify_app;

-- The event's boosts for the Boosts page, by start: the category and its names, the window, whether it is a rehearsal
-- boost, whether it may still be edited or deleted, and how many entries it paid.
CREATE FUNCTION event_boosts(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', b.id, 'categoryId', b.category_id, 'category', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
      'multiplier', b.multiplier, 'startsAt', b.starts_at, 'endsAt', b.ends_at, 'rehearsal', b.rehearsal,
      'editable', b.starts_at > clock_timestamp() + interval '1 minute'
                  AND NOT EXISTS (SELECT 1 FROM ledger_entry l WHERE l.boost_id = b.id),
      'paid', (SELECT count(*) FROM ledger_entry l WHERE l.boost_id = b.id AND l.kind = 'quest'))
      ORDER BY b.starts_at, b.id)
    FROM boost b JOIN category c ON c.id = b.category_id
    WHERE b.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION event_boosts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_boosts(uuid) TO questify_app;

-- ================================================================ the rehearsal wipe
-- As 0052, plus: after the rehearsal's ledger rows (they name the boosts), its rehearsal boosts are deleted, and its
-- launched flash quests go back to draft beside its sent polls. Real boosts and scheduled flash quests stay.
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
           'votes', (SELECT count(DISTINCT (v.enrollment_id, v.quest_id)) FROM quest_vote v
                     WHERE v.enrollment_id = ANY (accounts)),
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)),
           'surveys', (SELECT count(*) FROM survey_response r WHERE r.enrollment_id = ANY (accounts)),
           'reveals', (SELECT count(*) FROM category_reveal r WHERE r.enrollment_id = ANY (accounts)),
           'item_misses', (SELECT count(*) FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts)),
           'games', (SELECT count(*) FROM game_round g WHERE g.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  DELETE FROM category_bonus b WHERE b.enrollment_id = ANY (accounts);
  DELETE FROM category_reveal r WHERE r.enrollment_id = ANY (accounts);
  DELETE FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts);
  PERFORM set_config('questify.rehearsal_wipe', target::text, true);
  DELETE FROM ledger_note t WHERE t.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM manual_award_key k
  WHERE k.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal AND l.reverses IS NOT NULL;
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;
  GET DIAGNOSTICS entries = ROW_COUNT;
  PERFORM set_config('questify.rehearsal_wipe', '', true);
  DELETE FROM boost b WHERE b.event_id = target AND b.rehearsal;
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
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (accounts);
  DELETE FROM quest_completion c WHERE c.enrollment_id = ANY (accounts);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- The rehearsal's sent polls and launched flash quests go back to draft (no plays are left on them).
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, poll_sent_at = NULL
  WHERE q.event_id = target AND q.poll_sent_at IS NOT NULL;
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, flash_launched_at = NULL
  WHERE q.event_id = target AND q.flash_launched_at IS NOT NULL;
  -- Stock from what remains (FR-1722): every reservation still holding a unit.
  UPDATE reward r SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.reward_id = r.id AND d.status IN ('reserved', 'handed_over', 'delivered'))
  WHERE r.event_id = target;
  UPDATE quest_item i SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.quest_item_id = i.id AND d.status IN ('reserved', 'handed_over'))
  WHERE i.event_id = target;

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
