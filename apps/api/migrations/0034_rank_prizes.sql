-- Rank prizes and final results (T-214; ADR-162 to ADR-165). Organizers attach prizes to rank ranges (FR-519); once
-- the event has ended the owner confirms the places they saw, which freezes them (FR-1719); the reveal then gives
-- each winner their prize as a desk reservation with no price (FR-520, FR-521). Results and places are read and
-- written only through definers: no API grant on either table. Lock order: event, then event_result, then
-- enrollment, then redemption.

-- ================================================================ the event's switch and official rules
ALTER TABLE event
  ADD COLUMN rank_prizes boolean NOT NULL DEFAULT true,
  ADD COLUMN rules_ar    text CHECK (length(rules_ar) BETWEEN 1 AND 10000),
  ADD COLUMN rules_en    text CHECK (length(rules_en) BETWEEN 1 AND 10000);
GRANT UPDATE (rank_prizes, rules_ar, rules_en) ON event TO questify_app;

-- The switch locks once the event is live, as `spending lowers rank` does (0025): players compete for what was
-- announced. Seeds by the migration owner are let through.
CREATE FUNCTION event_rank_prizes_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF event_status_now(OLD.status, OLD.starts_at, OLD.ends_at) IN ('live', 'ended', 'archived') THEN
    RAISE EXCEPTION 'rank prizes are locked once the event is live' USING ERRCODE = 'RF409', DETAIL = 'prizes_locked';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_rank_prizes_guard() FROM PUBLIC;
CREATE TRIGGER event_rank_prizes_guard BEFORE UPDATE OF rank_prizes ON event
  FOR EACH ROW WHEN (OLD.rank_prizes IS DISTINCT FROM NEW.rank_prizes)
  EXECUTE FUNCTION event_rank_prizes_guard();

-- ================================================================ results (written by the definers below only)
CREATE TABLE event_result (
  event_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  revealed_at  timestamptz,
  revealed_by  uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  -- The claim deadline the owner set at the reveal (ADR-162).
  claim_until  timestamptz,
  CHECK ((revealed_at IS NULL) = (claim_until IS NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);

-- ================================================================ rank prizes (FR-519)
CREATE TABLE rank_prize (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL REFERENCES organizer (id),
  event_id       uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  rank_from      integer NOT NULL CHECK (rank_from BETWEEN 1 AND 100),
  rank_to        integer NOT NULL CHECK (rank_to BETWEEN 1 AND 100),
  kind           text NOT NULL CHECK (kind IN ('item', 'experience')),
  name_ar        text CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en        text CHECK (length(name_en) BETWEEN 1 AND 120),
  description_ar text CHECK (length(description_ar) BETWEEN 1 AND 2000),
  description_en text CHECK (length(description_en) BETWEEN 1 AND 2000),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  CHECK (rank_from <= rank_to),
  CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id)
);
CREATE INDEX rank_prize_event ON rank_prize (event_id, rank_from) WHERE status = 'active';
CREATE TRIGGER rank_prize_organizer BEFORE INSERT ON rank_prize
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();
CREATE TRIGGER rank_prize_touch BEFORE UPDATE ON rank_prize FOR EACH ROW EXECUTE FUNCTION quest_touch();

ALTER TABLE rank_prize ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_prize FORCE ROW LEVEL SECURITY;
ALTER TABLE event_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_result FORCE ROW LEVEL SECURITY;
REVOKE ALL ON rank_prize, event_result FROM PUBLIC;

-- Organizers read, create and edit; `kind` is fixed at creation; `status` is for removal only (no DELETE: a
-- redemption may point at the prize). Players read prizes only through the definers below.
GRANT SELECT ON rank_prize TO questify_app;
GRANT INSERT (event_id, kind, rank_from, rank_to, name_ar, name_en, description_ar, description_en)
  ON rank_prize TO questify_app;
GRANT UPDATE (rank_from, rank_to, name_ar, name_en, description_ar, description_en, status) ON rank_prize TO questify_app;
CREATE POLICY rank_prize_member ON rank_prize FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- Whether the caller's event has confirmed results. The guard below runs as the API role, which cannot read
-- event_result; this answers for the caller's own organizer only (false for anyone else's event). Internal to
-- the guard, so granted to the API role.
CREATE FUNCTION results_frozen(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM event_result x
                 WHERE x.event_id = target AND (x.organizer_id = app_organizer_id() OR app_is_admin()))
