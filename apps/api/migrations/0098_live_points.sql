-- Live points edits (T-604, FR-411, FR-412, FR-413, ADR-387): a quest's new points for future completions only, or also
-- for every kept past completion through compensating `adjust` entries (never an edit of a row), and a played quest's
-- delete that keeps or removes its points. Every points move is one INSERT INTO ledger_entry inside a definer door, in
-- the transaction of the fact it pays for; the triggers do the rest. Deny by default: the new table and columns carry no
-- grant, PUBLIC holds no EXECUTE on anything here, the three doors are granted to the API's role alone.
--
-- Lock order everywhere: event -> quest -> enrollment. Every door that writes a completion, a ledger row or a bulk row
-- naming a quest pins the quest (FOR KEY SHARE) before its enrollment lock; the past and delete doors take the quest
-- FOR UPDATE, so they wait for scans already holding it (and see them once committed: each statement takes a new
-- snapshot) and later scans wait and read the new points. Session check-in names no quest and is left as it is.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the data
-- One past-points change: who, which quest, from and to, and what it did. Written once, after its entries.
CREATE TABLE quest_points_change (
  id              uuid PRIMARY KEY,
  organizer_id    uuid NOT NULL,
  event_id        uuid NOT NULL,
  quest_id        uuid NOT NULL,
  staff_user_id   uuid NOT NULL,
  from_points     integer NOT NULL CHECK (from_points >= 0),
  to_points       integer NOT NULL CHECK (to_points >= 0),
  completions     integer NOT NULL CHECK (completions >= 0),
  players         integer NOT NULL CHECK (players >= 0),
  raised          integer NOT NULL CHECK (raised >= 0),
  lowered         integer NOT NULL CHECK (lowered >= 0),
  clamped         integer NOT NULL CHECK (clamped >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT,
  UNIQUE (event_id, staff_user_id, idempotency_key)
);
CREATE INDEX quest_points_change_quest_idx ON quest_points_change (quest_id);
ALTER TABLE quest_points_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_points_change FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_points_change FROM PUBLIC;
CREATE TRIGGER quest_points_change_no_update_or_delete BEFORE UPDATE OR DELETE ON quest_points_change
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER quest_points_change_no_truncate BEFORE TRUNCATE ON quest_points_change
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();

-- The `adjust` kind: one compensating entry per kept completion and change. Its change header is written after the
-- entries (the key is checked at commit). Signs are independent and one delta may be 0, never both (plan review MAJOR 1).
ALTER TABLE ledger_entry
  ADD COLUMN points_change_id uuid,
  ADD CONSTRAINT ledger_entry_points_change_fkey FOREIGN KEY (points_change_id) REFERENCES quest_points_change (id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal', 'bonus',
                  'community', 'first_bonus', 'streak', 'session', 'adjust')) NOT VALID;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_staff_kinds;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_staff_kinds
  CHECK (actor <> 'staff' OR kind IN ('quest', 'award', 'removal', 'adjust')) NOT VALID;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_adjust_shape
  CHECK ((kind = 'adjust') = (points_change_id IS NOT NULL)
         AND (kind <> 'adjust' OR (completion_id IS NOT NULL AND quest_id IS NOT NULL AND actor = 'staff'
                                   AND (score_delta <> 0 OR balance_delta <> 0) AND reverses IS NULL
                                   AND redemption_id IS NULL AND category_id IS NULL AND community_step_id IS NULL
                                   AND session_id IS NULL AND boost_id IS NULL))) NOT VALID;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_points_change_fkey;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_staff_kinds;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_adjust_shape;
CREATE UNIQUE INDEX ledger_entry_adjust_key ON ledger_entry (points_change_id, completion_id) WHERE kind = 'adjust';
CREATE INDEX ledger_entry_adjust_completion_idx ON ledger_entry (completion_id) WHERE kind = 'adjust';

-- A played quest is deleted by a mark: its completions, ledger and history name it. Hidden at once; nothing about it
-- changes afterwards (QX409), so every bulk change of live quests passes untouched.
ALTER TABLE quest
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by uuid,
  ADD CONSTRAINT quest_deleted_named CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
  ADD CONSTRAINT quest_deleted_hidden CHECK (deleted_at IS NULL OR NOT visible);

CREATE FUNCTION quest_deleted_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a deleted quest does not change' USING ERRCODE = 'QX409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_deleted_frozen() FROM PUBLIC;
CREATE TRIGGER quest_deleted_frozen BEFORE UPDATE ON quest
  FOR EACH ROW WHEN (OLD.deleted_at IS NOT NULL) EXECUTE FUNCTION quest_deleted_frozen();

-- ================================================================ the pin
-- The quest's KEY SHARE lock, taken before any enrollment lock by every door that pays or names it. Scans never block
-- each other or a plain builder edit; the past and delete doors (FOR UPDATE) wait for them.
CREATE FUNCTION pin_quest(target uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM quest q WHERE q.id = target FOR KEY SHARE;
END $$;
REVOKE ALL ON FUNCTION pin_quest(uuid) FROM PUBLIC;

-- ================================================================ removals
-- What removing an entry takes back before the clamp: a quest entry with every adjust of its completion folded in
-- (score and balance on their own), any other entry its own amounts.
CREATE FUNCTION removal_nets(credit ledger_entry, OUT score bigint, OUT balance bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT credit.score_delta + coalesce(sum(a.score_delta), 0), credit.balance_delta + coalesce(sum(a.balance_delta), 0)
  FROM ledger_entry a
  WHERE credit.kind = 'quest' AND a.kind = 'adjust' AND a.completion_id = credit.completion_id;
$$;
REVOKE ALL ON FUNCTION removal_nets(ledger_entry) FROM PUBLIC;

-- The one way to write a removal (remove_award and the quest delete): the entry and its folded adjusts, clamped at the
-- player's score and balance (FR-1601), a note, the approved submission marked removed, a reserved quest item cancelled.
-- The caller holds the enrollment's lock. Answers the removal's id and what it took.
CREATE FUNCTION write_removal(ev event, credit ledger_entry, why text, me uuid,
                              OUT made bigint, OUT took_score bigint, OUT took_balance bigint, OUT given redemption)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  nets     record;
BEGIN
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = credit.enrollment_id;
  nets := removal_nets(credit);
  took_score := greatest(least(nets.score, enrolled.score), 0);
  took_balance := greatest(least(nets.balance, enrolled.balance), 0);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, category_id, community_step_id, actor, staff_user_id, reverses, boost_id,
                            session_id)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -took_score, -took_balance, credit.completion_id,
          credit.quest_id, credit.category_id, credit.community_step_id, 'staff', me, credit.id, credit.boost_id,
          credit.session_id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  IF credit.kind = 'quest' THEN
    UPDATE submission s SET status = 'removed', reason = why, removed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.completion_id = credit.completion_id AND s.status = 'approved';
  END IF;
  given := credit_item(credit);
  IF given.status = 'reserved' THEN
    PERFORM end_reservation(given.id, 'cancelled', 'removal', 'staff', NULL);
    given := credit_item(credit);
  END IF;
END $$;
REVOKE ALL ON FUNCTION write_removal(event, ledger_entry, text, uuid) FROM PUBLIC;

-- Restated from 0093: the removal goes through write_removal, the quest is pinned before the enrollment, and a quest
-- entry's reserved-prize check (AO409) weighs its folded adjusts.
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean, item text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
  given    redemption%ROWTYPE;
  nets     record;
  taken    record;
  why      text;
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

  -- The event first, then the quest, then the enrollment (confirm_results takes the event FOR UPDATE).
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
  END IF;
  why := clean_reason(reason);
  SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = target_entry AND l.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such entry in this event' USING ERRCODE = 'AE404';
  END IF;
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus', 'streak', 'session') THEN
    RAISE EXCEPTION 'only an award can be removed' USING ERRCODE = 'AT422';
  END IF;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  IF (CASE WHEN credit.rehearsal THEN st NOT IN ('draft', 'scheduled') ELSE st NOT IN ('live', 'ended') END) THEN
    RAISE EXCEPTION 'the event is not live or ended' USING ERRCODE = 'AS409';
  END IF;
  IF credit.quest_id IS NOT NULL THEN
    PERFORM pin_quest(credit.quest_id);
  END IF;
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = credit.enrollment_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM ledger_entry l WHERE l.reverses = credit.id AND l.kind = 'removal') THEN
    RAISE EXCEPTION 'already removed' USING ERRCODE = 'AD409';
  END IF;
  nets := removal_nets(credit);
  IF (least(nets.score, enrolled.score) < nets.score OR least(nets.balance, enrolled.balance) < nets.balance)
     AND EXISTS (SELECT 1 FROM redemption d
                 WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved' AND d.price > 0) THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  taken := write_removal(ev, credit, why, me);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, taken.made);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', taken.made, 'score', enrolled.score - taken.took_score,
                             'balance', enrolled.balance - taken.took_balance, 'item', credit_item_state(taken.given)),
          request);
  PERFORM ranking_repair_mark(ev.id);
  RETURN QUERY SELECT taken.made, -taken.took_score, -taken.took_balance, false, credit_item_state(taken.given);
END $$;

