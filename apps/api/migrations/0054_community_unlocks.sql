-- Unlock rewards (T-306c, F-101, FR-247, ADR-227 to ADR-229; plan docs/plans/2026-10-24-t-306c-unlock-rewards.md). A
-- community step may unlock one quest, one category or one shop reward of its event: the target is locked from the
-- goal's save until the step's reach, the same for every player. Every door and reader that serves the target passes
-- the gate below. Deny by default: no new table, no grant change on community_step (RLS forced, closed); every new
-- function is closed to PUBLIC here; the restated doors keep their grants, the re-created ones get theirs again.

-- ================================================================ the step names its target (ADR-227)
-- One target a step, in its own column, in the step's own event; a direct delete of a target is refused (the quest and
-- category builders answer goal_in_use). One lock a target for the event's life: the unique indexes span every step,
-- reached or not.
ALTER TABLE community_step DROP CONSTRAINT community_step_reward_check;
ALTER TABLE community_step ADD CONSTRAINT community_step_reward_check
  CHECK (reward IN ('points', 'moment', 'nothing', 'unlock'));
ALTER TABLE community_step
  ADD COLUMN unlock_quest_id uuid,
  ADD COLUMN unlock_category_id uuid,
  ADD COLUMN unlock_reward_id uuid,
  ADD CONSTRAINT community_step_unlock_quest_fkey FOREIGN KEY (unlock_quest_id, event_id)
    REFERENCES quest (id, event_id),
  ADD CONSTRAINT community_step_unlock_category_fkey FOREIGN KEY (unlock_category_id, event_id)
    REFERENCES category (id, event_id),
  ADD CONSTRAINT community_step_unlock_reward_fkey FOREIGN KEY (unlock_reward_id, event_id)
    REFERENCES reward (id, event_id),
  ADD CONSTRAINT community_step_unlock_shape
    CHECK (num_nonnulls(unlock_quest_id, unlock_category_id, unlock_reward_id)
           = CASE WHEN reward = 'unlock' THEN 1 ELSE 0 END);
CREATE UNIQUE INDEX community_step_unlock_quest_key ON community_step (unlock_quest_id)
  WHERE unlock_quest_id IS NOT NULL;
CREATE UNIQUE INDEX community_step_unlock_category_key ON community_step (unlock_category_id)
  WHERE unlock_category_id IS NOT NULL;
CREATE UNIQUE INDEX community_step_unlock_reward_key ON community_step (unlock_reward_id)
  WHERE unlock_reward_id IS NOT NULL;

-- A draft event's delete cascades to its quests, categories and rewards before its goals (the keys' triggers run in
-- the order the keys were made), so a goal or step naming one would stop it. The event's goals go first, with their
-- steps; a direct delete of a target is still refused. 0053's goals on a counted quest had the same trap.
CREATE FUNCTION event_delete_goals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM community_goal g WHERE g.event_id = OLD.id;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION event_delete_goals() FROM PUBLIC;
CREATE TRIGGER event_delete_goals BEFORE DELETE ON event FOR EACH ROW EXECUTE FUNCTION event_delete_goals();

-- ================================================================ the gate (internal)
-- The waiting step that locks a category as a whole, or NULL. One probe of the partial unique index, then the reach.
CREATE FUNCTION category_community_lock(target uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.id FROM community_step s
  WHERE s.unlock_category_id = target AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)
$$;
REVOKE ALL ON FUNCTION category_community_lock(uuid) FROM PUBLIC;

-- The step holding the quest shut: its own first, then its category's; NULL when free. The same for every player.
CREATE FUNCTION quest_community_lock(quest_row quest) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(
    (SELECT s.id FROM community_step s
     WHERE s.unlock_quest_id = quest_row.id AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)),
    category_community_lock(quest_row.category_id))
$$;
REVOKE ALL ON FUNCTION quest_community_lock(quest) FROM PUBLIC;

-- The step holding a shop reward shut, or NULL.
CREATE FUNCTION reward_community_lock(reward_row reward) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.id FROM community_step s
  WHERE s.unlock_reward_id = reward_row.id AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)
$$;
REVOKE ALL ON FUNCTION reward_community_lock(reward) FROM PUBLIC;

-- Whether a step's lock is missed for good (ADR-229): no reach, and its goal is final or missed. That counts a
-- milestone left unreached on a goal that ended `reached` too. False for NULL.
CREATE FUNCTION community_lock_missed(step uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM community_step s JOIN community_goal g ON g.id = s.goal_id
                 WHERE s.id = step AND (g.final_at IS NOT NULL OR g.status = 'missed')
                   AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id))
$$;
REVOKE ALL ON FUNCTION community_lock_missed(uuid) FROM PUBLIC;

-- Whether a quest can never open because its own lock or its category's was missed (CTO 2): such a quest is left out
-- of the category rules, as live polls are.
CREATE FUNCTION quest_lock_missed(quest_row quest) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT community_lock_missed((SELECT s.id FROM community_step s WHERE s.unlock_quest_id = quest_row.id))
      OR community_lock_missed((SELECT s.id FROM community_step s WHERE s.unlock_category_id = quest_row.category_id))
$$;
REVOKE ALL ON FUNCTION quest_lock_missed(quest) FROM PUBLIC;