$$;
REVOKE ALL ON FUNCTION results_frozen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION results_frozen(uuid) TO questify_app;

-- Every write to a rank prize (ADR-162):
--   RF409 results_final  the results are confirmed: nothing changes any more;
--   RF409 prizes_locked  once the event is live, ranges, adding and removing are locked (names stay editable);
--   RF409 removed        a removed prize stays removed;
--   DL409                an item prize needs the prize desk's place, as an item reward does (FR-1716);
--   RF409 overlap        two active prizes never cover the same rank.
-- The overlap check runs for every writer under the prize-range lock: pg_advisory_xact_lock(hashtextextended(
-- 'rank_prize:' || event id, 0)), the same key scheme as T-209's device lock ('device:' || event || ':' || device),
-- so two writes in one event cannot both pass it.
CREATE FUNCTION rank_prize_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev event%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('rank_prize:' || NEW.event_id::text, 0));
  IF current_user = 'questify_app' THEN
    -- A write outside the caller's own events is left to row-level security, which refuses it.
    SELECT * INTO ev FROM event e WHERE e.id = NEW.event_id;
    IF NOT FOUND OR ((ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope()))
                     OR app_is_admin()) IS NOT TRUE THEN
      RETURN NEW;
    END IF;
    IF results_frozen(ev.id) THEN
      RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'removed' THEN
      RAISE EXCEPTION 'a removed rank prize does not change' USING ERRCODE = 'RF409', DETAIL = 'removed';
    END IF;
    IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('live', 'ended', 'archived')
       AND (TG_OP = 'INSERT' OR NEW.rank_from <> OLD.rank_from OR NEW.rank_to <> OLD.rank_to
            OR NEW.status <> OLD.status) THEN
      RAISE EXCEPTION 'rank prizes are locked once the event is live' USING ERRCODE = 'RF409', DETAIL = 'prizes_locked';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.kind = 'item' AND ev.desk_location_ar IS NULL AND ev.desk_location_en IS NULL THEN
      RAISE EXCEPTION 'set the prize desk before adding item prizes' USING ERRCODE = 'DL409';
    END IF;
  END IF;
  IF NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM rank_prize p
    WHERE p.event_id = NEW.event_id AND p.status = 'active' AND p.id <> NEW.id
      AND int4range(p.rank_from, p.rank_to, '[]') && int4range(NEW.rank_from, NEW.rank_to, '[]')) THEN
    RAISE EXCEPTION 'another prize covers these ranks' USING ERRCODE = 'RF409', DETAIL = 'overlap';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION rank_prize_guard() FROM PUBLIC;
CREATE TRIGGER rank_prize_guard BEFORE INSERT OR UPDATE ON rank_prize
  FOR EACH ROW EXECUTE FUNCTION rank_prize_guard();

-- The prize desk's place stays while an active item prize needs it (as for item rewards, 0029).
CREATE OR REPLACE FUNCTION event_desk_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (OLD.desk_location_ar IS NOT NULL OR OLD.desk_location_en IS NOT NULL)
     AND NEW.desk_location_ar IS NULL AND NEW.desk_location_en IS NULL
     AND (EXISTS (SELECT 1 FROM reward r WHERE r.event_id = NEW.id AND r.kind = 'item' AND r.status = 'active')
          OR EXISTS (SELECT 1 FROM rank_prize p WHERE p.event_id = NEW.id AND p.kind = 'item' AND p.status = 'active'))
  THEN
    RAISE EXCEPTION 'item rewards need the prize desk' USING ERRCODE = 'DL409';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ the frozen places