-- ================================================================ past points
-- The types paid `quest.points × the boost's multiplier` once per completion (plan review MINOR: passport and meet in).
CREATE FUNCTION past_points_type(quest_type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT quest_type IN ('scan_qr', 'enter_code', 'location', 'vote', 'survey', 'share', 'challenge', 'passport', 'meet');
$$;
REVOKE ALL ON FUNCTION past_points_type(text) FROM PUBLIC;

-- Every kept real completion of the quest by an active member, with its nets and its targets at `points`: the score
-- target is points × the multiplier of its entry's boost; the balance target the same when the entry credited the
-- balance, else 0 (paid while the shop was closed). In the members' current score_version order, then completion id,
-- so writing in this order keeps tied players in their order (ADR-118).
CREATE FUNCTION past_points_rows(target uuid, points integer)
  RETURNS TABLE (completion_id bigint, enrollment_id uuid, net_score bigint, net_balance bigint, target_score bigint,
                 target_balance bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT c.id, c.enrollment_id,
         l.score_delta + coalesce(adj.score, 0), l.balance_delta + coalesce(adj.balance, 0),
         points::bigint * coalesce(b.multiplier, 1),
         CASE WHEN l.balance_delta = l.score_delta THEN points::bigint * coalesce(b.multiplier, 1) ELSE 0 END
  FROM quest_completion c
  JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
  JOIN enrollment n ON n.id = c.enrollment_id AND n.status = 'active'
  LEFT JOIN boost b ON b.id = l.boost_id
  LEFT JOIN LATERAL (SELECT sum(a.score_delta) AS score, sum(a.balance_delta) AS balance FROM ledger_entry a
                     WHERE a.kind = 'adjust' AND a.completion_id = c.id) adj ON true
  WHERE c.quest_id = target AND NOT l.rehearsal
    AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = l.id AND r.kind = 'removal')
  ORDER BY n.score_version, c.id;
$$;
REVOKE ALL ON FUNCTION past_points_rows(uuid, integer) FROM PUBLIC;

-- The quest of a live event for the past and delete doors, after the event's KEY SHARE and the results check, locked
-- FOR UPDATE. AQ404 for a quest outside the event or deleted.
CREATE FUNCTION edited_quest(ev event, target_quest uuid) RETURNS quest
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  found_row quest%ROWTYPE;
BEGIN
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'live' THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'AS409';
  END IF;
  SELECT q.* INTO found_row FROM quest q
  WHERE q.id = target_quest AND q.event_id = ev.id AND q.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  RETURN found_row;
END $$;
REVOKE ALL ON FUNCTION edited_quest(event, uuid) FROM PUBLIC;

-- What each kept completion still needs to reach its targets, in the rows' order: a raise of the balance while the
-- shop is closed now writes 0 balance (as pay_completion).
CREATE FUNCTION past_points_wanted(target uuid, points integer, shop_shut boolean)
  RETURNS TABLE (ord bigint, completion_id bigint, enrollment_id uuid, ds bigint, db bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT r.ord, r.completion_id, r.enrollment_id, r.target_score - r.net_score,
         CASE WHEN shop_shut THEN least(r.target_balance - r.net_balance, 0)
              ELSE r.target_balance - r.net_balance END
  FROM past_points_rows(target, points) WITH ORDINALITY
       AS r(completion_id, enrollment_id, net_score, net_balance, target_score, target_balance, ord);
$$;
REVOKE ALL ON FUNCTION past_points_wanted(uuid, integer, boolean) FROM PUBLIC;

-- Makes every kept completion of the quest worth its points now (as written by this transaction) times its boost: one
-- `adjust` per completion whose clamped deltas are not both 0. A lowering never takes the score or the balance below
-- zero (each on its own; a player whose lowerings exceed either is written entry by entry, reading the score again). An
-- editor's raise per completion stays within award_cap_each (AC409 each; owners pass). At most `batch_limit` entries a
-- call (`more` when some are left; the API calls again in the same transaction, each call under the statement timeout:
-- about 1 ms an entry, ADR-387). Idempotent by key (AK422 for the same key with another quest or points); a run with a
-- new key finds the nets at target and writes nothing. Audited `quest.points_past`.
CREATE FUNCTION apply_past_points(target_event uuid, target_quest uuid, from_points integer, request_key text,
                                  request uuid, batch_limit integer DEFAULT 2000)
  RETURNS TABLE (change_id uuid, completions integer, players integer, raised integer, lowered integer,
                 clamped integer, replayed boolean, more boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  me        uuid := app_staff_user_id();
  earlier   quest_points_change%ROWTYPE;
  quest_row quest%ROWTYPE;
  made      uuid := gen_random_uuid();
  shop_shut boolean;
  unsafe    uuid[];
  item      record;
  cur       record;
  ds        bigint;
  db        bigint;
  n_done    integer := 0;
  n_players integer := 0;
  n_up      integer := 0;
  n_down    integer := 0;
  n_short   integer := 0;
  left_over boolean := false;
  shorted   uuid;
  wrote     boolean;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT k.* INTO earlier FROM quest_points_change k
  WHERE k.event_id = ev.id AND k.staff_user_id = me AND k.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.quest_id <> target_quest
       OR earlier.to_points IS DISTINCT FROM (SELECT q.points FROM quest q WHERE q.id = target_quest) THEN
      RAISE EXCEPTION 'this key was used for another change' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.completions, earlier.players, earlier.raised, earlier.lowered,
                        earlier.clamped, true, false;
    RETURN;
  END IF;
  quest_row := edited_quest(ev, target_quest);
  IF NOT past_points_type(quest_row.type) THEN
    RAISE EXCEPTION 'this type pays its own amounts' USING ERRCODE = 'PX422', DETAIL = quest_row.type;
  END IF;
  shop_shut := shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed';
  IF NOT app_is_owner(ev.organizer_id)
     AND EXISTS (SELECT 1 FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w WHERE w.ds > ev.award_cap_each) THEN
    RAISE EXCEPTION 'over the cap per award' USING ERRCODE = 'AC409', DETAIL = 'each',
      HINT = ev.award_cap_each || ',' || ev.award_cap_day;
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id IN (SELECT w.enrollment_id FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w)
  ORDER BY n.id FOR NO KEY UPDATE;

  -- A player whose lowerings together exceed their score or balance is clamped entry by entry below; everyone else
  -- is written in one statement, at most `batch_limit` entries a call (the API calls again while `more`).
  unsafe := ARRAY(
    SELECT w.enrollment_id FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w JOIN enrollment n ON n.id = w.enrollment_id
    GROUP BY w.enrollment_id, n.score, n.balance
    HAVING -sum(least(w.ds, 0)) > n.score OR -sum(least(w.db, 0)) > n.balance);
  WITH chosen AS (
    SELECT w.* FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w
    WHERE w.enrollment_id <> ALL (unsafe) AND (w.ds <> 0 OR w.db <> 0)
    ORDER BY w.ord LIMIT greatest(coalesce(batch_limit, 2000), 1)
  ),
  written AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                              quest_id, actor, staff_user_id, points_change_id)
    SELECT ev.organizer_id, ev.id, c.enrollment_id, 'adjust', c.ds, c.db, c.completion_id, quest_row.id, 'staff', me,
           made
    FROM chosen c ORDER BY c.ord
    RETURNING enrollment_id, score_delta, balance_delta
  )
  SELECT count(*), count(DISTINCT w.enrollment_id),
         count(*) FILTER (WHERE w.score_delta > 0 OR (w.score_delta = 0 AND w.balance_delta > 0)),
         count(*) FILTER (WHERE w.score_delta < 0 OR (w.score_delta = 0 AND w.balance_delta < 0))
  INTO n_done, n_players, n_up, n_down
  FROM written w;
  -- Read after the write (a new snapshot): what is still away from its target.
  left_over := EXISTS (SELECT 1 FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w
                       WHERE w.enrollment_id <> ALL (unsafe) AND (w.ds <> 0 OR w.db <> 0));

  FOREACH shorted IN ARRAY unsafe LOOP
    n_short := n_short + 1;
    wrote := false;
    FOR item IN SELECT w.* FROM past_points_wanted(quest_row.id, quest_row.points, shop_shut) w WHERE w.enrollment_id = shorted ORDER BY w.ord LOOP
      SELECT n.score, n.balance INTO cur FROM enrollment n WHERE n.id = shorted;
      ds := greatest(item.ds, -cur.score);
      db := greatest(item.db, -cur.balance);
      CONTINUE WHEN ds = 0 AND db = 0;
      INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                completion_id, quest_id, actor, staff_user_id, points_change_id)
      VALUES (ev.organizer_id, ev.id, shorted, 'adjust', ds, db, item.completion_id, quest_row.id, 'staff', me, made);
      n_done := n_done + 1;
      wrote := true;
      n_up := n_up + CASE WHEN ds > 0 OR (ds = 0 AND db > 0) THEN 1 ELSE 0 END;
      n_down := n_down + CASE WHEN ds < 0 OR (ds = 0 AND db < 0) THEN 1 ELSE 0 END;
    END LOOP;
    n_players := n_players + CASE WHEN wrote THEN 1 ELSE 0 END;
  END LOOP;

  INSERT INTO quest_points_change (id, organizer_id, event_id, quest_id, staff_user_id, from_points, to_points,
                                   completions, players, raised, lowered, clamped, idempotency_key, request_id)
  VALUES (made, ev.organizer_id, ev.id, quest_row.id, me, greatest(coalesce(from_points, 0), 0), quest_row.points,
          n_done, n_players, n_up, n_down, n_short, request_key, request);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'quest.points_past', 'quest', quest_row.id::text,
          jsonb_build_object('points', greatest(coalesce(from_points, 0), 0)),
          jsonb_build_object('points', quest_row.points, 'change', made, 'completions', n_done, 'players', n_players,
                             'raised', n_up, 'lowered', n_down, 'clamped', n_short),
          request);
  IF n_done > 0 THEN
    PERFORM ranking_repair_mark(ev.id);
  END IF;
  RETURN QUERY SELECT made, n_done, n_players, n_up, n_down, n_short, false, left_over;
