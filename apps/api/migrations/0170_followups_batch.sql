-- FOLLOWUPS batch 16 (docs/FOLLOWUPS.md). One function restated with the same arguments, so its grants stay:
-- record_completion. No new table, column or function. Nothing here writes points differently: a first completion runs as
-- 0098 left it, and a replay still writes nothing. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ a replay answers the current net (T-604)
-- As 0098, with one change: a replayed key answers the quest entry with its adjusts and its own removal folded in, what
-- the completion is worth now, not what it paid first. Score only, as the first answer. A bonus or a removal of a bonus
-- on the same completion stays out: the first answer never held a bonus.
CREATE OR REPLACE FUNCTION public.record_completion(target uuid, who uuid, proof_method text, proof_version integer, typed_code text, request_key text, device uuid, operator uuid, staff uuid, reason text, expected_event uuid, reading jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  quest_row      quest%ROWTYPE;
  enrolled       enrollment%ROWTYPE;
  earlier        quest_completion%ROWTYPE;
  earlier_by     uuid;
  earlier_staff  uuid;
  earlier_entry  bigint;
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
  -- A `kiosk:` key is the kiosk door's alone, and the kiosk method takes no other key (ADR-244).
  IF (coalesce(request_key, '') LIKE 'kiosk:%') IS DISTINCT FROM (proof_method = 'kiosk') THEN
    RAISE EXCEPTION 'this key is reserved' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target FOR KEY SHARE;
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
    SELECT l.id, l.operator_id, l.staff_user_id INTO earlier_entry, earlier_by, earlier_staff
    FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    IF earlier.quest_id <> target OR earlier.method <> proof_method OR earlier_by IS DISTINCT FROM operator
       OR earlier_staff IS DISTINCT FROM staff THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, sum(l.score_delta)::bigint, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l
      WHERE l.completion_id = earlier.id
        AND (l.kind IN ('quest', 'adjust') OR (l.kind = 'removal' AND l.reverses = earlier_entry));
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
            OR (quest_row.type = 'scan_qr' AND proof_method = 'nfc' AND 'nfc' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'screen_qr'
                AND 'screen_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'kiosk' AND 'kiosk' = ANY (quest_row.verification))
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
    IF proof_method IN ('screen_qr', 'kiosk') AND NOT screen_window_ok(proof_version, now()) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'expired';
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
  -- One pay per player per screen window (CTO 6), read under the enrollment lock taken above; a live code likewise,
  -- each method on its own (the first condition keeps quest_completion_window_idx usable).
  IF proof_method IN ('screen_qr', 'kiosk') AND EXISTS (
    SELECT 1 FROM quest_completion c
    WHERE c.enrollment_id = enrolled.id AND c.quest_id = target AND c.method IN ('screen_qr', 'kiosk')
      AND c.method = proof_method
      AND c.created_at > now() - interval '45 seconds') THEN
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
  PERFORM pay_first_bonus(enrolled, target, made, request_key);

  RETURN QUERY SELECT made, paid, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$
;
