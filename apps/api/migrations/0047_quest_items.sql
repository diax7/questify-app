-- Items as quest or category rewards (T-304d, ADR-205; plan docs/plans/2026-10-24-t-304d-item-rewards.md). An organizer
-- makes a quest item (its own stock, never sold in the shop) and names it on quests and categories. A quest gives it on
-- the player's first completion, a category with its bonus once per period, as a price-0 desk reservation: a
-- redemption's third source after shop rewards and rank prizes. Out of stock, or the desk's hours over, pays the
-- points only and records a miss (FR-1617). Deny by default: quest_item_miss has no grant; quest_item's units_out has
-- none; the definers below are their only doors. Lock order: enrollment, quest items (by id), redemption.

-- ================================================================ the item (FR-522)
CREATE TABLE quest_item (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id   uuid NOT NULL REFERENCES organizer (id),
  event_id       uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  name_ar        text CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en        text CHECK (length(name_en) BETWEEN 1 AND 120),
  description_ar text CHECK (length(description_ar) BETWEEN 1 AND 2000),
  description_en text CHECK (length(description_en) BETWEEN 1 AND 2000),
  stock_total    integer NOT NULL CHECK (stock_total BETWEEN 0 AND 100000),
  -- Units reserved or handed over; only the definers below move it.
  units_out      integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  CONSTRAINT quest_item_stock_covers_out CHECK (units_out BETWEEN 0 AND stock_total),
  CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id)
);
CREATE INDEX quest_item_event ON quest_item (event_id) WHERE status = 'active';
CREATE TRIGGER quest_item_organizer BEFORE INSERT ON quest_item
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();
CREATE TRIGGER quest_item_touch BEFORE UPDATE ON quest_item FOR EACH ROW EXECUTE FUNCTION quest_touch();

ALTER TABLE quest_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_item FROM PUBLIC;
-- Organizers read, create and edit; `status` is for removal only (no DELETE: a redemption may point at the item).
-- Players read items only through the definers below.
GRANT SELECT ON quest_item TO questify_app;
GRANT INSERT (event_id, name_ar, name_en, description_ar, description_en, stock_total) ON quest_item TO questify_app;
GRANT UPDATE (name_ar, name_en, description_ar, description_en, stock_total, status) ON quest_item TO questify_app;
CREATE POLICY quest_item_member ON quest_item FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- Every write to an item:
--   DL409                a new item needs the prize desk's place, as an item reward does (FR-1716);
--   QI409 removed        a removed item stays removed;
--   QI409 item_in_use    an item a quest or category still names is not removed.
-- Links and removals of one event serialize on pg_advisory_xact_lock(hashtextextended('quest_item:' || event, 0)):
-- the composite FK takes only FOR KEY SHARE, which a status update does not wait for. Seeds by the migration owner skip
-- the desk check, as reward_desk_guard does.
CREATE FUNCTION quest_item_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  has_place boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_user = 'questify_app' THEN
      SELECT e.desk_location_ar IS NOT NULL OR e.desk_location_en IS NOT NULL INTO has_place
      FROM event e WHERE e.id = NEW.event_id FOR SHARE OF e;
      IF FOUND AND NOT has_place THEN
        RAISE EXCEPTION 'set the prize desk before adding quest items' USING ERRCODE = 'DL409';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'removed' AND NEW.status <> 'removed' THEN
    RAISE EXCEPTION 'a removed quest item stays removed' USING ERRCODE = 'QI409', DETAIL = 'removed';
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'removed' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('quest_item:' || NEW.event_id, 0));
    IF EXISTS (SELECT 1 FROM quest q WHERE q.item_id = NEW.id)
       OR EXISTS (SELECT 1 FROM category c WHERE c.item_id = NEW.id) THEN
      RAISE EXCEPTION 'a quest or category still gives this item' USING ERRCODE = 'QI409', DETAIL = 'item_in_use';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_item_guard() FROM PUBLIC;
CREATE TRIGGER quest_item_guard BEFORE INSERT OR UPDATE ON quest_item
  FOR EACH ROW EXECUTE FUNCTION quest_item_guard();

-- The prize desk's place stays while an active item, item prize or quest item needs it (0029, 0034).
CREATE OR REPLACE FUNCTION event_desk_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (OLD.desk_location_ar IS NOT NULL OR OLD.desk_location_en IS NOT NULL)
     AND NEW.desk_location_ar IS NULL AND NEW.desk_location_en IS NULL
     AND (EXISTS (SELECT 1 FROM reward r WHERE r.event_id = NEW.id AND r.kind = 'item' AND r.status = 'active')
          OR EXISTS (SELECT 1 FROM rank_prize p WHERE p.event_id = NEW.id AND p.kind = 'item' AND p.status = 'active')
          OR EXISTS (SELECT 1 FROM quest_item i WHERE i.event_id = NEW.id AND i.status = 'active'))
  THEN
    RAISE EXCEPTION 'item rewards need the prize desk' USING ERRCODE = 'DL409';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ one item, many sources
