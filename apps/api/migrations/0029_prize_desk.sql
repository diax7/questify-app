-- The prize desk (T-206; ADR-137, ADR-150, ADR-151). One desk per event: a place, optional opening hours and how the
-- player confirms a handover in their own app (the owner's choice). Operators with the hand_over ability scan My QR,
-- see the player's reserved items, hand them over or cancel them; the desk never awards points (FR-926). Every write
-- is a definer; the handover itself is one body holding every gate, so the desk's and the player's paths cannot
-- disagree. Lock order everywhere: the operator's assignment (FOR SHARE), enrollment, reward, redemption.

-- ================================================================ the event's desk (FR-1716, FR-1717, ADR-150)
-- Hours are optional: NULL means the desk is open the whole time. Set, they are 1 to 14 bounded windows.
CREATE FUNCTION desk_hours_valid(hours tstzmultirange) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT isempty(hours) AND NOT lower_inf(hours) AND NOT upper_inf(hours)
         AND (SELECT count(*) FROM unnest(hours)) <= 14
$$;
REVOKE ALL ON FUNCTION desk_hours_valid(tstzmultirange) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_hours_valid(tstzmultirange) TO questify_app;

ALTER TABLE event
  ADD COLUMN desk_location_ar text CHECK (length(desk_location_ar) BETWEEN 1 AND 200),
  ADD COLUMN desk_location_en text CHECK (length(desk_location_en) BETWEEN 1 AND 200),
  ADD COLUMN desk_lat         numeric(9, 6) CHECK (desk_lat BETWEEN -90 AND 90),
  ADD COLUMN desk_lng         numeric(9, 6) CHECK (desk_lng BETWEEN -180 AND 180),
  ADD COLUMN desk_hours       tstzmultirange CHECK (desk_hours IS NULL OR desk_hours_valid(desk_hours)),
  ADD COLUMN handover_confirm text NOT NULL DEFAULT 'collect_first'
    CHECK (handover_confirm IN ('collect_first', 'desk_offer')),
  ADD CONSTRAINT event_desk_pin_pair CHECK ((desk_lat IS NULL) = (desk_lng IS NULL));
GRANT UPDATE (desk_location_ar, desk_location_en, desk_lat, desk_lng, desk_hours, handover_confirm)
  ON event TO questify_app;

-- open: no hours, or a window holds now; closed: a later window exists; finished: every window is past. The only
-- place this rule lives; STABLE (it reads now()).
CREATE FUNCTION desk_state(hours tstzmultirange) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN hours IS NULL OR hours @> now() THEN 'open'
              WHEN upper(hours) > now() THEN 'closed'
              ELSE 'finished' END
$$;
REVOKE ALL ON FUNCTION desk_state(tstzmultirange) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_state(tstzmultirange) TO questify_app;

-- FR-1716: an item reward needs the desk's place. The event is read FOR SHARE, so a reward insert and a clear of the
-- place cannot both commit. `kind` is not updatable, so INSERT is enough. Seeds by the migration owner are let through,
-- as the other reward guards do; so is an event the caller cannot see, which row-level security then refuses.
CREATE FUNCTION reward_desk_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  has_place boolean;
BEGIN
  IF current_user = 'questify_app' AND NEW.kind = 'item' THEN
    SELECT e.desk_location_ar IS NOT NULL OR e.desk_location_en IS NOT NULL INTO has_place
    FROM event e WHERE e.id = NEW.event_id FOR SHARE OF e;
    IF FOUND AND NOT has_place THEN
      RAISE EXCEPTION 'set the prize desk before adding item rewards' USING ERRCODE = 'DL409';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reward_desk_guard() FROM PUBLIC;
CREATE TRIGGER reward_desk_guard BEFORE INSERT ON reward FOR EACH ROW EXECUTE FUNCTION reward_desk_guard();

-- Only the move of the place from set to unset is refused while an active item reward exists, so an older event
-- without a desk still saves its other settings.
CREATE FUNCTION event_desk_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (OLD.desk_location_ar IS NOT NULL OR OLD.desk_location_en IS NOT NULL)
     AND NEW.desk_location_ar IS NULL AND NEW.desk_location_en IS NULL
     AND EXISTS (SELECT 1 FROM reward r WHERE r.event_id = NEW.id AND r.kind = 'item' AND r.status = 'active') THEN
    RAISE EXCEPTION 'item rewards need the prize desk' USING ERRCODE = 'DL409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_desk_guard() FROM PUBLIC;
CREATE TRIGGER event_desk_guard BEFORE UPDATE OF desk_location_ar, desk_location_en ON event
  FOR EACH ROW EXECUTE FUNCTION event_desk_guard();

-- ================================================================ redemptions learn the desk
ALTER TABLE redemption DROP CONSTRAINT redemption_status_check;
ALTER TABLE redemption ADD CONSTRAINT redemption_status_check
  CHECK (status IN ('reserved', 'cancelled', 'expired', 'delivered', 'handed_over'));
ALTER TABLE redemption DROP CONSTRAINT redemption_ended_by_check;
ALTER TABLE redemption ADD CONSTRAINT redemption_ended_by_check
  CHECK (ended_by IN ('player', 'timeout', 'delivery', 'handover', 'operator'));
ALTER TABLE redemption
  -- Who handed over or cancelled (a player id: operators are players).
  ADD COLUMN operator_id   uuid REFERENCES player (id),
  -- The player's Collect (collect_first): ready at the desk until then.
  ADD COLUMN collect_until timestamptz,
  -- The desk's offer (desk_offer): the player may accept until then.
  ADD COLUMN offer_by      uuid REFERENCES player (id),
  ADD COLUMN offer_until   timestamptz,
  ADD CONSTRAINT redemption_handover_shape CHECK ((status = 'handed_over') = (ended_by IS NOT DISTINCT FROM 'handover')),
  ADD CONSTRAINT redemption_operator_cancel CHECK (ended_by IS DISTINCT FROM 'operator' OR status = 'cancelled'),
  ADD CONSTRAINT redemption_operator_named
    CHECK (coalesce(ended_by IN ('handover', 'operator'), false) = (operator_id IS NOT NULL)),
  ADD CONSTRAINT redemption_offer_pair CHECK ((offer_by IS NULL) = (offer_until IS NULL)),
  ADD CONSTRAINT redemption_open_only CHECK (status = 'reserved' OR (collect_until IS NULL AND offer_by IS NULL));

-- ================================================================ the ledger learns handovers (FR-507)
-- A handover moves nothing (both deltas 0) and names the operator who handed over; one per redemption. An operator's
-- cancel returns the points as the operator.
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_handover_shape
  CHECK (kind <> 'handover' OR (redemption_id IS NOT NULL AND score_delta = 0 AND balance_delta = 0
                                AND completion_id IS NULL AND quest_id IS NULL AND actor = 'operator'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_redemption_only_spend;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_redemption_only_spend
  CHECK (redemption_id IS NULL OR kind IN ('redeem', 'redeem_return', 'handover'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_operator_quests_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_operator_quests_only
  CHECK (actor <> 'operator' OR kind IN ('quest', 'handover', 'redeem_return'));
CREATE UNIQUE INDEX ledger_entry_handover_key ON ledger_entry (redemption_id) WHERE kind = 'handover';

-- ================================================================ reserving, again (0025 plus the desk)
-- As in 0025, and: the per-player limit counts handed-over rewards; an item or experience is not reservable once the
-- desk's last window has ended (FR-1717, ADR-150: RS403 desk_finished); while the desk is closed between windows the
-- pickup time starts at the next opening (ADR-151).
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
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.event_id INTO found_ev FROM reward r WHERE r.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = found_ev AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;

  SELECT * INTO earlier FROM redemption d WHERE d.enrollment_id = enrolled.id AND d.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.reward_id <> target THEN
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
  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  IF item.status <> 'active' THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = item.event_id;
  shop := shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after);
  IF shop <> 'open' THEN
    RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = shop;
  END IF;
  IF item.kind IN ('item', 'experience') THEN
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
  IF item.kind = 'digital' THEN
    -- The reward's lock already serializes its codes; the row lock guards against any other writer.
    SELECT c.id INTO code_id FROM reward_code c
    WHERE c.reward_id = target AND c.redemption_id IS NULL ORDER BY c.id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a digital reward''s stock and codes disagree' USING ERRCODE = 'RX500';
    END IF;
  END IF;
  -- Live is judged here, with the same now() as the shop's state (ADR-135: after the end, spending moves the balance).
  IF ev.spend_lowers_rank AND event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live' THEN
    spend_rank := -item.price;
  END IF;

  INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, status,
                          reserved_until, ended_at, ended_by)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, item.price, request_key,
          CASE WHEN code_id IS NULL THEN 'reserved' ELSE 'delivered' END,
          CASE WHEN code_id IS NULL THEN pickup_from + make_interval(mins => ev.pickup_minutes) END,
          CASE WHEN code_id IS NOT NULL THEN now() END,
          CASE WHEN code_id IS NOT NULL THEN 'delivery' END)
  RETURNING * INTO made;
  UPDATE reward_code c SET redemption_id = made.id WHERE c.id = code_id;
  UPDATE reward r SET units_out = r.units_out + 1 WHERE r.id = target;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'redeem', spend_rank, -item.price, made.id, 'player');
  IF spend_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (enrolled.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;

  RETURN QUERY SELECT made.id, item.kind, made.status, made.price, made.reserved_until, n.balance,
                      item.stock_total - item.units_out - 1, false,
                      (SELECT c.code_cipher FROM reward_code c WHERE c.id = code_id)
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;

-- As in 0025, with `held_by_me` counting handed-over rewards too (the per-player limit's count).
CREATE OR REPLACE FUNCTION shop_rewards(target uuid)
  RETURNS TABLE (id uuid, kind text, name_ar text, name_en text, description_ar text, description_en text,
                 price integer, stock_left integer, per_player_limit integer, opens_at timestamptz,
                 closes_at timestamptz, section text, tag_new boolean, tag_limited boolean, popular boolean,
                 held_by_me integer)
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
    WHERE d.event_id = target AND d.status NOT IN ('cancelled', 'expired')
    GROUP BY d.reward_id HAVING count(*) >= popular_floor
    ORDER BY count(*) DESC, d.reward_id LIMIT popular_count
  )
  SELECT r.id, r.kind, r.name_ar, r.name_en, r.description_ar, r.description_en, r.price,
         r.stock_total - r.units_out, r.per_player_limit, r.opens_at, r.closes_at, r.section, r.tag_new,
         r.tag_limited, EXISTS (SELECT 1 FROM taken t WHERE t.reward_id = r.id),
         (SELECT count(*)::integer FROM redemption d
          WHERE d.enrollment_id = mine AND d.reward_id = r.id AND d.status NOT IN ('cancelled', 'expired'))
  FROM reward r
  WHERE r.event_id = target AND r.status = 'active'
  ORDER BY r.position, r.id;
END $$;

-- ================================================================ ending a reservation, again
-- 0025's body with the operator who ended it (an operator's cancel). Still total: any row no longer reserved answers
-- false. An expiry is checked again under the lock: the deadline passed and no Collect or offer is live (a Collect
-- that committed after expire_one_reservation's unlocked pick wins). Not callable by any role.
DROP FUNCTION end_reservation(uuid, text, text, text);
CREATE FUNCTION end_reservation(target uuid, outcome text, by_whom text, who text, operator uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  paid_rank bigint;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = found_row.enrollment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM reward r WHERE r.id = found_row.reward_id FOR UPDATE;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF locked.status <> 'reserved' THEN
    RETURN false;
  END IF;
  IF outcome = 'expired' AND (locked.reserved_until > now() OR coalesce(locked.collect_until > now(), false)
                              OR coalesce(locked.offer_until > now(), false)) THEN
    RETURN false;
  END IF;
  SELECT l.score_delta INTO paid_rank FROM ledger_entry l WHERE l.redemption_id = target AND l.kind = 'redeem';
  UPDATE redemption d
  SET status = outcome, ended_at = now(), ended_by = by_whom, operator_id = operator, collect_until = NULL,
      offer_by = NULL, offer_until = NULL
  WHERE d.id = target;
  UPDATE reward r SET units_out = r.units_out - 1 WHERE r.id = locked.reward_id;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor, operator_id)
  VALUES (locked.organizer_id, locked.event_id, locked.enrollment_id, 'redeem_return', -paid_rank, locked.price,
          target, who, operator);
  IF paid_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (locked.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION end_reservation(uuid, text, text, text, uuid) FROM PUBLIC;

-- As in 0024, through the new body.
CREATE OR REPLACE FUNCTION cancel_redemption(target uuid)
  RETURNS TABLE (redemption_id uuid, status text, price integer, balance bigint, stock_left integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := app_player_id();
  mine  redemption%ROWTYPE;
  ended boolean;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.* INTO mine FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
  WHERE d.id = target AND n.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  ended := end_reservation(target, 'cancelled', 'player', 'player', NULL);
  SELECT * INTO mine FROM redemption d WHERE d.id = target;
  IF NOT ended AND mine.status <> 'cancelled' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = mine.status;
  END IF;
  RETURN QUERY SELECT mine.id, mine.status, mine.price, n.balance, r.stock_total - r.units_out, NOT ended
    FROM enrollment n, reward r WHERE n.id = mine.enrollment_id AND r.id = mine.reward_id;
END $$;

-- As in 0024, skipping a row the player is collecting or was offered right now: the player is at the desk. The row is
-- taken once those 5 or 2 minutes pass, so nothing stalls behind it.
CREATE OR REPLACE FUNCTION expire_one_reservation() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due uuid;
BEGIN
  SELECT d.id INTO due FROM redemption d
  WHERE d.status = 'reserved' AND d.reserved_until <= now()
    AND coalesce(d.collect_until, '-infinity') <= now() AND coalesce(d.offer_until, '-infinity') <= now()
  ORDER BY d.reserved_until, d.id LIMIT 1;
  IF due IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN CASE WHEN end_reservation(due, 'expired', 'timeout', 'system', NULL) THEN 'expired' ELSE 'skipped' END;
END $$;

-- ================================================================ the desk's operator
-- The caller's assignment in the event, FOR SHARE: a removal waits for a desk action in flight and refuses every later
-- one (FR-905). OP403 not an operator, OA403 the hand_over ability is off. Internal.
CREATE FUNCTION desk_operator(target_event uuid, who uuid) RETURNS staff_assignment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  assignment staff_assignment%ROWTYPE;
BEGIN
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = who FOR SHARE;
  IF NOT FOUND OR who IS NULL THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('hand_over' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'handing over is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  RETURN assignment;
END $$;
REVOKE ALL ON FUNCTION desk_operator(uuid, uuid) FROM PUBLIC;

-- ================================================================ one handover body (FR-507, FR-509, ADR-137)
-- Every gate of a handover, for both paths: the desk's Handed over after the player's Collect (via_offer false) and
-- the player's Accept of the desk's offer (via_offer true, `operator` the offering desk). Locks in the one order, then
-- checks under them. T-209's hold joins here. Answers 'handed_over', or 'replayed' when this operator already handed
-- it over. Refusals:
--   RN404 unknown   OP403/OA403 the operator   RE409 not reserved (DETAIL: status, or 'expired')
--   RA403 enrollment not active   OY409 the operator's own reservation   RM409 the event confirms the other way
--   RS403 desk_closed   RO410 no live offer from this operator   RC409 the player has not tapped Collect
-- Internal: not callable by any role.
CREATE FUNCTION finish_handover(target uuid, operator uuid, via_offer boolean) RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
  live      boolean;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM desk_operator(found_row.event_id, operator);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = found_row.enrollment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM reward r WHERE r.id = found_row.reward_id FOR UPDATE;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;

  IF locked.status = 'handed_over' AND locked.operator_id = operator THEN
    RETURN 'replayed';
  END IF;
  IF locked.status <> 'reserved' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = locked.status;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.player_id = operator THEN
    RAISE EXCEPTION 'an operator does not hand over their own reservation' USING ERRCODE = 'OY409';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = locked.event_id;
  IF ev.handover_confirm <> (CASE WHEN via_offer THEN 'desk_offer' ELSE 'collect_first' END) THEN
    RAISE EXCEPTION 'this event confirms handovers the other way' USING ERRCODE = 'RM409';
  END IF;
  IF desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;
  live := CASE WHEN via_offer THEN locked.offer_by = operator AND locked.offer_until > now()
               ELSE locked.collect_until > now() END;
  live := coalesce(live, false);
  IF locked.reserved_until <= now() AND NOT live THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = 'expired';
  END IF;
  IF NOT live AND via_offer THEN
    RAISE EXCEPTION 'no live offer' USING ERRCODE = 'RO410';
  END IF;
  IF NOT live THEN
    RAISE EXCEPTION 'the player has not tapped Collect' USING ERRCODE = 'RC409';
  END IF;

  UPDATE redemption d
  SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = operator, collect_until = NULL,
      offer_by = NULL, offer_until = NULL
  WHERE d.id = target;
  -- The unit stays out: a handed-over reward never returns to stock (FR-1603).
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor, operator_id)
  VALUES (locked.organizer_id, locked.event_id, locked.enrollment_id, 'handover', 0, 0, target, 'operator', operator);
  RETURN 'handed_over';
END $$;
REVOKE ALL ON FUNCTION finish_handover(uuid, uuid, boolean) FROM PUBLIC;

-- ================================================================ the desk's calls
-- The desk's header before any scan: its place, pin, windows, state and how players confirm. OP403/OA403.
CREATE FUNCTION operator_desk(target_event uuid)
  RETURNS TABLE (desk_location_ar text, desk_location_en text, desk_lat numeric, desk_lng numeric,
                 desk_opens timestamptz[], desk_closes timestamptz[], desk_state text, handover_confirm text,
                 timezone text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM desk_operator(target_event, app_player_id());
  RETURN QUERY
  SELECT e.desk_location_ar, e.desk_location_en, e.desk_lat, e.desk_lng,
         (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         desk_state(e.desk_hours), e.handover_confirm, e.timezone
  FROM event e WHERE e.id = target_event;
END $$;
REVOKE ALL ON FUNCTION operator_desk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_desk(uuid) TO questify_app;

-- Who the desk scanned (their current My QR) and what they reserved for the desk, oldest first: one row per item, or
-- one row with NULL item columns when nothing waits. Digital rewards never go through the desk. Reads only: nothing
-- here or anywhere on the desk completes a quest or pays points (FR-926). Refusals: OP403/OA403, OY409 own code,
-- OM422 an earlier My QR, QC404 not in this event.
CREATE FUNCTION desk_lookup(target_event uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (username text, avatar text, enrollment_status text, redemption_id uuid, kind text, name_ar text,
                 name_en text, price integer, reserved_at timestamptz, reserved_until timestamptz, ready boolean,
                 offered boolean, offer_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := app_player_id();
  current integer;
  found_n enrollment%ROWTYPE;
BEGIN
  PERFORM desk_operator(target_event, me);
  IF scanned = me THEN
    RAISE EXCEPTION 'an operator cannot scan their own code' USING ERRCODE = 'OY409';
  END IF;
  SELECT p.my_qr_version INTO current FROM player p WHERE p.id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  END IF;
  IF current IS DISTINCT FROM scanned_version THEN
    RAISE EXCEPTION 'an earlier My QR' USING ERRCODE = 'OM422';
  END IF;
  SELECT * INTO found_n FROM enrollment n WHERE n.event_id = target_event AND n.player_id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  END IF;
  RETURN QUERY
  SELECT p.username, p.avatar, found_n.status, d.id, r.kind, r.name_ar, r.name_en, d.price, d.created_at,
         d.reserved_until, coalesce(d.collect_until > now(), false),
         coalesce(d.offer_by = me AND d.offer_until > now(), false), CASE WHEN d.offer_by = me THEN d.offer_until END
  FROM player p
  LEFT JOIN redemption d ON d.enrollment_id = found_n.id AND d.status = 'reserved'
  LEFT JOIN reward r ON r.id = d.reward_id
  WHERE p.id = scanned
  ORDER BY d.created_at, d.id;
END $$;
REVOKE ALL ON FUNCTION desk_lookup(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_lookup(uuid, uuid, integer) TO questify_app;

-- The desk's Handed over (collect_first: final, through finish_handover) or Hand over (desk_offer: an offer for 2
-- minutes, replacing an older one). The offer's checks run unlocked on purpose: finish_handover checks every one
-- again under the locks when the player accepts. The offer takes the assignment (FOR SHARE) and the redemption only.
CREATE FUNCTION desk_hand_over(target uuid)
  RETURNS TABLE (status text, offer_until timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
  answer    text;
  until     timestamptz;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = found_row.event_id;
  IF ev.handover_confirm = 'collect_first' THEN
    answer := finish_handover(target, me, false);
    RETURN QUERY SELECT 'handed_over'::text, NULL::timestamptz, answer = 'replayed';
    RETURN;
  END IF;

  PERFORM desk_operator(found_row.event_id, me);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = found_row.enrollment_id;
  IF enrolled.player_id = me THEN
    RAISE EXCEPTION 'an operator does not hand over their own reservation' USING ERRCODE = 'OY409';
  END IF;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF locked.status = 'handed_over' AND locked.operator_id = me THEN
    RETURN QUERY SELECT 'handed_over'::text, NULL::timestamptz, true;
    RETURN;
  END IF;
  IF locked.status <> 'reserved' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = locked.status;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;
  IF locked.reserved_until <= now() AND coalesce(locked.offer_until <= now(), true) THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = 'expired';
  END IF;
  -- Past the deadline a live offer may change hands but never runs longer (ADR-151).
  UPDATE redemption d
  SET offer_by = me,
      offer_until = CASE WHEN locked.reserved_until <= now() THEN locked.offer_until
                         ELSE now() + interval '2 minutes' END
  WHERE d.id = target RETURNING d.offer_until INTO until;
  RETURN QUERY SELECT 'offered'::text, until, false;
END $$;
REVOKE ALL ON FUNCTION desk_hand_over(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_hand_over(uuid) TO questify_app;

-- The desk's poll while it waits for an accept. `offered` is this desk's own live offer only: another desk's newer
-- offer reads as not offered here.
CREATE FUNCTION desk_redemption(target uuid)
  RETURNS TABLE (status text, offered boolean, offer_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  found_row redemption%ROWTYPE;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM desk_operator(found_row.event_id, me);
  RETURN QUERY SELECT found_row.status, coalesce(found_row.offer_by = me AND found_row.offer_until > now(), false),
                      CASE WHEN found_row.offer_by = me THEN found_row.offer_until END;
END $$;
REVOKE ALL ON FUNCTION desk_redemption(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_redemption(uuid) TO questify_app;

-- The operator's Cancel (FR-513, FR-1603): the points and the unit come back, written as the operator. Allowed while
-- the desk is closed. Cancelling twice answers the cancelled reservation again. Refusals: RN404, OP403/OA403, OY409
-- the operator's own reservation, RE409 it ended another way (DETAIL: the status). The player's balance is not shown.
CREATE FUNCTION operator_cancel_redemption(target uuid)
  RETURNS TABLE (redemption_id uuid, status text, price integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  found_row redemption%ROWTYPE;
  ended     boolean;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM desk_operator(found_row.event_id, me);
  IF EXISTS (SELECT 1 FROM enrollment n WHERE n.id = found_row.enrollment_id AND n.player_id = me) THEN
    RAISE EXCEPTION 'an operator does not cancel their own reservation here' USING ERRCODE = 'OY409';
  END IF;
  ended := end_reservation(target, 'cancelled', 'operator', 'operator', me);
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT ended AND NOT (found_row.status = 'cancelled' AND found_row.ended_by = 'operator') THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = found_row.status;
  END IF;
  RETURN QUERY SELECT found_row.id, found_row.status, found_row.price, NOT ended;
END $$;
REVOKE ALL ON FUNCTION operator_cancel_redemption(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_cancel_redemption(uuid) TO questify_app;

-- ================================================================ the player's side
-- The player's own reservation, read unlocked: the redemption and its enrollment's status. RN404 when not theirs.
CREATE FUNCTION my_desk_redemption(target uuid, me uuid) RETURNS redemption
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  mine redemption%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT d.* INTO mine FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
  WHERE d.id = target AND n.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  RETURN mine;
END $$;
REVOKE ALL ON FUNCTION my_desk_redemption(uuid, uuid) FROM PUBLIC;

-- Collect (collect_first): the reservation is ready at the desk for 5 minutes. Takes the redemption's lock only.
-- Refusals: RN404, RM409 the event uses desk offers, RS403 desk_closed (closed or finished), RA403 enrollment not
-- active, RE409 not reserved or past its deadline (DETAIL: status or 'expired').
CREATE FUNCTION start_collect(target uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := app_player_id();
  mine   redemption%ROWTYPE := my_desk_redemption(target, app_player_id());
  ev     event%ROWTYPE;
  joined text;
  locked redemption%ROWTYPE;
  until  timestamptz;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = mine.event_id;
  IF ev.handover_confirm <> 'collect_first' THEN
    RAISE EXCEPTION 'this event confirms handovers the other way' USING ERRCODE = 'RM409';
  END IF;
  IF desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;
  SELECT n.status INTO joined FROM enrollment n WHERE n.id = mine.enrollment_id AND n.player_id = me;
  IF joined <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = joined;
  END IF;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF locked.status <> 'reserved' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = locked.status;
  END IF;
  IF locked.reserved_until <= now() AND coalesce(locked.collect_until <= now(), true) THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = 'expired';
  END IF;
  -- Past the deadline a live Collect is answered again, never renewed (ADR-151).
  UPDATE redemption d
  SET collect_until = CASE WHEN locked.reserved_until <= now() THEN locked.collect_until
                           ELSE now() + interval '5 minutes' END
  WHERE d.id = target RETURNING d.collect_until INTO until;
  RETURN until;
END $$;
REVOKE ALL ON FUNCTION start_collect(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_collect(uuid) TO questify_app;

-- Accept the desk's offer (desk_offer): final through finish_handover, which checks the offer again under the locks.
-- Accepting twice answers the handover again. Refusals: RN404, RM409, RO410 no live offer, and finish_handover's.
CREATE FUNCTION accept_handover(target uuid) RETURNS TABLE (status text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine   redemption%ROWTYPE := my_desk_redemption(target, app_player_id());
  answer text;
BEGIN
  IF (SELECT e.handover_confirm FROM event e WHERE e.id = mine.event_id) <> 'desk_offer' THEN
    RAISE EXCEPTION 'this event confirms handovers the other way' USING ERRCODE = 'RM409';
  END IF;
  IF mine.status = 'handed_over' THEN
    RETURN QUERY SELECT 'handed_over'::text, true;
    RETURN;
  END IF;
  IF mine.offer_by IS NULL THEN
    RAISE EXCEPTION 'no live offer' USING ERRCODE = 'RO410';
  END IF;
  answer := finish_handover(target, mine.offer_by, true);
  RETURN QUERY SELECT 'handed_over'::text, answer = 'replayed';
END $$;
REVOKE ALL ON FUNCTION accept_handover(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_handover(uuid) TO questify_app;

-- Not now: the offer goes; the reservation stays. False when there was no offer. Takes the redemption's lock only.
CREATE FUNCTION decline_handover(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine   redemption%ROWTYPE := my_desk_redemption(target, app_player_id());
  locked redemption%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM redemption d WHERE d.id = mine.id FOR UPDATE;
  IF locked.status <> 'reserved' OR locked.offer_by IS NULL THEN
    RETURN false;
  END IF;
  UPDATE redemption d SET offer_by = NULL, offer_until = NULL WHERE d.id = mine.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION decline_handover(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decline_handover(uuid) TO questify_app;

-- What My QR shows: the caller's reservations ready at a desk or offered by one right now, in every event they are
-- still an active member of.
CREATE FUNCTION my_desk_items()
  RETURNS TABLE (redemption_id uuid, event_id uuid, event_name_ar text, event_name_en text, kind text, name_ar text,
                 name_en text, state text, until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, e.id, e.name_ar, e.name_en, r.kind, r.name_ar, r.name_en,
         CASE WHEN d.offer_until > now() THEN 'offered' ELSE 'collecting' END,
         CASE WHEN d.offer_until > now() THEN d.offer_until ELSE d.collect_until END
  FROM enrollment n
  JOIN redemption d ON d.enrollment_id = n.id AND d.status = 'reserved'
  JOIN reward r ON r.id = d.reward_id
  JOIN event e ON e.id = n.event_id
  WHERE n.player_id = app_player_id() AND n.status = 'active'
    AND (d.offer_until > now() OR d.collect_until > now())
  ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION my_desk_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_desk_items() TO questify_app;

-- True when the caller holds a reserved desk reward in an event that uses desk offers: only then does My QR watch for
-- an offer.
CREATE FUNCTION my_desk_watch() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM enrollment n
    JOIN redemption d ON d.enrollment_id = n.id AND d.status = 'reserved'
    JOIN event e ON e.id = n.event_id
    WHERE n.player_id = app_player_id() AND n.status = 'active' AND e.handover_confirm = 'desk_offer')
$$;
REVOKE ALL ON FUNCTION my_desk_watch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_desk_watch() TO questify_app;

-- ================================================================ the player's reads, again
-- As in 0025, plus the desk (FR-1716: shown on every reservation): its place, pin, windows (sorted), state and how the
-- player confirms, and the event's zone to show the windows in.
DROP FUNCTION event_shop(uuid);
CREATE FUNCTION event_shop(target uuid)
  RETURNS TABLE (state text, closes_at timestamptz, pickup_minutes integer, rules_ar text, rules_en text,
                 balance bigint, first_redemption boolean, spend_lowers_rank boolean, desk_location_ar text,
                 desk_location_en text, desk_lat numeric, desk_lng numeric, desk_opens timestamptz[],
                 desk_closes timestamptz[], desk_state text, handover_confirm text, timezone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after),
         e.ends_at + make_interval(days => e.shop_days_after), e.pickup_minutes, e.shop_rules_ar, e.shop_rules_en,
         n.balance, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id),
         e.spend_lowers_rank AND event_status_now(e.status, e.starts_at, e.ends_at) = 'live',
         e.desk_location_ar, e.desk_location_en, e.desk_lat, e.desk_lng,
         (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         desk_state(e.desk_hours), e.handover_confirm, e.timezone
  FROM enrollment n JOIN event e ON e.id = n.event_id JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION event_shop(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_shop(uuid) TO questify_app;

-- As in 0025, plus the live Collect and offer times.
DROP FUNCTION my_redemptions(uuid);
CREATE FUNCTION my_redemptions(target uuid)
  RETURNS TABLE (id uuid, reward_id uuid, kind text, name_ar text, name_en text, price integer, status text,
                 reserved_until timestamptz, created_at timestamptz, ended_at timestamptz, code_cipher bytea,
                 collect_until timestamptz, offer_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.reward_id, r.kind, r.name_ar, r.name_en, d.price, d.status, d.reserved_until, d.created_at, d.ended_at,
         c.code_cipher, CASE WHEN d.collect_until > now() THEN d.collect_until END,
         CASE WHEN d.offer_until > now() THEN d.offer_until END
  FROM enrollment n JOIN redemption d ON d.enrollment_id = n.id JOIN reward r ON r.id = d.reward_id
  LEFT JOIN reward_code c ON c.redemption_id = d.id
  WHERE n.event_id = target AND n.player_id = app_player_id()
  ORDER BY d.created_at DESC, d.id
  LIMIT 100
$$;
REVOKE ALL ON FUNCTION my_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_redemptions(uuid) TO questify_app;
