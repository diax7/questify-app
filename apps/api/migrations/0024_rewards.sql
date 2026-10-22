-- Rewards, the shop and reservations (T-201, T-202; ADR-043, ADR-048, ADR-049). Organizers build rewards under row-level
-- security like quests. Players never touch the tables: they read the shop and reserve, cancel and see their own
-- reservations through definer functions, which are the only writers of redemptions, of a reward's units out and of
-- the two new ledger kinds. Spending moves the balance only, never the score (ADR-043). Deny by default: forced
-- row-level security, column grants for the organizer's writes, every definer pinned and executable by questify_app
-- only. Lock order everywhere: enrollment, then reward, then redemption.

-- ================================================================ the event's shop settings
ALTER TABLE event
  ADD COLUMN pickup_minutes  integer NOT NULL DEFAULT 120 CHECK (pickup_minutes BETWEEN 15 AND 10080),
  ADD COLUMN shop_days_after integer NOT NULL DEFAULT 3 CHECK (shop_days_after BETWEEN 0 AND 30),
  ADD COLUMN shop_rules_ar   text CHECK (length(shop_rules_ar) BETWEEN 1 AND 2000),
  ADD COLUMN shop_rules_en   text CHECK (length(shop_rules_en) BETWEEN 1 AND 2000);
GRANT UPDATE (pickup_minutes, shop_days_after, shop_rules_ar, shop_rules_en) ON event TO questify_app;

-- The shop is open while the event is live, and for `shop_days_after` days after it ends (ADR-048). The only place
-- this rule lives; STABLE (it reads now()).
CREATE FUNCTION shop_state(status text, starts_at timestamptz, ends_at timestamptz, days_after integer)
  RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE event_status_now(status, starts_at, ends_at)
    WHEN 'live' THEN 'open'
    WHEN 'ended' THEN CASE WHEN ends_at + make_interval(days => days_after) > now() THEN 'open' ELSE 'closed' END
    WHEN 'archived' THEN 'closed'
    ELSE 'not_open'
  END
$$;
REVOKE ALL ON FUNCTION shop_state(text, timestamptz, timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shop_state(text, timestamptz, timestamptz, integer) TO questify_app;

-- ================================================================ rewards
CREATE TABLE reward (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id     uuid NOT NULL REFERENCES organizer (id),
  event_id         uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  -- The digital-code kind joins with its codes (T-203).
  kind             text NOT NULL CONSTRAINT reward_kind_known CHECK (kind IN ('item', 'experience')),
  name_ar          text CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en          text CHECK (length(name_en) BETWEEN 1 AND 120),
  description_ar   text CHECK (length(description_ar) BETWEEN 1 AND 2000),
  description_en   text CHECK (length(description_en) BETWEEN 1 AND 2000),
  price            integer NOT NULL CHECK (price BETWEEN 1 AND 1000000),
  stock_total      integer NOT NULL CHECK (stock_total BETWEEN 0 AND 100000),
  -- Units reserved or handed over. Only the definers below move it; remaining stock is stock_total - units_out, so it
  -- never drifts, and an organizer cannot set the total below what is out (FR-514).
  units_out        integer NOT NULL DEFAULT 0,
  per_player_limit integer CHECK (per_player_limit BETWEEN 1 AND 100),
  opens_at         timestamptz,
  closes_at        timestamptz,
  section          text CHECK (section IN ('featured', 'merch', 'food', 'experiences')),
  tag_new          boolean NOT NULL DEFAULT false,
  tag_limited      boolean NOT NULL DEFAULT false,
  position         integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  CONSTRAINT reward_stock_covers_out CHECK (units_out BETWEEN 0 AND stock_total),
  CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id)
);
CREATE INDEX reward_event_order ON reward (event_id, position, id) WHERE status = 'active';

CREATE TRIGGER reward_organizer BEFORE INSERT ON reward
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();
CREATE TRIGGER reward_touch BEFORE UPDATE ON reward FOR EACH ROW EXECUTE FUNCTION quest_touch();

