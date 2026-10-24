-- The first-N bonus (T-313, F-342, FR-1840, ADR-260 to ADR-263; plan docs/plans/2026-10-25-t-313-first-n-bonus.md):
-- an owner or editor sets on a quest a bonus of X points for its first N completions. One row per slot, claimed with
-- FOR UPDATE SKIP LOCKED as the payer's last write, so concurrent claimers each take a different free slot and no more
-- than N bonuses are ever paid. Deny by default: both tables keep row-level security forced and no grant; every
-- function here is closed to PUBLIC, and only the entry points are granted to the API role. The functions 0055 to 0060
-- last stated are restated here, never edited there.

-- ================================================================ the bonus and its slots (ADR-260)
CREATE TABLE quest_first_bonus (
  quest_id     uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  points       integer NOT NULL CHECK (points BETWEEN 1 AND 100000),
  -- Always the number of the quest's slot rows: the setter keeps them together.
  slots        integer NOT NULL CHECK (slots BETWEEN 1 AND 1000),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX quest_first_bonus_event_idx ON quest_first_bonus (event_id);
ALTER TABLE quest_first_bonus ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_first_bonus FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_first_bonus FROM PUBLIC;

-- A slot is free while `completion_id` is NULL. `place` is only the row's key: the place a player and the team see is
-- the claim's rank among the quest's claimed slots by (claimed_at, place) (first_bonus_place, CTO 5). Erasure keeps
-- the enrollment, its completions and ledger rows, so a claimed slot stays used; the rehearsal wipe frees its slots.
CREATE TABLE quest_bonus_slot (
  quest_id      uuid NOT NULL REFERENCES quest_first_bonus (quest_id) ON DELETE CASCADE,
  place         integer NOT NULL CHECK (place >= 1),
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  completion_id bigint UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  entry_id      bigint UNIQUE REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  enrollment_id uuid,
  rehearsal     boolean NOT NULL DEFAULT false,
  claimed_at    timestamptz,
  PRIMARY KEY (quest_id, place),
  UNIQUE (quest_id, enrollment_id),
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CHECK ((completion_id IS NULL) = (entry_id IS NULL) AND (completion_id IS NULL) = (enrollment_id IS NULL)
         AND (completion_id IS NULL) = (claimed_at IS NULL)),
  CHECK (completion_id IS NOT NULL OR NOT rehearsal)
);
-- The claim's scan and the count of what is left.
CREATE INDEX quest_bonus_slot_free ON quest_bonus_slot (quest_id, place) WHERE completion_id IS NULL;
-- The rehearsal wipe's slots.
CREATE INDEX quest_bonus_slot_rehearsal_idx ON quest_bonus_slot (event_id) WHERE rehearsal;
CREATE INDEX quest_bonus_slot_enrollment_idx ON quest_bonus_slot (enrollment_id) WHERE enrollment_id IS NOT NULL;
ALTER TABLE quest_bonus_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_bonus_slot FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_bonus_slot FROM PUBLIC;

-- ================================================================ the ledger knows the first-N bonus
-- Its own kind: the organizer's fixed amount (never boosted, no XP), paid by the system with the completion it
-- rewards, moving the balance only while the shop is not closed. One per completion and one per player and quest.
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal', 'bonus',
                  'community', 'first_bonus'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_system_returns_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_system_returns_only
  CHECK (actor <> 'system' OR kind IN ('redeem_return', 'welcome', 'bonus', 'community', 'first_bonus'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_first_bonus_shape
  CHECK (kind <> 'first_bonus' OR (completion_id IS NOT NULL AND quest_id IS NOT NULL AND score_delta > 0
                                   AND balance_delta IN (0, score_delta) AND category_id IS NULL
                                   AND community_step_id IS NULL AND redemption_id IS NULL AND boost_id IS NULL
                                   AND actor = 'system'));
CREATE UNIQUE INDEX ledger_entry_first_bonus_completion_key ON ledger_entry (completion_id)
  WHERE kind = 'first_bonus';
CREATE UNIQUE INDEX ledger_entry_first_bonus_player_key ON ledger_entry (quest_id, enrollment_id)
  WHERE kind = 'first_bonus';

-- ================================================================ the claim (internal, ADR-260, ADR-261)
-- The bonus a completion takes, as its payer's last write: the entry's id, or NULL. Nothing (no lock) when the quest
-- has no bonus (one primary-key probe, the only cost a plain quest pays), the completion is a repeat, a manual award or
-- a practice scan, or no slot is free (an unlocked read: once used up, no completer locks anything for it). Otherwise
-- the bonus's advisory lock, shared (the setter takes it exclusive, so a claim and an edit wait for each other and a
-- waiting edit is never starved, CTO 4), the bonus read again (it may have changed or gone while this waited), then the
-- lowest free slot FOR UPDATE SKIP LOCKED: concurrent claimers take different slots, and the loser of the last slot
-- skips it at once and pays the quest's points only. `claimed_at` is the claim's own clock, so a rank once shown never
-- moves for a transaction that started earlier and claimed later (CTO note 3).
CREATE FUNCTION pay_first_bonus(enrolled enrollment, target_quest uuid, completion bigint, request_key text)
  RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  bonus quest_first_bonus%ROWTYPE;
  done  quest_completion%ROWTYPE;
  ev    event%ROWTYPE;
  slot  integer;
  entry bigint;
BEGIN
  SELECT * INTO bonus FROM quest_first_bonus b WHERE b.quest_id = target_quest;
  IF NOT FOUND OR coalesce(request_key, '') LIKE 'practice:%' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO done FROM quest_completion c WHERE c.id = completion;
  IF done.occurrence > 1 OR done.method = 'manual'
     OR NOT EXISTS (SELECT 1 FROM quest_bonus_slot s WHERE s.quest_id = target_quest AND s.completion_id IS NULL) THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('first-bonus:' || target_quest, 0));
  SELECT * INTO bonus FROM quest_first_bonus b WHERE b.quest_id = target_quest;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT s.place INTO slot FROM quest_bonus_slot s
  WHERE s.quest_id = target_quest AND s.completion_id IS NULL
  ORDER BY s.place
  LIMIT 1
  FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'first_bonus', bonus.points,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE bonus.points END,
          completion, target_quest, 'system')
  RETURNING id INTO entry;
  UPDATE quest_bonus_slot s
  SET completion_id = completion, entry_id = entry, enrollment_id = enrolled.id,
      rehearsal = enrolled.joined_via IS NOT DISTINCT FROM 'rehearsal', claimed_at = clock_timestamp()
  WHERE s.quest_id = target_quest AND s.place = slot;
  RETURN entry;
