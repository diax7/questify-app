-- Flags, the desk's hold and the owner's pause (T-209; ADR-041, ADR-100, ADR-153 to ADR-156). The system flags and
-- people decide: a flag never touches play, points or a reservation (FR-329). Two exceptions, both at the prize desk:
-- an open flag holds the player's handover while the event's hold is on (FR-1815), and a banned player's items are
-- held (FR-1747). The owner may pause a player's redemptions by hand (FR-518, FR-1604). The desk shows "held" for a
-- flag and a ban alike and never says which. Every write is a definer; the flag table has no grant at all.

-- ================================================================ the switches
-- Written only through set_redeem_pause and set_flag_hold (owner, audited): neither is in the API role's grants.
ALTER TABLE enrollment ADD COLUMN redeem_paused_at timestamptz;
ALTER TABLE event ADD COLUMN flag_hold boolean NOT NULL DEFAULT true;

-- ================================================================ flags (FR-330, FR-333, FR-1745)
-- One case per account and phone, ever (`shared_device`: a cleared case stays cleared); at most one open burst case
-- per account. `device_id` is the app's install id: personal data, erased with the account (T-217).
CREATE TABLE flag (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('shared_device', 'burst')),
  device_id     uuid,
  -- burst: {"completions": [ids]}, the newest 50; shared_device: {} (the accounts are read live).
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cleared', 'confirmed')),
  resolution    text CHECK (resolution IN ('cleared', 'points_removed', 'banned')),
  note          text CHECK (char_length(note) BETWEEN 1 AND 300),
  raised_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  CONSTRAINT flag_device_kind CHECK ((kind = 'shared_device') = (device_id IS NOT NULL)),
  CONSTRAINT flag_resolution CHECK (
    (status = 'open' AND resolution IS NULL AND resolved_at IS NULL)
    OR (status = 'cleared' AND resolution = 'cleared' AND resolved_at IS NOT NULL)
    OR (status = 'confirmed' AND resolution IN ('points_removed', 'banned') AND resolved_at IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX flag_device_once ON flag (enrollment_id, device_id) WHERE kind = 'shared_device';
CREATE UNIQUE INDEX flag_burst_open ON flag (enrollment_id) WHERE kind = 'burst' AND status = 'open';
CREATE INDEX flag_event_idx ON flag (event_id, id DESC);
CREATE INDEX flag_open_idx ON flag (enrollment_id) WHERE status = 'open';
ALTER TABLE flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE flag FORCE ROW LEVEL SECURITY;
REVOKE ALL ON flag FROM PUBLIC;

CREATE INDEX quest_completion_device_idx ON quest_completion (event_id, device_id) WHERE device_id IS NOT NULL;
CREATE INDEX quest_completion_recent_idx ON quest_completion (enrollment_id, created_at);

-- The flag numbers (Q-074, Q-120) until T-703 makes them console settings.
CREATE FUNCTION flag_tuning(OUT burst_count integer, OUT burst_window interval)
  LANGUAGE sql IMMUTABLE AS $$ SELECT 10, interval '5 minutes' $$;
REVOKE ALL ON FUNCTION flag_tuning() FROM PUBLIC;

-- Runs inside every completion's transaction, after the row is written, under the enrollment lock record_completion
-- holds. A manual award is a person's choice and raises nothing. Same device: every account of the event seen on this
-- install (a removed one aside) gets one case, under a lock on (event, device) so two accounts scanning at once see each other. Burst: the
-- account's scans in the window since its last resolved burst case; only its own row is touched. Never raises.
CREATE FUNCTION raise_completion_flags() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tuning  record;
  since   timestamptz;
  recent  jsonb;
BEGIN
  IF NEW.method = 'manual' THEN
    RETURN NULL;
  END IF;
  IF NEW.device_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('device:' || NEW.event_id || ':' || NEW.device_id, 0));
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, device_id)
    SELECT NEW.organizer_id, NEW.event_id, s.enrollment_id, 'shared_device', NEW.device_id
    FROM (SELECT DISTINCT c.enrollment_id FROM quest_completion c
          JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
          WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id) s
    WHERE EXISTS (SELECT 1 FROM quest_completion c
                  JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
                  WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id
                    AND c.enrollment_id <> NEW.enrollment_id)
    ORDER BY s.enrollment_id
    ON CONFLICT (enrollment_id, device_id) WHERE kind = 'shared_device' DO NOTHING;
  END IF;

  SELECT * INTO tuning FROM flag_tuning();
  SELECT max(f.resolved_at) INTO since FROM flag f
  WHERE f.enrollment_id = NEW.enrollment_id AND f.kind = 'burst' AND f.status <> 'open';
  SELECT jsonb_agg(c.id ORDER BY c.id) INTO recent FROM quest_completion c
  WHERE c.enrollment_id = NEW.enrollment_id AND c.method <> 'manual'
    AND c.created_at > now() - tuning.burst_window AND c.created_at > coalesce(since, '-infinity');
  IF jsonb_array_length(coalesce(recent, '[]'::jsonb)) >= tuning.burst_count THEN
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
    VALUES (NEW.organizer_id, NEW.event_id, NEW.enrollment_id, 'burst', jsonb_build_object('completions', recent))
    ON CONFLICT (enrollment_id) WHERE kind = 'burst' AND status = 'open' DO UPDATE
    SET last_seen_at = now(),
        evidence = jsonb_build_object('completions', (
          SELECT jsonb_agg(x ORDER BY x) FROM (
            SELECT DISTINCT x FROM jsonb_array_elements((flag.evidence -> 'completions') || (EXCLUDED.evidence -> 'completions')) x
            ORDER BY x DESC LIMIT 50) newest));
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION raise_completion_flags() FROM PUBLIC;
CREATE TRIGGER quest_completion_flags AFTER INSERT ON quest_completion
  FOR EACH ROW EXECUTE FUNCTION raise_completion_flags();