-- NO ACTION (as category.unlock_after, 0044), so a draft event's delete cascades through its quests and items in one
-- statement; an item stays while named (QI409 above), and removal is the only way out of use.
ALTER TABLE quest ADD COLUMN item_id uuid;
ALTER TABLE quest ADD CONSTRAINT quest_item_fkey FOREIGN KEY (item_id, event_id) REFERENCES quest_item (id, event_id);
CREATE INDEX quest_item_idx ON quest (item_id) WHERE item_id IS NOT NULL;
ALTER TABLE category ADD COLUMN item_id uuid;
ALTER TABLE category ADD CONSTRAINT category_item_fkey
  FOREIGN KEY (item_id, event_id) REFERENCES quest_item (id, event_id);
CREATE INDEX category_item_idx ON category (item_id) WHERE item_id IS NOT NULL;
GRANT INSERT (item_id), UPDATE (item_id) ON quest TO questify_app;
GRANT UPDATE (item_id) ON category TO questify_app;

-- A quest or category names an active item only (QI422). Takes the event's item lock before reading the item, so a
-- link and a removal of the same event never both pass. The triggers are named quest_item_* and category_item_* so
-- they fire before *_refresh_type (triggers fire by name): this lock is always taken before the refresh lock.
CREATE FUNCTION item_link_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.item_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.item_id IS NOT DISTINCT FROM OLD.item_id) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('quest_item:' || NEW.event_id, 0));
  IF NOT EXISTS (SELECT 1 FROM quest_item i WHERE i.id = NEW.item_id AND i.event_id = NEW.event_id
                   AND i.status = 'active') THEN
    RAISE EXCEPTION 'no such quest item in this event' USING ERRCODE = 'QI422', DETAIL = 'invalid_item';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION item_link_guard() FROM PUBLIC;
CREATE TRIGGER quest_item_link BEFORE INSERT OR UPDATE OF item_id ON quest
  FOR EACH ROW EXECUTE FUNCTION item_link_guard();
CREATE TRIGGER category_item_link BEFORE INSERT OR UPDATE OF item_id ON category
  FOR EACH ROW EXECUTE FUNCTION item_link_guard();