END $$;
REVOKE ALL ON FUNCTION apply_past_points(uuid, uuid, integer, text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_past_points(uuid, uuid, integer, text, uuid, integer) TO questify_app;

-- The real numbers for the edit screen (FR-413, FR-1032), read only: whether "also past" applies to the type, the kept
-- completions and players it would reach at `points`, how many would rise or fall, the players a lowering would clamp,
-- and the rank prizes already handed over (they are not taken back).
CREATE FUNCTION quest_points_impact(target_event uuid, target_quest uuid, points integer)
  RETURNS TABLE (eligible boolean, completions integer, players integer, raise integer, lower integer,
                 clamped integer, prizes_handed integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  quest_row quest%ROWTYPE;
BEGIN
  IF points IS NULL OR points < 0 OR points > 100000 THEN
    RAISE EXCEPTION 'points of 0 to 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT q.* INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id AND q.deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  RETURN QUERY
  WITH rows AS (SELECT * FROM past_points_rows(quest_row.id, points)),
  per_player AS (
    SELECT r.enrollment_id, sum(least(r.target_score - r.net_score, 0)) AS down_score,
           sum(least(r.target_balance - r.net_balance, 0)) AS down_balance
    FROM rows r GROUP BY r.enrollment_id
  )
  SELECT past_points_type(quest_row.type),
         (SELECT count(*)::integer FROM rows),
         (SELECT count(DISTINCT r.enrollment_id)::integer FROM rows r),
         (SELECT count(*)::integer FROM rows r WHERE r.target_score > r.net_score),
         (SELECT count(*)::integer FROM rows r WHERE r.target_score < r.net_score),
         (SELECT count(*)::integer FROM per_player p JOIN enrollment n ON n.id = p.enrollment_id
          WHERE -p.down_score > n.score OR -p.down_balance > n.balance),
         (SELECT count(*)::integer FROM redemption d
          WHERE d.event_id = ev.id AND d.rank_prize_id IS NOT NULL AND d.ended_by = 'handover');
END $$;
REVOKE ALL ON FUNCTION quest_points_impact(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_points_impact(uuid, uuid, integer) TO questify_app;

-- ================================================================ delete keep or remove
-- Deletes a played quest by a mark (FR-412): hidden at once and frozen, its pause and skip cleared, the Up next pin
-- cleared when it named it. With `remove`, every kept real quest and first-N bonus entry of it, any enrollment status, is
-- removed through write_removal (a quest entry with its folded adjusts) in score_version order. Category bonuses and
-- streak days already paid stay (Q-354). Audited `quest.delete`. A retry finds the quest deleted (AQ404).
CREATE FUNCTION delete_played_quest(target_event uuid, target_quest uuid, remove boolean, reason text, request uuid)
  RETURNS TABLE (removed integer, total bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  me        uuid := app_staff_user_id();
  quest_row quest%ROWTYPE;
  why       text;
  credit    ledger_entry%ROWTYPE;
  taken     record;
  n_gone    integer := 0;
  sum_gone  bigint := 0;
BEGIN
  IF remove IS NULL THEN
    RAISE EXCEPTION 'keep or remove is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  quest_row := edited_quest(ev, target_quest);
  why := clean_reason(coalesce(reason, 'quest deleted'));
  IF remove THEN
    PERFORM 1 FROM enrollment n
    WHERE n.id IN (SELECT l.enrollment_id FROM ledger_entry l
                   WHERE l.quest_id = quest_row.id AND l.kind IN ('quest', 'first_bonus') AND NOT l.rehearsal)
    ORDER BY n.id FOR NO KEY UPDATE;
    FOR credit IN
      SELECT l.* FROM ledger_entry l JOIN enrollment n ON n.id = l.enrollment_id
      WHERE l.quest_id = quest_row.id AND l.kind IN ('quest', 'first_bonus') AND NOT l.rehearsal
        AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = l.id AND r.kind = 'removal')
      ORDER BY n.score_version, l.id
    LOOP
      taken := write_removal(ev, credit, why, me);
      n_gone := n_gone + 1;
      sum_gone := sum_gone + taken.took_score;
    END LOOP;
  END IF;
  UPDATE quest q
  SET deleted_at = date_trunc('milliseconds', now()), deleted_by = me, visible = false,
      paused_at = NULL, paused_by = NULL, skipped_at = NULL, skipped_by = NULL
  WHERE q.id = quest_row.id;
  UPDATE event e SET focus_quest_id = NULL WHERE e.id = ev.id AND e.focus_quest_id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'quest.delete', 'quest', quest_row.id::text,
          jsonb_build_object('title', jsonb_build_object('ar', quest_row.title_ar, 'en', quest_row.title_en),
                             'points', quest_row.points),
          jsonb_build_object('points', CASE WHEN remove THEN 'remove' ELSE 'keep' END, 'removed', n_gone,
                             'total', sum_gone),
          request);
  IF n_gone > 0 THEN
    PERFORM ranking_repair_mark(ev.id);
  END IF;
  RETURN QUERY SELECT n_gone, sum_gone;
END $$;
REVOKE ALL ON FUNCTION delete_played_quest(uuid, uuid, boolean, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_played_quest(uuid, uuid, boolean, text, uuid) TO questify_app;

-- The caller's own past-points change under this key (its batches `key#2`, `key#3` summed), for the PATCH's replay before
-- it writes anything (plan review MINOR): none when the key is new.
CREATE FUNCTION past_points_replay(target_event uuid, request_key text)
  RETURNS TABLE (change_id uuid, quest_id uuid, to_points integer, completions integer, players integer,
                 raised integer, lowered integer, clamped integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT (array_agg(k.id ORDER BY k.created_at, k.id))[1], (array_agg(k.quest_id))[1], (array_agg(k.to_points))[1],
         sum(k.completions)::integer, sum(k.players)::integer, sum(k.raised)::integer, sum(k.lowered)::integer,
         sum(k.clamped)::integer
  FROM quest_points_change k
  WHERE k.event_id = ev.id AND k.staff_user_id = app_staff_user_id()
    AND (k.idempotency_key = request_key OR k.idempotency_key LIKE request_key || '#%')
  HAVING count(*) > 0;
END $$;
REVOKE ALL ON FUNCTION past_points_replay(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION past_points_replay(uuid, text) TO questify_app;

-- Restated from 0062: the first read of the quest takes its KEY SHARE, before the enrollment lock (the pin).
CREATE OR REPLACE FUNCTION public.record_completion(target uuid, who uuid, proof_method text, proof_version integer, typed_code text, request_key text, device uuid, operator uuid, staff uuid, reason text, expected_event uuid, reading jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  quest_row      quest%ROWTYPE;
  enrolled       enrollment%ROWTYPE;
  earlier        quest_completion%ROWTYPE;
  earlier_by     uuid;
  earlier_staff  uuid;
  lifetime_count integer;
  made           bigint;
  entry          bigint;
  boosted        boost%ROWTYPE;
  paid           bigint;
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%'
     OR request_key LIKE 'meet:%' OR request_key LIKE 'game:%' THEN
    RAISE EXCEPTION 'this key is reserved' USING ERRCODE = 'QK422';
  END IF;
  -- A `kiosk:` key is the kiosk door's alone, and the kiosk method takes no other key (ADR-244).
  IF (coalesce(request_key, '') LIKE 'kiosk:%') IS DISTINCT FROM (proof_method = 'kiosk') THEN
    RAISE EXCEPTION 'this key is reserved' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target FOR KEY SHARE;
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
  -- Read again after the wipe: a rehearsal launch of this flash quest is a draft again.
  SELECT * INTO quest_row FROM quest WHERE id = target;

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
            OR (quest_row.type = 'scan_qr' AND proof_method = 'nfc' AND 'nfc' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'screen_qr'
                AND 'screen_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'kiosk' AND 'kiosk' = ANY (quest_row.verification))
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
    IF proof_method IN ('screen_qr', 'kiosk') AND NOT screen_window_ok(proof_version, now()) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'expired';
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
  -- One pay per player per screen window (CTO 6), read under the enrollment lock taken above; a live code likewise,
  -- each method on its own (the first condition keeps quest_completion_window_idx usable).
  IF proof_method IN ('screen_qr', 'kiosk') AND EXISTS (
    SELECT 1 FROM quest_completion c
    WHERE c.enrollment_id = enrolled.id AND c.quest_id = target AND c.method IN ('screen_qr', 'kiosk')
      AND c.method = proof_method
      AND c.created_at > now() - interval '45 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  -- Both counts are read under the enrollment lock taken above.
  IF period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;
  SELECT count(*) INTO lifetime_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  PERFORM lock_quest_items(quest_row);
  -- Staff award the quest's own points: a manual award is never boosted (ADR-232).
  IF proof_method <> 'manual' THEN
    boosted := quest_boost(quest_row, enrolled, now());
  END IF;
  paid := quest_row.points::bigint * coalesce(boosted.multiplier, 1);

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id, boost_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', paid, paid, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff, boosted.id)
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
  PERFORM pay_first_bonus(enrolled, target, made, request_key);

  RETURN QUERY SELECT made, paid, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$
;


-- Restated from 0032: a quest award pins the quest before the enrollment lock.
CREATE OR REPLACE FUNCTION public.grant_manual_award(ev event, target_enrollment uuid, target_quest uuid, amount integer, reason text, request_key text, operator uuid, staff uuid, capped boolean)
 RETURNS TABLE(entry_id bigint, points bigint, replayed boolean)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  enrolled  enrollment%ROWTYPE;
  quest_row quest%ROWTYPE;
  earlier   manual_award_key%ROWTYPE;
  worth     bigint;
  used      bigint;
  why       text;
  made      bigint;
  done      record;
BEGIN
  IF (target_quest IS NULL) = (amount IS NULL) THEN
    RAISE EXCEPTION 'award a quest or an amount' USING ERRCODE = 'AP400';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);

  IF amount IS NOT NULL THEN
    SELECT k.* INTO earlier FROM manual_award_key k
    WHERE k.event_id = ev.id AND k.idempotency_key = request_key
      AND k.operator_id IS NOT DISTINCT FROM operator AND k.staff_user_id IS NOT DISTINCT FROM staff;
    IF FOUND THEN
      IF earlier.kind <> 'award' OR earlier.enrollment_id <> target_enrollment OR earlier.amount <> amount THEN
        RAISE EXCEPTION 'this key was used for another award' USING ERRCODE = 'AK422';
      END IF;
      RETURN QUERY SELECT earlier.entry_id, earlier.amount, true;
      RETURN;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  ELSIF EXISTS (SELECT 1 FROM quest_completion c
                WHERE c.enrollment_id = target_enrollment AND c.idempotency_key = request_key) THEN
    SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = target_enrollment AND n.event_id = ev.id;
    SELECT * INTO done FROM record_completion(target_quest, enrolled.player_id, 'manual', NULL, NULL, request_key, NULL,
                                              operator, staff, reason, ev.id);
    RETURN QUERY SELECT l.id, done.points, done.replayed FROM ledger_entry l
      WHERE l.completion_id = done.completion_id AND l.kind = 'quest';
    RETURN;
  END IF;

  why := clean_reason(reason);
  IF target_quest IS NOT NULL THEN
    PERFORM pin_quest(target_quest);
  END IF;
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = target_enrollment AND n.event_id = ev.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such player in this event' USING ERRCODE = 'QC404';
  END IF;
  IF operator IS NOT NULL AND enrolled.player_id = operator THEN
    RAISE EXCEPTION 'an operator cannot award themselves' USING ERRCODE = 'AY409';
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  IF play_phase(ev, enrolled) IS NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;

  IF target_quest IS NOT NULL THEN
    SELECT q.* INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
    END IF;
    worth := quest_row.points;
  ELSE
    IF amount NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'an amount of 1 to 100000 points' USING ERRCODE = 'AP400';
    END IF;
    worth := amount;
  END IF;

  IF capped THEN
    used := awarded_today(ev, operator, staff);
    IF worth > ev.award_cap_each THEN
      RAISE EXCEPTION 'over the cap per award' USING ERRCODE = 'AC409', DETAIL = 'each',
        HINT = ev.award_cap_each || ',' || greatest(ev.award_cap_day - used, 0);
    END IF;
    IF used + worth > ev.award_cap_day THEN
      RAISE EXCEPTION 'over the daily cap' USING ERRCODE = 'AC409', DETAIL = 'day',
        HINT = ev.award_cap_day || ',' || greatest(ev.award_cap_day - used, 0);
    END IF;
  END IF;

  IF target_quest IS NOT NULL THEN
    SELECT * INTO done FROM record_completion(target_quest, enrolled.player_id, 'manual', NULL, NULL, request_key, NULL,
                                              operator, staff, why, ev.id);
    RETURN QUERY SELECT l.id, done.points, done.replayed FROM ledger_entry l
      WHERE l.completion_id = done.completion_id AND l.kind = 'quest';
  ELSE
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              operator_id, staff_user_id)
    VALUES (ev.organizer_id, ev.id, enrolled.id, 'award', worth, worth,
            CASE WHEN operator IS NOT NULL THEN 'operator' ELSE 'staff' END, operator, staff)
    RETURNING id INTO made;
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
    INSERT INTO manual_award_key (event_id, operator_id, staff_user_id, idempotency_key, kind, enrollment_id, amount,
                                  entry_id)
    VALUES (ev.id, operator, staff, request_key, 'award', enrolled.id, worth, made);
    RETURN QUERY SELECT made, worth, false;
  END IF;
  PERFORM mark_ranking_repair(ev.id);
END $$
;


-- Restated from 0093: a bulk award naming a quest pins it before the enrollment locks.
CREATE OR REPLACE FUNCTION public.bulk_award(target_event uuid, enrollments uuid[], target_quest uuid, target_session uuid, amount integer, reason text, request_key text, request uuid)
 RETURNS TABLE(bulk_id uuid, awarded integer, skipped integer, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev         event := award_event_of(target_event);
  me         uuid := app_staff_user_id();
  earlier    bulk_award%ROWTYPE;
  why        text;
  asked      integer;
  candidates uuid[];
  targets    uuid[];
  made       uuid;
  got        integer;
  st         text;
  rehearsing boolean;
BEGIN
  IF num_nonnulls(enrollments, target_quest, target_session) <> 1 OR coalesce(cardinality(enrollments), 0) > 2000 THEN
    RAISE EXCEPTION 'a list of at most 2000 members, a quest or a session' USING ERRCODE = 'AB400';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  asked := coalesce(cardinality(enrollments), 0);
  SELECT b.* INTO earlier FROM bulk_award b
  WHERE b.event_id = ev.id AND b.staff_user_id = me AND b.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.amount IS DISTINCT FROM amount OR earlier.quest_id IS DISTINCT FROM target_quest
       OR earlier.session_id IS DISTINCT FROM target_session OR earlier.requested IS DISTINCT FROM asked THEN
      RAISE EXCEPTION 'this key was used for another bulk award' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.awarded, earlier.skipped, true;
    RETURN;
  END IF;

  why := clean_reason(reason);
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'an amount of 1 to 100000 points' USING ERRCODE = 'AP400';
  END IF;
  IF NOT app_is_owner(ev.organizer_id) AND amount > ev.award_cap_each THEN
    RAISE EXCEPTION 'over the cap per award' USING ERRCODE = 'AC409', DETAIL = 'each',
      HINT = ev.award_cap_each || ',' || ev.award_cap_day;
  END IF;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  rehearsing := st IN ('draft', 'scheduled');
  IF NOT rehearsing AND st <> 'live' THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF target_quest IS NOT NULL THEN
  PERFORM pin_quest(target_quest);
    IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
    END IF;
    candidates := ARRAY(SELECT quest_bulk_targets(ev, target_quest));
  ELSIF target_session IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id) THEN
      RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
    END IF;
    candidates := ARRAY(SELECT session_bulk_targets(ev, target_session));
  ELSE
    candidates := enrollments;
  END IF;
  IF rehearsing AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.id = ANY (candidates) AND n.event_id = ev.id
                                                            AND n.joined_via = 'rehearsal') THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = ANY (candidates) AND n.event_id = ev.id ORDER BY n.id FOR NO KEY UPDATE;
  targets := ARRAY(SELECT bulk_award_eligible(ev, candidates, rehearsing));

  INSERT INTO bulk_award (organizer_id, event_id, staff_user_id, amount, reason, quest_id, session_id, requested,
                          awarded, skipped, idempotency_key, rehearsal)
  VALUES (ev.organizer_id, ev.id, me, amount, why, target_quest, target_session, asked, cardinality(targets),
          greatest(asked - cardinality(targets), 0), request_key, rehearsing)
  RETURNING id INTO made;
  WITH entries AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              staff_user_id)
    SELECT ev.organizer_id, ev.id, t.id, 'award', amount, amount, 'staff', me FROM unnest(targets) AS t(id)
    RETURNING id
  )
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, bulk_id)
  SELECT entries.id, ev.organizer_id, ev.id, made FROM entries;
  GET DIAGNOSTICS got = ROW_COUNT;

  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.bulk_award', 'bulk_award', made::text,
          jsonb_build_object('amount', amount, 'quest', target_quest, 'session', target_session, 'awarded', got),
          request);
  PERFORM ranking_repair_mark(ev.id);
  RETURN QUERY SELECT made, got, greatest(asked - got, 0), false;
END $$
;


-- Restated from 0097: the quest is pinned after the wipe, before the enrollment lock.
CREATE OR REPLACE FUNCTION public.play_enter(quest_row quest, wanted text)
 RETURNS enrollment
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  me       uuid := app_player_id();
  enrolled enrollment%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  PERFORM pin_quest(quest_row.id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.type <> wanted THEN
    RAISE EXCEPTION 'not this kind of quest' USING ERRCODE = 'QT422', DETAIL = wanted;
  END IF;
  PERFORM quest_open_check(quest_row, enrolled, false, quest_row.type = 'quiz' AND EXISTS (
    SELECT 1 FROM quiz_attempt a
    WHERE a.enrollment_id = enrolled.id AND a.quest_id = quest_row.id AND a.status = 'open'));
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN enrolled;
END $$
;


-- Restated from 0045: the quest is pinned after the wipe, before the enrollment lock.
CREATE OR REPLACE FUNCTION public.submit_quest(target uuid, body text, guidelines text, request_key text)
 RETURNS TABLE(submission_id bigint, status text, points integer, completion_id bigint, score bigint, balance bigint, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  earlier    submission%ROWTYPE;
  made       submission%ROWTYPE;
  cleaned    text;
  done_count integer;
  paid       bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key LIKE 'sub:%'
     OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  PERFORM pin_quest(quest_row.id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  cleaned := clean_submission_text(body);

  SELECT * INTO earlier FROM submission s WHERE s.enrollment_id = enrolled.id AND s.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.quest_id <> target OR earlier.body IS DISTINCT FROM cleaned THEN
      RAISE EXCEPTION 'this key was used for another submission' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.points, earlier.completion_id, n.score, n.balance, true
      FROM enrollment n WHERE n.id = enrolled.id;
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled);
  IF quest_row.type <> 'submission' THEN
    RAISE EXCEPTION 'not a submission quest' USING ERRCODE = 'SQ422';
  END IF;
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  IF guidelines IS NULL OR NOT EXISTS (
    SELECT 1 FROM player_acceptance a
    WHERE a.player_id = me AND a.document = 'community_guidelines' AND a.version = guidelines) THEN
    RAISE EXCEPTION 'accept the community guidelines first' USING ERRCODE = 'SG403';
  END IF;
  IF EXISTS (SELECT 1 FROM submission s
             WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'pending') THEN
    RAISE EXCEPTION 'a submission is already waiting' USING ERRCODE = 'SP409';
  END IF;
  IF coalesce((quest_row.type_config ->> 'resubmit')::boolean, false) IS FALSE AND EXISTS (
    SELECT 1 FROM submission s
    WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'rejected' AND NOT s.reason_system) THEN
    RAISE EXCEPTION 'closed after a rejection' USING ERRCODE = 'QD409', DETAIL = 'closed';
  END IF;
  SELECT (SELECT count(*) FROM quest_completion c WHERE c.enrollment_id = enrolled.id AND c.quest_id = target)
         + (SELECT count(*) FROM submission s
            WHERE s.enrollment_id = enrolled.id AND s.quest_id = target AND s.status = 'pending')
  INTO done_count;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, auto, marked,
                          idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, 'text', cleaned, quest_row.points, 'pending',
          coalesce((quest_row.type_config ->> 'autoApprove')::boolean, false), text_marked(cleaned), request_key)
  RETURNING * INTO made;
  IF made.auto THEN
    paid := pay_submission(made, NULL, NULL);
    UPDATE submission s SET status = 'approved', completion_id = paid, reviewed_at = now()
    WHERE s.id = made.id RETURNING * INTO made;
  END IF;
  RETURN QUERY SELECT made.id, made.status, made.points, made.completion_id, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$
;


-- Restated from 0062: the passport quest is pinned after the wipe, before the enrollment lock.
CREATE OR REPLACE FUNCTION public.stamp_step(target uuid, proof_version integer, request_key text, device uuid)
 RETURNS TABLE(quest_id uuid, completion_id bigint, points bigint, stamped boolean, done integer, needed integer, score bigint, balance bigint, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  me        uuid := app_player_id();
  step_row  passport_step%ROWTYPE;
  quest_row quest%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  earlier   passport_stamp%ROWTYPE;
  wanted    integer;
  have      integer;
  paid      bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key LIKE 'sub:%'
     OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%' THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO step_row FROM passport_step s WHERE s.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = step_row.quest_id;
  IF quest_row.type <> 'passport' THEN
    RAISE EXCEPTION 'not a passport quest' USING ERRCODE = 'QT422', DETAIL = 'passport';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  PERFORM pin_quest(quest_row.id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = step_row.quest_id;
  wanted := (quest_row.type_config ->> 'needed')::integer;

  SELECT * INTO earlier FROM passport_stamp p WHERE p.enrollment_id = enrolled.id AND p.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.step_id <> target THEN
      RAISE EXCEPTION 'this key was used for another stamp' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT quest_row.id, earlier.completion_id,
                        (SELECT l.score_delta FROM ledger_entry l
                         WHERE l.completion_id = earlier.completion_id AND l.kind = 'quest'),
                        true,
                        (SELECT count(*)::int FROM passport_stamp p
                         WHERE p.enrollment_id = enrolled.id AND p.quest_id = quest_row.id),
                        wanted, n.score, n.balance, true
      FROM enrollment n WHERE n.id = enrolled.id;
    RETURN;
  END IF;

  PERFORM quest_open_check(quest_row, enrolled);
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = enrolled.event_id AND sa.player_id = me AND NOT sa.can_play)
  THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  IF EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = enrolled.id AND c.quest_id = quest_row.id) THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = '1';
  END IF;
  IF proof_version IS DISTINCT FROM step_row.qr_version THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
  END IF;
  SELECT count(*)::int INTO have FROM passport_stamp p
  WHERE p.enrollment_id = enrolled.id AND p.quest_id = quest_row.id;
  IF EXISTS (SELECT 1 FROM passport_stamp p WHERE p.enrollment_id = enrolled.id AND p.step_id = target) THEN
    -- A `needed` lowered while a stamp was in flight leaves the player at the count, unpaid (no completion: checked
    -- above). Re-scanning a stamped step pays then, on that stamp, which takes this key so a retry replays the payment.
    IF have >= wanted THEN
      paid := pay_completion(enrolled, quest_row.id, quest_row.points, 'passport', 'pass:' || quest_row.id, NULL, NULL,
                             NULL, now());
      UPDATE passport_stamp p SET completion_id = paid, idempotency_key = request_key
      WHERE p.enrollment_id = enrolled.id AND p.step_id = target;
      PERFORM pay_first_bonus(enrolled, quest_row.id, paid, 'pass:' || quest_row.id);
      RETURN QUERY SELECT quest_row.id, paid, l.score_delta, true, have, wanted, n.score, n.balance, false
        FROM enrollment n, ledger_entry l WHERE n.id = enrolled.id AND l.completion_id = paid AND l.kind = 'quest';
      RETURN;
    END IF;
    RETURN QUERY SELECT quest_row.id, NULL::bigint, NULL::bigint, false, have, wanted, enrolled.score, enrolled.balance,
                        false;
    RETURN;
  END IF;

  have := have + 1;
  IF have >= wanted THEN
    paid := pay_completion(enrolled, quest_row.id, quest_row.points, 'passport', 'pass:' || quest_row.id, NULL, NULL,
                           NULL, now());
  END IF;
  INSERT INTO passport_stamp (organizer_id, event_id, enrollment_id, quest_id, step_id, idempotency_key, device_id,
                              completion_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, quest_row.id, target, request_key, device, paid);
  IF paid IS NOT NULL THEN
    PERFORM pay_first_bonus(enrolled, quest_row.id, paid, 'pass:' || quest_row.id);
  END IF;
  RETURN QUERY SELECT quest_row.id, paid,
                      (SELECT l.score_delta FROM ledger_entry l WHERE l.completion_id = paid AND l.kind = 'quest'),
                      true, have, wanted, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$
;


-- Restated from 0055: an approval pins the submission's quest before the enrollment lock.
CREATE OR REPLACE FUNCTION public.review_core(ev event, target bigint, decision text, reason text, request_key text, operator uuid, staff uuid, request uuid)
 RETURNS TABLE(submission_id bigint, status text, points integer, replayed boolean, completion_id bigint, player_id uuid)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  earlier  submission%ROWTYPE;
  item     submission%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  why      text;
  st       text;
  paid     bigint;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'SK422';
  END IF;
  IF decision IS NULL OR decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'approve or reject' USING ERRCODE = 'SV422', DETAIL = 'decision';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT s.* INTO earlier FROM submission s
  WHERE s.event_id = ev.id AND s.review_key = request_key
    AND ((staff IS NOT NULL AND s.reviewed_by_staff = staff) OR (operator IS NOT NULL AND s.reviewed_by_operator = operator));
  IF FOUND THEN
    IF earlier.id <> target OR (decision = 'approve') <> (earlier.completion_id IS NOT NULL) THEN
      RAISE EXCEPTION 'this key was used for another review' USING ERRCODE = 'SK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.points, true, earlier.completion_id, n.player_id
                 FROM enrollment n WHERE n.id = earlier.enrollment_id;
    RETURN;
  END IF;

  PERFORM 1 FROM event e WHERE e.id = ev.id FOR KEY SHARE;
  SELECT s.* INTO item FROM submission s WHERE s.id = target AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such submission in this event' USING ERRCODE = 'SN404';
  END IF;
  IF operator IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM enrollment n WHERE n.id = item.enrollment_id AND n.player_id = operator) THEN
      RAISE EXCEPTION 'not your own submission' USING ERRCODE = 'SS403';
    END IF;
    IF NOT operator_reviews_quest(ev.id, operator, item.quest_id) THEN
      RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
    END IF;
  END IF;
  PERFORM pin_quest(item.quest_id);
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = item.enrollment_id FOR NO KEY UPDATE;
  SELECT s.* INTO item FROM submission s WHERE s.id = target FOR UPDATE;
  IF item.status <> 'pending' THEN
    RAISE EXCEPTION 'already reviewed' USING ERRCODE = 'SR409', DETAIL = item.status;
  END IF;

  IF decision = 'reject' THEN
    why := clean_reason(reason);
    UPDATE submission s
    SET status = 'rejected', reason = why, reviewed_by_staff = staff, reviewed_by_operator = operator,
        review_key = request_key, reviewed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.id = item.id;
  ELSE
    st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
    IF enrolled.status <> 'active'
       OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = enrolled.player_id AND p.status = 'active')
       OR (CASE WHEN enrolled.joined_via = 'rehearsal' THEN st NOT IN ('draft', 'scheduled')
                ELSE st NOT IN ('live', 'ended') END) THEN
      RAISE EXCEPTION 'this submission can no longer be approved' USING ERRCODE = 'SE409';
    END IF;
    IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
      RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
    END IF;
    paid := pay_submission(item, operator, staff);
    UPDATE submission s
    SET status = 'approved', completion_id = paid, reviewed_by_staff = staff, reviewed_by_operator = operator,
        review_key = request_key, reviewed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.id = item.id;
    PERFORM mark_ranking_repair(ev.id);
  END IF;
  IF staff IS NOT NULL THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('staff', staff, ev.organizer_id, ev.id,
            CASE WHEN decision = 'approve' THEN 'event.submission_approved' ELSE 'event.submission_rejected' END,
            'submission', item.id::text, jsonb_build_object('points', item.points), request);
  END IF;
  RETURN QUERY SELECT s.id, s.status, s.points, false, s.completion_id, enrolled.player_id
               FROM submission s WHERE s.id = item.id;
