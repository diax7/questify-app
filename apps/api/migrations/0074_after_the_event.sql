-- T-410: after the event (FR-750, FR-751, FR-752, FR-1018; ADR-336 to ADR-339; plan
-- docs/plans/2026-10-27-t-410-after-the-event.md). The shop's window only grows after the end and is frozen once
-- closed (a guard on event.shop_days_after), and event_recap answers a member's recap of an ended event. The balance
-- closes by rule, with no write (ADR-337): shop_state stays the one definition of "closed" and nothing here changes it.
-- reserve_reward is restated (0054's body) so its rehearsal flag is never NULL after the end. Deny by default: no
-- table, no ledger change, no tick; the guard and event_recap are closed to PUBLIC in the group that creates them and
-- only event_recap is granted to the API role (reserve_reward keeps its grants). Migrations 0073 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- The new trigger takes SHARE ROW EXCLUSIVE on event; taken up front, as 0068 and 0073 do. Nothing else is locked.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the window (ADR-336)
-- After the end the window only grows, and once closed it is frozen, even to lengthen. The API's role only, as
-- event_times_guard; judged on clock_timestamp(), not now(), so an edit whose transaction began a moment before the
-- close cannot reopen it. "Closed" is shop_state's rule read on that clock: ended and ends_at + days at or before it,
-- or archived. Sending the stored value is no change (the WHEN clause).
CREATE FUNCTION event_shop_window_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ended boolean;
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  ended := OLD.status IN ('ended', 'archived')
           OR (OLD.status IN ('scheduled', 'live') AND OLD.ends_at <= clock_timestamp());
  IF ended AND (OLD.status = 'archived'
                OR NOT coalesce(OLD.ends_at + make_interval(days => OLD.shop_days_after) > clock_timestamp(),
                                false)) THEN
    RAISE EXCEPTION 'the shop has closed' USING ERRCODE = 'SW409', DETAIL = 'closed';
  END IF;
  IF ended AND NEW.shop_days_after < OLD.shop_days_after THEN
    RAISE EXCEPTION 'after the end the shop window only grows' USING ERRCODE = 'SW409', DETAIL = 'shorter';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_shop_window_guard() FROM PUBLIC;
CREATE TRIGGER event_shop_window_guard BEFORE UPDATE OF shop_days_after ON event
  FOR EACH ROW WHEN (OLD.shop_days_after IS DISTINCT FROM NEW.shop_days_after)
  EXECUTE FUNCTION event_shop_window_guard();

-- ================================================================ the recap (ADR-339)
-- The caller's recap of one event: one row while their membership counts as played for the passport (not pending,
-- declined, banned or removed; not a rehearsal account; `left` included; joined_via is NULL before 0018), none
-- otherwise. Only what the player already sees: the event's name, local start date and city, the rank as own_events
-- gives it (the same CASE), the distinct quests of this membership's `quest` entries that no removal reverses (never
-- XP credits: XP pays a quest's first completion only), and the souvenirs this event gave them, in earned order.
-- Never another player, a score, a balance or a count of players. The API answers 409 before the end.
CREATE FUNCTION event_recap(target uuid)
  RETURNS TABLE (status_now text, name jsonb, local_date text, city jsonb, rank integer, rank_state text,
                 quests_done integer, souvenirs jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT st.now,
         jsonb_build_object('ar', coalesce(e.name_ar, e.name_en), 'en', coalesce(e.name_en, e.name_ar)),
         to_char(coalesce(e.starts_at, e.created_at) AT TIME ZONE e.timezone, 'YYYY-MM-DD'),
         CASE WHEN c.id IS NOT NULL THEN jsonb_build_object('ar', c.name_ar, 'en', c.name_en) END,
         CASE WHEN r.revealed_at IS NOT NULL THEN f.rank END,
         CASE WHEN st.now NOT IN ('ended', 'archived') THEN 'live'
              WHEN r.revealed_at IS NULL THEN 'pending'
              WHEN f.rank IS NULL THEN 'unranked'
              ELSE 'final' END,
         (SELECT count(DISTINCT l.quest_id)::integer FROM ledger_entry l
          WHERE l.enrollment_id = n.id AND l.kind = 'quest'
            AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.kind = 'removal' AND x.reverses = l.id)),
         (SELECT coalesce(jsonb_agg(item_json(o.item_id) ORDER BY o.earned_at, o.item_id), '[]'::jsonb)
          FROM player_item o
          WHERE o.player_id = n.player_id AND o.source = 'souvenir' AND o.source_event_id = e.id)
  FROM enrollment n JOIN event e ON e.id = n.event_id
  LEFT JOIN city c ON c.id = e.city_id
  LEFT JOIN event_result r ON r.event_id = e.id
  LEFT JOIN final_rank f ON f.event_id = e.id AND f.enrollment_id = n.id
  CROSS JOIN LATERAL (SELECT event_status_now(e.status, e.starts_at, e.ends_at) AS now) st
  WHERE n.event_id = target AND n.player_id = profile_player()
    AND n.status NOT IN ('pending', 'declined', 'banned', 'removed') AND n.joined_via IS DISTINCT FROM 'rehearsal'
$$;
REVOKE ALL ON FUNCTION event_recap(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_recap(uuid) TO questify_app;

-- ================================================================ the shop after the end (FR-750, ADR-337)
-- As 0054, with the rehearsal flag never NULL. play_phase is NULL once the event has ended, so 0054's flag was NULL in
-- the days after the end and every `NOT rehearsing` test was skipped: a digital reward bought then was delivered
-- with no code and no unit counted, and an item skipped the desk's hours (`desk_finished`, the next opening). Found
-- by T-410's after-the-end tests; nothing else changes. No repair: no real players yet.
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