-- What a player is told about a lock (CTO 11), NULL for a NULL step: the goal and its numbers, never the target.
-- `scheduled` until the goal's first settle (with `startsAt`), `waiting` while it runs, `missed` for good.
CREATE FUNCTION community_lock_note(step uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'goalId', g.id, 'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure,
    'threshold', s.threshold,
    'state', CASE WHEN community_lock_missed(s.id) THEN 'missed'
                  WHEN g.settled_until IS NULL THEN 'scheduled' ELSE 'waiting' END,
    'startsAt', g.starts_at)
  FROM community_step s JOIN community_goal g ON g.id = s.goal_id
  WHERE s.id = step
$$;
REVOKE ALL ON FUNCTION community_lock_note(uuid) FROM PUBLIC;

-- ================================================================ the category rules know the lock (CTO 2)
-- As 0052, with quests whose lock was missed left out: a category whose other quests are done is done (its bonus pays
-- on the completion that finishes it; nothing pays it later on its own, ADR-227). A waiting lock counts as today.
CREATE OR REPLACE FUNCTION category_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.category_id = target AND q.visible AND NOT is_live_poll(q.type, q.type_config)
                   AND NOT quest_lock_missed(q))
     AND NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND NOT is_live_poll(q.type, q.type_config)
                       AND NOT quest_lock_missed(q) AND NOT quest_done(member, q.id))
$$;

-- As 0052, with quests whose lock was missed left out: a category locked as a whole whose lock was missed is cleared,
-- so the category that unlocks after it opens.
CREATE OR REPLACE FUNCTION category_cleared(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND (q.closes_at IS NULL OR q.closes_at > now())
                       AND NOT is_live_poll(q.type, q.type_config) AND NOT quest_lock_missed(q)
                       AND NOT quest_done(member, q.id))
$$;

-- 0052's category_lock without the community lock: the opening time, the unlock and the in-order rule, with a
-- missed-locked quest never the earlier quest that blocks. member_event_quests calls it with the lock read once.
CREATE FUNCTION category_rule_lock(quest_row quest, member uuid) RETURNS text
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
  IF group_row.order_mode = 'in_order' AND NOT is_live_poll(quest_row.type, quest_row.type_config) AND EXISTS (
    SELECT 1 FROM quest q
    WHERE q.category_id = group_row.id AND q.visible AND (q.position, q.id) < (quest_row.position, quest_row.id)
      AND (q.closes_at IS NULL OR q.closes_at > now()) AND NOT is_live_poll(q.type, q.type_config)
      AND NOT quest_lock_missed(q) AND NOT quest_done(member, q.id)) THEN
    RETURN 'order_locked';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION category_rule_lock(quest, uuid) FROM PUBLIC;

-- As 0052, with the community lock first (`community_locked`), so quest_open_check refuses it at every door. An owner's
-- or editor's manual award skips category_lock, so it passes the lock as it passes every category rule.
CREATE OR REPLACE FUNCTION category_lock(quest_row quest, member uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN quest_community_lock(quest_row) IS NOT NULL THEN 'community_locked'
              ELSE category_rule_lock(quest_row, member) END
$$;

-- ================================================================ the completion engine (CTO 1)
-- As 0050, plus: an operator's capped award (`manual` with an operator) does not pass the community lock (QN403
-- community_locked); the owner's or editor's manual award does.
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

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff)
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

  RETURN QUERY SELECT made, quest_row.points::bigint, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- As 0030, without community-locked quests (CTO 1): an operator is not offered what they may not award.
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
    AND quest_community_lock(q) IS NULL
  ORDER BY c.position NULLS LAST, q.position, q.id
$$;