END $$
;


-- Restated: the tick's quiz sweep pins the quiz before the enrollment lock.
CREATE OR REPLACE FUNCTION public.finish_one_due_quiz()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  due     quiz_attempt%ROWTYPE;
  outcome text;
BEGIN
  IF NOT ranking_system() THEN
    RETURN NULL;
  END IF;
  FOR due IN SELECT a.* FROM quiz_attempt a WHERE a.status = 'open' ORDER BY a.id LOOP
    CONTINUE WHEN NOT quiz_due(due);
    PERFORM ensure_rehearsal_wiped(due.event_id);
    PERFORM 1 FROM event e WHERE e.id = due.event_id FOR KEY SHARE;
  PERFORM pin_quest(due.quest_id);
    PERFORM 1 FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    SELECT * INTO due FROM quiz_attempt a WHERE a.id = due.id FOR UPDATE;
    CONTINUE WHEN NOT FOUND OR NOT quiz_due(due);
    BEGIN
      UPDATE quiz_attempt a SET swept = true WHERE a.id = due.id RETURNING * INTO due;
      outcome := finish_quiz(due);
      IF outcome = 'paid' THEN
        PERFORM mark_ranking_repair(due.event_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE quiz_attempt a SET status = 'void', swept = true, finished_at = now() WHERE a.id = due.id;
      INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after)
      VALUES ('system', due.organizer_id, due.event_id, 'event.quiz_voided', 'quiz_attempt', due.id::text,
              jsonb_build_object('error', SQLSTATE));
      outcome := 'void';
    END;
    RETURN outcome;
  END LOOP;
  RETURN NULL;