CREATE TABLE result_place (
  event_id      uuid NOT NULL REFERENCES event_result (event_id) ON DELETE CASCADE,
  rank          integer NOT NULL CHECK (rank BETWEEN 1 AND 100),
  enrollment_id uuid NOT NULL,
  score         bigint NOT NULL,
  score_version bigint NOT NULL,
  -- Open flags on the player when the owner confirmed (FR-1719).
  open_flags    integer NOT NULL DEFAULT 0 CHECK (open_flags >= 0),
  -- The prize for this rank when the owner confirmed (NULL: none, or the switch was off).
  rank_prize_id uuid,
  -- The winner's prize, made at the reveal; the reveal skips a place that has one.
  redemption_id uuid UNIQUE,
  PRIMARY KEY (event_id, rank),
  UNIQUE (event_id, enrollment_id),
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (rank_prize_id, event_id) REFERENCES rank_prize (id, event_id) ON DELETE RESTRICT,
  CHECK (redemption_id IS NULL OR rank_prize_id IS NOT NULL)
);
ALTER TABLE result_place ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_place FORCE ROW LEVEL SECURITY;
REVOKE ALL ON result_place FROM PUBLIC;

-- ================================================================ a redemption is a shop reward or a rank prize
ALTER TABLE redemption
  ALTER COLUMN reward_id DROP NOT NULL,
  ADD COLUMN rank_prize_id uuid,
  ADD CONSTRAINT redemption_rank_prize_fk FOREIGN KEY (rank_prize_id, event_id) REFERENCES rank_prize (id, event_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT redemption_one_source CHECK (num_nonnulls(reward_id, rank_prize_id) = 1),
  DROP CONSTRAINT redemption_price_check,
  ADD CONSTRAINT redemption_price_check CHECK (CASE WHEN rank_prize_id IS NULL THEN price >= 1 ELSE price = 0 END),
  ADD CONSTRAINT redemption_rank_prize_desk CHECK (rank_prize_id IS NULL OR status <> 'delivered');
CREATE UNIQUE INDEX redemption_rank_prize_once ON redemption (rank_prize_id, enrollment_id)
  WHERE rank_prize_id IS NOT NULL;
ALTER TABLE result_place ADD CONSTRAINT result_place_redemption_fk FOREIGN KEY (redemption_id)
  REFERENCES redemption (id) ON DELETE RESTRICT;

-- ================================================================ readers of a redemption learn rank prizes
-- As 0032; a rank prize (no price, no stock) ends with no return entry and no unit back (ADR-162).
CREATE OR REPLACE FUNCTION end_reservation(target uuid, outcome text, by_whom text, who text, operator uuid)
  RETURNS boolean
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
  PERFORM ensure_rehearsal_wiped(found_row.event_id);
  PERFORM 1 FROM enrollment n WHERE n.id = found_row.enrollment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM reward r WHERE r.id = found_row.reward_id FOR UPDATE;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF NOT FOUND OR locked.status <> 'reserved' THEN
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
  IF locked.rank_prize_id IS NOT NULL THEN
    RETURN true;
  END IF;
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

-- As 0029; RZ409: a rank prize is not the player's to cancel (ADR-162).
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
  IF mine.rank_prize_id IS NOT NULL THEN
    RAISE EXCEPTION 'a rank prize is not cancelled by its winner' USING ERRCODE = 'RZ409';
  END IF;
  ended := end_reservation(target, 'cancelled', 'player', 'player', NULL);
  SELECT * INTO mine FROM redemption d WHERE d.id = target;
  IF NOT ended AND mine.status <> 'cancelled' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = mine.status;
  END IF;
  RETURN QUERY SELECT mine.id, mine.status, mine.price, n.balance, r.stock_total - r.units_out, NOT ended
    FROM enrollment n LEFT JOIN reward r ON r.id = mine.reward_id WHERE n.id = mine.enrollment_id;
END $$;

-- desk_items, desk_lookup and desk_find gain `rank` (the winner's place for a rank prize, NULL for a shop item)
-- and read a rank prize's name and kind. Return types change, so the three are dropped and made again.
DROP FUNCTION desk_lookup(uuid, uuid, integer);
DROP FUNCTION desk_find(uuid, text, text);
DROP FUNCTION desk_items(enrollment, uuid);
CREATE FUNCTION desk_items(found_n enrollment, me uuid)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz, rank integer)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.username, p.avatar, found_n.status IN ('active', 'banned'),
         (SELECT desk_hold(found_n, e) FROM event e WHERE e.id = found_n.event_id),
         d.id, coalesce(r.kind, k.kind), coalesce(r.name_ar, k.name_ar),
         coalesce(r.name_en, k.name_en), d.created_at, d.reserved_until, coalesce(d.collect_until > now(), false),
         coalesce(d.offer_by = me AND d.offer_until > now(), false), CASE WHEN d.offer_by = me THEN d.offer_until END,
         x.rank
  FROM player p
  LEFT JOIN redemption d ON d.enrollment_id = found_n.id AND d.status = 'reserved'
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN result_place x ON x.redemption_id = d.id
  WHERE p.id = found_n.player_id
  ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION desk_items(enrollment, uuid) FROM PUBLIC;

CREATE FUNCTION desk_lookup(target_event uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz, rank integer)
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

CREATE FUNCTION desk_find(target_event uuid, by_username text, by_phone text)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz, rank integer)
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