END $$;
REVOKE ALL ON FUNCTION pay_first_bonus(enrollment, uuid, bigint, text) FROM PUBLIC;

-- The place a claimed slot shows: its rank among the quest's claimed slots by (claimed_at, place), so it never exceeds
-- the bonus's N after a lower (CTO 5). Internal.
CREATE FUNCTION first_bonus_place(slot quest_bonus_slot) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM quest_bonus_slot o
  WHERE o.quest_id = slot.quest_id AND o.completion_id IS NOT NULL
    AND (o.claimed_at, o.place) <= (slot.claimed_at, slot.place)
$$;
REVOKE ALL ON FUNCTION first_bonus_place(quest_bonus_slot) FROM PUBLIC;

-- ================================================================ the setter (owners and editors, ADR-262)
-- Sets, changes, stops or switches off a quest's bonus, in the builder's save after its quest write. Off is `points` and
-- `slots` both NULL; Stop is `points` NULL and `slots` 0: N becomes the number given, counted under the lock, so a
-- claim in flight is never refused or lost (nobody got it: off). AN404 outside the caller's events, QC404 not a quest of this event, QE409 once the event ended or
-- its results are final, QB422 (points: 1 to 100,000; slots: 1 to 1,000), QB409 first_bonus_paid (off, or new points,
-- once a real player got it), QB409 below_given (fewer slots than given, HINT the count). The rehearsal row, then the
-- bonus's advisory lock exclusive (it waits for the claims in flight, which then count exactly), the bonus row, then
-- its slots: never an enrollment, an item or an XP row. Raising adds places; lowering deletes free slots from the
-- highest place down. Audited `event.first_bonus_set` when anything changed. Answers 'set', 'off' or 'unchanged'.
CREATE FUNCTION set_quest_first_bonus(target_event uuid, target_quest uuid, bonus_points integer,
                                      bonus_slots integer, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  old       quest_first_bonus%ROWTYPE;
  given     integer := 0;
  real_paid integer := 0;
  outcome   text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'QC404';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'QE409';
  END IF;
  IF (bonus_points IS NULL AND bonus_slots IS NOT NULL AND bonus_slots <> 0)
     OR (bonus_points IS NOT NULL AND bonus_slots IS NULL) OR bonus_points NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'bonus points are 1 to 100,000' USING ERRCODE = 'QB422', DETAIL = 'points';
  END IF;
  IF bonus_points IS NOT NULL AND bonus_slots NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'a bonus is for 1 to 1,000 players' USING ERRCODE = 'QB422', DETAIL = 'slots';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  PERFORM pg_advisory_xact_lock(hashtextextended('first-bonus:' || target_quest, 0));
  SELECT * INTO old FROM quest_first_bonus b WHERE b.quest_id = target_quest FOR UPDATE;
  IF FOUND THEN
    SELECT count(s.completion_id)::integer, count(*) FILTER (WHERE s.completion_id IS NOT NULL AND NOT s.rehearsal)::integer
    INTO given, real_paid
    FROM quest_bonus_slot s WHERE s.quest_id = target_quest;
  END IF;

  IF bonus_slots = 0 AND old.quest_id IS NOT NULL AND given > 0 THEN
    bonus_points := old.points;
    bonus_slots := given;
  END IF;
  IF bonus_points IS NULL THEN
    IF old.quest_id IS NULL THEN
      RETURN 'unchanged';
    END IF;
    IF real_paid > 0 THEN
      RAISE EXCEPTION 'players already got this bonus' USING ERRCODE = 'QB409', DETAIL = 'first_bonus_paid';
    END IF;
    DELETE FROM quest_first_bonus b WHERE b.quest_id = target_quest;
    outcome := 'off';
  ELSIF old.quest_id IS NULL THEN
    INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots)
    VALUES (target_quest, ev.organizer_id, ev.id, bonus_points, bonus_slots);
    INSERT INTO quest_bonus_slot (quest_id, place, organizer_id, event_id)
    SELECT target_quest, g, ev.organizer_id, ev.id FROM generate_series(1, bonus_slots) g;
    outcome := 'set';
  ELSE
    IF old.points = bonus_points AND old.slots = bonus_slots THEN
      RETURN 'unchanged';
    END IF;
    IF old.points <> bonus_points AND real_paid > 0 THEN
      RAISE EXCEPTION 'players already got this bonus' USING ERRCODE = 'QB409', DETAIL = 'first_bonus_paid';
    END IF;
    IF bonus_slots < given THEN
      RAISE EXCEPTION 'fewer players than already got it' USING ERRCODE = 'QB409', DETAIL = 'below_given',
        HINT = given::text;
    END IF;
    IF bonus_slots > old.slots THEN
      INSERT INTO quest_bonus_slot (quest_id, place, organizer_id, event_id)
      SELECT target_quest, top.place + g, ev.organizer_id, ev.id
      FROM (SELECT max(s.place) AS place FROM quest_bonus_slot s WHERE s.quest_id = target_quest) top,
           generate_series(1, bonus_slots - old.slots) g;
    ELSIF bonus_slots < old.slots THEN
      DELETE FROM quest_bonus_slot s
      WHERE s.quest_id = target_quest AND s.place IN (
        SELECT f.place FROM quest_bonus_slot f WHERE f.quest_id = target_quest AND f.completion_id IS NULL
        ORDER BY f.place DESC LIMIT old.slots - bonus_slots);
    END IF;
    UPDATE quest_first_bonus b SET points = bonus_points, slots = bonus_slots, updated_at = now()
    WHERE b.quest_id = target_quest;
    outcome := 'set';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.first_bonus_set', 'quest', target_quest::text,
          CASE WHEN old.quest_id IS NOT NULL
               THEN jsonb_build_object('points', old.points, 'slots', old.slots, 'given', given) END,
          CASE WHEN outcome = 'set'
               THEN jsonb_build_object('points', bonus_points, 'slots', bonus_slots, 'given', given) END,
          request);
  RETURN outcome;