END $$
;


-- Restated: the confirm's quiz sweep pins each quiz before its enrollment lock (event -> quest -> enrollment).
CREATE OR REPLACE FUNCTION public.confirm_results(target_event uuid, expected uuid[], request uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev  event := award_event_of(target_event);
  now_places uuid[];
  due        quiz_attempt%ROWTYPE;
  finished   boolean := false;
  pending    record;
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
  SELECT * INTO pending FROM community_pending(ev.id);
  IF pending.goals > 0 OR pending.due > 0 THEN
    RAISE EXCEPTION 'community rewards are still being paid' USING ERRCODE = 'RF409', DETAIL = 'community_paying',
      HINT = jsonb_build_object('goals', pending.goals, 'due', pending.due)::text;
  END IF;
  -- Quizzes still open pay what they earned before the places freeze (T-302); a change commits and is reported.
  FOR due IN SELECT a.* FROM quiz_attempt a WHERE a.event_id = ev.id AND a.status = 'open' ORDER BY a.id LOOP
  PERFORM pin_quest(due.quest_id);
    PERFORM 1 FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    SELECT * INTO due FROM quiz_attempt a WHERE a.id = due.id FOR UPDATE;
    CONTINUE WHEN due.status <> 'open';
    UPDATE quiz_attempt a SET swept = true WHERE a.id = due.id RETURNING * INTO due;
    finished := finish_quiz(due) = 'paid' OR finished;
  END LOOP;
  now_places := ARRAY(SELECT c.enrollment_id FROM current_places(ev) c ORDER BY c.rank);
  IF finished AND now_places <> expected THEN
    PERFORM mark_ranking_repair(ev.id);
    RETURN 'results_changed';
  END IF;
  IF now_places <> expected THEN
    RAISE EXCEPTION 'the places changed' USING ERRCODE = 'RF409', DETAIL = 'results_changed';
  END IF;

  INSERT INTO event_result (event_id, organizer_id, confirmed_by) VALUES (ev.id, ev.organizer_id, app_staff_user_id());
  WITH places AS MATERIALIZED (SELECT * FROM all_places(ev)),
  kept AS (
    INSERT INTO final_rank (event_id, enrollment_id, rank) SELECT ev.id, c.enrollment_id, c.rank FROM places c
  )
  INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version, open_flags, rank_prize_id)
  SELECT ev.id, c.rank, c.enrollment_id, c.score, c.score_version,
         (SELECT count(*) FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'),
         prize_for_rank(ev, c.rank)
  FROM places c
  WHERE c.rank <= result_depth(ev);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.results_confirmed', 'event', ev.id::text,
          jsonb_build_object('places', cardinality(now_places),
                             'flagged', (SELECT count(*) FROM result_place x WHERE x.event_id = ev.id AND x.open_flags > 0)),
          request);
  RETURN 'confirmed';