-- ================================================================ the desk's hold (FR-1604, FR-1747, FR-1815)
-- 'paused' (the owner paused the player), 'held' (banned, or an open flag while the event's hold is on), or NULL. A
-- player who is not active or banned has no hold: the status check answers them (RA403).
-- Read under the enrollment's lock wherever a handover is decided. Internal.
CREATE FUNCTION desk_hold(enrolled enrollment, ev event) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN enrolled.status IN ('pending', 'left', 'removed') THEN NULL
    WHEN enrolled.redeem_paused_at IS NOT NULL THEN 'paused'
    WHEN enrolled.status = 'banned' THEN 'held'
    WHEN ev.flag_hold AND EXISTS (SELECT 1 FROM flag f WHERE f.enrollment_id = enrolled.id AND f.status = 'open')
      THEN 'held'
  END
$$;
REVOKE ALL ON FUNCTION desk_hold(enrollment, event) FROM PUBLIC;

-- ================================================================ what the desk sees
-- The player and their reserved desk items, oldest first (one row with NULL item columns when nothing waits). Never
-- the enrollment's status: `active` is true for a banned player too, so a ban reads exactly like a flag (`hold`).
-- Internal: desk_lookup (My QR) and desk_find (username or phone) both answer through it.
CREATE FUNCTION desk_items(found_n enrollment, me uuid)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.username, p.avatar, found_n.status IN ('active', 'banned'),
         (SELECT desk_hold(found_n, e) FROM event e WHERE e.id = found_n.event_id),
         d.id, r.kind, r.name_ar, r.name_en, d.created_at, d.reserved_until, coalesce(d.collect_until > now(), false),
         coalesce(d.offer_by = me AND d.offer_until > now(), false), CASE WHEN d.offer_by = me THEN d.offer_until END
  FROM player p
  LEFT JOIN redemption d ON d.enrollment_id = found_n.id AND d.status = 'reserved'
  LEFT JOIN reward r ON r.id = d.reward_id
  WHERE p.id = found_n.player_id
  ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION desk_items(enrollment, uuid) FROM PUBLIC;

-- As in 0029, answering through desk_items. Refusals: OP403/OA403, OY409 own code, OM422 an earlier My QR, QC404.
DROP FUNCTION desk_lookup(uuid, uuid, integer);
CREATE FUNCTION desk_lookup(target_event uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz)
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
  RETURN QUERY SELECT * FROM desk_items(found_n, me);
END $$;
REVOKE ALL ON FUNCTION desk_lookup(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_lookup(uuid, uuid, integer) TO questify_app;

-- FR-1848 (ADR-156): when My QR will not scan, the desk finds a member by exact username (folded) or exact Saudi
-- mobile (E.164, normalised by the API). Removed players are not found. No rows when nobody matches. Safe without
-- My QR: every handover still needs the player's Collect or Accept in their own app (ADR-137). Refusals: OP403/OA403
-- (the hand_over ability), OY409 finding yourself, 22023 neither or both of username and phone.
CREATE FUNCTION desk_find(target_event uuid, by_username text, by_phone text)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := app_player_id();
  found_n enrollment%ROWTYPE;
BEGIN
  PERFORM desk_operator(target_event, me);
  IF (by_username IS NULL) = (by_phone IS NULL) THEN
    RAISE EXCEPTION 'search by username or by phone' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT n.* INTO found_n
  FROM enrollment n
  JOIN player p ON p.id = n.player_id
  LEFT JOIN player_contact pc ON pc.player_id = p.id
  WHERE n.event_id = target_event AND n.status <> 'removed'
    AND ((by_username IS NOT NULL AND username_fold(p.username) = username_fold(by_username))
         OR (by_phone IS NOT NULL AND pc.phone_e164 = by_phone))
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF found_n.player_id = me THEN
    RAISE EXCEPTION 'an operator cannot find themselves at the desk' USING ERRCODE = 'OY409';
  END IF;
  RETURN QUERY SELECT * FROM desk_items(found_n, me);
END $$;
REVOKE ALL ON FUNCTION desk_find(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION desk_find(uuid, text, text) TO questify_app;

-- ================================================================ the handover and the player's side, again
-- As in 0029 with the hold: every function below checks desk_hold before the enrollment's status, so a banned
-- player is answered RH409 'held', exactly like a flagged one, never RA403 'banned'. RP403: the player's redemptions
-- are paused (FR-518), checked after the replay (a replayed reservation still answers).

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
  IF enrolled.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
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

CREATE OR REPLACE FUNCTION finish_handover(target uuid, operator uuid, via_offer boolean) RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
  hold      text;
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
  SELECT * INTO ev FROM event e WHERE e.id = locked.event_id;
  hold := desk_hold(enrolled, ev);
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.player_id = operator THEN
    RAISE EXCEPTION 'an operator does not hand over their own reservation' USING ERRCODE = 'OY409';
  END IF;
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

CREATE OR REPLACE FUNCTION desk_hand_over(target uuid)
  RETURNS TABLE (status text, offer_until timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
  answer    text;
  hold      text;
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
  hold := desk_hold(enrolled, ev);
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
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

CREATE OR REPLACE FUNCTION start_collect(target uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := app_player_id();
  mine   redemption%ROWTYPE := my_desk_redemption(target, app_player_id());
  ev     event%ROWTYPE;
  joined enrollment%ROWTYPE;
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
  SELECT n.* INTO joined FROM enrollment n WHERE n.id = mine.enrollment_id AND n.player_id = me;
  IF joined.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = joined.status;
  END IF;
  IF joined.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
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

-- ================================================================ the owner's and the team's actions (ADR-155)
-- As in 0019, and a ban closes the player's open cases as 'banned', each with its own audit entry carrying the
-- request id. Lock order as everywhere: the enrollment, then its cases.
CREATE OR REPLACE FUNCTION set_enrollment_ban(target_event uuid, target uuid, banned boolean, request uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  org uuid := app_organizer_id();
  row_found enrollment;
  wanted text;
BEGIN
  IF banned IS NULL THEN
    RAISE EXCEPTION 'banned must be true or false' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT n.* INTO row_found FROM enrollment n JOIN event ev ON ev.id = n.event_id
  WHERE n.id = target AND n.event_id = target_event
    AND ev.organizer_id = org AND in_event_scope(ev.id, app_event_scope())
  FOR UPDATE OF n;
  IF row_found.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF NOT app_is_owner(org) THEN
    RETURN 'not_owner';
  END IF;
  IF row_found.status = 'removed' THEN
    RETURN 'not_allowed';
  END IF;
  wanted := CASE WHEN banned THEN 'banned' ELSE 'active' END;
  IF row_found.status = wanted OR (NOT banned AND row_found.status <> 'banned') THEN
    RETURN 'unchanged';
  END IF;
  UPDATE enrollment SET status = wanted WHERE id = row_found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), org, target_event,
          CASE WHEN banned THEN 'event.player_ban' ELSE 'event.player_unban' END, 'enrollment', target::text,
          jsonb_build_object('status', row_found.status), jsonb_build_object('status', wanted), request);
  IF banned THEN
    WITH closed AS (
      UPDATE flag f SET status = 'confirmed', resolution = 'banned', resolved_at = now(),
                        resolved_by = app_staff_user_id()
      WHERE f.enrollment_id = row_found.id AND f.status = 'open'
      RETURNING f.id
    )
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                           after, request_id)
    SELECT 'staff', app_staff_user_id(), org, target_event, 'event.flag_confirmed', 'flag', closed.id::text,
           jsonb_build_object('status', 'open'), jsonb_build_object('status', 'confirmed', 'resolution', 'banned'),
           request
    FROM closed;
  END IF;
  RETURN 'changed';
END $$;

-- Clear a case, or close it after removing points (FR-336): owners and editors in their events (AN404). A case
-- closes once. Refusals: FN404 no such case in the event, FN409 'resolved' (already closed) or 'no_removal' (no
-- removal entry for that player since the case was raised), FV400 a bad resolution or note.
CREATE FUNCTION resolve_flag(target_event uuid, target_flag bigint, outcome text, note text, request uuid)
  RETURNS TABLE (status text, resolution text, resolved_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  seen   flag%ROWTYPE;
  locked flag%ROWTYPE;
  said   text := nullif(btrim(note), '');
BEGIN
  IF outcome IS NULL OR outcome NOT IN ('cleared', 'points_removed') THEN
    RAISE EXCEPTION 'a case is cleared or closed as points removed' USING ERRCODE = 'FV400';
  END IF;
  IF char_length(said) > 300 THEN
    RAISE EXCEPTION 'a note has at most 300 characters' USING ERRCODE = 'FV400';
  END IF;
  SELECT f.* INTO seen FROM flag f WHERE f.id = target_flag AND f.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such case in this event' USING ERRCODE = 'FN404';
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = seen.enrollment_id FOR NO KEY UPDATE;
  SELECT f.* INTO locked FROM flag f WHERE f.id = target_flag FOR UPDATE;
  IF locked.status <> 'open' THEN
    RAISE EXCEPTION 'the case is closed' USING ERRCODE = 'FN409', DETAIL = 'resolved';
  END IF;
  IF outcome = 'points_removed' AND NOT EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.enrollment_id = locked.enrollment_id AND l.kind = 'removal' AND l.created_at >= locked.raised_at) THEN
    RAISE EXCEPTION 'no points were removed since the case was raised' USING ERRCODE = 'FN409', DETAIL = 'no_removal';
  END IF;
  UPDATE flag f
  SET status = CASE WHEN outcome = 'cleared' THEN 'cleared' ELSE 'confirmed' END, resolution = outcome,
      note = said, resolved_at = now(), resolved_by = app_staff_user_id()
  WHERE f.id = locked.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id,
          CASE WHEN outcome = 'cleared' THEN 'event.flag_cleared' ELSE 'event.flag_confirmed' END, 'flag',
          locked.id::text, jsonb_build_object('status', 'open'), jsonb_build_object('resolution', outcome), request);
  RETURN QUERY SELECT f.status, f.resolution, f.resolved_at FROM flag f WHERE f.id = locked.id;
END $$;
REVOKE ALL ON FUNCTION resolve_flag(uuid, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_flag(uuid, bigint, text, text, uuid) TO questify_app;

-- The owner pauses or resumes a player's redemptions (FR-518, FR-1604); never automatic. Outcomes: changed,
-- unchanged, not_owner, not_found (no such member of the event). AN404 for an event out of reach.
CREATE FUNCTION set_redeem_pause(target_event uuid, target uuid, paused boolean, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  row_found enrollment%ROWTYPE;
BEGIN
  IF paused IS NULL THEN
    RAISE EXCEPTION 'paused must be true or false' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  SELECT n.* INTO row_found FROM enrollment n WHERE n.id = target AND n.event_id = ev.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF (row_found.redeem_paused_at IS NOT NULL) = paused THEN
    RETURN 'unchanged';
  END IF;
  UPDATE enrollment SET redeem_paused_at = CASE WHEN paused THEN now() END WHERE id = row_found.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id,
          CASE WHEN paused THEN 'event.redeem_paused' ELSE 'event.redeem_resumed' END, 'enrollment', target::text,
          jsonb_build_object('paused', NOT paused), jsonb_build_object('paused', paused), request);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION set_redeem_pause(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_redeem_pause(uuid, uuid, boolean, uuid) TO questify_app;

-- The owner switches the flag hold for the event (FR-1815). Outcomes: changed, unchanged, not_owner. AN404.
CREATE FUNCTION set_flag_hold(target_event uuid, hold_on boolean, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF hold_on IS NULL THEN
    RAISE EXCEPTION 'the hold is on or off' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  IF ev.flag_hold = hold_on THEN
    RETURN 'unchanged';
  END IF;
  UPDATE event SET flag_hold = hold_on WHERE id = ev.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.flag_hold', 'event', ev.id::text,
          jsonb_build_object('on', ev.flag_hold), jsonb_build_object('on', hold_on), request);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION set_flag_hold(uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_flag_hold(uuid, boolean, uuid) TO questify_app;

-- ================================================================ the flagged-activity page (FR-335)
-- The event's cases, newest first, open or closed: the player, the kind, the size of the evidence (accounts on the
-- phone, or scans in the burst) and how many desk items wait for them. Owners and editors in their events (AN404).
CREATE FUNCTION event_flags(target_event uuid, open_only boolean, before_id bigint, page integer)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, enrollment_id uuid, username text, avatar text,
                 accounts integer, scans integer, waiting integer, hold boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.raised_at, f.last_seen_at, f.resolved_at, f.enrollment_id,
         p.username, p.avatar,
         CASE WHEN f.kind = 'shared_device' THEN
           (SELECT count(DISTINCT c.enrollment_id)::integer FROM quest_completion c
            WHERE c.event_id = ev.id AND c.device_id = f.device_id) END,
         CASE WHEN f.kind = 'burst' THEN jsonb_array_length(f.evidence -> 'completions') END,
         (SELECT count(*)::integer FROM redemption d WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         ev.flag_hold
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE f.event_id = ev.id AND (f.status = 'open') = coalesce(open_only, true)
    AND (before_id IS NULL OR f.id < before_id)
  ORDER BY f.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION event_flags(uuid, boolean, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_flags(uuid, boolean, bigint, integer) TO questify_app;

-- One case with its evidence (FR-335, FR-336): same phone, the accounts seen on it and their last scan; a burst,
-- each scan with its quest, method and operator. Also the player's waiting desk items (with their pickup deadline),
-- whether their redemptions are paused, and the removal entries written since the case was raised. Never the
-- install id. No row for a case outside the event. Owners and editors (AN404).
CREATE FUNCTION flag_detail(target_event uuid, target_flag bigint)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, note text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, resolved_by text, enrollment_id uuid,
                 username text, avatar text, enrollment_status text, paused boolean, hold boolean,
                 evidence jsonb, waiting jsonb, removals jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.note, f.raised_at, f.last_seen_at, f.resolved_at, su.email,
         f.enrollment_id, p.username, p.avatar, n.status, n.redeem_paused_at IS NOT NULL, ev.flag_hold,
         CASE WHEN f.kind = 'shared_device' THEN (
           SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId', a.enrollment_id, 'username', ap.username,
                                                        'lastScanAt', a.last_at) ORDER BY a.last_at DESC), '[]')
           FROM (SELECT c.enrollment_id, max(c.created_at) AS last_at FROM quest_completion c
                 WHERE c.event_id = ev.id AND c.device_id = f.device_id GROUP BY c.enrollment_id) a
           JOIN enrollment an ON an.id = a.enrollment_id JOIN player ap ON ap.id = an.player_id)
         ELSE (
           SELECT coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'method', c.method, 'questAr', q.title_ar,
                                                        'questEn', q.title_en, 'operator', op.username)
                                     ORDER BY c.id), '[]')
           FROM quest_completion c
           JOIN quest q ON q.id = c.quest_id
           LEFT JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
           LEFT JOIN player op ON op.id = l.operator_id
           WHERE c.enrollment_id = f.enrollment_id
             AND c.id IN (SELECT (x #>> '{}')::bigint FROM jsonb_array_elements(f.evidence -> 'completions') x))
         END,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('nameAr', r.name_ar, 'nameEn', r.name_en,
                                                       'reservedUntil', d.reserved_until) ORDER BY d.created_at), '[]')
          FROM redemption d JOIN reward r ON r.id = d.reward_id
          WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('entryId', l.id, 'at', l.created_at, 'score', l.score_delta,
                                                       'balance', l.balance_delta, 'reason', ln.reason)
                                    ORDER BY l.id), '[]')
          FROM ledger_entry l LEFT JOIN ledger_note ln ON ln.entry_id = l.id
          WHERE l.enrollment_id = f.enrollment_id AND l.kind = 'removal' AND l.created_at >= f.raised_at)
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN staff_user su ON su.id = f.resolved_by
  WHERE f.id = target_flag AND f.event_id = ev.id;