-- ================================================================ redemptions
CREATE TABLE redemption (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id    uuid NOT NULL,
  event_id        uuid NOT NULL,
  enrollment_id   uuid NOT NULL,
  reward_id       uuid NOT NULL,
  -- What the player paid: a return gives back exactly this, whatever the price is now.
  price           integer NOT NULL CHECK (price >= 1),
  -- handed_over joins with the prize desk (T-206).
  status          text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'cancelled', 'expired')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  reserved_until  timestamptz NOT NULL,
  ended_at        timestamptz,
  ended_by        text CHECK (ended_by IN ('player', 'timeout')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, idempotency_key),
  CHECK ((status = 'reserved') = (ended_at IS NULL)),
  CHECK ((status = 'reserved') = (ended_by IS NULL)),
  CHECK (status <> 'expired' OR ended_by = 'timeout'),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (reward_id, event_id) REFERENCES reward (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX redemption_due ON redemption (reserved_until) WHERE status = 'reserved';
CREATE INDEX redemption_reward ON redemption (reward_id, status);
CREATE INDEX redemption_enrollment ON redemption (enrollment_id, created_at);

-- ================================================================ the ledger learns spending
-- redeem: the price leaves the balance; redeem_return: it comes back (cancel or timeout). Neither moves the score.
ALTER TABLE ledger_entry ADD COLUMN redemption_id uuid REFERENCES redemption (id) ON DELETE RESTRICT;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_actor_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_actor_check CHECK (actor IN ('player', 'system'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_redeem_shape
  CHECK (kind NOT IN ('redeem', 'redeem_return') OR (redemption_id IS NOT NULL AND score_delta = 0
         AND completion_id IS NULL AND quest_id IS NULL
         AND CASE kind WHEN 'redeem' THEN balance_delta < 0 ELSE balance_delta > 0 END));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_redemption_only_spend
  CHECK (redemption_id IS NULL OR kind IN ('redeem', 'redeem_return'));
-- Only the timeout acts as the system, and only to give points back.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_system_returns_only
  CHECK (actor <> 'system' OR kind = 'redeem_return');
-- One payment and at most one return per reservation, whatever goes wrong above.
CREATE UNIQUE INDEX ledger_entry_redeem_key ON ledger_entry (redemption_id) WHERE kind = 'redeem';
CREATE UNIQUE INDEX ledger_entry_redeem_return_key ON ledger_entry (redemption_id) WHERE kind = 'redeem_return';

-- ================================================================ who may do what
ALTER TABLE reward ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward FORCE ROW LEVEL SECURITY;
ALTER TABLE redemption ENABLE ROW LEVEL SECURITY;
ALTER TABLE redemption FORCE ROW LEVEL SECURITY;
REVOKE ALL ON reward, redemption FROM PUBLIC;

-- Organizers read, create and edit; never units_out or the tenant keys. `status` is granted for removal only: the
-- guard below allows active to removed and nothing else. No role but the definers writes a redemption.
GRANT SELECT ON reward, redemption TO questify_app;
GRANT INSERT (event_id, kind, name_ar, name_en, description_ar, description_en, price, stock_total, per_player_limit,
              opens_at, closes_at, section, tag_new, tag_limited, position) ON reward TO questify_app;
GRANT UPDATE (name_ar, name_en, description_ar, description_en, price, stock_total, per_player_limit, opens_at,
              closes_at, section, tag_new, tag_limited, position, status) ON reward TO questify_app;

-- Players get no row here: their reads are the definers below.
CREATE POLICY reward_member ON reward FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
CREATE POLICY redemption_read ON redemption FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- A removed reward stays removed: reservations point at it and the history names it.
CREATE FUNCTION reward_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'removed' AND current_user = 'questify_app' AND OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'a removed reward does not change' USING ERRCODE = 'RR409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION reward_status_guard() FROM PUBLIC;
CREATE TRIGGER reward_status_guard BEFORE UPDATE ON reward FOR EACH ROW EXECUTE FUNCTION reward_status_guard();

-- ================================================================ reserving (FR-506, FR-502, FR-503, FR-514)
-- The caller is the player of the request context, never an argument. Refusals raise:
--   RN404 no such reward, removed, or not this player's event    RK422 the key was used for another reward
--   RA403 enrollment not active (DETAIL: its status)              RS403 shop not open (DETAIL: not_open|closed)
--   RW403 outside the reward's window (DETAIL: not_started|ended) RO409 sold out
--   RL409 per-player limit reached (DETAIL: the limit)            RB422 balance below the price
-- A retry with the same key returns the first reservation as it is now (it may since have been cancelled).
CREATE FUNCTION reserve_reward(target uuid, request_key text)
  RETURNS TABLE (redemption_id uuid, status text, price integer, reserved_until timestamptz, balance bigint,
                 stock_left integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := app_player_id();
  found_ev uuid;
  enrolled enrollment%ROWTYPE;
  item     reward%ROWTYPE;
  earlier  redemption%ROWTYPE;
  shop     text;
  held     integer;
  made     redemption%ROWTYPE;
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
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.price, earlier.reserved_until, enrolled.balance,
                        r.stock_total - r.units_out, true
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
  SELECT shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after) INTO shop FROM event e WHERE e.id = item.event_id;
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
    WHERE d.enrollment_id = enrolled.id AND d.reward_id = target AND d.status = 'reserved';
    IF held >= item.per_player_limit THEN
      RAISE EXCEPTION 'limit reached' USING ERRCODE = 'RL409', DETAIL = item.per_player_limit::text;
    END IF;
  END IF;
  IF enrolled.balance < item.price THEN
    RAISE EXCEPTION 'balance too low' USING ERRCODE = 'RB422';
  END IF;

  INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until)
  SELECT enrolled.organizer_id, enrolled.event_id, enrolled.id, target, item.price, request_key,
         now() + make_interval(mins => e.pickup_minutes)
  FROM event e WHERE e.id = item.event_id
  RETURNING * INTO made;
  UPDATE reward r SET units_out = r.units_out + 1 WHERE r.id = target;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'redeem', 0, -item.price, made.id, 'player');

  RETURN QUERY SELECT made.id, made.status, made.price, made.reserved_until, n.balance,
                      item.stock_total - item.units_out - 1, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION reserve_reward(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_reward(uuid, text) TO questify_app;

-- ================================================================ giving a reservation back (FR-513, FR-1603, FR-508)
-- One body for the player's cancel and the timeout: the redemption is read unlocked to find its enrollment and reward,
-- then the three rows are locked in the one order and the status is checked again. False when the redemption was no
-- longer reserved by then (another path ended it first). Not callable by any role: only the two definers below.
CREATE FUNCTION end_reservation(target uuid, outcome text, by_whom text, who text) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
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
  UPDATE redemption d SET status = outcome, ended_at = now(), ended_by = by_whom WHERE d.id = target;
  UPDATE reward r SET units_out = r.units_out - 1 WHERE r.id = locked.reward_id;
  -- Exactly what was paid comes back, whatever the price is now.
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (locked.organizer_id, locked.event_id, locked.enrollment_id, 'redeem_return', 0, locked.price, target, who);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION end_reservation(uuid, text, text, text) FROM PUBLIC;

-- The player cancels their own reservation. Refusals: RN404 not theirs or unknown; RE409 it ended another way (DETAIL:
-- the status). Cancelling twice answers the cancelled reservation again, with no second entry.
CREATE FUNCTION cancel_redemption(target uuid)
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
  ended := end_reservation(target, 'cancelled', 'player', 'player');
  SELECT * INTO mine FROM redemption d WHERE d.id = target;
  IF NOT ended AND mine.status <> 'cancelled' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = mine.status;
  END IF;
  RETURN QUERY SELECT mine.id, mine.status, mine.price, n.balance, r.stock_total - r.units_out, NOT ended
    FROM enrollment n, reward r WHERE n.id = mine.enrollment_id AND r.id = mine.reward_id;
END $$;
REVOKE ALL ON FUNCTION cancel_redemption(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_redemption(uuid) TO questify_app;

-- The pickup timeout (FR-508, FR-1609): one due reservation per call, so each is its own transaction and no call holds
-- more than one player's locks. The row is chosen without a lock (locking it first would break the order); a row
-- another path ended meanwhile is 'skipped'. NULL when nothing is due. The API's lifecycle tick calls it.
CREATE FUNCTION expire_one_reservation() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due uuid;
BEGIN
  SELECT d.id INTO due FROM redemption d
  WHERE d.status = 'reserved' AND d.reserved_until <= now()
  ORDER BY d.reserved_until, d.id LIMIT 1;
  IF due IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN CASE WHEN end_reservation(due, 'expired', 'timeout', 'system') THEN 'expired' ELSE 'skipped' END;
END $$;
REVOKE ALL ON FUNCTION expire_one_reservation() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_one_reservation() TO questify_app;

-- ================================================================ the player's reads
-- The shop of an event the player is an active member of (no row otherwise): its state, settings and the balance.
-- `first_redemption` is true until the player has reserved anything in this event (FR-515).
CREATE FUNCTION event_shop(target uuid)
  RETURNS TABLE (state text, closes_at timestamptz, pickup_minutes integer, rules_ar text, rules_en text,
                 balance bigint, first_redemption boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after),
         e.ends_at + make_interval(days => e.shop_days_after), e.pickup_minutes, e.shop_rules_ar, e.shop_rules_en,
         n.balance, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id)
  FROM enrollment n JOIN event e ON e.id = n.event_id JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION event_shop(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_shop(uuid) TO questify_app;

-- The active rewards, named columns only, with the real stock left (FR-514) and 'popular' (FR-1618): the three rewards
-- most reserved, each at least `popular_floor` times, cancelled and expired ones not counted. Nothing for a non-member.
CREATE FUNCTION shop_rewards(target uuid)
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
          WHERE d.enrollment_id = mine AND d.reward_id = r.id AND d.status = 'reserved')
  FROM reward r
  WHERE r.event_id = target AND r.status = 'active'
  ORDER BY r.position, r.id;
END $$;
REVOKE ALL ON FUNCTION shop_rewards(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION shop_rewards(uuid) TO questify_app;

-- The player's own reservations in an event, newest first, whatever their enrollment's status now (a player who left
-- still sees what they reserved). The reward's name stays even when it was removed.
CREATE FUNCTION my_redemptions(target uuid)
  RETURNS TABLE (id uuid, reward_id uuid, kind text, name_ar text, name_en text, price integer, status text,
                 reserved_until timestamptz, created_at timestamptz, ended_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.reward_id, r.kind, r.name_ar, r.name_en, d.price, d.status, d.reserved_until, d.created_at, d.ended_at
  FROM enrollment n JOIN redemption d ON d.enrollment_id = n.id JOIN reward r ON r.id = d.reward_id
  WHERE n.event_id = target AND n.player_id = app_player_id()
  ORDER BY d.created_at DESC, d.id
  LIMIT 100
$$;
REVOKE ALL ON FUNCTION my_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_redemptions(uuid) TO questify_app;

-- ================================================================ the history names what was spent (FR-410)
CREATE OR REPLACE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar), coalesce(q.title_en, r.name_en)
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;