END $$
;


-- Restated from 0062: a round's end pins its quest before the enrollment lock.
CREATE OR REPLACE FUNCTION public.finish_game_round(target bigint, result_key text, given_verdict text, given_result jsonb, given_reason text, given_unlikely boolean, last_input_ms integer)
 RETURNS TABLE(verdict text, completion_id bigint, points bigint, score bigint, balance bigint, attempts_left integer, replayed boolean, result jsonb, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  me        uuid := app_player_id();
  played    game_round%ROWTYPE;
  earlier   game_round%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  quest_row quest%ROWTYPE;
  outcome   text := given_verdict;
  why       text := given_reason;
  paid      bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF finish_game_round.result_key IS NULL OR length(finish_game_round.result_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF outcome IS NULL OR outcome NOT IN ('passed', 'short', 'refused') OR (outcome = 'refused') <> (why IS NOT NULL)
     OR last_input_ms IS NULL OR last_input_ms < 0 THEN
    RAISE EXCEPTION 'not a verdict' USING ERRCODE = '22023';
  END IF;
  SELECT r.* INTO played FROM game_round r
  JOIN enrollment n ON n.id = r.enrollment_id AND n.player_id = me WHERE r.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO earlier FROM game_round r
  WHERE r.enrollment_id = played.enrollment_id AND r.result_key = finish_game_round.result_key;
  IF FOUND THEN
    IF earlier.id <> played.id THEN
      RAISE EXCEPTION 'this key was used for another round' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT * FROM game_answer(earlier, true);
    RETURN;
  END IF;

  PERFORM ensure_rehearsal_wiped(played.event_id);
  PERFORM pin_quest(played.quest_id);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = played.enrollment_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO played FROM game_round r WHERE r.id = played.id FOR UPDATE;
  -- The rehearsal wipe deleted it while this waited on the locks.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'round not found' USING ERRCODE = 'QC404';
  END IF;
  -- A duplicate that waited on the first result's locks answers it, never `finished`.
  IF played.result_key IS NOT DISTINCT FROM finish_game_round.result_key THEN
    RETURN QUERY SELECT * FROM game_answer(played, true);
    RETURN;
  END IF;
  IF played.status = 'expired' OR (played.status = 'open' AND played.deadline_at <= now()) THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'expired';
  END IF;
  IF played.status <> 'open' THEN
    RAISE EXCEPTION 'round over' USING ERRCODE = 'QG409', DETAIL = 'finished';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = played.quest_id;
  PERFORM meet_may_play(enrolled, quest_row);

  IF last_input_ms > floor(extract(epoch FROM now() - played.issued_at) * 1000) + 3000 THEN
    outcome := 'refused';
    why := 'clock';
  END IF;
  IF outcome = 'passed' AND period_count(enrolled.id, quest_row) = 0 THEN
    paid := pay_completion(enrolled, quest_row.id, played.points, 'game', 'game:' || played.id, NULL, NULL,
                           played.device_id, played.issued_at);
  END IF;
  UPDATE game_round r
  SET status = outcome, finished_at = now(), result_key = finish_game_round.result_key,
      result = CASE WHEN outcome = 'refused' THEN NULL ELSE given_result END,
      reason = CASE WHEN outcome = 'refused' THEN why END,
      unlikely = outcome <> 'refused' AND coalesce(given_unlikely, false), completion_id = paid
  WHERE r.id = played.id
  RETURNING * INTO played;
  IF outcome = 'refused' THEN
    PERFORM raise_game_flag(played, why);
  ELSIF outcome = 'passed' AND played.unlikely THEN
    PERFORM raise_game_flag(played, 'unlikely');
  END IF;
  IF outcome <> 'passed' THEN
    PERFORM game_last_attempt(enrolled, quest_row);
  END IF;
  IF paid IS NOT NULL THEN
    PERFORM pay_first_bonus(enrolled, quest_row.id, paid, 'game:' || played.id);
  END IF;
  RETURN QUERY SELECT * FROM game_answer(played, false);
END $$
;


-- Restated: a meeting pins its quest (and reads its points again under the pin) before the enrollment locks.
CREATE OR REPLACE FUNCTION public.meet_player(token_hash bytea, request_key text, device uuid, reading jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean, quest_id uuid, other_completion bigint, other_player uuid, other_username text, other_avatar text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  me        uuid := app_player_id();
  pass      meet_pass%ROWTYPE;
  quest_row quest%ROWTYPE;
  mine      enrollment%ROWTYPE;
  theirs    enrollment%ROWTYPE;
  met       meeting%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  pass := meet_pass_for(meet_player.token_hash);
  SELECT * INTO quest_row FROM quest q WHERE q.id = pass.quest_id;
  IF quest_row.type <> 'meet' THEN
    RAISE EXCEPTION 'not a meet code' USING ERRCODE = 'QM422', DETAIL = 'bad_code';
  END IF;
  IF NOT meet_on(pass.event_id) THEN
    RAISE EXCEPTION 'meet quests are off for this event' USING ERRCODE = 'QF403';
  END IF;
  SELECT * INTO mine FROM enrollment n WHERE n.event_id = pass.event_id AND n.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QM403', DETAIL = 'not_in_event';
  END IF;
  met := meet_replay(mine.id, meet_player.request_key, pass.id);
  IF met.id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM meet_answer(met, true);
    RETURN;
  END IF;
  IF pass.enrollment_id = mine.id THEN
    RAISE EXCEPTION 'own code' USING ERRCODE = 'QM422', DETAIL = 'self';
  END IF;
  IF device = pass.device_id THEN
    RAISE EXCEPTION 'same device' USING ERRCODE = 'QM422', DETAIL = 'same_device';
  END IF;
  IF pass.expires_at <= now() THEN
    RAISE EXCEPTION 'code expired' USING ERRCODE = 'QM422', DETAIL = 'expired';
  END IF;

  -- ADR-211: the rehearsal row shared, both enrollments in one id-ordered statement, then the code.
  PERFORM ensure_rehearsal_wiped(pass.event_id);
  SELECT * INTO quest_row FROM quest q WHERE q.id = pass.quest_id FOR KEY SHARE;
  PERFORM 1 FROM enrollment n WHERE n.id IN (mine.id, pass.enrollment_id) ORDER BY n.id FOR NO KEY UPDATE;
  SELECT * INTO mine FROM enrollment n WHERE n.id = mine.id;
  SELECT * INTO theirs FROM enrollment n WHERE n.id = pass.enrollment_id;
  SELECT * INTO pass FROM meet_pass p WHERE p.id = pass.id FOR UPDATE;
  -- A duplicate that waited on the first request's locks answers its meeting, never `used` (CTO 2).
  met := meet_replay(mine.id, meet_player.request_key, pass.id);
  IF met.id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM meet_answer(met, true);
    RETURN;
  END IF;
  PERFORM meet_refusal(pass, mine, theirs, quest_row);
  met := pay_meeting(pass, mine, theirs, quest_row, meet_player.request_key, device, reading);
  RETURN QUERY SELECT * FROM meet_answer(met, false);
END $$
;


-- Restated from 0055: work in flight never pays a deleted quest (QN403 hidden); its removal already ran.
CREATE OR REPLACE FUNCTION public.pay_completion(enrolled enrollment, quest uuid, points bigint, method text, completion_key text, operator uuid, staff uuid, device uuid, fixed_at timestamp with time zone)
 RETURNS bigint
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev         event%ROWTYPE;
  quest_row  quest%ROWTYPE;
  done_count integer;
  made       bigint;
  boosted    boost%ROWTYPE;
  paid       bigint;
BEGIN
  IF fixed_at IS NULL THEN
    RAISE EXCEPTION 'pay_completion needs the time the points were fixed' USING ERRCODE = '22004';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = pay_completion.quest;
  IF quest_row.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  PERFORM lock_quest_items(quest_row);
  boosted := quest_boost(quest_row, enrolled, fixed_at);
  paid := points * coalesce(boosted.multiplier, 1);
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = pay_completion.quest;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key,
                                device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, pay_completion.quest, done_count + 1, method,
          completion_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id, boost_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', paid,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE paid END,
          made, pay_completion.quest,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff, boosted.id);
  IF done_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);
  RETURN made;
END $$
;


-- Restated from 0062: an attempt on a deleted quest ends void (the confirm's sweep never stops on it).
CREATE OR REPLACE FUNCTION public.finish_quiz(attempt quiz_attempt)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  st       text;
  paid     bigint;
  payable  boolean;
BEGIN
  UPDATE quiz_answer a SET closed = true
  WHERE a.attempt_id = attempt.id AND a.answered_at IS NULL AND NOT a.closed;
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = attempt.enrollment_id;
  SELECT * INTO ev FROM event e WHERE e.id = attempt.event_id;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  payable := NOT (enrolled.status <> 'active'
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = enrolled.player_id AND p.status = 'active')
     OR (CASE WHEN enrolled.joined_via = 'rehearsal' THEN st NOT IN ('draft', 'scheduled')
              ELSE st NOT IN ('live', 'ended') END)
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id)
     OR EXISTS (SELECT 1 FROM quest q WHERE q.id = attempt.quest_id AND q.deleted_at IS NOT NULL)
     OR (enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
           SELECT 1 FROM staff_assignment sa
           WHERE sa.event_id = ev.id AND sa.player_id = enrolled.player_id AND NOT sa.can_play)));
  IF attempt.right_count = 0 THEN
    UPDATE quiz_attempt a SET status = 'finished', finished_at = now() WHERE a.id = attempt.id;
    IF payable AND pay_category_bonus(enrolled, (SELECT q.category_id FROM quest q WHERE q.id = attempt.quest_id),
                                      NULL) IS NOT NULL THEN
      PERFORM mark_ranking_repair(ev.id);
    END IF;
    RETURN 'finished';
  END IF;
  IF NOT payable THEN
    UPDATE quiz_attempt a SET status = 'void', finished_at = now() WHERE a.id = attempt.id;
    RETURN 'void';
  END IF;
  paid := pay_completion(enrolled, attempt.quest_id, attempt.right_count::bigint * attempt.points_each, 'quiz',
                         'quiz:' || attempt.id, NULL, NULL, NULL, attempt.started_at);
  UPDATE quiz_attempt a SET status = 'finished', completion_id = paid, finished_at = now() WHERE a.id = attempt.id;
  -- A quiz swept once the event is no longer live (confirm_results' sweep, or the tick after the end) claims nothing,
  -- so no slot is taken after the event and the places check never moves for a bonus; one that timed out during play
  -- (the tick's sweep while live) claims as any finish (CTO MAJOR 1, CTO note 1).
  IF NOT (attempt.swept AND (CASE WHEN enrolled.joined_via = 'rehearsal' THEN st NOT IN ('draft', 'scheduled')
                                  ELSE st <> 'live' END)) THEN
    PERFORM pay_first_bonus(enrolled, attempt.quest_id, paid, 'quiz:' || attempt.id);
  END IF;
  RETURN 'paid';
END $$
;


-- Restated from 0068: a points-measure goal counts an `adjust` as its quest's points (plan review MAJOR 3); a
-- count-measure goal ignores it.
CREATE OR REPLACE FUNCTION public.community_read_slice(goal community_goal, close_at timestamp with time zone, lower timestamp with time zone, upper timestamp with time zone, split timestamp with time zone)
 RETURNS TABLE(enrollment_id uuid, first_at timestamp with time zone, settled bigint, tail bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $$
  WITH counted AS (
    SELECT l.enrollment_id, l.created_at, l.kind,
           CASE WHEN goal.measure = 'points' THEN l.score_delta WHEN l.kind = 'removal' THEN -1 ELSE 1 END AS delta,
           l.kind <> 'removal' AND (goal.measure <> 'points' OR l.score_delta > 0) AS contributes
    FROM ledger_entry l
    LEFT JOIN ledger_entry r ON l.kind = 'removal' AND r.id = l.reverses
    LEFT JOIN quest q ON q.id = CASE WHEN l.kind = 'removal' THEN r.quest_id ELSE l.quest_id END
    WHERE l.event_id = goal.event_id AND l.created_at >= lower AND l.created_at < upper AND NOT l.rehearsal
      AND l.kind IN ('quest', 'bonus', 'first_bonus', 'streak', 'removal', 'adjust')
      AND (l.kind <> 'removal' OR (NOT r.rehearsal AND r.created_at >= goal.starts_at AND r.created_at < close_at))
      AND CASE WHEN l.kind = 'removal' THEN r.kind ELSE l.kind END
          = ANY (CASE WHEN goal.measure = 'points' THEN ARRAY['quest', 'bonus', 'first_bonus', 'streak', 'adjust']
                      ELSE ARRAY['quest'] END)
      AND (goal.measure = 'points' OR (goal.quest_id IS NULL AND goal.category_id IS NULL)
           OR q.id = goal.quest_id OR q.category_id = goal.category_id)
  )
  SELECT c.enrollment_id, min(c.created_at) FILTER (WHERE c.contributes),
         coalesce(sum(c.delta) FILTER (WHERE c.created_at < split), 0)::bigint,
         coalesce(sum(c.delta) FILTER (WHERE c.created_at >= split), 0)::bigint
  FROM counted c
  GROUP BY c.enrollment_id
$$
;


-- Restated from 0092: a deleted quest and every link to it stay behind (plan review MAJOR 4).
CREATE OR REPLACE FUNCTION public.event_copy_quests(src event, tgt event, shift interval)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO quest (id, organizer_id, event_id, category_id, type, title_ar, title_en, description_ar, description_en,
                     points, repeat_cap, opens_at, closes_at, visible, position, type_config, verification, item_id,
                     place_lat, place_lng, place_radius_m, flash)
  SELECT copy_id(q.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(q.category_id, tgt.id), q.type, q.title_ar, q.title_en,
         q.description_ar, q.description_en, q.points, q.repeat_cap, q.opens_at + shift, q.closes_at + shift, q.visible,
         q.position,
         CASE WHEN q.type = 'enter_code' THEN jsonb_set(q.type_config, '{code}', to_jsonb(fresh_entry_code()))
              ELSE q.type_config END,
         q.verification, copy_id(q.item_id, tgt.id), q.place_lat, q.place_lng, q.place_radius_m, q.flash
  FROM quest q WHERE q.event_id = src.id AND q.deleted_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots)
  SELECT copy_id(b.quest_id, tgt.id), tgt.organizer_id, tgt.id, b.points, b.slots
  FROM quest_first_bonus b WHERE b.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = b.quest_id AND d.deleted_at IS NOT NULL);
  INSERT INTO passport_step (id, organizer_id, event_id, quest_id, name_ar, name_en, position)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(p.quest_id, tgt.id), p.name_ar, p.name_en, p.position
  FROM passport_step p WHERE p.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = p.quest_id AND d.deleted_at IS NOT NULL);
  UPDATE event e SET focus_quest_id = copy_id(src.focus_quest_id, tgt.id)
  WHERE e.id = tgt.id AND src.focus_quest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = src.focus_quest_id AND d.deleted_at IS NOT NULL);
  RETURN n;