-- ================================================================ a redemption's third source
ALTER TABLE redemption
  ADD COLUMN quest_item_id        uuid,
  -- The source of a quest item: the completion that gave it, or the category bonus's category and period.
  ADD COLUMN source_completion_id bigint REFERENCES quest_completion (id) ON DELETE RESTRICT,
  ADD COLUMN source_category_id   uuid,
  ADD COLUMN source_period        timestamptz,
  ADD CONSTRAINT redemption_quest_item_fk FOREIGN KEY (quest_item_id, event_id) REFERENCES quest_item (id, event_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT redemption_source_category_fk FOREIGN KEY (source_category_id, event_id)
    REFERENCES category (id, event_id) ON DELETE RESTRICT,
  DROP CONSTRAINT redemption_one_source,
  ADD CONSTRAINT redemption_one_source CHECK (num_nonnulls(reward_id, rank_prize_id, quest_item_id) = 1),
  DROP CONSTRAINT redemption_price_check,
  ADD CONSTRAINT redemption_price_check CHECK (CASE WHEN reward_id IS NOT NULL THEN price >= 1 ELSE price = 0 END),
  DROP CONSTRAINT redemption_rank_prize_desk,
  ADD CONSTRAINT redemption_free_desk CHECK (reward_id IS NOT NULL OR status <> 'delivered'),
  ADD CONSTRAINT redemption_item_source CHECK (
    CASE WHEN quest_item_id IS NULL THEN num_nonnulls(source_completion_id, source_category_id, source_period) = 0
         ELSE (source_completion_id IS NOT NULL AND source_category_id IS NULL AND source_period IS NULL)
           OR (source_completion_id IS NULL AND source_category_id IS NOT NULL AND source_period IS NOT NULL) END),
  DROP CONSTRAINT redemption_ended_by_check,
  ADD CONSTRAINT redemption_ended_by_check
    CHECK (ended_by IN ('player', 'timeout', 'delivery', 'handover', 'operator', 'erasure', 'removal'));
-- Once per source: the database's own guard behind give_item.
CREATE UNIQUE INDEX redemption_item_completion_once ON redemption (source_completion_id)
  WHERE quest_item_id IS NOT NULL;
CREATE UNIQUE INDEX redemption_item_category_once ON redemption (enrollment_id, source_category_id, source_period)
  WHERE quest_item_id IS NOT NULL AND source_category_id IS NOT NULL;
CREATE INDEX redemption_quest_item ON redemption (quest_item_id, status) WHERE quest_item_id IS NOT NULL;

-- ================================================================ the misses (FR-1617)
-- One row per source that should have given an item and did not: no stock (or the item was removed), or the desk's
-- hours are over. Nothing is given later. Written by give_item only; read through the definers below.
CREATE TABLE quest_item_miss (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id         uuid NOT NULL,
  event_id             uuid NOT NULL,
  enrollment_id        uuid NOT NULL,
  quest_item_id        uuid NOT NULL,
  source_completion_id bigint REFERENCES quest_completion (id) ON DELETE RESTRICT,
  source_category_id   uuid,
  source_period        timestamptz,
  reason               text NOT NULL CHECK (reason IN ('out_of_stock', 'claim_closed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_completion_id IS NOT NULL AND source_category_id IS NULL AND source_period IS NULL)
         OR (source_completion_id IS NULL AND source_category_id IS NOT NULL AND source_period IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_item_id, event_id) REFERENCES quest_item (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_category_id, event_id) REFERENCES category (id, event_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX quest_item_miss_completion_once ON quest_item_miss (source_completion_id)
  WHERE source_completion_id IS NOT NULL;
CREATE UNIQUE INDEX quest_item_miss_category_once ON quest_item_miss (enrollment_id, source_category_id, source_period)
  WHERE source_category_id IS NOT NULL;
CREATE INDEX quest_item_miss_item ON quest_item_miss (quest_item_id, created_at);
CREATE INDEX quest_item_miss_category ON quest_item_miss (source_category_id) WHERE source_category_id IS NOT NULL;
ALTER TABLE quest_item_miss ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_item_miss FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_item_miss FROM PUBLIC;

-- ================================================================ giving the item
-- Gives `item` for one source (a completion, or a category and period) and answers pending, out_of_stock or
-- claim_closed (NULL for no item). Called only inside the payers, which hold the enrollment and have already locked
-- the items in id order; the FOR UPDATE here is a re-read then (finish_quiz's zero-right path names one item only).
-- Runs once per source by construction, so a unique violation on the source keys is a bug and raises: no ON CONFLICT,
-- and stock moves only after a real insert. The claim deadline is default_claim_until, else the desk's last window
-- while it is still ahead; NULL means the desk's hours are over.
CREATE FUNCTION give_item(enrolled enrollment, item uuid, completion bigint, cat uuid, period timestamptz)
  RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  thing quest_item%ROWTYPE;
  ev    event%ROWTYPE;
  until timestamptz;
  made  uuid;
  why   text;
BEGIN
  IF item IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO thing FROM quest_item i WHERE i.id = item FOR UPDATE;
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  until := coalesce(default_claim_until(ev), CASE WHEN upper(ev.desk_hours) > now() THEN upper(ev.desk_hours) END);
  IF thing.status <> 'active' OR thing.units_out >= thing.stock_total THEN
    why := 'out_of_stock';
  ELSIF until IS NULL THEN
    why := 'claim_closed';
  END IF;
  IF why IS NOT NULL THEN
    INSERT INTO quest_item_miss (organizer_id, event_id, enrollment_id, quest_item_id, source_completion_id,
                                 source_category_id, source_period, reason)
    VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, item, completion, cat, period, why);
    RETURN why;
  END IF;
  made := gen_random_uuid();
  INSERT INTO redemption (id, organizer_id, event_id, enrollment_id, quest_item_id, price, idempotency_key,
                          reserved_until, source_completion_id, source_category_id, source_period)
  VALUES (made, enrolled.organizer_id, enrolled.event_id, enrolled.id, item, 0, 'quest item ' || made::text, until,
          completion, cat, period);
  UPDATE quest_item i SET units_out = i.units_out + 1 WHERE i.id = item;
  RETURN 'pending';
END $$;
REVOKE ALL ON FUNCTION give_item(enrollment, uuid, bigint, uuid, timestamptz) FROM PUBLIC;

-- Locks the quest's and its category's items in id order. Every completion takes it, even a repeat that gives no
-- item: a short wait on one row, so two completions naming the same items in crossed roles never deadlock (40P01).
CREATE FUNCTION lock_quest_items(quest_row quest) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM quest_item i
  WHERE i.id IN (quest_row.item_id, (SELECT c.item_id FROM category c WHERE c.id = quest_row.category_id))
  ORDER BY i.id FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION lock_quest_items(quest) FROM PUBLIC;

-- ================================================================ the payers
-- As 0046, with the category's item: the bonus row is written for points, an item or both; the ledger entry only for
-- points (an item-only bonus has none and answers NULL); then the item, once per period (the bonus row's guard first,
-- the redemption's and miss's period keys second).
CREATE OR REPLACE FUNCTION pay_category_bonus(enrolled enrollment, target_category uuid, completion bigint) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  group_row category%ROWTYPE;
  ev        event%ROWTYPE;
  period    timestamptz;
  entry     bigint;
BEGIN
  SELECT * INTO group_row FROM category c WHERE c.id = target_category;
  IF NOT FOUND OR (group_row.completion_bonus = 0 AND group_row.item_id IS NULL)
     OR NOT category_done(enrolled.id, group_row.id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  period := category_period_start(group_row, ev);
  IF EXISTS (SELECT 1 FROM category_bonus b
             WHERE b.enrollment_id = enrolled.id AND b.category_id = group_row.id AND b.period_start >= period) THEN
    RETURN NULL;
  END IF;
  INSERT INTO category_bonus (organizer_id, event_id, enrollment_id, category_id, completion_id, period_start)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, group_row.id, completion, period)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF group_row.completion_bonus > 0 THEN
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, category_id,
                              actor, bonus_period)
    VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'bonus', group_row.completion_bonus,
            CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
                 ELSE group_row.completion_bonus END,
            group_row.id, 'system', period)
    RETURNING id INTO entry;
    UPDATE category_bonus b SET entry_id = entry
    WHERE b.enrollment_id = enrolled.id AND b.category_id = group_row.id AND b.period_start = period;
  END IF;
  PERFORM give_item(enrolled, group_row.item_id, NULL, group_row.id, period);
  RETURN entry;
END $$;

-- As 0044, with the quest's item on the first completion (ADR-205), the items locked in id order first.
CREATE OR REPLACE FUNCTION pay_completion(enrolled enrollment, quest uuid, points bigint, method text,
                                          completion_key text, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  quest_row  quest%ROWTYPE;
  done_count integer;
  made       bigint;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = pay_completion.quest;
  PERFORM lock_quest_items(quest_row);
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = pay_completion.quest;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, pay_completion.quest, done_count + 1, method,
          completion_key)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', points,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE points END,
          made, pay_completion.quest,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff);
  IF done_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);
  RETURN made;
END $$;

-- As 0046, with the quest's item on the first completion (lifetime occurrence 1), the items locked in id order before
-- the completion is written.
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid)
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
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
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
  -- A quiz in play pays itself at its end; a manual award now would pay the quest twice (T-302).
  IF proof_method = 'manual' AND quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id = enrolled.id AND a.quest_id = target AND a.status = 'open') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr' AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
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