END $$;
REVOKE ALL ON FUNCTION set_quest_first_bonus(uuid, uuid, integer, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_quest_first_bonus(uuid, uuid, integer, integer, uuid) TO questify_app;

-- ================================================================ the readers (ADR-263)
-- Every bonus of the event, counts only (no player): its points, slots, the slots left, how many got it and how many
-- of those are real players (the edit lock). For an active member of the event, or its team within their events; no
-- row for anyone else (CTO 6). The API caches it per event for 2 seconds and filters it per caller.
CREATE FUNCTION first_bonus_left(target_event uuid)
  RETURNS TABLE (quest_id uuid, points integer, slots integer, free integer, given integer, real_given integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.quest_id, b.points, b.slots,
         count(*) FILTER (WHERE s.completion_id IS NULL)::integer,
         count(s.completion_id)::integer,
         count(*) FILTER (WHERE s.completion_id IS NOT NULL AND NOT s.rehearsal)::integer
  FROM quest_first_bonus b
  JOIN quest_bonus_slot s ON s.quest_id = b.quest_id
  WHERE b.event_id = target_event
    AND (EXISTS (SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
                 WHERE n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active')
         OR EXISTS (SELECT 1 FROM event e
                    WHERE e.id = target_event AND app_staff_user_id() IS NOT NULL
                      AND e.organizer_id = app_organizer_id() AND in_event_scope(e.id, app_event_scope())))
  GROUP BY b.quest_id, b.points, b.slots
  ORDER BY b.quest_id
$$;
REVOKE ALL ON FUNCTION first_bonus_left(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION first_bonus_left(uuid) TO questify_app;

-- The first-N bonus of the calling player's own completion: its points, the place shown and the bonus's slots; place
-- NULL when the completion was the player's first of a bonus quest and found every slot taken ("all taken"). No row
-- for another player's completion, a repeat or a manual award, or a quest without a bonus. The same on a replay.
CREATE FUNCTION own_first_bonus(completion bigint)
  RETURNS TABLE (points integer, place integer, slots integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(l.score_delta::integer, b.points),
         CASE WHEN s.quest_id IS NOT NULL THEN first_bonus_place(s) END,
         b.slots
  FROM quest_completion c
  JOIN enrollment n ON n.id = c.enrollment_id AND n.player_id = app_player_id()
  JOIN quest_first_bonus b ON b.quest_id = c.quest_id
  LEFT JOIN quest_bonus_slot s ON s.completion_id = c.id
  LEFT JOIN ledger_entry l ON l.id = s.entry_id
  WHERE c.id = completion AND (s.quest_id IS NOT NULL OR (c.occurrence = 1 AND c.method <> 'manual'))
$$;
REVOKE ALL ON FUNCTION own_first_bonus(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_first_bonus(bigint) TO questify_app;

-- What a practice scan would add (ADR-249): the bonus's points while a slot is free, for an operator of the quest's
-- event; NULL otherwise. An unlocked read: practice takes no slot and no lock.
CREATE FUNCTION practice_first_bonus(target uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.points FROM quest_first_bonus b
  WHERE b.quest_id = target
    AND EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = b.event_id AND sa.player_id = app_player_id())
    AND EXISTS (SELECT 1 FROM quest_bonus_slot s WHERE s.quest_id = target AND s.completion_id IS NULL)
$$;
REVOKE ALL ON FUNCTION practice_first_bonus(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION practice_first_bonus(uuid) TO questify_app;

-- ================================================================ the payers claim last (ADR-260)
-- Each payer's caller claims the first-N bonus as its last write, never inside pay_completion (CTO MAJOR 2): the slot is
-- held only from there to the commit, after the enrollment, the items, the XP row and the category bonus.

-- As 0058, with the claim after the category bonus and before the final score read (the score answered holds it).
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid, reading jsonb DEFAULT NULL)
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
END $$;

-- As 0055, with the claim at the approval (the approval order decides who is first; pending points hold no slot).
CREATE OR REPLACE FUNCTION pay_submission(sub submission, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  paid     bigint;
BEGIN
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = sub.enrollment_id;
  paid := pay_completion(enrolled, sub.quest_id, sub.points, 'submission', 'sub:' || sub.id, operator, staff, NULL,
                         sub.created_at);
  PERFORM pay_first_bonus(enrolled, sub.quest_id, paid, 'sub:' || sub.id);
  RETURN paid;
END $$;

-- As 0055, with the claim after the quiz's pay, except a quiz swept after the event.
CREATE OR REPLACE FUNCTION finish_quiz(attempt quiz_attempt) RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
END $$;

-- As 0055, with the claim after the round's result is written.
CREATE OR REPLACE FUNCTION finish_game_round(target bigint, result_key text, given_verdict text, given_result jsonb,
                                             given_reason text, given_unlikely boolean, last_input_ms integer)
  RETURNS TABLE (verdict text, completion_id bigint, points bigint, score bigint, balance bigint,
                 attempts_left integer, replayed boolean, result jsonb, reason text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- As 0055, with the claim after the stamp that finishes the passport.
CREATE OR REPLACE FUNCTION stamp_step(target uuid, proof_version integer, request_key text, device uuid)
  RETURNS TABLE (quest_id uuid, completion_id bigint, points bigint, stamped boolean, done integer, needed integer,
                 score bigint, balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;

-- As 0055, with both sides' claims last.
CREATE OR REPLACE FUNCTION pay_meeting(pass meet_pass, mine enrollment, theirs enrollment, quest_row quest, key text,
                                       device uuid, reading jsonb) RETURNS meeting
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  lock_key   bigint;
  scanner_id bigint;
  shown_id   bigint;
  met        meeting%ROWTYPE;
BEGIN
  PERFORM lock_quest_items(quest_row);
  FOR lock_key IN
    SELECT DISTINCT hashtextextended('device:' || pass.event_id || ':' || d, 0)
    FROM unnest(ARRAY[device, pass.device_id]) d WHERE d IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(lock_key);
  END LOOP;
  IF mine.player_id < theirs.player_id THEN
    scanner_id := pay_completion(mine, quest_row.id, quest_row.points, 'meet_scan', 'meet:' || pass.id, NULL, NULL,
                                 device, now());
    shown_id := pay_completion(theirs, quest_row.id, quest_row.points, 'meet_shown', 'meet:' || pass.id, NULL, NULL,
                               pass.device_id, now());
  ELSE
    shown_id := pay_completion(theirs, quest_row.id, quest_row.points, 'meet_shown', 'meet:' || pass.id, NULL, NULL,
                               pass.device_id, now());
    scanner_id := pay_completion(mine, quest_row.id, quest_row.points, 'meet_scan', 'meet:' || pass.id, NULL, NULL,
                                 device, now());
  END IF;
  PERFORM keep_position(scanner_id, mine, reading);
  INSERT INTO meeting (organizer_id, event_id, quest_id, scanner_enrollment, shown_enrollment, pass_id, request_key,
                       scanner_completion, shown_completion)
  VALUES (pass.organizer_id, pass.event_id, quest_row.id, mine.id, theirs.id, pass.id, key, scanner_id, shown_id)
  RETURNING * INTO met;
  UPDATE meet_pass p SET ended_at = now() WHERE p.id = pass.id;
  -- Both sides claim after both paid, in player id order (the order they were paid): with one slot left, the side
  -- with the lower player id takes it.
  IF mine.player_id < theirs.player_id THEN
    PERFORM pay_first_bonus(mine, quest_row.id, scanner_id, 'meet:' || pass.id);
    PERFORM pay_first_bonus(theirs, quest_row.id, shown_id, 'meet:' || pass.id);
  ELSE
    PERFORM pay_first_bonus(theirs, quest_row.id, shown_id, 'meet:' || pass.id);
    PERFORM pay_first_bonus(mine, quest_row.id, scanner_id, 'meet:' || pass.id);
  END IF;
  RETURN met;
END $$;

-- ================================================================ the kind in the readers and the wipe
-- As 0055, with the first-N bonus removable on its own (it copies the completion and the quest). A removal never
-- frees the slot: the place stays used (Q-223).
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus') THEN
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
                            quest_id, category_id, community_step_id, actor, staff_user_id, reverses, boost_id)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, credit.community_step_id, 'staff', me, credit.id, credit.boost_id)
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

-- As 0053, with the first-N bonus (the quest entry before it is refused first).
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal AND NEW.kind IN ('quest', 'redeem', 'award', 'bonus', 'community', 'first_bonus') AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- As 0053: a points goal counts the first-N bonus as it counts the category bonus.
CREATE OR REPLACE FUNCTION community_read_slice(goal community_goal, close_at timestamptz, lower timestamptz, upper timestamptz,
                                     split timestamptz)
  RETURNS TABLE (enrollment_id uuid, first_at timestamptz, settled bigint, tail bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH counted AS (
    SELECT l.enrollment_id, l.created_at, l.kind,
           CASE WHEN goal.measure = 'points' THEN l.score_delta WHEN l.kind = 'removal' THEN -1 ELSE 1 END AS delta,
           l.kind <> 'removal' AND (goal.measure <> 'points' OR l.score_delta > 0) AS contributes
    FROM ledger_entry l
    LEFT JOIN ledger_entry r ON l.kind = 'removal' AND r.id = l.reverses
    LEFT JOIN quest q ON q.id = CASE WHEN l.kind = 'removal' THEN r.quest_id ELSE l.quest_id END
    WHERE l.event_id = goal.event_id AND l.created_at >= lower AND l.created_at < upper AND NOT l.rehearsal
      AND l.kind IN ('quest', 'bonus', 'first_bonus', 'removal')
      AND (l.kind <> 'removal' OR (NOT r.rehearsal AND r.created_at >= goal.starts_at AND r.created_at < close_at))
      AND CASE WHEN l.kind = 'removal' THEN r.kind ELSE l.kind END
          = ANY (CASE WHEN goal.measure = 'points' THEN ARRAY['quest', 'bonus', 'first_bonus'] ELSE ARRAY['quest'] END)
      AND (goal.measure = 'points' OR (goal.quest_id IS NULL AND goal.category_id IS NULL)
           OR q.id = goal.quest_id OR q.category_id = goal.category_id)
  )
  SELECT c.enrollment_id, min(c.created_at) FILTER (WHERE c.contributes),
         coalesce(sum(c.delta) FILTER (WHERE c.created_at < split), 0)::bigint,
         coalesce(sum(c.delta) FILTER (WHERE c.created_at >= split), 0)::bigint
  FROM counted c
  GROUP BY c.enrollment_id
$$;

-- As 0044, with the first-N bonus in the points.
CREATE OR REPLACE FUNCTION rehearsal_card(target_event uuid)
  RETURNS TABLE (code text, status_now text, accounts integer, completions integer, points bigint, reservations integer,
                 flags integer, first_play_at timestamptz, erased_at timestamptz, erase_counts jsonb,
                 live_wiped_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT r.code, event_status_now(ev.status, ev.starts_at, ev.ends_at),
         (SELECT count(*)::integer FROM enrollment n WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM ledger_entry l WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest'),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.event_id = ev.id AND l.rehearsal AND l.kind IN ('quest', 'award', 'removal', 'bonus', 'first_bonus')),
         (SELECT count(*)::integer FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM flag f JOIN enrollment n ON n.id = f.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         coalesce(r.first_play_at, (SELECT min(l.created_at) FROM ledger_entry l
                                    WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest')),
         r.erased_at, r.erase_counts, r.live_wiped_at
  FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
END $$;

-- As 0059: the rehearsal's first-N slots are given back first, before the entries and completions they point at
-- are deleted, and counted as `first_bonuses`; the bonus in the points.
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

-- As 0055, with `bonus_slots` on a first-N bonus line ("First-{slots} bonus"). The output changed: DROP and CREATE.
DROP FUNCTION member_activity(uuid, bigint, integer);
CREATE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, multiplier integer, bonus_slots integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, r.name_en, k.name_en, i.name_en, g.name_en, cg.title_en),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus' THEN fb.slots END
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = l.quest_id AND l.kind = 'first_bonus'
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;
REVOKE ALL ON FUNCTION member_activity(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_activity(uuid, bigint, integer) TO questify_app;

-- As 0055, with the first-N bonus removable on its own; `bonus_slots` and `bonus_place` on its line, and
-- `bonus_slots` on the quest line whose completion earned a bonus not yet removed (the remove dialog's hint). The
-- output changed: DROP and CREATE.
DROP FUNCTION member_ledger(uuid, uuid, bigint, integer);
CREATE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean, multiplier integer, bonus_slots integer, bonus_place integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en, cg.title_en),
         coalesce(n.reason, b.reason),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus'
                   OR (l.kind = 'quest' AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = fs.entry_id))
              THEN fb.slots END,
         CASE WHEN l.kind = 'first_bonus' THEN first_bonus_place(fs) END
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_bonus_slot fs ON fs.completion_id = l.completion_id AND l.kind IN ('quest', 'first_bonus')
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = fs.quest_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION member_ledger(uuid, uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_ledger(uuid, uuid, bigint, integer) TO questify_app;

-- As 0060, also answering `bonus_points` when the scan would be the player's first and a slot is free (an unlocked
-- read; the real door skipped the claim for the `practice:` key, so practice takes no slot and no lock). The output
-- changed: DROP and CREATE.
DROP FUNCTION operator_practice_scan(uuid, uuid, integer);
CREATE FUNCTION operator_practice_scan(target uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (outcome text, points bigint, occurrence integer, refusal text, refusal_detail text,
                 bonus_points integer)
  LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE
  would_points     bigint;
  would_occurrence integer;
  would_bonus      integer;
  done             text;
  code             text;
  detail           text;
BEGIN
  IF practice_wipe_owed(target) THEN
    RETURN QUERY SELECT 'refused'::text, NULL::bigint, NULL::integer, 'PW409'::text, NULL::text, NULL::integer;
    RETURN;
  END IF;
  BEGIN
    SELECT c.points, c.occurrence INTO would_points, would_occurrence
    FROM operator_complete_quest(target, scanned, scanned_version, 'practice:' || gen_random_uuid()::text) c;
    RAISE EXCEPTION 'practice scan undone' USING ERRCODE = 'PX000';
  EXCEPTION
    WHEN SQLSTATE 'PX000' THEN
      done := 'completed';
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS code = RETURNED_SQLSTATE, detail = PG_EXCEPTION_DETAIL;
      done := 'refused';
  END;
  IF done = 'completed' AND would_occurrence = 1 THEN
    would_bonus := practice_first_bonus(target);
  END IF;
  RETURN QUERY SELECT done, would_points, would_occurrence, code, nullif(detail, ''), would_bonus;
END $$;
REVOKE ALL ON FUNCTION operator_practice_scan(uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_practice_scan(uuid, uuid, integer) TO questify_app;

-- As 0055, plus `firstBonus`: the ids of the bonus quests this member may play now and has never completed (a bonus
-- with no slot left included, so the app can say "All taken"). Ids only: the counts come from the API's 2-second
-- cache (first_bonus_left), never a count per player.
CREATE OR REPLACE FUNCTION live_state(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  playing  boolean;
BEGIN
  SELECT n.* INTO enrolled FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL, 'flash', '[]'::jsonb,
                              'boosts', '[]'::jsonb, 'firstBonus', '[]'::jsonb);
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target;
  IF NOT polls_shown(ev) THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL, 'flash', '[]'::jsonb,
                              'boosts', '[]'::jsonb, 'firstBonus', '[]'::jsonb);
  END IF;
  playing := play_phase(ev, enrolled) IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target AND sa.player_id = enrolled.player_id AND NOT sa.can_play);
  RETURN jsonb_build_object(
    'polls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id, 'closesAt', least(q.closes_at, ev.ends_at))
                       ORDER BY q.opens_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE playing AND q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.opens_at <= now() AND q.closes_at > now() AND (ev.ends_at IS NULL OR ev.ends_at > now())
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = enrolled.id AND qc.quest_id = q.id)),
      '[]'::jsonb),
    'closed', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id) ORDER BY q.closes_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.type_config -> 'live' ->> 'results' = 'at_close'
        AND least(q.closes_at, ev.ends_at) <= now() AND least(q.closes_at, ev.ends_at) > now() - interval '15 minutes'
        AND sees_category(enrolled.id, c) AND quest_community_lock(q) IS NULL),
      '[]'::jsonb),
    'community', member_community(ev, enrolled.id),
    'flash', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id,
                                          'title', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
                                          'closesAt', q.closes_at) ORDER BY q.opens_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE playing AND q.event_id = target AND q.flash AND q.visible AND flash_shown(q)
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT quest_done(enrolled.id, q.id)),
      '[]'::jsonb),
    'boosts', coalesce((
      SELECT jsonb_agg(jsonb_build_object('boostId', (r.running).id, 'categoryId', c.id,
                                          'category', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
                                          'multiplier', (r.running).multiplier, 'endsAt', (r.running).ends_at)
                       ORDER BY (r.running).starts_at, (r.running).id)
      FROM category c
      CROSS JOIN LATERAL (SELECT boost_in_force(c.id, enrolled, now()) AS running) r
      WHERE playing AND c.event_id = target AND (r.running).id IS NOT NULL AND sees_category(enrolled.id, c)),
      '[]'::jsonb),
    'firstBonus', coalesce((
      SELECT jsonb_agg(q.id ORDER BY q.position, q.id)
      FROM quest_first_bonus b
      JOIN quest q ON q.id = b.quest_id
      JOIN category c ON c.id = q.category_id
      WHERE playing AND b.event_id = target AND q.visible AND flash_shown(q)
        AND (q.opens_at IS NULL OR q.opens_at <= now()) AND (q.closes_at IS NULL OR q.closes_at > now())
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = enrolled.id AND qc.quest_id = q.id)),
      '[]'::jsonb));
END $$;

-- As 0055, also true while a shown quest of the event has a first-N bonus with a slot free, and for 15 minutes after
-- its last claim (so "All taken" reaches the app): the live read carries the bonuses left.
CREATE OR REPLACE FUNCTION event_has_live(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
                   AND q.closes_at > now() - interval '15 minutes')
      OR EXISTS (SELECT 1 FROM community_goal g
                 WHERE g.event_id = event_has_live.target AND g.settled_until IS NOT NULL
                   AND (g.final_at IS NULL OR g.final_at > now() - interval '30 minutes'))
      OR EXISTS (SELECT 1 FROM quest q
                 WHERE q.event_id = target AND q.flash AND q.visible AND q.opens_at <= now()
                   AND q.opens_at > now() - interval '15 minutes' AND q.closes_at > now())
      OR EXISTS (SELECT 1 FROM boost b
                 WHERE b.event_id = event_has_live.target AND b.starts_at <= now()
                   AND b.starts_at > now() - interval '15 minutes' AND b.ends_at > now())
      OR EXISTS (SELECT 1 FROM quest_first_bonus fb JOIN quest q ON q.id = fb.quest_id
                 WHERE fb.event_id = event_has_live.target AND q.visible
                   AND EXISTS (SELECT 1 FROM quest_bonus_slot s
                               WHERE s.quest_id = fb.quest_id
                                 AND (s.completion_id IS NULL OR s.claimed_at > now() - interval '15 minutes')))
$$;

-- As 0055, with the quest's first-N bonus (`first_bonus_points`, `first_bonus_slots`, NULL when none) and the
-- calling member's own place in it (`first_bonus_place`, NULL until they got it). The output changed: DROP and CREATE.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz,
                 item_ar text, item_en text, bonus_item_ar text, bonus_item_en text, place_lat numeric,
                 place_lng numeric, place_radius_m integer, daily_cap integer, met_today integer,
                 game_left integer, game_passed boolean, community_lock jsonb, category_community_lock jsonb,
                 flash_closes_at timestamptz, boost jsonb, first_bonus_points integer, first_bonus_slots integer,
                 first_bonus_place integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, n AS enrolled FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         period_count(me.id, q)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL)
           + CASE WHEN q.type = 'game' AND period_count(me.id, q) = 0 AND game_spent(me.id, q) THEN 1 ELSE 0 END,
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
         CASE WHEN k.step IS NOT NULL THEN 'community_locked' ELSE category_rule_lock(q, me.id) END,
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
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_en END,
         CASE WHEN q.type = 'location' THEN q.place_lat END,
         CASE WHEN q.type = 'location' THEN q.place_lng END,
         CASE WHEN q.type = 'location' THEN q.place_radius_m END,
         CASE WHEN q.type = 'meet' THEN (q.type_config ->> 'dailyCap')::int END,
         CASE WHEN q.type = 'meet' THEN meet_today(me.id, q) END,
         CASE WHEN q.type = 'game' THEN game_left(me.id, q) END,
         CASE WHEN q.type = 'game' THEN (SELECT a.passed FROM game_attempts(me.id, q) a) END,
         community_lock_note(k.step),
         community_lock_note(k.category_step),
         CASE WHEN q.flash THEN q.closes_at END,
         CASE WHEN (cb.running).id IS NOT NULL
              THEN jsonb_build_object('boostId', (cb.running).id, 'multiplier', (cb.running).multiplier,
                                      'endsAt', (cb.running).ends_at) END,
         fb.points, fb.slots,
         CASE WHEN fs.quest_id IS NOT NULL THEN first_bonus_place(fs) END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  CROSS JOIN LATERAL (SELECT boost_in_force(c.id, me.enrolled, now()) AS running) cb
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible AND flash_shown(q)
  CROSS JOIN LATERAL (SELECT category_community_lock(c.id) AS category_step) kc
  CROSS JOIN LATERAL (SELECT coalesce(
                        (SELECT s.id FROM community_step s
                         WHERE s.unlock_quest_id = q.id
                           AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)),
                        kc.category_step) AS step, kc.category_step) k
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = q.id
  LEFT JOIN quest_bonus_slot fs ON fs.quest_id = q.id AND fs.enrollment_id = me.id
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- As 0056, plus the event's first-N bonuses and their slots first (a slot names a completion, RESTRICT; CTO 9).
CREATE OR REPLACE FUNCTION event_delete_goals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM community_goal g WHERE g.event_id = OLD.id;
  DELETE FROM boost b WHERE b.event_id = OLD.id;
  DELETE FROM nfc_tap t WHERE t.event_id = OLD.id;
  DELETE FROM nfc_tag t WHERE t.event_id = OLD.id;
  DELETE FROM quest_first_bonus b WHERE b.event_id = OLD.id;
  RETURN OLD;
END $$;
