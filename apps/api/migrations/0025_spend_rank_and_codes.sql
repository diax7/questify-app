-- Spending may lower the ranking (T-219, ADR-134) and digital rewards hand out uploaded codes (T-203, FR-510 to
-- FR-512). Each event chooses, before it goes live, whether a purchase also lowers the score; the ledger entry says
-- what it moved, and a return always mirrors its own payment. A digital reward's stock is its uploaded codes: one is
-- given per redemption, at once and for good. Codes are encrypted by the API before they reach this database; the
-- database holds only ciphers and keyed hashes, and no role reads either but the definers.

-- ================================================================ the event's choice (FR-1847)
ALTER TABLE event ADD COLUMN spend_lowers_rank boolean NOT NULL DEFAULT false;
GRANT UPDATE (spend_lowers_rank) ON event TO questify_app;

-- The owner's choice (FR-1847), not an editor's, and locked once the event is live so the board never reshuffles
-- mid-event; the shop opens only when live, so every spend of an event follows one rule. The owner connection and the
-- definers are not the API's role.
CREATE FUNCTION event_spend_rank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF NOT (app_is_admin() OR app_is_owner(OLD.organizer_id)) THEN
    RAISE EXCEPTION 'only the owner changes this' USING ERRCODE = 'QO403';
  END IF;
  IF event_status_now(OLD.status, OLD.starts_at, OLD.ends_at) IN ('live', 'ended', 'archived') THEN
    RAISE EXCEPTION 'spending lowers rank is locked once the event is live' USING ERRCODE = 'QE409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_spend_rank_guard() FROM PUBLIC;
CREATE TRIGGER event_spend_rank_guard BEFORE UPDATE OF spend_lowers_rank ON event
  FOR EACH ROW WHEN (OLD.spend_lowers_rank IS DISTINCT FROM NEW.spend_lowers_rank)
  EXECUTE FUNCTION event_spend_rank_guard();

-- A spend moves the balance, and the score too when the event says so: by the same amount, never another.
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_redeem_shape;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_redeem_shape
  CHECK (kind NOT IN ('redeem', 'redeem_return') OR (redemption_id IS NOT NULL
         AND (score_delta = 0 OR score_delta = balance_delta)
         AND completion_id IS NULL AND quest_id IS NULL
         AND CASE kind WHEN 'redeem' THEN balance_delta < 0 ELSE balance_delta > 0 END));

-- ================================================================ digital rewards (FR-505, FR-510, FR-511)
ALTER TABLE reward DROP CONSTRAINT reward_kind_known;
ALTER TABLE reward ADD CONSTRAINT reward_kind_known CHECK (kind IN ('item', 'experience', 'digital'));

-- A digital reward's stock is its uploaded codes: created at 0, raised only by add_reward_codes.
CREATE FUNCTION reward_digital_stock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'questify_app' AND NEW.kind = 'digital'
     AND (CASE TG_OP WHEN 'INSERT' THEN NEW.stock_total <> 0 ELSE NEW.stock_total <> OLD.stock_total END) THEN
    RAISE EXCEPTION 'a digital reward''s stock is its codes' USING ERRCODE = 'RD409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reward_digital_stock_guard() FROM PUBLIC;
CREATE TRIGGER reward_digital_stock_guard BEFORE INSERT OR UPDATE OF stock_total ON reward
  FOR EACH ROW EXECUTE FUNCTION reward_digital_stock_guard();

-- A digital redemption is delivered at once and for good: no pickup time, no timeout, no cancel (the code was shown).
ALTER TABLE redemption DROP CONSTRAINT redemption_status_check;
ALTER TABLE redemption ADD CONSTRAINT redemption_status_check
  CHECK (status IN ('reserved', 'cancelled', 'expired', 'delivered'));
ALTER TABLE redemption DROP CONSTRAINT redemption_ended_by_check;
ALTER TABLE redemption ADD CONSTRAINT redemption_ended_by_check CHECK (ended_by IN ('player', 'timeout', 'delivery'));
ALTER TABLE redemption ALTER COLUMN reserved_until DROP NOT NULL;
ALTER TABLE redemption ADD CONSTRAINT redemption_delivered_shape
  CHECK ((status = 'delivered') = (ended_by IS NOT DISTINCT FROM 'delivery')
         AND (status = 'delivered') = (reserved_until IS NULL));