-- ================================================================ what the player reads of a payment
-- The item a completion gave or missed, for the player who made it: pending (a reservation was made, whatever became
-- of it), out_of_stock or claim_closed, with the claim deadline and the event's zone to say it in (the deadline may be
-- the desk's closing within minutes, ADR-205). No row when the completion gave no item.
CREATE FUNCTION own_quest_item(completion bigint)
  RETURNS TABLE (name_ar text, name_en text, outcome text, until timestamptz, time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.name_ar, i.name_en, CASE WHEN d.id IS NOT NULL THEN 'pending' ELSE m.reason END, d.reserved_until,
         e.timezone
  FROM quest_completion c
  JOIN enrollment n ON n.id = c.enrollment_id AND n.player_id = app_player_id()
  JOIN event e ON e.id = c.event_id
  LEFT JOIN redemption d ON d.source_completion_id = c.id AND d.quest_item_id IS NOT NULL
  LEFT JOIN quest_item_miss m ON m.source_completion_id = c.id
  JOIN quest_item i ON i.id = coalesce(d.quest_item_id, m.quest_item_id)
  WHERE c.id = completion
$$;
REVOKE ALL ON FUNCTION own_quest_item(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_quest_item(bigint) TO questify_app;

-- As 0044, with the bonus's item (by its category and period) and points 0 for an item-only bonus. The output changed:
-- DROP and CREATE, with the REVOKE and GRANT repeated.
DROP FUNCTION own_bonus(bigint);
CREATE FUNCTION own_bonus(completion bigint)
  RETURNS TABLE (category_id uuid, points bigint, name_ar text, name_en text, item_ar text, item_en text,
                 item_outcome text, item_until timestamptz, item_time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.category_id, coalesce(l.score_delta, 0), c.name_ar, c.name_en, i.name_ar, i.name_en,
         CASE WHEN d.id IS NOT NULL THEN 'pending' ELSE m.reason END, d.reserved_until,
         (SELECT x.timezone FROM event x WHERE x.id = b.event_id)
  FROM category_bonus b
  JOIN enrollment n ON n.id = b.enrollment_id AND n.player_id = app_player_id()
  LEFT JOIN ledger_entry l ON l.id = b.entry_id
  JOIN category c ON c.id = b.category_id
  LEFT JOIN redemption d ON d.enrollment_id = b.enrollment_id AND d.source_category_id = b.category_id
    AND d.source_period = b.period_start AND d.quest_item_id IS NOT NULL
  LEFT JOIN quest_item_miss m ON m.enrollment_id = b.enrollment_id AND m.source_category_id = b.category_id
    AND m.source_period = b.period_start
  LEFT JOIN quest_item i ON i.id = coalesce(d.quest_item_id, m.quest_item_id)
  WHERE b.completion_id = completion
$$;
REVOKE ALL ON FUNCTION own_bonus(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_bonus(bigint) TO questify_app;

-- As 0046, with the bonus's item and points 0 for an item-only bonus.
DROP FUNCTION own_category_bonus(uuid);
CREATE FUNCTION own_category_bonus(target uuid)
  RETURNS TABLE (category_id uuid, points bigint, name_ar text, name_en text, item_ar text, item_en text,
                 item_outcome text, item_until timestamptz, item_time_zone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.category_id, coalesce(l.score_delta, 0), c.name_ar, c.name_en, i.name_ar, i.name_en,
         CASE WHEN d.id IS NOT NULL THEN 'pending' ELSE m.reason END, d.reserved_until, e.timezone
  FROM quest q
  JOIN event e ON e.id = q.event_id
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id()
  JOIN quiz_attempt a ON a.enrollment_id = n.id AND a.quest_id = q.id AND a.status = 'finished'
  JOIN category_bonus b ON b.enrollment_id = n.id AND b.category_id = q.category_id
    AND b.period_start = category_period_start(c, e)
    AND (b.completion_id = a.completion_id
         OR (a.completion_id IS NULL AND b.completion_id IS NULL AND b.created_at = a.finished_at))
  LEFT JOIN ledger_entry l ON l.id = b.entry_id
  LEFT JOIN redemption d ON d.enrollment_id = b.enrollment_id AND d.source_category_id = b.category_id
    AND d.source_period = b.period_start AND d.quest_item_id IS NOT NULL
  LEFT JOIN quest_item_miss m ON m.enrollment_id = b.enrollment_id AND m.source_category_id = b.category_id
    AND m.source_period = b.period_start
  LEFT JOIN quest_item i ON i.id = coalesce(d.quest_item_id, m.quest_item_id)
  WHERE q.id = target
$$;
REVOKE ALL ON FUNCTION own_category_bonus(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_category_bonus(uuid) TO questify_app;

-- As 0046, with the items still to win: a quest's while the player has never completed it and stock is left (it gives
-- the item on the first completion only), a category's while stock is left. The output changed: DROP and CREATE.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz,
                 item_ar text, item_en text, bonus_item_ar text, bonus_item_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         period_count(me.id, q)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL),
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
         category_lock(q, me.id),
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
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_en END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ ending a reservation
-- As 0034; the item row is locked before the redemption, as a reward's is. A quest item (no price) ends with no
-- return entry and its unit back on the item; a rank prize with neither.
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
  PERFORM 1 FROM quest_item i WHERE i.id = found_row.quest_item_id FOR UPDATE;
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
  IF locked.quest_item_id IS NOT NULL THEN
    UPDATE quest_item i SET units_out = i.units_out - 1 WHERE i.id = locked.quest_item_id;
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

-- As 0034; RZ409: a free item (a rank prize or a quest item) is not the player's to cancel.
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
  IF mine.reward_id IS NULL THEN
    RAISE EXCEPTION 'a free item is not cancelled by its winner' USING ERRCODE = 'RZ409';
  END IF;
  ended := end_reservation(target, 'cancelled', 'player', 'player', NULL);
  SELECT * INTO mine FROM redemption d WHERE d.id = target;
  IF NOT ended AND mine.status <> 'cancelled' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = mine.status;
  END IF;
  RETURN QUERY SELECT mine.id, mine.status, mine.price, n.balance, r.stock_total - r.units_out, NOT ended
    FROM enrollment n LEFT JOIN reward r ON r.id = mine.reward_id WHERE n.id = mine.enrollment_id;
END $$;

-- ================================================================ readers of a redemption learn quest items
-- Where a redemption comes from: shop, rank or quest.
CREATE FUNCTION redemption_source(given redemption) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN given.reward_id IS NOT NULL THEN 'shop'
              WHEN given.rank_prize_id IS NOT NULL THEN 'rank'
              WHEN given.quest_item_id IS NOT NULL THEN 'quest' END
$$;
REVOKE ALL ON FUNCTION redemption_source(redemption) FROM PUBLIC;

-- desk_items, desk_lookup and desk_find gain `source` and read a quest item's name. Return types change, so the three
-- are dropped and made again.
DROP FUNCTION desk_lookup(uuid, uuid, integer);
DROP FUNCTION desk_find(uuid, text, text);
DROP FUNCTION desk_items(enrollment, uuid);
CREATE FUNCTION desk_items(found_n enrollment, me uuid)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz, rank integer, source text)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.username, p.avatar, found_n.status IN ('active', 'banned'),
         (SELECT desk_hold(found_n, e) FROM event e WHERE e.id = found_n.event_id),
         d.id, coalesce(r.kind, k.kind, CASE WHEN i.id IS NOT NULL THEN 'item' END),
         coalesce(r.name_ar, k.name_ar, i.name_ar), coalesce(r.name_en, k.name_en, i.name_en), d.created_at,
         d.reserved_until, coalesce(d.collect_until > now(), false),
         coalesce(d.offer_by = me AND d.offer_until > now(), false), CASE WHEN d.offer_by = me THEN d.offer_until END,
         x.rank, CASE WHEN d.id IS NOT NULL THEN redemption_source(d) END
  FROM player p
  LEFT JOIN redemption d ON d.enrollment_id = found_n.id AND d.status = 'reserved'
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN result_place x ON x.redemption_id = d.id
  WHERE p.id = found_n.player_id
  ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION desk_items(enrollment, uuid) FROM PUBLIC;

CREATE FUNCTION desk_lookup(target_event uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (username text, avatar text, active boolean, hold text, redemption_id uuid, kind text, name_ar text,
                 name_en text, reserved_at timestamptz, reserved_until timestamptz, ready boolean, offered boolean,
                 offer_until timestamptz, rank integer, source text)
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
                 offer_until timestamptz, rank integer, source text)
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

-- As 0034, with quest items and each row's source. The return type changes.
DROP FUNCTION my_desk_items();
CREATE FUNCTION my_desk_items()
  RETURNS TABLE (redemption_id uuid, event_id uuid, event_name_ar text, event_name_en text, kind text, name_ar text,
                 name_en text, state text, until timestamptz, source text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, e.id, e.name_ar, e.name_en, coalesce(r.kind, k.kind, 'item'), coalesce(r.name_ar, k.name_ar, i.name_ar),
         coalesce(r.name_en, k.name_en, i.name_en),
         CASE WHEN d.offer_until > now() THEN 'offered' ELSE 'collecting' END,
         CASE WHEN d.offer_until > now() THEN d.offer_until ELSE d.collect_until END,
         redemption_source(d)
  FROM enrollment n
  JOIN redemption d ON d.enrollment_id = n.id AND d.status = 'reserved'
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  JOIN event e ON e.id = n.event_id
  WHERE n.player_id = app_player_id() AND n.status = 'active'
    AND (d.offer_until > now() OR d.collect_until > now())
  ORDER BY d.created_at, d.id
$$;
REVOKE ALL ON FUNCTION my_desk_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_desk_items() TO questify_app;

-- As 0034, with quest items and each row's source. The return type changes.
DROP FUNCTION my_redemptions(uuid);
CREATE FUNCTION my_redemptions(target uuid)
  RETURNS TABLE (id uuid, reward_id uuid, kind text, name_ar text, name_en text, price integer, status text,
                 reserved_until timestamptz, created_at timestamptz, ended_at timestamptz, code_cipher bytea,
                 collect_until timestamptz, offer_until timestamptz, rank integer, source text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.reward_id, coalesce(r.kind, k.kind, 'item'), coalesce(r.name_ar, k.name_ar, i.name_ar),
         coalesce(r.name_en, k.name_en, i.name_en), d.price, d.status, d.reserved_until, d.created_at, d.ended_at,
         c.code_cipher, CASE WHEN d.collect_until > now() THEN d.collect_until END,
         CASE WHEN d.offer_until > now() THEN d.offer_until END, x.rank, redemption_source(d)
  FROM enrollment n JOIN redemption d ON d.enrollment_id = n.id LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN result_place x ON x.redemption_id = d.id
  LEFT JOIN reward_code c ON c.redemption_id = d.id
  WHERE n.event_id = target AND n.player_id = app_player_id()
  ORDER BY d.created_at DESC, d.id
  LIMIT 100
$$;
REVOKE ALL ON FUNCTION my_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_redemptions(uuid) TO questify_app;

-- As 0034; a held quest item is among the waiting items.
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
         (SELECT coalesce(jsonb_agg(jsonb_build_object('nameAr', coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                       'nameEn', coalesce(r.name_en, k.name_en, i.name_en),
                                                       'reservedUntil', d.reserved_until) ORDER BY d.created_at), '[]')
          FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
          LEFT JOIN quest_item i ON i.id = d.quest_item_id
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

-- As 0044; a quest item's handover entry names the item.
CREATE OR REPLACE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, i.name_ar, g.name_ar),
         coalesce(q.title_en, r.name_en, k.name_en, i.name_en, g.name_en)
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;

-- As 0044; a free item's handover entry names the item.
CREATE OR REPLACE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en),
         coalesce(n.reason, b.reason),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id)
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;

-- As 0038, with a quest item's name.
CREATE OR REPLACE FUNCTION deletion_pending(deletion bytea)
  RETURNS TABLE (redemption_id uuid, event_id uuid, event_ar text, event_en text, item_ar text, item_en text,
                 rank_prize boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, e.id, e.name_ar, e.name_en, coalesce(r.name_ar, k.name_ar, i.name_ar),
         coalesce(r.name_en, k.name_en, i.name_en), d.rank_prize_id IS NOT NULL
  FROM redemption d
  JOIN enrollment n ON n.id = d.enrollment_id
  JOIN event e ON e.id = d.event_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  WHERE n.player_id = deletion_holder(deletion) AND d.status = 'reserved'
  ORDER BY d.created_at, d.id
$$;

-- As 0037; the popular count groups shop rewards only, so free items never form a NULL group.
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
    WHERE d.event_id = target AND d.reward_id IS NOT NULL AND d.status NOT IN ('cancelled', 'expired')
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
    AND in_audience(mine, r.audience_kind, r.audience_field_id, r.audience_values)
  ORDER BY r.position, r.id;
END $$;

-- ================================================================ removing an award (ADR-152, ADR-205)
-- The quest item a credit gave: a quest credit's by its completion, a bonus credit's by its category and period.
CREATE FUNCTION credit_item(credit ledger_entry) RETURNS redemption
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT d.* FROM redemption d
  WHERE d.quest_item_id IS NOT NULL
    AND ((credit.kind = 'quest' AND d.source_completion_id = credit.completion_id)
         OR (credit.kind = 'bonus' AND d.enrollment_id = credit.enrollment_id
             AND d.source_category_id = credit.category_id AND d.source_period = credit.bonus_period))
$$;
REVOKE ALL ON FUNCTION credit_item(ledger_entry) FROM PUBLIC;

-- What a removal did to that item: cancelled (by this removal), handed_over (it stays handed over), or NULL.
CREATE FUNCTION credit_item_state(given redemption) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN given.status = 'handed_over' THEN 'handed_over'
              WHEN given.status = 'cancelled' AND given.ended_by = 'removal' THEN 'cancelled' END
$$;
REVOKE ALL ON FUNCTION credit_item_state(redemption) FROM PUBLIC;

-- As 0044, plus: a removal cancels the credit's quest item while it is still reserved (the unit returns, no ledger
-- entry) and answers `item`; the replay answers it again from the item's current state. AO409 counts priced
-- reservations only: ending a free item moves no balance. The output changed: DROP and CREATE.
DROP FUNCTION remove_award(uuid, bigint, text, text, uuid);
CREATE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text, request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean, item text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
  given    redemption%ROWTYPE;
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
    SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = earlier.reverses;
    given := credit_item(credit);
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true, credit_item_state(given)
      FROM ledger_entry l WHERE l.id = earlier.entry_id;
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus') THEN
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
     AND EXISTS (SELECT 1 FROM redemption d
                 WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved' AND d.price > 0) THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, category_id, actor, staff_user_id, reverses)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, 'staff', me, credit.id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, made);
  IF credit.kind = 'quest' THEN
    UPDATE submission s SET status = 'removed', reason = why, removed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.completion_id = credit.completion_id AND s.status = 'approved';
  END IF;
  given := credit_item(credit);
  IF given.status = 'reserved' THEN
    PERFORM end_reservation(given.id, 'cancelled', 'removal', 'staff', NULL);
    given := credit_item(credit);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b,
                             'item', credit_item_state(given)),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false, credit_item_state(given);
END $$;
REVOKE ALL ON FUNCTION remove_award(uuid, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_award(uuid, bigint, text, text, uuid) TO questify_app;

-- As 0040, answering remove_award's `item` too. The output changed: DROP and CREATE.
DROP FUNCTION remove_submission(uuid, bigint, text, text, uuid);
CREATE FUNCTION remove_submission(target_event uuid, target bigint, reason text, request_key text, request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean, item text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := award_event_of(target_event);
  sent  submission%ROWTYPE;
  entry bigint;
BEGIN
  SELECT s.* INTO sent FROM submission s WHERE s.id = target AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such submission in this event' USING ERRCODE = 'SN404';
  END IF;
  SELECT l.id INTO entry FROM ledger_entry l WHERE l.completion_id = sent.completion_id AND l.kind = 'quest';
  IF entry IS NULL OR (sent.status <> 'approved' AND NOT EXISTS (
    SELECT 1 FROM manual_award_key k
    WHERE k.event_id = ev.id AND k.staff_user_id = app_staff_user_id() AND k.idempotency_key = request_key
      AND k.reverses = entry)) THEN
    RAISE EXCEPTION 'only an approved submission can be removed' USING ERRCODE = 'SR409', DETAIL = sent.status;
  END IF;
  RETURN QUERY SELECT * FROM remove_award(target_event, entry, reason, request_key, request);
END $$;
REVOKE ALL ON FUNCTION remove_submission(uuid, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_submission(uuid, bigint, text, text, uuid) TO questify_app;

-- ================================================================ the organizer's view (owners and editors, AN404)
-- Each active item with its stock, units out, misses and the quests and categories that name it.
CREATE FUNCTION quest_items(target_event uuid)
  RETURNS TABLE (id uuid, name_ar text, name_en text, description_ar text, description_en text, stock_total integer,
                 units_out integer, stock_left integer, missed integer, quests jsonb, categories jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT i.id, i.name_ar, i.name_en, i.description_ar, i.description_en, i.stock_total, i.units_out,
         i.stock_total - i.units_out,
         (SELECT count(*)::integer FROM quest_item_miss m WHERE m.quest_item_id = i.id),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'ar', q.title_ar, 'en', q.title_en)
                                    ORDER BY q.position, q.id), '[]')
          FROM quest q WHERE q.item_id = i.id),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'ar', c.name_ar, 'en', c.name_en)
                                    ORDER BY c.position, c.id), '[]')
          FROM category c WHERE c.item_id = i.id)
  FROM quest_item i
  WHERE i.event_id = ev.id AND i.status = 'active'
  ORDER BY i.created_at, i.id;
