-- T-602c: the event's switches inside the points doors (FR-1009; plan docs/plans/2026-10-31-t-505b-t-602c-points-doors.md,
-- plan review 86 folded; ADR-383). T-602 (ADR-381) refused the shop read and hid live polls at the API; the doors that
-- spend or pay points did not know the switches. Now the database is the one gate: `reserve_reward` refuses a new
-- reservation while the shop is off (RS403 `feature_off`), and `vote_quest`, `member_poll` (so `poll_results`) and
-- `member_vote` refuse a live poll while live polls are off (PF403 `feature_off`). The switch is feature_enabled (0083):
-- the event's `config.features.<key>` and the platform's `features.<key>.enabled`. A retried request whose key already
-- succeeded answers its first result (the replay paths run before the switch), so only a new write is refused. A plain
-- vote quest is not a live poll and stays open. A caller who would not see the quest gets no row (not found) as before,
-- so the switch never reveals a quest. A reservation made before the switch-off stands (desk handover, cancel and
-- expiry are not behind it). No new table or grant; every restated function keeps its grant. No EXCEPTION block.
-- Migrations 0093 and earlier untouched: what changes is restated here.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the shop switch in the reserve door
-- As 0074, plus the shop switch after the event row is read (rehearsal accounts too: the switch is the setup).
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
  IF NOT feature_enabled(ev, 'shop') THEN
    RAISE EXCEPTION 'the shop is switched off' USING ERRCODE = 'RS403', DETAIL = 'feature_off';
  END IF;
  rehearsing := coalesce(play_phase(ev, enrolled) = 'rehearsal', false);
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

-- ================================================================ the polls switch in the live poll doors
-- Whether live polls are switched off for the quest's event. Internal.
CREATE FUNCTION polls_off(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q JOIN event e ON e.id = q.event_id
                 WHERE q.id = target AND is_live_poll(q.type, q.type_config) AND NOT feature_enabled(e, 'polls'))
$$;
REVOKE ALL ON FUNCTION polls_off(uuid) FROM PUBLIC;

-- As 0052, plus the polls switch after play_quest (an outsider still gets not found), for a live poll only, and not
-- for a retry whose key the caller already used in the event (record_completion replays it or refuses the key).
CREATE OR REPLACE FUNCTION vote_quest(target uuid, options text[], request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  quest_row quest%ROWTYPE;
  paid      record;
  chosen    text[];
  earlier   text[];
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(q.event_id) FROM quest q WHERE q.id = target;
  quest_row := play_quest(target, 'vote');
  IF polls_off(target) AND NOT EXISTS (
    SELECT 1 FROM quest_completion c JOIN enrollment n ON n.id = c.enrollment_id
    WHERE n.event_id = quest_row.event_id AND n.player_id = me AND c.idempotency_key = request_key) THEN
    RAISE EXCEPTION 'live polls are switched off' USING ERRCODE = 'PF403', DETAIL = 'feature_off';
  END IF;
  chosen := ARRAY(SELECT DISTINCT o FROM unnest(options) o WHERE o IS NOT NULL ORDER BY o);
  IF coalesce(cardinality(options), 0) = 0 OR cardinality(chosen) <> cardinality(options) OR EXISTS (
    SELECT 1 FROM unnest(chosen) o
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(quest_row.type_config -> 'options') x WHERE x ->> 'id' = o)) THEN
    RAISE EXCEPTION 'no such option' USING ERRCODE = 'VO422';
  END IF;
  IF cardinality(chosen) > 1 AND quest_row.type_config -> 'live' ->> 'choices' IS DISTINCT FROM 'several' THEN
    RAISE EXCEPTION 'this vote takes one choice' USING ERRCODE = 'VC422', DETAIL = 'too_many_choices';
  END IF;
  SELECT * INTO paid FROM record_completion(target, me, 'vote', NULL, NULL, request_key, NULL, NULL, NULL, NULL,
                                            quest_row.event_id) r;
  IF paid.replayed THEN
    earlier := ARRAY(SELECT v.option_id FROM quest_vote v WHERE v.completion_id = paid.completion_id ORDER BY 1);
    IF earlier IS DISTINCT FROM chosen THEN
      RAISE EXCEPTION 'this key was used for another vote' USING ERRCODE = 'QK422';
    END IF;
  ELSE
    INSERT INTO quest_vote (organizer_id, event_id, enrollment_id, quest_id, option_id, completion_id)
    SELECT n.organizer_id, n.event_id, n.id, target, o, paid.completion_id
    FROM enrollment n, unnest(chosen) o WHERE n.event_id = quest_row.event_id AND n.player_id = me;
  END IF;
  RETURN QUERY SELECT paid.completion_id, paid.points, paid.occurrence, paid.score, paid.balance, paid.replayed;
END $$;

-- As 0054, now plpgsql with the same output (every column qualified, columns win a name clash): the row it would
-- return, then PF403 while live polls are off. No row stays no row (not found), so a non-member learns nothing.
-- poll_results reads it first and inherits the refusal.
CREATE OR REPLACE FUNCTION member_poll(target uuid)
  RETURNS TABLE (title_ar text, title_en text, points integer, choices text, results text, closes_at timestamptz,
                 closed boolean, mine text[], server_now timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT q.title_ar, q.title_en, q.points, q.type_config -> 'live' ->> 'choices', q.type_config -> 'live' ->> 'results',
         least(q.closes_at, e.ends_at), least(q.closes_at, e.ends_at) <= now(),
         ARRAY(SELECT v.option_id FROM quest_vote v WHERE v.enrollment_id = n.id AND v.quest_id = q.id ORDER BY 1),
         now()
  FROM quest q
  JOIN event e ON e.id = q.event_id
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = member_poll.target AND is_live_poll(q.type, q.type_config) AND q.visible AND sees_category(n.id, c)
    AND polls_shown(e) AND quest_community_lock(q) IS NULL;
  IF FOUND AND polls_off(member_poll.target) THEN
    RAISE EXCEPTION 'live polls are switched off' USING ERRCODE = 'PF403', DETAIL = 'feature_off';
  END IF;
END $$;

-- As 0055, now plpgsql with the same output: the options it would return, then PF403 for a live poll while live polls
-- are off. A plain vote quest is never affected; no row stays no row.
CREATE OR REPLACE FUNCTION member_vote(target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, mine boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH me AS (
    SELECT n.id, q.type_config FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = member_vote.target AND q.type = 'vote' AND q.visible AND sees_category(n.id, c)
      AND quest_community_lock(q) IS NULL AND flash_shown(q)
  )
  SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
         EXISTS (SELECT 1 FROM quest_vote v WHERE v.enrollment_id = me.id AND v.quest_id = member_vote.target
                   AND v.option_id = o ->> 'id')
  FROM me, jsonb_array_elements(me.type_config -> 'options') WITH ORDINALITY AS t(o, i)
  ORDER BY i;
  IF FOUND AND polls_off(member_vote.target) THEN
    RAISE EXCEPTION 'live polls are switched off' USING ERRCODE = 'PF403', DETAIL = 'feature_off';
  END IF;
END $$;