END $$;
REVOKE ALL ON FUNCTION flag_detail(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION flag_detail(uuid, bigint) TO questify_app;

-- ================================================================ the players list, with flags and the pause
-- As in 0019, and `open_flag` (the oldest open case, for the Players page's link) and `redeem_paused`.
DROP FUNCTION event_players(uuid, uuid, integer, text);
CREATE FUNCTION event_players(target uuid, after_id uuid, page integer, prefix text)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, status text, score bigint, joined_at timestamptz,
                 open_flag bigint, redeem_paused boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT n.id, p.username, p.avatar, n.status, n.score, n.joined_at,
         (SELECT min(f.id) FROM flag f WHERE f.enrollment_id = n.id AND f.status = 'open'),
         n.redeem_paused_at IS NOT NULL
  FROM event ev
  JOIN enrollment n ON n.event_id = ev.id
  JOIN player p ON p.id = n.player_id
  WHERE ev.id = target
    AND ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope())
    AND (prefix IS NULL OR username_fold(p.username) LIKE
         replace(replace(replace(username_fold(left(prefix, 30)), '\', '\\'), '%', '\%'), '_', '\_') || '%')
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM enrollment c WHERE c.id = after_id AND c.event_id = target)
         OR (n.joined_at, n.id) > (SELECT c.joined_at, c.id FROM enrollment c WHERE c.id = after_id AND c.event_id = target))
  ORDER BY n.joined_at, n.id
  LIMIT least(greatest(page, 1), 100)
$$;
REVOKE ALL ON FUNCTION event_players(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_players(uuid, uuid, integer, text) TO questify_app;