-- ================================================================ the shop (ADR-227)
-- As 0037, plus: a community-locked reward is not open (RW403 community_locked), after the reward's lock and the
-- audience check and before the shop state; in rehearsal too. A replay still answers. A goal saved while this runs
-- waits on the reward lock (its step's key takes KEY SHARE), or this waits on it and its later read sees the step.
CREATE OR REPLACE FUNCTION reserve_reward(target uuid, request_key text)
  RETURNS TABLE (redemption_id uuid, kind text, status text, price integer, reserved_until timestamptz,
                 balance bigint, stock_left integer, replayed boolean, code_cipher bytea)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me          uuid := app_player_id();
  found_ev    uuid;
  enrolled    enrollment%ROWTYPE;
  item        reward%ROWTYPE;
  ev          event%ROWTYPE;
  earlier     redemption%ROWTYPE;
  shop        text;
  desk        text;
  held        integer;
  code_id     bigint;
  spend_rank  integer := 0;
  pickup_from timestamptz := now();
  made        redemption%ROWTYPE;
  rehearsing  boolean;
  test_digital boolean;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.event_id INTO found_ev FROM reward r WHERE r.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM ensure_rehearsal_wiped(found_ev);
  SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = found_ev AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;

  SELECT * INTO earlier FROM redemption d WHERE d.enrollment_id = enrolled.id AND d.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.reward_id IS DISTINCT FROM target THEN
      RAISE EXCEPTION 'this key was used for another reward' USING ERRCODE = 'RK422';
    END IF;
    RETURN QUERY SELECT earlier.id, r.kind, earlier.status, earlier.price, earlier.reserved_until, enrolled.balance,
                        r.stock_total - r.units_out, true,
                        (SELECT c.code_cipher FROM reward_code c WHERE c.redemption_id = earlier.id)
      FROM reward r WHERE r.id = target;
    RETURN;
  END IF;

  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  IF item.status <> 'active'
     OR NOT in_audience(enrolled.id, item.audience_kind, item.audience_field_id, item.audience_values) THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF reward_community_lock(item) IS NOT NULL THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'community_locked';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = item.event_id;
  rehearsing := play_phase(ev, enrolled) = 'rehearsal';
  shop := CASE WHEN rehearsing THEN 'open' ELSE shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) END;
  IF shop <> 'open' THEN
    RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = shop;
  END IF;
  IF item.kind IN ('item', 'experience') AND NOT rehearsing THEN
    desk := desk_state(ev.desk_hours);
    IF desk = 'finished' THEN
      RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = 'desk_finished';
    END IF;
    IF desk = 'closed' THEN
      SELECT min(lower(w)) INTO pickup_from FROM unnest(ev.desk_hours) w WHERE lower(w) > now();
    END IF;
  END IF;
  IF item.opens_at IS NOT NULL AND item.opens_at > now() THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'not_started';
  END IF;
  IF item.closes_at IS NOT NULL AND item.closes_at <= now() THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'ended';
  END IF;
  IF item.units_out >= item.stock_total THEN
    RAISE EXCEPTION 'sold out' USING ERRCODE = 'RO409';
  END IF;
  IF item.per_player_limit IS NOT NULL THEN
    SELECT count(*) INTO held FROM redemption d
    WHERE d.enrollment_id = enrolled.id AND d.reward_id = target AND d.status NOT IN ('cancelled', 'expired');
    IF held >= item.per_player_limit THEN
      RAISE EXCEPTION 'limit reached' USING ERRCODE = 'RL409', DETAIL = item.per_player_limit::text;
    END IF;
  END IF;
  IF enrolled.balance < item.price THEN
    RAISE EXCEPTION 'balance too low' USING ERRCODE = 'RB422';
  END IF;
  test_digital := item.kind = 'digital' AND rehearsing;
  IF item.kind = 'digital' AND NOT rehearsing THEN
    SELECT c.id INTO code_id FROM reward_code c
    WHERE c.reward_id = target AND c.redemption_id IS NULL ORDER BY c.id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a digital reward''s stock and codes disagree' USING ERRCODE = 'RX500';
    END IF;
  END IF;
  IF ev.spend_lowers_rank AND play_phase(ev, enrolled) IS NOT NULL THEN
    spend_rank := -item.price;
  END IF;

  INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, status,
                          reserved_until, ended_at, ended_by)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, item.price, request_key,
          CASE WHEN item.kind = 'digital' THEN 'delivered' ELSE 'reserved' END,
          CASE WHEN item.kind <> 'digital' THEN pickup_from + make_interval(mins => ev.pickup_minutes) END,
          CASE WHEN item.kind = 'digital' THEN now() END,
          CASE WHEN item.kind = 'digital' THEN 'delivery' END)
  RETURNING * INTO made;
  UPDATE reward_code c SET redemption_id = made.id WHERE c.id = code_id;
  IF NOT test_digital THEN
    UPDATE reward r SET units_out = r.units_out + 1 WHERE r.id = target;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'redeem', spend_rank, -item.price, made.id, 'player');
  IF spend_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (enrolled.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;

  RETURN QUERY SELECT made.id, item.kind, made.status, made.price, made.reserved_until, n.balance,
                      item.stock_total - item.units_out - CASE WHEN test_digital THEN 0 ELSE 1 END, false,
                      (SELECT c.code_cipher FROM reward_code c WHERE c.id = code_id)
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;

-- As 0047, with each reward's lock note (`community_lock`, NULL when open). The output changed: DROP and CREATE.
DROP FUNCTION shop_rewards(uuid);
CREATE FUNCTION shop_rewards(target uuid)
  RETURNS TABLE (id uuid, kind text, name_ar text, name_en text, description_ar text, description_en text,
                 price integer, stock_left integer, per_player_limit integer, opens_at timestamptz,
                 closes_at timestamptz, section text, tag_new boolean, tag_limited boolean, popular boolean,
                 held_by_me integer, community_lock jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  popular_floor CONSTANT integer := 3;
  popular_count CONSTANT integer := 3;
  mine          uuid;
BEGIN
  SELECT n.id INTO mine FROM enrollment n JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active';
  IF mine IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH taken AS (
    SELECT d.reward_id FROM redemption d
    WHERE d.event_id = target AND d.reward_id IS NOT NULL AND d.status NOT IN ('cancelled', 'expired')
    GROUP BY d.reward_id HAVING count(*) >= popular_floor
    ORDER BY count(*) DESC, d.reward_id LIMIT popular_count
  )
  SELECT r.id, r.kind, r.name_ar, r.name_en, r.description_ar, r.description_en, r.price,
         r.stock_total - r.units_out, r.per_player_limit, r.opens_at, r.closes_at, r.section, r.tag_new,
         r.tag_limited, EXISTS (SELECT 1 FROM taken t WHERE t.reward_id = r.id),
         (SELECT count(*)::integer FROM redemption d
          WHERE d.enrollment_id = mine AND d.reward_id = r.id AND d.status NOT IN ('cancelled', 'expired')),
         community_lock_note(reward_community_lock(r))
  FROM reward r
  WHERE r.event_id = target AND r.status = 'active'
    AND in_audience(mine, r.audience_kind, r.audience_field_id, r.audience_values)
  ORDER BY r.position, r.id;
END $$;
REVOKE ALL ON FUNCTION shop_rewards(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shop_rewards(uuid) TO questify_app;

-- ================================================================ the quest sheets serve nothing while locked (ADR-228)
-- As 0046, for a quest that is not community-locked.
CREATE OR REPLACE FUNCTION member_vote(target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, mine boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, q.type_config FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'vote' AND q.visible AND sees_category(n.id, c) AND quest_community_lock(q) IS NULL
  )
  SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
         EXISTS (SELECT 1 FROM quest_vote v WHERE v.enrollment_id = me.id AND v.quest_id = target
                   AND v.option_id = o ->> 'id')
  FROM me, jsonb_array_elements(me.type_config -> 'options') WITH ORDINALITY AS t(o, i)
  ORDER BY i
$$;

-- As 0046, for a quest that is not community-locked.
CREATE OR REPLACE FUNCTION member_quiz(target uuid)
  RETURNS TABLE (status text, total integer, points_each integer, timer_seconds integer, right_count integer,
                 earned bigint, completion_id bigint, server_now timestamptz, current jsonb, answered jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id AS enrollment_id, q.id AS quest_id, q.points, q.type_config
    FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'quiz' AND q.visible AND sees_category(n.id, c) AND quest_community_lock(q) IS NULL
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
         coalesce(t.right_count::bigint * t.points_each, 0),
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

-- As 0046, for a quest that is not community-locked.
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
$$;

-- As 0046, for a quest that is not community-locked.
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
    AND quest_community_lock(q) IS NULL
$$;

-- As 0046, for a quest that is not community-locked.
CREATE OR REPLACE FUNCTION member_passport(target uuid)
  RETURNS TABLE (needed integer, step_id uuid, name_ar text, name_en text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM quest q
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    JOIN category c ON c.id = q.category_id
    WHERE q.id = target AND q.type = 'passport' AND q.visible AND sees_category(n.id, c)
      AND quest_community_lock(q) IS NULL
  )
  SELECT (q.type_config ->> 'needed')::int, s.id, s.name_ar, s.name_en,
         EXISTS (SELECT 1 FROM passport_stamp p WHERE p.enrollment_id = me.id AND p.step_id = s.id)
  FROM me
  JOIN quest q ON q.id = target
  JOIN passport_step s ON s.quest_id = q.id
  ORDER BY s.position, s.id
$$;

-- As 0050; a community-locked game answers QN403 community_locked (its reader expects one row, so it refuses rather
-- than answer nothing).
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

-- As 0052, for a poll that is not community-locked.
CREATE OR REPLACE FUNCTION member_poll(target uuid)
  RETURNS TABLE (title_ar text, title_en text, points integer, choices text, results text, closes_at timestamptz,
                 closed boolean, mine text[], server_now timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.title_ar, q.title_en, q.points, q.type_config -> 'live' ->> 'choices', q.type_config -> 'live' ->> 'results',
         least(q.closes_at, e.ends_at), least(q.closes_at, e.ends_at) <= now(),
         ARRAY(SELECT v.option_id FROM quest_vote v WHERE v.enrollment_id = n.id AND v.quest_id = q.id ORDER BY 1),
         now()
  FROM quest q
  JOIN event e ON e.id = q.event_id
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND is_live_poll(q.type, q.type_config) AND q.visible AND sees_category(n.id, c)
    AND polls_shown(e) AND quest_community_lock(q) IS NULL
$$;

-- As 0052, plus: a poll whose quest or category is community-locked is not sent (PL409 community_locked, CTO 7). A
-- poll sent and still open answers as before.
CREATE OR REPLACE FUNCTION send_poll(target_event uuid, target_quest uuid, request uuid)
  RETURNS TABLE (opens_at timestamptz, closes_at timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  phase     text := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  -- Milliseconds, so the builder's read and write back of a sent poll leaves its window exactly as it was.
  at        timestamptz := date_trunc('milliseconds', now());
  quest_row quest%ROWTYPE;
  ends      timestamptz;
BEGIN
  IF phase = 'live' THEN
    PERFORM ensure_rehearsal_wiped(ev.id);
  ELSIF phase NOT IN ('draft', 'scheduled') OR NOT EXISTS (
    SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL) THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'PE409', DETAIL = 'event_not_live';
  END IF;
  quest_row := team_poll(target_event, target_quest);
  IF quest_row.poll_sent_at IS NOT NULL THEN
    IF quest_row.closes_at > now() THEN
      RETURN QUERY SELECT quest_row.opens_at, quest_row.closes_at, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'this poll was sent and has closed' USING ERRCODE = 'PS409', DETAIL = 'already_sent';
  END IF;
  IF quest_community_lock(quest_row) IS NOT NULL THEN
    RAISE EXCEPTION 'this poll is locked by a community goal' USING ERRCODE = 'PL409', DETAIL = 'community_locked';
  END IF;
  ends := date_trunc('milliseconds',
                     least(at + make_interval(mins => (quest_row.type_config -> 'live' ->> 'minutes')::integer),
                           ev.ends_at));
  UPDATE quest q SET visible = true, opens_at = at, closes_at = ends, poll_sent_at = at WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'quest.poll_send', 'quest', quest_row.id::text,
          jsonb_build_object('opensAt', at, 'closesAt', ends, 'rehearsal', phase <> 'live'), request);
  RETURN QUERY SELECT at, ends, false;
END $$;

-- As 0046, without community-locked quests: the public page lists them once unlocked.
CREATE OR REPLACE FUNCTION public_event_quests(code text)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, opens_at timestamptz, closes_at timestamptz, quest_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.opens_at, q.closes_at, q.position
  FROM event e
  JOIN category c ON c.event_id = e.id AND c.audience_kind IS NULL AND NOT c.hidden
  JOIN quest q ON q.category_id = c.id AND q.event_id = e.id AND q.visible
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND e.access <> 'private'
    AND quest_community_lock(q) IS NULL
  ORDER BY c.position, c.id, q.position, q.id
$$;

-- ================================================================ the player's quest list (ADR-228)
-- As 0050, plus `community_lock` (the note of the step holding the quest shut, its category's included) and
-- `category_community_lock` (the note of the category's own lock, shown once as a category note). The quest's step is
-- read once per row (CTO 10) and `lock` reads `community_locked` from it. The output changed: DROP and CREATE.
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
                 game_left integer, game_passed boolean, community_lock jsonb, category_community_lock jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
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
         community_lock_note(k.category_step)
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  CROSS JOIN LATERAL (SELECT quest_community_lock(q) AS step, category_community_lock(c.id) AS category_step) k
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ the bar and live (ADR-228, CTO 7)
-- What an unlock step's marker may name to this member: a category they see, a visible quest in a category they see,
-- an active reward in their audience; NULL otherwise ("a surprise"). Internal.
CREATE FUNCTION community_unlock_target(step community_step, member uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN step.unlock_quest_id IS NOT NULL THEN
      (SELECT jsonb_build_object('kind', 'quest', 'id', q.id, 'name', jsonb_build_object('ar', q.title_ar, 'en', q.title_en))
       FROM quest q JOIN category c ON c.id = q.category_id
       WHERE q.id = step.unlock_quest_id AND q.visible AND sees_category(member, c))
    WHEN step.unlock_category_id IS NOT NULL THEN
      (SELECT jsonb_build_object('kind', 'category', 'id', c.id, 'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en))
       FROM category c WHERE c.id = step.unlock_category_id AND sees_category(member, c))
    WHEN step.unlock_reward_id IS NOT NULL THEN
      (SELECT jsonb_build_object('kind', 'reward', 'id', r.id, 'name', jsonb_build_object('ar', r.name_ar, 'en', r.name_en))
       FROM reward r
       WHERE r.id = step.unlock_reward_id AND r.status = 'active'
         AND in_audience(member, r.audience_kind, r.audience_field_id, r.audience_values))
  END
$$;
REVOKE ALL ON FUNCTION community_unlock_target(community_step, uuid) FROM PUBLIC;

-- As 0053, with an unlock step's `target` when the member may see it.
CREATE OR REPLACE FUNCTION member_community(ev event, enrolled_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'goalId', g.id, 'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure,
    'target', g.target, 'progress', g.progress, 'status', g.status, 'paidTo', g.paid_to,
    'endsAt', community_close_at(g.ends_at, ev.ends_at),
    'steps', (SELECT jsonb_agg(jsonb_build_object(
                'threshold', s.threshold, 'isGoal', s.is_goal,
                'reward', jsonb_strip_nulls(jsonb_build_object(
                  'kind', s.reward, 'points', s.points,
                  'moment', CASE WHEN s.reward = 'moment'
                                 THEN jsonb_build_object('ar', s.moment_ar, 'en', s.moment_en) END,
                  'target', CASE WHEN s.reward = 'unlock' THEN community_unlock_target(s, enrolled_id) END)),
                'reachedAt', r.reached_at, 'mine', p.status) ORDER BY s.threshold)
              FROM community_step s
              LEFT JOIN community_reach r ON r.step_id = s.id
              LEFT JOIN community_payout p ON p.step_id = s.id AND p.enrollment_id = enrolled_id
              WHERE s.goal_id = g.id),
    'contributed', EXISTS (SELECT 1 FROM community_contributor c WHERE c.goal_id = g.id AND c.enrollment_id = enrolled_id))
  FROM community_goal g
  WHERE g.event_id = ev.id AND g.settled_until IS NOT NULL
    AND (g.final_at IS NULL OR g.final_at > now() - interval '30 minutes')
    AND event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('live', 'ended') AND community_on(ev)
  ORDER BY g.starts_at DESC
  LIMIT 1
$$;

-- As 0053, with closed poll results kept back while the poll is community-locked (CTO 7); open polls already pass
-- category_lock.
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
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL);
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target;
  IF NOT polls_shown(ev) THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL);
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
    'community', member_community(ev, enrolled.id));
END $$;

-- ================================================================ the builder (ADR-227)
-- As 0053, with each step's unlock target (by the target's kind). The output changed: DROP and CREATE.
DROP FUNCTION community_body_steps(jsonb);
CREATE FUNCTION community_body_steps(body jsonb)
  RETURNS TABLE (threshold bigint, is_goal boolean, reward text, points integer, moment_ar text, moment_en text,
                 unlock_quest_id uuid, unlock_category_id uuid, unlock_reward_id uuid)
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN x.i = 0 THEN (body ->> 'target')::bigint ELSE (x.step ->> 'threshold')::bigint END, x.i = 0,
         x.step -> 'reward' ->> 'kind', (x.step -> 'reward' ->> 'points')::integer,
         x.step -> 'reward' -> 'moment' ->> 'ar', x.step -> 'reward' -> 'moment' ->> 'en',
         CASE WHEN x.step -> 'reward' -> 'target' ->> 'kind' = 'quest'
              THEN (x.step -> 'reward' -> 'target' ->> 'id')::uuid END,
         CASE WHEN x.step -> 'reward' -> 'target' ->> 'kind' = 'category'
              THEN (x.step -> 'reward' -> 'target' ->> 'id')::uuid END,
         CASE WHEN x.step -> 'reward' -> 'target' ->> 'kind' = 'reward'
              THEN (x.step -> 'reward' -> 'target' ->> 'id')::uuid END
  FROM (SELECT 0::bigint AS i, jsonb_build_object('reward', body -> 'reward') AS step
        UNION ALL
        SELECT m.i, m.step FROM jsonb_array_elements(coalesce(body -> 'milestones', '[]'::jsonb))
                                WITH ORDINALITY AS m(step, i)) x
$$;
REVOKE ALL ON FUNCTION community_body_steps(jsonb) FROM PUBLIC;

-- As 0053, with the unlock targets among the step fields a started goal keeps (`steps`).
CREATE OR REPLACE FUNCTION community_locked_field(goal community_goal, body jsonb, starts timestamptz, ends timestamptz)
  RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN body ->> 'measure' IS DISTINCT FROM goal.measure THEN 'measure'
    WHEN (body ->> 'questId')::uuid IS DISTINCT FROM goal.quest_id THEN 'questId'
    WHEN (body ->> 'categoryId')::uuid IS DISTINCT FROM goal.category_id THEN 'categoryId'
    WHEN (body ->> 'target')::bigint IS DISTINCT FROM goal.target THEN 'target'
    WHEN starts IS DISTINCT FROM goal.starts_at THEN 'startsAt'
    WHEN ends IS DISTINCT FROM goal.ends_at THEN 'endsAt'
    WHEN coalesce(body ->> 'paidTo', 'contributors') IS DISTINCT FROM goal.paid_to THEN 'paidTo'
    WHEN (SELECT jsonb_agg(jsonb_build_array(b.threshold, b.is_goal, b.reward, b.points, b.unlock_quest_id,
                                             b.unlock_category_id, b.unlock_reward_id) ORDER BY b.threshold)
          FROM community_body_steps(body) b)
         IS DISTINCT FROM
         (SELECT jsonb_agg(jsonb_build_array(s.threshold, s.is_goal, s.reward, s.points, s.unlock_quest_id,
                                             s.unlock_category_id, s.unlock_reward_id) ORDER BY s.threshold)
          FROM community_step s WHERE s.goal_id = goal.id) THEN 'steps'
  END
$$;

-- As 0053 (its body read through the new community_body_steps).
CREATE OR REPLACE FUNCTION community_check_window(ev event, target_goal uuid, body jsonb, starts timestamptz,
                                                  ends timestamptz)
  RETURNS void LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF starts IS NULL OR (ev.starts_at IS NOT NULL AND starts < ev.starts_at) THEN
    RAISE EXCEPTION 'the start is before the event' USING ERRCODE = 'CG422', DETAIL = 'startsAt';
  END IF;
  IF ends IS NULL OR ends < starts + interval '1 minute' OR (ev.ends_at IS NOT NULL AND ends > ev.ends_at) THEN
    RAISE EXCEPTION 'the end is too soon or after the event' USING ERRCODE = 'CG422', DETAIL = 'endsAt';
  END IF;
  IF EXISTS (SELECT 1 FROM community_body_steps(body) b
             WHERE b.threshold IS NULL OR b.threshold < 1 OR b.threshold > (body ->> 'target')::bigint
                OR (NOT b.is_goal AND b.threshold = (body ->> 'target')::bigint))
     OR (SELECT count(*) FROM community_body_steps(body) b WHERE NOT b.is_goal) > 5 THEN
    RAISE EXCEPTION 'milestones sit below the target, at most 5' USING ERRCODE = 'CG422', DETAIL = 'milestones';
  END IF;
  IF target_goal IS NULL AND (SELECT count(*) FROM community_goal g WHERE g.event_id = ev.id) >= 20 THEN
    RAISE EXCEPTION 'an event has at most 20 community goals' USING ERRCODE = 'GL409', DETAIL = 'goal_limit';
  END IF;
  IF EXISTS (SELECT 1 FROM community_goal g
             WHERE g.event_id = ev.id AND g.id IS DISTINCT FROM target_goal
               AND tstzrange(g.starts_at, g.ends_at) && tstzrange(starts, ends)) THEN
    RAISE EXCEPTION 'another community goal runs at that time' USING ERRCODE = 'GL409', DETAIL = 'goal_overlap';
  END IF;
END $$;

-- The unlock rules a new or not-yet-started goal's steps must meet (ADR-227). CG422 DETAIL unlock, HINT the reason:
-- `unlock_target` when a step does not name exactly one quest, category or active reward of this event, or names a
-- live poll (Send and Close own its window); `unlock_counted` when it names the quest or category the goal counts, or
-- the category of the quest it counts (it could never count past 0). GL409 unlock_taken when a target is named twice,
-- or already by another goal of the event (reached or not: a target is locked once). Goal writes of one event
-- serialise on the builder's advisory lock, so the unique indexes are only the backstop. Internal.
CREATE FUNCTION community_check_unlocks(ev event, target_goal uuid, body jsonb) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  counted_quest    uuid := (body ->> 'questId')::uuid;
  counted_category uuid := coalesce((body ->> 'categoryId')::uuid,
                                    (SELECT q.category_id FROM quest q WHERE q.id = counted_quest AND q.event_id = ev.id));
BEGIN
  IF EXISTS (
    SELECT 1 FROM community_body_steps(body) b
    WHERE b.reward = 'unlock'
      AND (num_nonnulls(b.unlock_quest_id, b.unlock_category_id, b.unlock_reward_id) <> 1
           OR (b.unlock_quest_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM quest q
                 WHERE q.id = b.unlock_quest_id AND q.event_id = ev.id AND NOT is_live_poll(q.type, q.type_config)))
           OR (b.unlock_category_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM category c WHERE c.id = b.unlock_category_id AND c.event_id = ev.id))
           OR (b.unlock_reward_id IS NOT NULL AND NOT EXISTS (
                 SELECT 1 FROM reward r WHERE r.id = b.unlock_reward_id AND r.event_id = ev.id AND r.status = 'active')))
  ) THEN
    RAISE EXCEPTION 'an unlock names one quest, category or shop reward of this event' USING ERRCODE = 'CG422',
      DETAIL = 'unlock', HINT = 'unlock_target';
  END IF;
  IF EXISTS (SELECT 1 FROM community_body_steps(body) b
             WHERE b.reward = 'unlock'
               AND (b.unlock_quest_id = counted_quest OR b.unlock_category_id = counted_category)) THEN
    RAISE EXCEPTION 'a goal can not lock what it counts' USING ERRCODE = 'CG422', DETAIL = 'unlock',
      HINT = 'unlock_counted';
  END IF;
  IF EXISTS (SELECT 1 FROM community_body_steps(body) b WHERE b.reward = 'unlock'
             GROUP BY b.unlock_quest_id, b.unlock_category_id, b.unlock_reward_id HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM community_body_steps(body) b
                JOIN community_step s ON s.event_id = ev.id AND s.goal_id IS DISTINCT FROM target_goal
                 AND (s.unlock_quest_id = b.unlock_quest_id OR s.unlock_category_id = b.unlock_category_id
                      OR s.unlock_reward_id = b.unlock_reward_id)
                WHERE b.reward = 'unlock') THEN
    RAISE EXCEPTION 'this is already unlocked by a community goal' USING ERRCODE = 'GL409', DETAIL = 'unlock_taken';
  END IF;
END $$;
REVOKE ALL ON FUNCTION community_check_unlocks(event, uuid, jsonb) FROM PUBLIC;

-- As 0053, with the unlock rules checked after the window's and each step's target written. The step inserts take KEY
-- SHARE on their targets (their keys), after the advisory lock and the goal (rules.md lock order).
CREATE OR REPLACE FUNCTION save_community_goal(target_event uuid, target_goal uuid, body jsonb, request uuid)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  old    community_goal%ROWTYPE;
  saved  uuid;
  starts timestamptz := date_trunc('milliseconds', (body ->> 'startsAt')::timestamptz);
  ends   timestamptz := date_trunc('milliseconds', (body ->> 'endsAt')::timestamptz);
  field  text;
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  PERFORM pg_advisory_xact_lock(hashtextextended('community_goal:' || ev.id, 0));
  IF target_goal IS NOT NULL THEN
    SELECT g.* INTO old FROM community_goal g WHERE g.id = target_goal AND g.event_id = ev.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such community goal in this event' USING ERRCODE = 'GN404';
    END IF;
    IF community_started(old) THEN
      field := community_locked_field(old, body, starts, ends);
      IF field IS NOT NULL THEN
        RAISE EXCEPTION 'a started goal keeps everything but its texts' USING ERRCODE = 'GL409',
          DETAIL = 'goal_locked', HINT = field;
      END IF;
      UPDATE community_goal g SET title_ar = body -> 'title' ->> 'ar', title_en = body -> 'title' ->> 'en'
      WHERE g.id = old.id;
      UPDATE community_step s SET moment_ar = b.moment_ar, moment_en = b.moment_en
      FROM community_body_steps(body) b WHERE s.goal_id = old.id AND s.threshold = b.threshold;
      INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                             request_id)
      VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'community.goal_update', 'community_goal',
              old.id::text, jsonb_build_object('texts', true), request);
      RETURN old.id;
    END IF;
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'GL409', DETAIL = 'event_ended';
  END IF;
  IF starts < date_trunc('milliseconds', now()) - interval '60 seconds' THEN
    RAISE EXCEPTION 'the start is more than a minute ago' USING ERRCODE = 'CG422', DETAIL = 'startsAt';
  END IF;
  starts := greatest(starts, date_trunc('milliseconds', now()));
  PERFORM community_check_window(ev, target_goal, body, starts, ends);
  PERFORM community_check_unlocks(ev, target_goal, body);

  IF target_goal IS NULL THEN
    INSERT INTO community_goal (organizer_id, event_id, title_ar, title_en, measure, quest_id, category_id, target,
                                starts_at, ends_at, paid_to)
    VALUES (ev.organizer_id, ev.id, body -> 'title' ->> 'ar', body -> 'title' ->> 'en', body ->> 'measure',
            (body ->> 'questId')::uuid, (body ->> 'categoryId')::uuid, (body ->> 'target')::bigint, starts, ends,
            coalesce(body ->> 'paidTo', 'contributors'))
    RETURNING id INTO saved;
  ELSE
    UPDATE community_goal g
    SET title_ar = body -> 'title' ->> 'ar', title_en = body -> 'title' ->> 'en', measure = body ->> 'measure',
        quest_id = (body ->> 'questId')::uuid, category_id = (body ->> 'categoryId')::uuid,
        target = (body ->> 'target')::bigint, starts_at = starts, ends_at = ends,
        paid_to = coalesce(body ->> 'paidTo', 'contributors')
    WHERE g.id = old.id;
    DELETE FROM community_step s WHERE s.goal_id = old.id;
    saved := old.id;
  END IF;
  INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points, moment_ar, moment_en,
                              unlock_quest_id, unlock_category_id, unlock_reward_id)
  SELECT ev.id, saved, b.threshold, b.is_goal, b.reward, b.points, b.moment_ar, b.moment_en, b.unlock_quest_id,
         b.unlock_category_id, b.unlock_reward_id
  FROM community_body_steps(body) b;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id,
          CASE WHEN target_goal IS NULL THEN 'community.goal_create' ELSE 'community.goal_update' END,
          'community_goal', saved::text,
          jsonb_build_object('measure', body ->> 'measure', 'target', (body ->> 'target')::bigint, 'startsAt', starts,
                             'endsAt', ends),
          request);
  RETURN saved;