END $$
;


-- Restated from 0093: a session keeps no link to a deleted quest; map pins and sponsor tags naming one stay behind.
CREATE OR REPLACE FUNCTION public.event_copy_extras(src event, tgt event, shift interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  day_shift integer := coalesce(event_day(tgt.starts_at, tgt) - event_day(src.starts_at, src), 0);
  who       uuid := app_staff_user_id();
  sessions  integer;
  maps      integer;
  pins      integer;
  sponsors  integer;
  tags      integer;
BEGIN
  INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points, closed_weekdays, closed_days)
  SELECT tgt.id, tgt.organizer_id, s.enabled, s.bonus_points, s.closed_weekdays,
         ARRAY(SELECT d + day_shift FROM unnest(s.closed_days) AS d ORDER BY d)
  FROM event_streak s WHERE s.event_id = src.id;

  INSERT INTO event_session (id, organizer_id, event_id, kind, title_ar, title_en, description_ar, description_en,
                             place_ar, place_en, speakers, starts_at, ends_at, access, seats, closes_at,
                             registration_open, walk_ins, reminder_minutes, quest_id, points, created_by)
  SELECT copy_id(s.id, tgt.id), tgt.organizer_id, tgt.id, s.kind, s.title_ar, s.title_en, s.description_ar,
         s.description_en, s.place_ar, s.place_en, s.speakers, s.starts_at + shift, s.ends_at + shift, s.access,
         s.seats, s.closes_at + shift, s.registration_open, s.walk_ins, s.reminder_minutes,
         CASE WHEN EXISTS (SELECT 1 FROM quest d WHERE d.id = s.quest_id AND d.deleted_at IS NOT NULL) THEN NULL ELSE copy_id(s.quest_id, tgt.id) END,
         s.points, who
  FROM event_session s WHERE s.event_id = src.id;
  GET DIAGNOSTICS sessions = ROW_COUNT;

  INSERT INTO event_map (id, organizer_id, event_id, name_ar, name_en, position, created_by)
  SELECT copy_id(m.id, tgt.id), tgt.organizer_id, tgt.id, m.name_ar, m.name_en, m.position, who
  FROM event_map m WHERE m.event_id = src.id;
  GET DIAGNOSTICS maps = ROW_COUNT;
  INSERT INTO map_pin (id, organizer_id, event_id, map_id, kind, amenity, name_ar, name_en, details_ar, details_en, x, y,
                       quest_id, created_by)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(p.map_id, tgt.id), p.kind, p.amenity, p.name_ar,
         p.name_en, p.details_ar, p.details_en, p.x, p.y, copy_id(p.quest_id, tgt.id), who
  FROM map_pin p WHERE p.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = p.quest_id AND d.deleted_at IS NOT NULL);
  GET DIAGNOSTICS pins = ROW_COUNT;

  INSERT INTO sponsor (id, organizer_id, event_id, name_ar, name_en, tier, booth, created_by)
  SELECT copy_id(s.id, tgt.id), tgt.organizer_id, tgt.id, s.name_ar, s.name_en, s.tier, s.booth, who
  FROM sponsor s WHERE s.event_id = src.id;
  GET DIAGNOSTICS sponsors = ROW_COUNT;
  -- A tag on a reward that was removed has nothing to point at.
  INSERT INTO sponsor_tag (id, organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, created_by)
  SELECT copy_id(t.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(t.sponsor_id, tgt.id), t.kind,
         copy_id(t.quest_id, tgt.id), copy_id(t.category_id, tgt.id), copy_id(t.reward_id, tgt.id), who
  FROM sponsor_tag t
  WHERE t.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = t.quest_id AND d.deleted_at IS NOT NULL)
    AND (t.reward_id IS NULL OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'));
  GET DIAGNOSTICS tags = ROW_COUNT;

  INSERT INTO big_screen (event_id, organizer_id, scenes, updated_by)
  SELECT tgt.id, tgt.organizer_id, b.scenes, who FROM big_screen b WHERE b.event_id = src.id;

  RETURN jsonb_build_object('sessions', sessions, 'maps', maps, 'pins', pins, 'sponsors', sponsors,
                            'sponsorTags', tags);
END $$
;


-- Restated from 0093: an `adjust` line says the points it moved from and to, from its change's header.
CREATE OR REPLACE FUNCTION public.member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
 RETURNS TABLE(id bigint, at timestamp with time zone, kind text, score_delta bigint, balance_delta bigint, quest_id uuid, title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint, removable boolean, removed boolean, multiplier integer, bonus_slots integer, bonus_place integer, streak_days integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar, es.title_ar, es.title_en),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en, cg.title_en, es.title_en, es.title_ar),
         coalesce(n.reason, b.reason, pc.from_points || ' → ' || pc.to_points),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus', 'streak', 'session')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus'
                   OR (l.kind = 'quest' AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = fs.entry_id))
              THEN fb.slots END,
         CASE WHEN l.kind = 'first_bonus' THEN first_bonus_place(fs) END,
         sd.days
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest_points_change pc ON pc.id = l.points_change_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN event_session es ON es.id = l.session_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_bonus_slot fs ON fs.completion_id = l.completion_id AND l.kind IN ('quest', 'first_bonus')
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = fs.quest_id
  LEFT JOIN event_streak_day sd ON sd.entry_id = l.id AND l.kind = 'streak'
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$
;


-- Restated from 0093: the rehearsal's points sum counts `adjust` (none is written in a rehearsal, but a sum must not
-- hide a row).
CREATE OR REPLACE FUNCTION public.rehearsal_card(target_event uuid)
 RETURNS TABLE(code text, status_now text, accounts integer, completions integer, points bigint, reservations integer, flags integer, first_play_at timestamp with time zone, erased_at timestamp with time zone, erase_counts jsonb, live_wiped_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT r.code, event_status_now(ev.status, ev.starts_at, ev.ends_at),
         (SELECT count(*)::integer FROM enrollment n WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM ledger_entry l WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest'),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.event_id = ev.id AND l.rehearsal
            AND l.kind IN ('quest', 'award', 'removal', 'bonus', 'first_bonus', 'session', 'adjust')),
         (SELECT count(*)::integer FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM flag f JOIN enrollment n ON n.id = f.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         coalesce(r.first_play_at, (SELECT min(l.created_at) FROM ledger_entry l
                                    WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest')),
         r.erased_at, r.erase_counts, r.live_wiped_at
  FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
END $$
;