-- The codes. Each is the API's AES-256-GCM cipher (the reward id as associated data) and a keyed hash for spotting a
-- code uploaded twice in an event. Organizers see that codes exist and which are given, never a cipher or a hash;
-- players and everyone else see nothing; only add_reward_codes writes and only reserve_reward hands one out.
CREATE TABLE reward_code (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  reward_id     uuid NOT NULL,
  code_cipher   bytea NOT NULL CHECK (length(code_cipher) BETWEEN 29 AND 1024),
  code_hash     bytea NOT NULL CHECK (length(code_hash) = 32),
  redemption_id uuid UNIQUE REFERENCES redemption (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code_hash),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (reward_id, event_id) REFERENCES reward (id, event_id) ON DELETE CASCADE
);
CREATE INDEX reward_code_unused ON reward_code (reward_id, id) WHERE redemption_id IS NULL;

ALTER TABLE reward_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_code FORCE ROW LEVEL SECURITY;
REVOKE ALL ON reward_code FROM PUBLIC;
GRANT SELECT (id, reward_id, redemption_id, created_at) ON reward_code TO questify_app;
CREATE POLICY reward_code_read ON reward_code FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- Adds codes to a digital reward (FR-510) for a staff member of the reward's organizer within their events, or an
-- admin (organizer members are owners or editors, the two roles that build rewards): a code already in the event is
-- skipped and the stock rises by what was added. Refusals: RN404 no such reward, removed, or not the caller's; RD409
-- not a digital reward; RC422 more than 100 000 codes (DETAIL: how many more fit).
CREATE FUNCTION add_reward_codes(target uuid, ciphers bytea[], hashes bytea[])
  RETURNS TABLE (added integer, duplicates integer, stock_total integer, stock_left integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  most     CONSTANT integer := 100000;
  given    integer := coalesce(array_length(ciphers, 1), 0);
  item     reward%ROWTYPE;
  inserted integer;
BEGIN
  IF given = 0 OR given <> coalesce(array_length(hashes, 1), 0) THEN
    RAISE EXCEPTION 'codes and hashes must pair up' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target;
  IF NOT FOUND OR NOT (app_is_admin()
                       OR (item.organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
                           AND in_event_scope(item.event_id, app_event_scope()))) THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  IF item.status <> 'active' THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF item.kind <> 'digital' THEN
    RAISE EXCEPTION 'not a digital reward' USING ERRCODE = 'RD409';
  END IF;
  WITH fresh AS (
    INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
    SELECT item.organizer_id, item.event_id, item.id, u.cipher, u.hash FROM unnest(ciphers, hashes) AS u (cipher, hash)
    ON CONFLICT (event_id, code_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM fresh;
  IF item.stock_total + inserted > most THEN
    RAISE EXCEPTION 'too many codes' USING ERRCODE = 'RC422', DETAIL = (most - item.stock_total)::text;
  END IF;
  UPDATE reward r SET stock_total = r.stock_total + inserted WHERE r.id = target;
  RETURN QUERY SELECT inserted, given - inserted, item.stock_total + inserted,
                      item.stock_total + inserted - item.units_out;
END $$;
REVOKE ALL ON FUNCTION add_reward_codes(uuid, bytea[], bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_reward_codes(uuid, bytea[], bytea[]) TO questify_app;

-- ================================================================ reserving, again (0024 plus the two rules)
-- As in 0024, and: a digital reward hands out its oldest unused code and is delivered at once; the score falls with
-- the balance when the event spends from the ranking and is live (ADR-134, ADR-135); a move of the score marks the
-- event's ranking for a rebuild. The per-player limit counts delivered codes too. `code_cipher` is the given code's
-- cipher for a digital redemption (also on a replay), else NULL.
DROP FUNCTION reserve_reward(uuid, text);
CREATE FUNCTION reserve_reward(target uuid, request_key text)
  RETURNS TABLE (redemption_id uuid, kind text, status text, price integer, reserved_until timestamptz,
                 balance bigint, stock_left integer, replayed boolean, code_cipher bytea)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  found_ev   uuid;
  enrolled   enrollment%ROWTYPE;
  item       reward%ROWTYPE;
  ev         event%ROWTYPE;
  earlier    redemption%ROWTYPE;
  shop       text;
  held       integer;
  code_id    bigint;
  spend_rank integer := 0;
  made       redemption%ROWTYPE;
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
    WHERE d.enrollment_id = enrolled.id AND d.reward_id = target AND d.status IN ('reserved', 'delivered');
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
          CASE WHEN code_id IS NULL THEN now() + make_interval(mins => ev.pickup_minutes) END,
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
REVOKE ALL ON FUNCTION reserve_reward(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_reward(uuid, text) TO questify_app;

-- A return gives back exactly what its own payment took: the price, and the score only if the payment took it (never
-- the setting read again). Not callable by any role, as in 0024.
CREATE OR REPLACE FUNCTION end_reservation(target uuid, outcome text, by_whom text, who text) RETURNS boolean
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
  SELECT l.score_delta INTO paid_rank FROM ledger_entry l WHERE l.redemption_id = target AND l.kind = 'redeem';
  UPDATE redemption d SET status = outcome, ended_at = now(), ended_by = by_whom WHERE d.id = target;
  UPDATE reward r SET units_out = r.units_out - 1 WHERE r.id = locked.reward_id;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (locked.organizer_id, locked.event_id, locked.enrollment_id, 'redeem_return', -paid_rank, locked.price,
          target, who);
  IF paid_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (locked.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION end_reservation(uuid, text, text, text) FROM PUBLIC;

-- ================================================================ the player's reads, again
-- As in 0024, plus `spend_lowers_rank`: true when a purchase now would also lower the player's ranking points.
DROP FUNCTION event_shop(uuid);
CREATE FUNCTION event_shop(target uuid)
  RETURNS TABLE (state text, closes_at timestamptz, pickup_minutes integer, rules_ar text, rules_en text,
                 balance bigint, first_redemption boolean, spend_lowers_rank boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after),
         e.ends_at + make_interval(days => e.shop_days_after), e.pickup_minutes, e.shop_rules_ar, e.shop_rules_en,
         n.balance, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id),
         e.spend_lowers_rank AND event_status_now(e.status, e.starts_at, e.ends_at) = 'live'
  FROM enrollment n JOIN event e ON e.id = n.event_id JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION event_shop(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_shop(uuid) TO questify_app;

-- As in 0024, with `held_by_me` counting delivered codes too (the per-player limit's count).
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
          WHERE d.enrollment_id = mine AND d.reward_id = r.id AND d.status IN ('reserved', 'delivered'))
  FROM reward r
  WHERE r.event_id = target AND r.status = 'active'
  ORDER BY r.position, r.id;
END $$;

-- As in 0024, plus the code's cipher for the caller's own delivered digital redemptions.
DROP FUNCTION my_redemptions(uuid);
CREATE FUNCTION my_redemptions(target uuid)
  RETURNS TABLE (id uuid, reward_id uuid, kind text, name_ar text, name_en text, price integer, status text,
                 reserved_until timestamptz, created_at timestamptz, ended_at timestamptz, code_cipher bytea)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.reward_id, r.kind, r.name_ar, r.name_en, d.price, d.status, d.reserved_until, d.created_at, d.ended_at,
         c.code_cipher
  FROM enrollment n JOIN redemption d ON d.enrollment_id = n.id JOIN reward r ON r.id = d.reward_id
  LEFT JOIN reward_code c ON c.redemption_id = d.id
  WHERE n.event_id = target AND n.player_id = app_player_id()
  ORDER BY d.created_at DESC, d.id
  LIMIT 100
$$;
REVOKE ALL ON FUNCTION my_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_redemptions(uuid) TO questify_app;