END $$;

-- As 0053, with each unlock step's target (kind, id and names) for the Community page.
CREATE OR REPLACE FUNCTION community_goals(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', g.id, 'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure,
      'questId', g.quest_id, 'categoryId', g.category_id, 'target', g.target, 'startsAt', g.starts_at,
      'endsAt', g.ends_at, 'closesAt', community_close_at(g.ends_at, ev.ends_at), 'paidTo', g.paid_to,
      'status', g.status, 'progress', g.progress, 'progressAt', g.progress_at, 'finalAt', g.final_at,
      'started', community_started(g),
      'steps', (SELECT jsonb_agg(jsonb_build_object(
                  'threshold', s.threshold, 'isGoal', s.is_goal, 'reward', s.reward, 'points', s.points,
                  'moment', CASE WHEN s.reward = 'moment' THEN jsonb_build_object('ar', s.moment_ar, 'en', s.moment_en) END,
                  'unlock', CASE
                    WHEN s.unlock_quest_id IS NOT NULL THEN
                      (SELECT jsonb_build_object('kind', 'quest', 'id', q.id,
                                                 'name', jsonb_build_object('ar', q.title_ar, 'en', q.title_en))
                       FROM quest q WHERE q.id = s.unlock_quest_id)
                    WHEN s.unlock_category_id IS NOT NULL THEN
                      (SELECT jsonb_build_object('kind', 'category', 'id', c.id,
                                                 'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en))
                       FROM category c WHERE c.id = s.unlock_category_id)
                    WHEN s.unlock_reward_id IS NOT NULL THEN
                      (SELECT jsonb_build_object('kind', 'reward', 'id', w.id,
                                                 'name', jsonb_build_object('ar', w.name_ar, 'en', w.name_en))
                       FROM reward w WHERE w.id = s.unlock_reward_id) END,
                  'reachedAt', r.reached_at,
                  'due', (SELECT count(*) FROM community_payout p WHERE p.step_id = s.id AND p.status = 'due'),
                  'paid', (SELECT count(*) FROM community_payout p WHERE p.step_id = s.id AND p.status = 'paid'),
                  'skipped', (SELECT count(*) FROM community_payout p WHERE p.step_id = s.id AND p.status = 'skipped'))
                  ORDER BY s.threshold)
                FROM community_step s LEFT JOIN community_reach r ON r.step_id = s.id WHERE s.goal_id = g.id))
      ORDER BY g.starts_at, g.id)
    FROM community_goal g WHERE g.event_id = ev.id), '[]'::jsonb);
END $$;