END $$;
REVOKE ALL ON FUNCTION quest_items(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_items(uuid) TO questify_app;

-- Who missed an item, newest first, at most 200: the player, when, the quest or category, and why.
CREATE FUNCTION quest_item_misses(target_event uuid, target_item uuid)
  RETURNS TABLE (username text, avatar text, at timestamptz, source text, source_ar text, source_en text,
                 reason text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT p.username, p.avatar, m.created_at,
         CASE WHEN m.source_completion_id IS NOT NULL THEN 'quest' ELSE 'category' END,
         coalesce(q.title_ar, g.name_ar), coalesce(q.title_en, g.name_en), m.reason
  FROM quest_item_miss m
  JOIN enrollment n ON n.id = m.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN quest_completion c ON c.id = m.source_completion_id
  LEFT JOIN quest q ON q.id = c.quest_id
  LEFT JOIN category g ON g.id = m.source_category_id
  WHERE m.event_id = ev.id AND m.quest_item_id = target_item
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION quest_item_misses(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_item_misses(uuid, uuid) TO questify_app;

-- ================================================================ cleanup
-- As 0046, with the rehearsal's item misses counted and deleted before the completions they name, and each quest
-- item's units recounted from the reservations left.
CREATE OR REPLACE FUNCTION wipe_rehearsal(target uuid, reason text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal', 'bonus')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)),
           'submissions', (SELECT count(*) FROM submission s WHERE s.enrollment_id = ANY (accounts)),
           'votes', (SELECT count(*) FROM quest_vote v WHERE v.enrollment_id = ANY (accounts)),
           'quizzes', (SELECT count(*) FROM quiz_attempt a WHERE a.enrollment_id = ANY (accounts)),
           'surveys', (SELECT count(*) FROM survey_response r WHERE r.enrollment_id = ANY (accounts)),
           'reveals', (SELECT count(*) FROM category_reveal r WHERE r.enrollment_id = ANY (accounts)),
           'item_misses', (SELECT count(*) FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

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
  IF EXISTS (SELECT 1 FROM reward_code c JOIN redemption d ON d.id = c.redemption_id
             WHERE d.enrollment_id = ANY (accounts)) THEN
    RAISE EXCEPTION 'a rehearsal reservation holds a real code' USING ERRCODE = 'RX500';
  END IF;
  DELETE FROM redemption d WHERE d.enrollment_id = ANY (accounts);
  DELETE FROM submission s WHERE s.enrollment_id = ANY (accounts);
  DELETE FROM quest_vote v WHERE v.enrollment_id = ANY (accounts);
  DELETE FROM survey_response r WHERE r.enrollment_id = ANY (accounts);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (accounts);
  DELETE FROM quiz_attempt t WHERE t.enrollment_id = ANY (accounts);
  DELETE FROM passport_stamp p WHERE p.enrollment_id = ANY (accounts);
  DELETE FROM quest_completion c WHERE c.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
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

-- As 0046, plus: the account's item misses are deleted (its reservations follow the pending-handover rule).
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
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
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
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
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