-- As 0029, with rank prizes (a rank prize has no reward row).
CREATE OR REPLACE FUNCTION my_desk_items()
  RETURNS TABLE (redemption_id uuid, event_id uuid, event_name_ar text, event_name_en text, kind text, name_ar text,
                 name_en text, state text, until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, e.id, e.name_ar, e.name_en, coalesce(r.kind, k.kind), coalesce(r.name_ar, k.name_ar),
         coalesce(r.name_en, k.name_en),
         CASE WHEN d.offer_until > now() THEN 'offered' ELSE 'collecting' END,
         CASE WHEN d.offer_until > now() THEN d.offer_until ELSE d.collect_until END
  FROM enrollment n
  JOIN redemption d ON d.enrollment_id = n.id AND d.status = 'reserved'
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  JOIN event e ON e.id = n.event_id
  WHERE n.player_id = app_player_id() AND n.status = 'active'
    AND (d.offer_until > now() OR d.collect_until > now())
  ORDER BY d.created_at, d.id
$$;

-- As 0029, with rank prizes and the winner's place (`rank`, NULL for a shop item). The return type changes.
DROP FUNCTION my_redemptions(uuid);
CREATE FUNCTION my_redemptions(target uuid)
  RETURNS TABLE (id uuid, reward_id uuid, kind text, name_ar text, name_en text, price integer, status text,
                 reserved_until timestamptz, created_at timestamptz, ended_at timestamptz, code_cipher bytea,
                 collect_until timestamptz, offer_until timestamptz, rank integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.reward_id, coalesce(r.kind, k.kind), coalesce(r.name_ar, k.name_ar), coalesce(r.name_en, k.name_en), d.price, d.status, d.reserved_until, d.created_at, d.ended_at,
         c.code_cipher, CASE WHEN d.collect_until > now() THEN d.collect_until END,
         CASE WHEN d.offer_until > now() THEN d.offer_until END, x.rank
  FROM enrollment n JOIN redemption d ON d.enrollment_id = n.id LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id LEFT JOIN result_place x ON x.redemption_id = d.id
  LEFT JOIN reward_code c ON c.redemption_id = d.id
  WHERE n.event_id = target AND n.player_id = app_player_id()
  ORDER BY d.created_at DESC, d.id
  LIMIT 100
$$;
REVOKE ALL ON FUNCTION my_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_redemptions(uuid) TO questify_app;

-- As 0031; a held rank prize is among the waiting items (it has no reward row).
CREATE OR REPLACE FUNCTION flag_detail(target_event uuid, target_flag bigint)
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
         (SELECT coalesce(jsonb_agg(jsonb_build_object('nameAr', coalesce(r.name_ar, k.name_ar),
                                                       'nameEn', coalesce(r.name_en, k.name_en),
                                                       'reservedUntil', d.reserved_until) ORDER BY d.created_at), '[]')
          FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
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

-- As 0024; a rank prize's handover entry names the prize.
CREATE OR REPLACE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar), coalesce(q.title_en, r.name_en, k.name_en)
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;

-- As 0032; the replay compares with IS DISTINCT FROM: a rank prize's reward_id is NULL, and `NULL <> target`
-- would have answered its redemption as a replay of this reward.
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
  IF item.status <> 'active' THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
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

-- As 0032; refused once the results are confirmed (RF409 results_final), checked under the event's lock.
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
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
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true FROM ledger_entry l WHERE l.id = earlier.entry_id;
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome') THEN
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
     AND EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved') THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, staff_user_id, reverses)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          'staff', me, credit.id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, made);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false;
END $$;

-- ================================================================ the places (FR-520)
-- How many places results keep: at least 10, or the highest prize rank when prizes are on. Internal.
CREATE FUNCTION result_depth(ev event) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT greatest(10, coalesce((SELECT max(p.rank_to) FROM rank_prize p
                                WHERE p.event_id = ev.id AND p.status = 'active' AND ev.rank_prizes), 0))
$$;
REVOKE ALL ON FUNCTION result_depth(event) FROM PUBLIC;

-- The current places from PostgreSQL, never the cache: ranked members (the team, operators, banned players and the
-- exclusion list are out, ranked_enrollments), by score, then whoever reached it first (the lower score_version).
-- Internal.
CREATE FUNCTION current_places(ev event)
  RETURNS TABLE (rank integer, enrollment_id uuid, score bigint, score_version bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (row_number() OVER (ORDER BY r.score DESC, r.score_version, r.id))::integer, r.id, r.score, r.score_version
  FROM ranked_enrollments(ev.id) r
  WHERE r.ranked
  ORDER BY r.score DESC, r.score_version, r.id
  LIMIT result_depth(ev)
$$;
REVOKE ALL ON FUNCTION current_places(event) FROM PUBLIC;

-- The active prize covering a rank while prizes are on, else NULL. Internal.
CREATE FUNCTION prize_for_rank(ev event, place integer) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.id FROM rank_prize p
  WHERE ev.rank_prizes AND p.event_id = ev.id AND p.status = 'active' AND place BETWEEN p.rank_from AND p.rank_to
$$;
REVOKE ALL ON FUNCTION prize_for_rank(event, integer) FROM PUBLIC;

-- The claim deadline offered by default (ADR-162): the end of the desk's last open window, else the shop's closing,
-- kept between 1 and 60 days from now. NULL when the desk has hours and none remain before that time (the owner picks).
CREATE FUNCTION default_claim_until(ev event) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN ev.desk_hours IS NOT NULL AND kept.at > upper(ev.desk_hours) THEN NULL ELSE kept.at END
  FROM (SELECT least(greatest(CASE WHEN ev.desk_hours IS NOT NULL THEN upper(ev.desk_hours)
                                   ELSE ev.ends_at + make_interval(days => ev.shop_days_after) END,
                              now() + interval '1 day'),
                     now() + interval '60 days') AS at) kept
$$;
REVOKE ALL ON FUNCTION default_claim_until(event) FROM PUBLIC;

-- ================================================================ the team's view (FR-1719)
-- Where the results stand: not_ended, open (ended, not confirmed), confirmed, revealed. Owners and editors (AN404).
CREATE FUNCTION results_state(target_event uuid)
  RETURNS TABLE (state text, rank_prizes boolean, ends_at timestamptz, confirmed_at timestamptz,
                 revealed_at timestamptz, claim_until timestamptz, default_claim_until timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  res event_result%ROWTYPE;
BEGIN
  SELECT * INTO res FROM event_result x WHERE x.event_id = ev.id;
  RETURN QUERY SELECT
    CASE WHEN res.revealed_at IS NOT NULL THEN 'revealed'
         WHEN res.event_id IS NOT NULL THEN 'confirmed'
         WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'ended' THEN 'open'
         ELSE 'not_ended' END,
    ev.rank_prizes, ev.ends_at, res.confirmed_at, res.revealed_at, res.claim_until, default_claim_until(ev);
END $$;
REVOKE ALL ON FUNCTION results_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION results_state(uuid) TO questify_app;

-- The places: the frozen ones once confirmed, else the current standings with each player's open flags now. Each
-- with its prize and, after the reveal, the prize's redemption status. Owners and editors (AN404).
CREATE FUNCTION results_places(target_event uuid)
  RETURNS TABLE (rank integer, enrollment_id uuid, username text, avatar text, score bigint, open_flags integer,
                 flag_kinds text[], prize_id uuid, prize_kind text, prize_name_ar text, prize_name_en text,
                 redemption_status text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RETURN QUERY
    SELECT x.rank, x.enrollment_id, p.username, p.avatar, x.score, x.open_flags,
           ARRAY(SELECT DISTINCT f.kind FROM flag f WHERE f.enrollment_id = x.enrollment_id AND f.status = 'open'
                 ORDER BY f.kind),
           k.id, k.kind, k.name_ar, k.name_en, d.status
    FROM result_place x
    JOIN enrollment n ON n.id = x.enrollment_id
    JOIN player p ON p.id = n.player_id
    LEFT JOIN rank_prize k ON k.id = x.rank_prize_id
    LEFT JOIN redemption d ON d.id = x.redemption_id
    WHERE x.event_id = ev.id
    ORDER BY x.rank;
    RETURN;
  END IF;
  RETURN QUERY
  SELECT c.rank, c.enrollment_id, p.username, p.avatar, c.score,
         (SELECT count(*)::integer FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'),
         ARRAY(SELECT DISTINCT f.kind FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'
               ORDER BY f.kind),
         k.id, k.kind, k.name_ar, k.name_en, NULL::text
  FROM current_places(ev) c
  JOIN enrollment n ON n.id = c.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN rank_prize k ON k.id = prize_for_rank(ev, c.rank)
  ORDER BY c.rank;
END $$;
REVOKE ALL ON FUNCTION results_places(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION results_places(uuid) TO questify_app;

-- ================================================================ confirming (FR-1719, ADR-163)
-- The owner confirms the places they saw (`expected`: the enrollment ids in rank order) once the event has ended.
-- Under the event's FOR UPDATE lock, so a removal in flight (which takes the event FOR KEY SHARE first) either
-- commits before the places are read or is refused afterwards. Open flags never block. Outcomes: confirmed, replayed,
-- not_owner. Refusals: AN404, RF409 not_ended | results_changed, 22023 no list.
CREATE FUNCTION confirm_results(target_event uuid, expected uuid[], request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  now_places uuid[];
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  IF expected IS NULL OR array_position(expected, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'the places seen are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT * INTO ev FROM event e WHERE e.id = ev.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RETURN 'replayed';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'ended' THEN
    RAISE EXCEPTION 'results are confirmed after the event ends' USING ERRCODE = 'RF409', DETAIL = 'not_ended';
  END IF;
  now_places := ARRAY(SELECT c.enrollment_id FROM current_places(ev) c ORDER BY c.rank);
  IF now_places <> expected THEN
    RAISE EXCEPTION 'the places changed' USING ERRCODE = 'RF409', DETAIL = 'results_changed';
  END IF;

  INSERT INTO event_result (event_id, organizer_id, confirmed_by) VALUES (ev.id, ev.organizer_id, app_staff_user_id());
  INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version, open_flags, rank_prize_id)
  SELECT ev.id, c.rank, c.enrollment_id, c.score, c.score_version,
         (SELECT count(*) FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'),
         prize_for_rank(ev, c.rank)
  FROM current_places(ev) c;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.results_confirmed', 'event', ev.id::text,
          jsonb_build_object('places', cardinality(now_places),
                             'flagged', (SELECT count(*) FROM result_place x WHERE x.event_id = ev.id AND x.open_flags > 0)),
          request);
  RETURN 'confirmed';
END $$;
REVOKE ALL ON FUNCTION confirm_results(uuid, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_results(uuid, uuid[], uuid) TO questify_app;

-- ================================================================ the reveal (FR-520, FR-521, ADR-164)
-- The owner reveals confirmed results with the claim deadline they chose (1 hour to 60 days away; ADR-162). When
-- prizes are on, each place with a prize gets a reserved redemption with no price, due at the deadline; its id is
-- kept on the place, so a second reveal makes nothing (the partial unique key on redemption backs it). The
-- redemption's own key holds a space, which the API's Idempotency-Key format refuses, so no player request can ever
-- name it. No ledger entry: a prize takes no points. Outcomes: revealed, replayed, not_owner. Refusals: AN404, RF409
-- not_confirmed | not_ended | bad_deadline | desk_closed_until_deadline.
CREATE FUNCTION reveal_results(target_event uuid, claim_until timestamptz, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := award_event_of(target_event);
  res   event_result%ROWTYPE;
  place result_place%ROWTYPE;
  made  uuid;
  given integer := 0;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT * INTO res FROM event_result x WHERE x.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'confirm the results first' USING ERRCODE = 'RF409', DETAIL = 'not_confirmed';
  END IF;
  IF res.revealed_at IS NOT NULL THEN
    RETURN 'replayed';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'ended' THEN
    RAISE EXCEPTION 'the event is not in its ended state' USING ERRCODE = 'RF409', DETAIL = 'not_ended';
  END IF;
  IF claim_until IS NULL OR claim_until < now() + interval '1 hour' OR claim_until > now() + interval '60 days' THEN
    RAISE EXCEPTION 'the deadline is 1 hour to 60 days away' USING ERRCODE = 'RF409', DETAIL = 'bad_deadline';
  END IF;
  IF ev.desk_hours IS NOT NULL AND NOT (ev.desk_hours && tstzmultirange(tstzrange(now(), claim_until))) THEN
    RAISE EXCEPTION 'the desk is not open before the deadline' USING ERRCODE = 'RF409',
      DETAIL = 'desk_closed_until_deadline';
  END IF;

  FOR place IN
    SELECT x.* FROM result_place x
    WHERE x.event_id = ev.id AND x.rank_prize_id IS NOT NULL AND x.redemption_id IS NULL AND ev.rank_prizes
    ORDER BY x.rank
  LOOP
    PERFORM 1 FROM enrollment n WHERE n.id = place.enrollment_id FOR NO KEY UPDATE;
    made := gen_random_uuid();
    INSERT INTO redemption (id, organizer_id, event_id, enrollment_id, rank_prize_id, price, idempotency_key,
                            reserved_until)
    VALUES (made, ev.organizer_id, ev.id, place.enrollment_id, place.rank_prize_id, 0, 'rank prize ' || made::text,
            claim_until);
    UPDATE result_place x SET redemption_id = made WHERE x.event_id = ev.id AND x.rank = place.rank;
    given := given + 1;
  END LOOP;

  UPDATE event_result x SET revealed_at = now(), revealed_by = app_staff_user_id(), claim_until = reveal_results.claim_until
  WHERE x.event_id = ev.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.results_revealed', 'event', ev.id::text,
          jsonb_build_object('prizes', given, 'claimUntil', claim_until), request);
  RETURN 'revealed';
END $$;
REVOKE ALL ON FUNCTION reveal_results(uuid, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reveal_results(uuid, timestamptz, uuid) TO questify_app;

-- ================================================================ the player's view (FR-520, FR-1718)
-- The revealed places for an active member: rank, player, score, prize; for the caller's own place, their prize's
-- redemption, status and deadline. No rows before the reveal or for a non-member.
CREATE FUNCTION event_results(target uuid)
  RETURNS TABLE (rank integer, username text, avatar text, score bigint, prize_kind text, prize_name_ar text,
                 prize_name_en text, mine boolean, redemption_id uuid, redemption_status text,
                 claim_until timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT x.rank, p.username, p.avatar, x.score, k.kind, k.name_ar, k.name_en, x.enrollment_id = me.id,
         CASE WHEN x.enrollment_id = me.id THEN d.id END, CASE WHEN x.enrollment_id = me.id THEN d.status END,
         res.claim_until
  FROM me
  JOIN event_result res ON res.event_id = target AND res.revealed_at IS NOT NULL
  JOIN result_place x ON x.event_id = res.event_id
  JOIN enrollment n ON n.id = x.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN rank_prize k ON k.id = x.rank_prize_id
  LEFT JOIN redemption d ON d.id = x.redemption_id
  ORDER BY x.rank
$$;
REVOKE ALL ON FUNCTION event_results(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_results(uuid) TO questify_app;

-- ================================================================ official rules (FR-1707, ADR-165)
-- What the fixed rules block is built from (the API writes the words, packages/shared): the switch, the active
-- prizes in rank order, the organizer's name, the end time and zone, the claim deadline once revealed, and the
-- organizer's own text.
-- Internal.
CREATE FUNCTION rules_of(ev event) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'rankPrizes', ev.rank_prizes,
    'prizes', CASE WHEN ev.rank_prizes THEN (
      SELECT coalesce(jsonb_agg(jsonb_build_object('rankFrom', p.rank_from, 'rankTo', p.rank_to, 'kind', p.kind,
                                                   'nameAr', p.name_ar, 'nameEn', p.name_en) ORDER BY p.rank_from),
                      '[]')
      FROM rank_prize p WHERE p.event_id = ev.id AND p.status = 'active') ELSE '[]'::jsonb END,
    'organizer', (SELECT o.name FROM organizer o WHERE o.id = ev.organizer_id),
    'endsAt', ev.ends_at,
    'timezone', ev.timezone,
    'claimUntil', (SELECT x.claim_until FROM event_result x WHERE x.event_id = ev.id),
    'rulesAr', ev.rules_ar,
    'rulesEn', ev.rules_en)
$$;
REVOKE ALL ON FUNCTION rules_of(event) FROM PUBLIC;

-- The rules by join code, with the join card's visibility (public_event): any access type, never a draft or an
-- archived event. NULL when nothing matches.
CREATE FUNCTION public_event_rules(code text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rules_of(e) FROM event e WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
$$;
REVOKE ALL ON FUNCTION public_event_rules(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_event_rules(text) TO questify_app;

-- The rules for an active member in the app (the info page). NULL for anyone else.
CREATE FUNCTION event_rules(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rules_of(e) FROM event e
  WHERE e.id = target AND EXISTS (SELECT 1 FROM enrollment n
                                  WHERE n.event_id = e.id AND n.player_id = app_player_id() AND n.status = 'active')
$$;
REVOKE ALL ON FUNCTION event_rules(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_rules(uuid) TO questify_app;
