-- T-612: prize reservation On or Off, and the one-step desk sale (FR-1834; plan
-- docs/plans/2026-11-01-t-612-desk-redeem.md, plan review 88 folded; ADR-397, Q-364). `event.reservation_on` (owner
-- or editor, through the shop settings) chooses the mode. On: the shop reserves as today and nothing is sold at the
-- desk. Off: an item or experience is not reserved in the app (RS403 `reservation_off`); the desk scans My QR and
-- offers it, and the player's own Pay takes the price and hands it over in one transaction. Digital rewards stay in
-- the app in both modes. Reservations made before Off stand.
--
-- `reserve_reward`'s gates move into `spend_checks` and its writes into `spend_reward`, which both doors share, so a
-- sale writes exactly the rows a reserve plus a handover write (one `redeem`, one `handover`). `reserve_reward`'s
-- answers and refusal order are unchanged (test/rewards/reserve-order.int.test.ts) except: the reward's lock is taken
-- before RA403/RP403 are judged, and a key starting with `desk:` (the sale's own redemption key) is refused RK422.
--
-- A live offer is `status = 'offered' AND offer_until > now()` everywhere (desk_sale_live). Locks, in the one order:
-- the operator's assignment (FOR SHARE) -> enrollment -> reward -> desk_sale -> redemption. No event or quest lock.
-- New table: desk_sale, RLS forced, no policy and no grant (the definers below are its only doors). Every new function
-- is revoked from PUBLIC; the doors are granted to questify_app only. Migrations 0106 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the switch
ALTER TABLE event ADD COLUMN reservation_on boolean NOT NULL DEFAULT true;
GRANT UPDATE (reservation_on) ON event TO questify_app;

-- ================================================================ the desk's offers
-- An offer, never points: the price the player was shown, until when, and how it ended. `refusal` is the SQLSTATE
-- and detail that refused a Pay (`RO409`, `RB422`, `RW403:ended`, ...). An expired offer keeps `offered` with
-- `offer_until` past; readers say `expired`.
CREATE TABLE desk_sale (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id    uuid NOT NULL,
  event_id        uuid NOT NULL,
  enrollment_id   uuid NOT NULL,
  reward_id       uuid NOT NULL,
  operator_id     uuid NOT NULL REFERENCES player (id),
  price           integer NOT NULL CHECK (price >= 1),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  status          text NOT NULL DEFAULT 'offered'
                  CHECK (status IN ('offered', 'accepted', 'declined', 'withdrawn', 'refused')),
  refusal         text CHECK (length(refusal) BETWEEN 5 AND 40),
  offer_until     timestamptz NOT NULL,
  redemption_id   uuid UNIQUE REFERENCES redemption (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  UNIQUE (operator_id, idempotency_key),
  CHECK ((status = 'accepted') = (redemption_id IS NOT NULL)),
  CHECK ((status = 'refused') = (refusal IS NOT NULL)),
  CHECK ((status = 'offered') = (ended_at IS NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (reward_id, event_id) REFERENCES reward (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX desk_sale_open ON desk_sale (enrollment_id) WHERE status = 'offered';
CREATE INDEX desk_sale_reward ON desk_sale (reward_id);
ALTER TABLE desk_sale ENABLE ROW LEVEL SECURITY;
ALTER TABLE desk_sale FORCE ROW LEVEL SECURITY;
REVOKE ALL ON desk_sale FROM PUBLIC;

-- Whether an offer can still be paid (plan review MAJOR 1). Internal.
CREATE FUNCTION desk_sale_live(sale desk_sale) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT sale.status = 'offered' AND sale.offer_until > now()
$$;
REVOKE ALL ON FUNCTION desk_sale_live(desk_sale) FROM PUBLIC;

-- ================================================================ the one spend body (internal)
-- Every gate of a shop spend, in reserve_reward's order (0094). The caller holds the enrollment (FOR NO KEY UPDATE)
-- and the reward (FOR UPDATE). `at_desk` is the operator of a desk sale, NULL for the app's reserve. Answers when a
-- reserved desk reward may be picked up from (now, or the desk's next window). Refusals:
--   RA403 not active (DETAIL: status)   RP403 paused   RN404 removed or not in the audience
--   RW403 community_locked / not_started / ended   RS403 feature_off / reservation_off / the window / desk_finished /
--   desk_closed (a sale)   DS409 reservation_on (a sale while reservation is On)   RO409 sold out
--   RL409 the per-player limit (DETAIL: it)   RB422 too few points
CREATE FUNCTION spend_checks(enrolled enrollment, item reward, ev event, at_desk uuid) RETURNS timestamptz
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  rehearsing  boolean := coalesce(play_phase(ev, enrolled) = 'rehearsal', false);
  shop        text;
  desk        text;
  held        integer;
  pickup_from timestamptz := now();
BEGIN
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
  END IF;
  IF item.status <> 'active'
     OR NOT in_audience(enrolled.id, item.audience_kind, item.audience_field_id, item.audience_values) THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF reward_community_lock(item) IS NOT NULL THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'community_locked';
  END IF;
  IF NOT feature_enabled(ev, 'shop') THEN
    RAISE EXCEPTION 'the shop is switched off' USING ERRCODE = 'RS403', DETAIL = 'feature_off';
  END IF;
  IF at_desk IS NULL AND item.kind IN ('item', 'experience') AND NOT ev.reservation_on THEN
    RAISE EXCEPTION 'this prize is redeemed at the desk' USING ERRCODE = 'RS403', DETAIL = 'reservation_off';
  END IF;
  IF at_desk IS NOT NULL AND ev.reservation_on THEN
    RAISE EXCEPTION 'this event reserves prizes' USING ERRCODE = 'DS409', DETAIL = 'reservation_on';
  END IF;
  shop := CASE WHEN rehearsing THEN 'open' ELSE shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) END;
  IF shop <> 'open' THEN
    RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = shop;
  END IF;
  IF item.kind IN ('item', 'experience') AND NOT rehearsing THEN
    desk := desk_state(ev.desk_hours);
    IF at_desk IS NOT NULL AND desk <> 'open' THEN
      RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
    END IF;
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
    WHERE d.enrollment_id = enrolled.id AND d.reward_id = item.id AND d.status NOT IN ('cancelled', 'expired');
    IF held >= item.per_player_limit THEN
      RAISE EXCEPTION 'limit reached' USING ERRCODE = 'RL409', DETAIL = item.per_player_limit::text;
    END IF;
  END IF;
  IF enrolled.balance < item.price THEN
    RAISE EXCEPTION 'balance too low' USING ERRCODE = 'RB422';
  END IF;
  RETURN pickup_from;
END $$;
REVOKE ALL ON FUNCTION spend_checks(enrollment, reward, event, uuid) FROM PUBLIC;

-- The gates, then the writes: the redemption (reserved, delivered, or with `at_desk` handed over at once), the unit
-- (a rehearsal's digital reward takes none), the `redeem` row as the player (ADR-135's rank), and for a sale the
-- `handover` row as the operator. RX500 when a digital reward's stock and codes disagree. Internal.
CREATE FUNCTION spend_reward(enrolled enrollment, item reward, ev event, request_key text, at_desk uuid)
  RETURNS redemption
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  pickup_from  timestamptz := spend_checks(enrolled, item, ev, at_desk);
  rehearsing   boolean := coalesce(play_phase(ev, enrolled) = 'rehearsal', false);
  code_id      bigint;
  spend_rank   integer := 0;
  made         redemption%ROWTYPE;
  digital      boolean := item.kind = 'digital';
BEGIN
  IF digital AND NOT rehearsing THEN
    SELECT c.id INTO code_id FROM reward_code c
    WHERE c.reward_id = item.id AND c.redemption_id IS NULL ORDER BY c.id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a digital reward''s stock and codes disagree' USING ERRCODE = 'RX500';
    END IF;
  END IF;
  IF ev.spend_lowers_rank AND play_phase(ev, enrolled) IS NOT NULL THEN
    spend_rank := -item.price;
  END IF;

  INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, status,
                          reserved_until, ended_at, ended_by, operator_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, item.id, item.price, request_key,
          CASE WHEN at_desk IS NOT NULL THEN 'handed_over' WHEN digital THEN 'delivered' ELSE 'reserved' END,
          CASE WHEN at_desk IS NOT NULL THEN now()
               WHEN NOT digital THEN pickup_from + make_interval(mins => ev.pickup_minutes) END,
          CASE WHEN at_desk IS NOT NULL OR digital THEN now() END,
          CASE WHEN at_desk IS NOT NULL THEN 'handover' WHEN digital THEN 'delivery' END,
          at_desk)
  RETURNING * INTO made;
  UPDATE reward_code c SET redemption_id = made.id WHERE c.id = code_id;
  IF NOT (digital AND rehearsing) THEN
    UPDATE reward r SET units_out = r.units_out + 1 WHERE r.id = item.id;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'redeem', spend_rank, -item.price, made.id, 'player');
  IF spend_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (enrolled.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  IF at_desk IS NOT NULL THEN
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                              redemption_id, actor, operator_id)
    VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'handover', 0, 0, made.id, 'operator', at_desk);
  END IF;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION spend_reward(enrollment, reward, event, text, uuid) FROM PUBLIC;

-- ================================================================ the app's reserve
-- As 0094, its gates and writes now in spend_reward. A key starting with `desk:` belongs to a desk sale (RK422).
CREATE OR REPLACE FUNCTION reserve_reward(target uuid, request_key text)
  RETURNS TABLE (redemption_id uuid, kind text, status text, price integer, reserved_until timestamptz,
                 balance bigint, stock_left integer, replayed boolean, code_cipher bytea)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := app_player_id();
  found_ev uuid;
  enrolled enrollment%ROWTYPE;
  item     reward%ROWTYPE;
  ev       event%ROWTYPE;
  earlier  redemption%ROWTYPE;
  made     redemption%ROWTYPE;
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
  IF starts_with(request_key, 'desk:') THEN
    RAISE EXCEPTION 'this key belongs to a desk sale' USING ERRCODE = 'RK422';
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

  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  SELECT * INTO ev FROM event e WHERE e.id = item.event_id;
  made := spend_reward(enrolled, item, ev, request_key, NULL);

  RETURN QUERY SELECT made.id, item.kind, made.status, made.price, made.reserved_until, n.balance,
                      r.stock_total - r.units_out, false,
                      (SELECT c.code_cipher FROM reward_code c WHERE c.redemption_id = made.id)
    FROM enrollment n, reward r WHERE n.id = enrolled.id AND r.id = target;
END $$;
REVOKE ALL ON FUNCTION reserve_reward(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_reward(uuid, text) TO questify_app;

-- ================================================================ the desk's side
-- The scanned player as desk_lookup checks them (OP403/OA403 the operator, OY409 their own code, QC404 not in the
-- event, OM422 an earlier My QR), FOR NO KEY UPDATE when `lock_it`. Internal.
CREATE FUNCTION desk_scanned(target_event uuid, me uuid, scanned uuid, scanned_version integer, lock_it boolean)
  RETURNS enrollment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
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
  IF lock_it THEN
    SELECT * INTO found_n FROM enrollment n WHERE n.event_id = target_event AND n.player_id = scanned FOR NO KEY UPDATE;
  ELSE
    SELECT * INTO found_n FROM enrollment n WHERE n.event_id = target_event AND n.player_id = scanned;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  END IF;
  RETURN found_n;
END $$;
REVOKE ALL ON FUNCTION desk_scanned(uuid, uuid, uuid, integer, boolean) FROM PUBLIC;

-- "Sell from the shop": the scanned player's offerable rewards (active desk kinds in their audience and not
-- community-locked), in the shop's order, with whether they can buy each now. The balance is not shown, only `can`:
-- ok, too_few_points, limit, sold_out, not_open. No rows while reservation is On, the shop is off, or the player is
-- not active or held (the lookup already tells the desk why).
CREATE FUNCTION desk_sale_rewards(target_event uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (reward_id uuid, kind text, name_ar text, name_en text, price integer, stock_left integer, can text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  found_n    enrollment%ROWTYPE;
  ev         event%ROWTYPE;
  rehearsing boolean;
  open_now   boolean;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  found_n := desk_scanned(target_event, me, scanned, scanned_version, false);
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  IF ev.reservation_on OR NOT feature_enabled(ev, 'shop') OR found_n.status <> 'active'
     OR desk_hold(found_n, ev) IS NOT NULL THEN
    RETURN;
  END IF;
  rehearsing := coalesce(play_phase(ev, found_n) = 'rehearsal', false);
  open_now := rehearsing OR (shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'open'
                             AND desk_state(ev.desk_hours) = 'open');
  RETURN QUERY
  SELECT r.id, r.kind, r.name_ar, r.name_en, r.price, r.stock_total - r.units_out,
         CASE WHEN NOT open_now OR coalesce(r.opens_at > now(), false) OR coalesce(r.closes_at <= now(), false)
                THEN 'not_open'
              WHEN r.units_out >= r.stock_total THEN 'sold_out'
              WHEN r.per_player_limit IS NOT NULL AND r.per_player_limit <= (
                SELECT count(*) FROM redemption d
                WHERE d.enrollment_id = found_n.id AND d.reward_id = r.id AND d.status NOT IN ('cancelled', 'expired'))
                THEN 'limit'
              WHEN found_n.balance < r.price THEN 'too_few_points'
              ELSE 'ok' END
  FROM reward r
  WHERE r.event_id = target_event AND r.status = 'active' AND r.kind IN ('item', 'experience')
    AND in_audience(found_n.id, r.audience_kind, r.audience_field_id, r.audience_values)
    AND reward_community_lock(r) IS NULL
  ORDER BY r.position, r.id;
END $$;
REVOKE ALL ON FUNCTION desk_sale_rewards(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_sale_rewards(uuid, uuid, integer) TO questify_app;

-- Whether the player paid for this reward at a desk in the last 2 minutes (plan review MINOR 8). Internal.
CREATE FUNCTION desk_just_bought(enrolled uuid, target_reward uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM desk_sale s
                 WHERE s.enrollment_id = enrolled AND s.reward_id = target_reward AND s.status = 'accepted'
                   AND s.ended_at > now() - interval '2 minutes')
$$;
REVOKE ALL ON FUNCTION desk_just_bought(uuid, uuid) FROM PUBLIC;

-- The desk offers one reward to the scanned player for 2 minutes. Nothing is held and no points move. Locks: the
-- assignment (FOR SHARE) -> the enrollment. A key this operator already used answers its offer (RK422 when it named
-- another event, player or reward). A live offer by another operator is DS409 `desk_busy`; this operator's live offer
-- of the same reward answers itself; of another reward it is withdrawn and replaced. Refusals: the scan's (above),
-- RH409 held (DETAIL: held or paused), RA403 not active, RN404 not a reward of this event, DS422 `not_desk_reward`
-- (digital), DS409 `reservation_on`, RS403 `feature_off` or `desk_closed` (a rehearsal account's desk is open).
CREATE FUNCTION desk_offer_sale(target_event uuid, scanned uuid, scanned_version integer, target_reward uuid,
                                request_key text)
  RETURNS TABLE (sale_id uuid, status text, price integer, offer_until timestamptz, replayed boolean,
                 just_bought boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := app_player_id();
  earlier  desk_sale%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  item     reward%ROWTYPE;
  hold     text;
  live     desk_sale%ROWTYPE;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  PERFORM desk_operator(target_event, me);
  SELECT * INTO earlier FROM desk_sale s WHERE s.operator_id = me AND s.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.event_id <> target_event OR earlier.reward_id <> target_reward
       OR (SELECT n.player_id FROM enrollment n WHERE n.id = earlier.enrollment_id) IS DISTINCT FROM scanned THEN
      RAISE EXCEPTION 'this key was used for another offer' USING ERRCODE = 'RK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.price, earlier.offer_until, true,
                        desk_just_bought(earlier.enrollment_id, earlier.reward_id);
    RETURN;
  END IF;
  enrolled := desk_scanned(target_event, me, scanned, scanned_version, true);
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  hold := desk_hold(enrolled, ev);
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target_reward AND r.event_id = target_event AND r.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF item.kind NOT IN ('item', 'experience') THEN
    RAISE EXCEPTION 'a digital reward stays in the app' USING ERRCODE = 'DS422', DETAIL = 'not_desk_reward';
  END IF;
  IF ev.reservation_on THEN
    RAISE EXCEPTION 'this event reserves prizes' USING ERRCODE = 'DS409', DETAIL = 'reservation_on';
  END IF;
  IF NOT feature_enabled(ev, 'shop') THEN
    RAISE EXCEPTION 'the shop is switched off' USING ERRCODE = 'RS403', DETAIL = 'feature_off';
  END IF;
  IF play_phase(ev, enrolled) IS DISTINCT FROM 'rehearsal' AND desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;

  SELECT s.* INTO live FROM desk_sale s
  WHERE s.enrollment_id = enrolled.id AND desk_sale_live(s) ORDER BY s.created_at DESC LIMIT 1;
  IF FOUND AND live.operator_id <> me THEN
    RAISE EXCEPTION 'another desk is serving this player' USING ERRCODE = 'DS409', DETAIL = 'desk_busy';
  END IF;
  IF FOUND AND live.reward_id = target_reward THEN
    RETURN QUERY SELECT live.id, live.status, live.price, live.offer_until, true,
                        desk_just_bought(enrolled.id, target_reward);
    RETURN;
  END IF;
  IF FOUND THEN
    UPDATE desk_sale s SET status = 'withdrawn', ended_at = now() WHERE s.id = live.id;
  END IF;
  INSERT INTO desk_sale (organizer_id, event_id, enrollment_id, reward_id, operator_id, price, idempotency_key,
                         offer_until)
  VALUES (enrolled.organizer_id, target_event, enrolled.id, target_reward, me, item.price, request_key,
          now() + interval '2 minutes')
  RETURNING * INTO live;
  RETURN QUERY SELECT live.id, live.status, live.price, live.offer_until, false,
                      desk_just_bought(enrolled.id, target_reward);
END $$;
REVOKE ALL ON FUNCTION desk_offer_sale(uuid, uuid, integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_offer_sale(uuid, uuid, integer, uuid, text) TO questify_app;

-- The desk's poll while it waits (2 s, no-store): the offer's state, `expired` once a live offer's time passed, and
-- why a Pay was refused. Any operator with hand_over in the sale's event (OP403/OA403); RN404 unknown.
CREATE FUNCTION desk_sale_state(target uuid)
  RETURNS TABLE (status text, price integer, offer_until timestamptz, refusal text, redemption_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  sale desk_sale%ROWTYPE;
BEGIN
  SELECT * INTO sale FROM desk_sale s WHERE s.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM desk_operator(sale.event_id, app_player_id());
  RETURN QUERY SELECT CASE WHEN sale.status = 'offered' AND NOT desk_sale_live(sale) THEN 'expired' ELSE sale.status END,
                      sale.price, sale.offer_until, sale.refusal, sale.redemption_id;
END $$;
REVOKE ALL ON FUNCTION desk_sale_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_sale_state(uuid) TO questify_app;

-- Withdraw: the offering operator, or any operator with hand_over in the event. Takes the sale's lock only. False when
-- the offer had already ended or expired. RN404 unknown, OP403/OA403.
CREATE FUNCTION withdraw_desk_sale(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  sale desk_sale%ROWTYPE;
BEGIN
  SELECT * INTO sale FROM desk_sale s WHERE s.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM ensure_rehearsal_wiped(sale.event_id);
  PERFORM desk_operator(sale.event_id, app_player_id());
  SELECT * INTO sale FROM desk_sale s WHERE s.id = target FOR UPDATE;
  IF NOT FOUND OR NOT desk_sale_live(sale) THEN
    RETURN false;
  END IF;
  UPDATE desk_sale s SET status = 'withdrawn', ended_at = now() WHERE s.id = target;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION withdraw_desk_sale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION withdraw_desk_sale(uuid) TO questify_app;

-- ================================================================ the player's side
-- The caller's own sale, read unlocked. RN404 when not theirs; insufficient_privilege without a player. Internal.
CREATE FUNCTION my_desk_sale(target uuid) RETURNS desk_sale
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := app_player_id();
  mine desk_sale%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO mine FROM desk_sale s JOIN enrollment n ON n.id = s.enrollment_id
  WHERE s.id = target AND n.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sale not found' USING ERRCODE = 'RN404';
  END IF;
  RETURN mine;
END $$;
REVOKE ALL ON FUNCTION my_desk_sale(uuid) FROM PUBLIC;

-- The sale's answer after a Pay: the sale as it now stands and the caller's balance.
CREATE FUNCTION desk_sale_answer(target uuid, was_replayed boolean)
  RETURNS TABLE (status text, redemption_id uuid, balance bigint, refusal text, replayed boolean)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.status, s.redemption_id, n.balance, s.refusal, was_replayed
  FROM desk_sale s JOIN enrollment n ON n.id = s.enrollment_id WHERE s.id = target
$$;
REVOKE ALL ON FUNCTION desk_sale_answer(uuid, boolean) FROM PUBLIC;

-- Pay (the player's own tap, ADR-137): every gate again under the locks, then the one spend with the sale's operator
-- as the handover's. Locks: the operator's assignment (FOR SHARE) -> enrollment -> reward -> the sale. A sale already
-- paid or refused answers again (`replayed`). DS410 when the offer ended (DETAIL: declined, withdrawn, expired); RN404
-- when it is not the caller's or is gone. A business refusal inside the block ends the sale `refused` with its code
-- and is answered as `status = 'refused'` (the operator lost hand_over: `withdrawn`); anything else rolls back whole.
CREATE FUNCTION accept_desk_sale(target uuid)
  RETURNS TABLE (status text, redemption_id uuid, balance bigint, refusal text, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_sale desk_sale%ROWTYPE := my_desk_sale(target);
  locked     desk_sale%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  item       reward%ROWTYPE;
  ev         event%ROWTYPE;
  hold       text;
  made       redemption%ROWTYPE;
  code       text;
  detail     text;
BEGIN
  PERFORM ensure_rehearsal_wiped(found_sale.event_id);
  PERFORM 1 FROM staff_assignment sa
  WHERE sa.event_id = found_sale.event_id AND sa.player_id = found_sale.operator_id FOR SHARE;
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = found_sale.enrollment_id FOR NO KEY UPDATE;
  SELECT * INTO item FROM reward r WHERE r.id = found_sale.reward_id FOR UPDATE;
  SELECT * INTO locked FROM desk_sale s WHERE s.id = target FOR UPDATE;
  IF NOT FOUND OR enrolled.id IS NULL THEN
    RAISE EXCEPTION 'sale not found' USING ERRCODE = 'RN404';
  END IF;
  IF locked.status IN ('accepted', 'refused') THEN
    RETURN QUERY SELECT * FROM desk_sale_answer(target, true);
    RETURN;
  END IF;
  IF locked.status <> 'offered' THEN
    RAISE EXCEPTION 'the offer ended' USING ERRCODE = 'DS410', DETAIL = locked.status;
  END IF;
  IF NOT desk_sale_live(locked) THEN
    RAISE EXCEPTION 'the offer ended' USING ERRCODE = 'DS410', DETAIL = 'expired';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = locked.event_id;
  BEGIN
    PERFORM desk_operator(locked.event_id, locked.operator_id);
    IF enrolled.player_id = locked.operator_id THEN
      RAISE EXCEPTION 'an operator does not sell to themselves' USING ERRCODE = 'OY409';
    END IF;
    hold := desk_hold(enrolled, ev);
    IF hold IS NOT NULL THEN
      RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
    END IF;
    IF item.price <> locked.price THEN
      RAISE EXCEPTION 'the price changed' USING ERRCODE = 'DS409', DETAIL = 'price_changed';
    END IF;
    made := spend_reward(enrolled, item, ev, 'desk:' || locked.id::text, locked.operator_id);
    UPDATE desk_sale s SET status = 'accepted', redemption_id = made.id, ended_at = now() WHERE s.id = target;
  EXCEPTION
    WHEN SQLSTATE 'RA403' OR SQLSTATE 'RP403' OR SQLSTATE 'RN404' OR SQLSTATE 'RW403' OR SQLSTATE 'RS403'
      OR SQLSTATE 'DS409' OR SQLSTATE 'RO409' OR SQLSTATE 'RL409' OR SQLSTATE 'RB422' OR SQLSTATE 'OP403'
      OR SQLSTATE 'OA403' OR SQLSTATE 'OY409' OR SQLSTATE 'RH409' OR SQLSTATE 'QP403' THEN
    GET STACKED DIAGNOSTICS code = RETURNED_SQLSTATE, detail = PG_EXCEPTION_DETAIL;
    UPDATE desk_sale s
    SET status = CASE WHEN code IN ('OP403', 'OA403') THEN 'withdrawn' ELSE 'refused' END,
        refusal = CASE WHEN code NOT IN ('OP403', 'OA403')
                       THEN left(code || coalesce(':' || nullif(detail, ''), ''), 40) END,
        ended_at = now()
    WHERE s.id = target;
  END;
  RETURN QUERY SELECT * FROM desk_sale_answer(target, false);
END $$;
REVOKE ALL ON FUNCTION accept_desk_sale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION accept_desk_sale(uuid) TO questify_app;

-- Not now: the offer ends `declined`. Takes the sale's lock only. False when it had already ended or expired.
CREATE FUNCTION decline_desk_sale(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine   desk_sale%ROWTYPE := my_desk_sale(target);
  locked desk_sale%ROWTYPE;
BEGIN
  SELECT * INTO locked FROM desk_sale s WHERE s.id = mine.id FOR UPDATE;
  IF NOT FOUND OR NOT desk_sale_live(locked) THEN
    RETURN false;
  END IF;
  UPDATE desk_sale s SET status = 'declined', ended_at = now() WHERE s.id = mine.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION decline_desk_sale(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION decline_desk_sale(uuid) TO questify_app;

-- What My QR shows for a sale: the caller's live offers in every event they are an active member of, with the price,
-- the balance after paying, the desk's place, the shop's rules for a first redemption, and whether they just bought
-- the same reward at a desk (plan review MINOR 8).
CREATE FUNCTION my_desk_sales()
  RETURNS TABLE (sale_id uuid, event_id uuid, event_name_ar text, event_name_en text, kind text, name_ar text,
                 name_en text, price integer, offer_until timestamptz, balance_after bigint, desk_location_ar text,
                 desk_location_en text, first_redemption boolean, rules_ar text, rules_en text, just_bought boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, e.id, e.name_ar, e.name_en, r.kind, r.name_ar, r.name_en, s.price, s.offer_until, n.balance - s.price,
         e.desk_location_ar, e.desk_location_en, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id),
         e.shop_rules_ar, e.shop_rules_en, desk_just_bought(n.id, s.reward_id)
  FROM enrollment n
  JOIN desk_sale s ON s.enrollment_id = n.id AND s.status = 'offered' AND s.offer_until > now()
  JOIN reward r ON r.id = s.reward_id
  JOIN event e ON e.id = n.event_id
  WHERE n.player_id = app_player_id() AND n.status = 'active'
  ORDER BY s.created_at, s.id
$$;
REVOKE ALL ON FUNCTION my_desk_sales() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_desk_sales() TO questify_app;

-- As 0029, plus: an event with reservation Off, the shop on and the desk open (a rehearsal account: always), so My QR
-- watches for a sale.
CREATE OR REPLACE FUNCTION my_desk_watch() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM enrollment n
    JOIN redemption d ON d.enrollment_id = n.id AND d.status = 'reserved'
    JOIN event e ON e.id = n.event_id
    WHERE n.player_id = app_player_id() AND n.status = 'active' AND e.handover_confirm = 'desk_offer')
  OR EXISTS (
    SELECT 1 FROM enrollment n JOIN event e ON e.id = n.event_id
    WHERE n.player_id = app_player_id() AND n.status = 'active' AND NOT e.reservation_on
      AND feature_enabled(e, 'shop')
      AND (play_phase(e, n) = 'rehearsal'
           OR (shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after) = 'open'
               AND desk_state(e.desk_hours) = 'open')))
$$;
REVOKE ALL ON FUNCTION my_desk_watch() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_desk_watch() TO questify_app;

-- ================================================================ the headers learn the mode
-- As 0032, plus `reservation_on` and the shop switch (no API check covers the desk). The return type changes.
DROP FUNCTION operator_desk(uuid);
CREATE FUNCTION operator_desk(target_event uuid)
  RETURNS TABLE (desk_location_ar text, desk_location_en text, desk_lat numeric, desk_lng numeric,
                 desk_opens timestamptz[], desk_closes timestamptz[], desk_state text, handover_confirm text,
                 timezone text, reservation_on boolean, shop_on boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM desk_operator(target_event, app_player_id());
  RETURN QUERY
  SELECT e.desk_location_ar, e.desk_location_en, e.desk_lat, e.desk_lng,
         (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         CASE WHEN event_status_now(e.status, e.starts_at, e.ends_at) IN ('draft', 'scheduled') THEN 'open'
              ELSE desk_state(e.desk_hours) END,
         e.handover_confirm, e.timezone, e.reservation_on, feature_enabled(e, 'shop')
  FROM event e WHERE e.id = target_event;
END $$;
REVOKE ALL ON FUNCTION operator_desk(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_desk(uuid) TO questify_app;

-- As 0032, plus `reservation_on` (the shop switch itself is the API's check, T-602). The return type changes.
DROP FUNCTION event_shop(uuid);
CREATE FUNCTION event_shop(target uuid)
  RETURNS TABLE (state text, closes_at timestamptz, pickup_minutes integer, rules_ar text, rules_en text,
                 balance bigint, first_redemption boolean, spend_lowers_rank boolean, desk_location_ar text,
                 desk_location_en text, desk_lat numeric, desk_lng numeric, desk_opens timestamptz[],
                 desk_closes timestamptz[], desk_state text, handover_confirm text, timezone text,
                 reservation_on boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN play_phase(e, n) = 'rehearsal' THEN 'open'
              ELSE shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after) END,
         e.ends_at + make_interval(days => e.shop_days_after), e.pickup_minutes, e.shop_rules_ar, e.shop_rules_en,
         n.balance, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id),
         e.spend_lowers_rank AND play_phase(e, n) IS NOT NULL,
         e.desk_location_ar, e.desk_location_en, e.desk_lat, e.desk_lng,
         (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         CASE WHEN play_phase(e, n) = 'rehearsal' THEN 'open' ELSE desk_state(e.desk_hours) END,
         e.handover_confirm, e.timezone, e.reservation_on
  FROM enrollment n JOIN event e ON e.id = n.event_id JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION event_shop(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_shop(uuid) TO questify_app;

-- ================================================================ the rehearsal wipe, erasure and duplication
-- As 0097: a rehearsal account's sales go before its redemptions (the sale's redemption FK is RESTRICT). The answer's
-- `reservations` already counts a sale's redemption.
CREATE OR REPLACE FUNCTION public.wipe_rehearsal(target uuid, reason text, request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
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
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal', 'bonus', 'first_bonus')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)),
           'submissions', (SELECT count(*) FROM submission s WHERE s.enrollment_id = ANY (accounts)),
           'votes', (SELECT count(DISTINCT (v.enrollment_id, v.quest_id)) FROM quest_vote v
                     WHERE v.enrollment_id = ANY (accounts)),
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)),
           'surveys', (SELECT count(*) FROM survey_response r WHERE r.enrollment_id = ANY (accounts)),
           'reveals', (SELECT count(*) FROM category_reveal r WHERE r.enrollment_id = ANY (accounts)),
           'item_misses', (SELECT count(*) FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts)),
           'games', (SELECT count(*) FROM game_round g WHERE g.enrollment_id = ANY (accounts)),
           'tickets', (SELECT count(*) FROM ticket t WHERE t.enrollment_id = ANY (accounts)),
           'first_bonuses', (SELECT count(*) FROM quest_bonus_slot s WHERE s.event_id = target AND s.rehearsal))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  UPDATE quest_bonus_slot s
  SET completion_id = NULL, entry_id = NULL, enrollment_id = NULL, rehearsal = false, claimed_at = NULL
  WHERE s.event_id = target AND s.rehearsal;
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
  DELETE FROM desk_sale s WHERE s.enrollment_id = ANY (accounts);
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
  DELETE FROM ticket t WHERE t.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- The rehearsal's sent polls and launched flash quests go back to draft (no plays are left on them).
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, poll_sent_at = NULL
  WHERE q.event_id = target AND q.poll_sent_at IS NOT NULL;
  UPDATE quest q SET visible = false, opens_at = NULL, closes_at = NULL, flash_launched_at = NULL
  WHERE q.event_id = target AND q.flash_launched_at IS NOT NULL;
  UPDATE quest q SET paused_at = NULL, paused_by = NULL, skipped_at = NULL, skipped_by = NULL
  WHERE q.event_id = target AND (q.paused_at IS NOT NULL OR q.skipped_at IS NOT NULL);
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
REVOKE ALL ON FUNCTION wipe_rehearsal(uuid, text, uuid) FROM PUBLIC;

-- As 0091, plus the erased operator's live offers withdrawn and the erased player's sales removed (no contact detail).
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
  DELETE FROM souvenir_receipt WHERE player_id = me;
  PERFORM set_config('app.erasure','',true);
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  DELETE FROM marketing_consent WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM marketing_state WHERE player_id = me;
  DELETE FROM player_preference WHERE player_id = me;
  DELETE FROM invitation_recipient WHERE player_id = me;
  DELETE FROM notice WHERE player_id = me;
  DELETE FROM notification WHERE player_id = me;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = me;
  DELETE FROM push_device WHERE player_id = me;
  DELETE FROM push_topic_mute WHERE player_id = me;
  DELETE FROM push_topic_on WHERE player_id = me;
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
  DELETE FROM ticket WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  -- After the assignment delete and the enrollment update: the order accept_desk_sale locks in (T-612).
  UPDATE desk_sale s SET status = 'withdrawn', ended_at = now() WHERE s.operator_id = me AND s.status = 'offered';
  DELETE FROM desk_sale s WHERE s.enrollment_id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  -- Last: the staff_assignment delete above enqueues while the enrollments are still active (enqueue_souvenir_on_staff).
  DELETE FROM souvenir_work WHERE enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid,uuid[],bytea) FROM PUBLIC;

-- As 0092, plus `reservation_on`.
CREATE OR REPLACE FUNCTION event_copy_settings(src event, tgt event, shift interval) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE event e SET
    pickup_minutes = src.pickup_minutes, shop_days_after = src.shop_days_after,
    shop_rules_ar = src.shop_rules_ar, shop_rules_en = src.shop_rules_en,
    spend_lowers_rank = src.spend_lowers_rank, join_fields_version = src.join_fields_version,
    guest_list_only = src.guest_list_only, email_domains = src.email_domains, welcome_points = src.welcome_points,
    desk_location_ar = src.desk_location_ar, desk_location_en = src.desk_location_en,
    desk_lat = src.desk_lat, desk_lng = src.desk_lng,
    desk_hours = (SELECT range_agg(tstzrange(lower(h) + shift, upper(h) + shift)) FROM unnest(src.desk_hours) AS h),
    handover_confirm = src.handover_confirm, award_cap_each = src.award_cap_each, award_cap_day = src.award_cap_day,
    flag_hold = src.flag_hold, rank_prizes = src.rank_prizes, rules_ar = src.rules_ar, rules_en = src.rules_en,
    config = src.config, reservation_on = src.reservation_on
  WHERE e.id = tgt.id;
  INSERT INTO event_topic_off (event_id, organizer_id, topic)
  SELECT tgt.id, tgt.organizer_id, d.topic FROM event_topic_off d WHERE d.event_id = src.id;
END $$;
REVOKE ALL ON FUNCTION event_copy_settings(event, event, interval) FROM PUBLIC;
