-- Manual awards, their caps and report, removing an award, bulk awards (T-207; ADR-152). An operator in the app, or an
-- owner or editor on the dashboard, awards a quest or points by hand with a required reason; operators and editors
-- follow the event's caps (per award, per person per event day), the owner does not. An owner or editor removes a
-- credit entry with a new `removal` entry that never takes the score or the balance below zero (FR-1601). Reasons live
-- beside the append-only ledger in `ledger_note`, so account deletion (T-217) can clear them. Deny by default: forced
-- row-level security, read grants only, every definer pinned and executable by questify_app only.

-- ================================================================ the event's caps (owner only, through set_award_caps)
ALTER TABLE event
  ADD COLUMN award_cap_each integer NOT NULL DEFAULT 200 CHECK (award_cap_each BETWEEN 1 AND 100000),
  ADD COLUMN award_cap_day integer NOT NULL DEFAULT 500,
  ADD CONSTRAINT event_award_caps CHECK (award_cap_day BETWEEN award_cap_each AND 1000000);

-- ================================================================ the ledger learns awards and removals
ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual'));

-- Like operator_id, the staff user is named without a foreign key: the record outlives a staff account.
ALTER TABLE ledger_entry
  ADD COLUMN staff_user_id uuid,
  ADD COLUMN reverses bigint REFERENCES ledger_entry (id) ON DELETE RESTRICT;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_actor_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_actor_check
  CHECK (actor IN ('player', 'system', 'operator', 'staff'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_staff_named CHECK ((actor = 'staff') = (staff_user_id IS NOT NULL));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_staff_kinds
  CHECK (actor <> 'staff' OR kind IN ('quest', 'award', 'removal'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_operator_quests_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_operator_quests_only
  CHECK (actor <> 'operator' OR kind IN ('quest', 'handover', 'redeem_return', 'award'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_award_shape
  CHECK (kind <> 'award' OR (score_delta > 0 AND score_delta = balance_delta AND completion_id IS NULL
                             AND quest_id IS NULL AND redemption_id IS NULL AND actor IN ('operator', 'staff')));
-- A removal names the entry it reverses and copies its completion and quest, so per-quest sums net out. Both deltas
-- are clamped at zero (FR-1601), so a removal may move nothing and still mark the entry removed.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_removal_shape
  CHECK ((kind = 'removal') = (reverses IS NOT NULL)
         AND (kind <> 'removal' OR (score_delta <= 0 AND balance_delta <= 0 AND redemption_id IS NULL
                                    AND actor = 'staff')));
CREATE UNIQUE INDEX ledger_entry_removal_key ON ledger_entry (reverses) WHERE kind = 'removal';
CREATE INDEX ledger_entry_staff_idx ON ledger_entry (staff_user_id, event_id, created_at)
  WHERE staff_user_id IS NOT NULL;

-- FR-906: an operator the owner has not allowed to play receives no award either.
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind IN ('quest', 'redeem', 'award') AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ bulk awards, reasons, keys
CREATE TABLE bulk_award (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id    uuid NOT NULL,
  event_id        uuid NOT NULL,
  staff_user_id   uuid NOT NULL,
  amount          integer NOT NULL CHECK (amount BETWEEN 1 AND 100000),
  -- Personal data a staff member may have typed: account deletion (T-217) may clear it.
  reason          text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300),
  quest_id        uuid,
  requested       integer NOT NULL CHECK (requested >= 0),
  awarded         integer NOT NULL CHECK (awarded >= 0),
  skipped         integer NOT NULL CHECK (skipped >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, staff_user_id, idempotency_key),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);

-- The reason of every manual entry (FR-309): exactly one per award, removal and manual quest entry, written in the
-- same function. A bulk award's reason is stored once, on bulk_award.
CREATE TABLE ledger_note (
  entry_id     bigint PRIMARY KEY REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  reason       text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300),
  bulk_id      uuid REFERENCES bulk_award (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((bulk_id IS NULL) OR reason IS NULL),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT
);
CREATE INDEX ledger_note_event_idx ON ledger_note (event_id, entry_id);

-- The idempotency record of points awards and removals (a quest award replays through its completion's key).
CREATE TABLE manual_award_key (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id        uuid NOT NULL REFERENCES event (id) ON DELETE RESTRICT,
  operator_id     uuid,
  staff_user_id   uuid,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  kind            text NOT NULL CHECK (kind IN ('award', 'removal')),
  enrollment_id   uuid NOT NULL,
  amount          bigint,
  reverses        bigint,
  entry_id        bigint NOT NULL REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((operator_id IS NULL) <> (staff_user_id IS NULL)),
  CHECK ((kind = 'award') = (amount IS NOT NULL) AND (kind = 'removal') = (reverses IS NOT NULL))
);
CREATE UNIQUE INDEX manual_award_key_operator ON manual_award_key (event_id, operator_id, idempotency_key)
  WHERE operator_id IS NOT NULL;
CREATE UNIQUE INDEX manual_award_key_staff ON manual_award_key (event_id, staff_user_id, idempotency_key)
  WHERE staff_user_id IS NOT NULL;

ALTER TABLE bulk_award ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_award FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_note FORCE ROW LEVEL SECURITY;
ALTER TABLE manual_award_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE manual_award_key FORCE ROW LEVEL SECURITY;
REVOKE ALL ON bulk_award, ledger_note, manual_award_key FROM PUBLIC;
GRANT SELECT ON bulk_award, ledger_note TO questify_app;
-- Players never read reasons; organizers read their events' notes, the console reads all.
CREATE POLICY bulk_award_read ON bulk_award FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());
CREATE POLICY ledger_note_read ON ledger_note FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- ================================================================ helpers (not executable by questify_app)
-- The event's day (FR-1714) a moment falls in.
CREATE FUNCTION event_day(at timestamptz, ev event) RETURNS date
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  RETURN ((at AT TIME ZONE ev.timezone) - make_interval(hours => ev.day_start_hour))::date;
REVOKE ALL ON FUNCTION event_day(timestamptz, event) FROM PUBLIC;

-- What one operator (or one staff user) awarded by hand today, toward the daily cap. Removals do not refund it; bulk
-- awards never count (FR-1712).
CREATE FUNCTION awarded_today(ev event, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(l.score_delta), 0)::bigint
  FROM ledger_entry l
  LEFT JOIN quest_completion c ON c.id = l.completion_id
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  WHERE l.event_id = ev.id
    AND ((operator IS NOT NULL AND l.operator_id = operator) OR (staff IS NOT NULL AND l.staff_user_id = staff))
    AND (l.kind = 'award' OR (l.kind = 'quest' AND c.method = 'manual'))
    AND n.bulk_id IS NULL
    AND l.created_at >= now() - interval '2 days'
    AND event_day(l.created_at, ev) = event_day(now(), ev)
$$;
REVOKE ALL ON FUNCTION awarded_today(event, uuid, uuid) FROM PUBLIC;

-- The event of the caller's organizer within their event limit (owners and editors), or AN404.
CREATE FUNCTION award_event_of(target_event uuid) RETURNS event
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  found_event event;
BEGIN
  SELECT ev.* INTO found_event FROM event ev
  WHERE ev.id = target_event AND app_staff_user_id() IS NOT NULL
    AND ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope());
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'AN404';
  END IF;
  RETURN found_event;
END $$;
REVOKE ALL ON FUNCTION award_event_of(uuid) FROM PUBLIC;

CREATE FUNCTION clean_reason(reason text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF reason IS NULL OR char_length(btrim(reason)) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'a reason of 1 to 300 characters is required' USING ERRCODE = 'AR400';
  END IF;
  RETURN btrim(reason);
END $$;
REVOKE ALL ON FUNCTION clean_reason(text) FROM PUBLIC;

-- ================================================================ one completion engine, with manual awards
-- As 0026, and: `staff` names a dashboard user awarding by hand (actor `staff`); method `manual` skips the proof
-- checks and keeps every other rule; a manual entry gets its reason in ledger_note. A replay must come from the same
-- operator and staff user.
CREATE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer, typed_code text,
                                  request_key text, device uuid, operator uuid, staff uuid, reason text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row     quest%ROWTYPE;
  enrolled      enrollment%ROWTYPE;
  earlier       quest_completion%ROWTYPE;
  earlier_by    uuid;
  earlier_staff uuid;
  status_now    text;
  done_count    integer;
  made          bigint;
  entry         bigint;
BEGIN
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
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

  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT event_status_now(e.status, e.starts_at, e.ends_at) INTO status_now FROM event e WHERE e.id = quest_row.event_id;
  IF status_now <> 'live' THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF NOT quest_row.visible THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  IF quest_row.opens_at IS NOT NULL AND quest_row.opens_at > now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_started';
  END IF;
  IF quest_row.closes_at IS NOT NULL AND quest_row.closes_at <= now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'ended';
  END IF;

  -- FR-301, FR-302: a completion only through a method the quest has, or by hand (FR-308).
  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr' AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'my_qr' AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'enter_code' AND proof_method = 'code')) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
    END IF;
    IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
    END IF;
    IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
    END IF;
  END IF;

  -- A fixed My QR held up at a station is read again and again: one completion per operator, player and quest in any
  -- 10 seconds, whatever the repeat cap (the app also ignores the same code for 5 seconds).
  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, done_count + 1, proof_method,
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
  END IF;

  RETURN QUERY SELECT made, quest_row.points::bigint, done_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION record_completion(uuid, uuid, text, integer, text, text, uuid, uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
                                          request_key text, device uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- My QR is the operator's method only; manual is staff's.
  IF proof_method IS NULL OR proof_method NOT IN ('qr', 'code') THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
  END IF;
  RETURN QUERY SELECT * FROM record_completion(target, me, proof_method, proof_version, typed_code, request_key, device,
                                               NULL, NULL, NULL);
END $$;

-- As 0026; the station's scan always passes method my_qr.
CREATE OR REPLACE FUNCTION operator_complete_quest(target uuid, scanned uuid, scanned_version integer, request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  assignment staff_assignment%ROWTYPE;
  current    integer;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'OQ404';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = quest_row.event_id AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id)
     AND NOT EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id AND q.quest_id = target)
  THEN
    RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
  END IF;
  IF scanned = me THEN
    RAISE EXCEPTION 'an operator cannot scan their own code' USING ERRCODE = 'OY409';
  END IF;
  SELECT p.my_qr_version INTO current FROM player p WHERE p.id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF current IS DISTINCT FROM scanned_version THEN
    RAISE EXCEPTION 'an earlier My QR' USING ERRCODE = 'OM422';
  END IF;
  RETURN QUERY SELECT * FROM record_completion(target, scanned, 'my_qr', NULL, NULL, request_key, NULL, me, NULL, NULL);
END $$;

DROP FUNCTION record_completion(uuid, uuid, text, integer, text, text, uuid, uuid);

-- ================================================================ awarding by hand (one body for both seats)
-- Every rule of a manual award after the caller is known and locked. `operator` or `staff` names the awarder;
-- `capped` is false only for the owner. Refusals:
--   AK422 the key was used for another award      QC404 no such enrollment in this event
--   AY409 awarding oneself                          QC403 enrollment not active (DETAIL: its status)
--   QN403 event not live (DETAIL: event_not_live)   AQ404 no such quest in this event
--   AC409 over a cap (DETAIL: each|day; HINT: "<limit>,<left today>")   AR400 reason missing   AP400 bad amount
-- plus record_completion's for a quest, and QP403 (an operator who may not play).
CREATE FUNCTION grant_manual_award(ev event, target_enrollment uuid, target_quest uuid, amount integer, reason text,
                                   request_key text, operator uuid, staff uuid, capped boolean)
  RETURNS TABLE (entry_id bigint, points bigint, replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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

  -- Replays first, before any rule that may have changed since.
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
  ELSIF EXISTS (SELECT 1 FROM quest_completion c
                WHERE c.enrollment_id = target_enrollment AND c.idempotency_key = request_key) THEN
    SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = target_enrollment AND n.event_id = ev.id;
    SELECT * INTO done FROM record_completion(target_quest, enrolled.player_id, 'manual', NULL, NULL, request_key, NULL,
                                              operator, staff, reason);
    RETURN QUERY SELECT l.id, done.points, done.replayed FROM ledger_entry l
      WHERE l.completion_id = done.completion_id AND l.kind = 'quest';
    RETURN;
  END IF;

  why := clean_reason(reason);
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
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'live' THEN
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
    -- Into a record first: a query that calls record_completion cannot see the rows it writes.
    SELECT * INTO done FROM record_completion(target_quest, enrolled.player_id, 'manual', NULL, NULL, request_key, NULL,
                                              operator, staff, why);
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
END $$;
REVOKE ALL ON FUNCTION grant_manual_award(event, uuid, uuid, integer, text, text, uuid, uuid, boolean) FROM PUBLIC;

-- The caller's assignment in the event with the award ability, locked so one operator's awards run one after the
-- other (the daily cap). FOR NO KEY UPDATE still waits for, and blocks, a removal; it leaves staff_assignment_quest's
-- key checks alone. Refusals: OP403 not an operator of this event, OA403 the award ability is off.
CREATE FUNCTION award_assignment(target_event uuid, me uuid) RETURNS staff_assignment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  assignment staff_assignment%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = target_event AND sa.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('award' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'awarding is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  RETURN assignment;
END $$;
REVOKE ALL ON FUNCTION award_assignment(uuid, uuid) FROM PUBLIC;

-- FR-308 to FR-310: the operator's manual award. Refusals: award_assignment's, grant_manual_award's, and OS403 a quest
-- outside the operator's quest limit.
CREATE FUNCTION operator_award(target_event uuid, target_enrollment uuid, target_quest uuid, amount integer,
                               reason text, request_key text)
  RETURNS TABLE (entry_id bigint, points bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
  ev         event;
BEGIN
  assignment := award_assignment(target_event, me);
  IF target_quest IS NOT NULL
     AND EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id)
     AND NOT EXISTS (SELECT 1 FROM staff_assignment_quest q
                     WHERE q.assignment_id = assignment.id AND q.quest_id = target_quest) THEN
    RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event;
  RETURN QUERY SELECT * FROM grant_manual_award(ev, target_enrollment, target_quest, amount, reason, request_key, me,
                                                NULL, true);
END $$;
REVOKE ALL ON FUNCTION operator_award(uuid, uuid, uuid, integer, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_award(uuid, uuid, uuid, integer, text, text) TO questify_app;

-- What the award form shows (FR-310): the caps, what is left today, whether the event is live. OP403 / OA403.
CREATE FUNCTION operator_award_state(target_event uuid)
  RETURNS TABLE (cap_each integer, cap_day integer, left_today bigint, live boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  ev event;
BEGIN
  IF me IS NULL OR NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me)
  THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_assignment sa
                 WHERE sa.event_id = target_event AND sa.player_id = me AND 'award' = ANY (sa.abilities)) THEN
    RAISE EXCEPTION 'awarding is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event;
  RETURN QUERY SELECT ev.award_cap_each, ev.award_cap_day,
                      greatest(ev.award_cap_day - awarded_today(ev, me, NULL), 0),
                      event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live';
END $$;
REVOKE ALL ON FUNCTION operator_award_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_award_state(uuid) TO questify_app;

-- The quests an operator may award by hand: visible, inside their window, inside the operator's quest limit.
CREATE FUNCTION operator_award_quests(target_event uuid)
  RETURNS TABLE (quest_id uuid, title_ar text, title_en text, points integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.id, q.title_ar, q.title_en, q.points
  FROM staff_assignment sa
  JOIN quest q ON q.event_id = sa.event_id
  LEFT JOIN category c ON c.id = q.category_id
  WHERE sa.event_id = target_event AND sa.player_id = app_player_id() AND 'award' = ANY (sa.abilities)
    AND q.visible AND (q.opens_at IS NULL OR q.opens_at <= now()) AND (q.closes_at IS NULL OR q.closes_at > now())
    AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = sa.id)
         OR q.id IN (SELECT s.quest_id FROM staff_assignment_quest s WHERE s.assignment_id = sa.id))
  ORDER BY c.position NULLS LAST, q.position, q.id
$$;
REVOKE ALL ON FUNCTION operator_award_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_award_quests(uuid) TO questify_app;

-- FR-308: find one member of the event by exact username (folded like the unique index) or exact Saudi mobile. Only
-- for an operator with the award ability (OP403 / OA403). `active` only: an operator is never told who is banned.
CREATE FUNCTION operator_find_player(target_event uuid, by_username text, by_phone text)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, active boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL OR NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me)
  THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_assignment sa
                 WHERE sa.event_id = target_event AND sa.player_id = me AND 'award' = ANY (sa.abilities)) THEN
    RAISE EXCEPTION 'awarding is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  IF (by_username IS NULL) = (by_phone IS NULL) THEN
    RAISE EXCEPTION 'search by username or by phone' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT n.id, p.username, p.avatar, n.status = 'active'
  FROM enrollment n
  JOIN player p ON p.id = n.player_id
  LEFT JOIN player_contact pc ON pc.player_id = p.id
  WHERE n.event_id = target_event AND n.status <> 'removed'
    AND ((by_username IS NOT NULL AND username_fold(p.username) = username_fold(by_username))
         OR (by_phone IS NOT NULL AND pc.phone_e164 = by_phone))
  LIMIT 1;
END $$;
REVOKE ALL ON FUNCTION operator_find_player(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_find_player(uuid, text, text) TO questify_app;

-- FR-1027: an owner's or editor's award from the dashboard. Editors follow the caps; the owner does not. Each staff
-- user's awards in an event run one after the other (an advisory lock: the daily cap). Refusals: AN404, and
-- grant_manual_award's.
CREATE FUNCTION staff_award(target_event uuid, target_enrollment uuid, target_quest uuid, amount integer, reason text,
                            request_key text, request uuid)
  RETURNS TABLE (entry_id bigint, points bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := award_event_of(target_event);
  me    uuid := app_staff_user_id();
  is_owner boolean := app_is_owner(ev.organizer_id);
  done  record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('award:' || ev.id || ':' || me, 0));
  SELECT * INTO done FROM grant_manual_award(ev, target_enrollment, target_quest, amount, reason, request_key, NULL, me,
                                             NOT is_owner);
  IF NOT done.replayed THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('staff', me, ev.organizer_id, ev.id, 'event.manual_award', 'enrollment', target_enrollment::text,
            jsonb_build_object('entry', done.entry_id, 'points', done.points, 'quest', target_quest), request);
  END IF;
  RETURN QUERY SELECT done.entry_id, done.points, done.replayed;
END $$;
REVOKE ALL ON FUNCTION staff_award(uuid, uuid, uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_award(uuid, uuid, uuid, integer, text, text, uuid) TO questify_app;

-- ================================================================ removing an award (FR-320, FR-1601)
-- An owner or editor removes a credit entry (a quest, an award, the welcome) while the event is live or ended. The
-- removal takes the full amount, clamped so neither the score nor the balance goes below zero; the record keeps the
-- full amount through `reverses`. A removed quest stays used (ADR-152). When a delta would be clamped and the player
-- holds a reserved prize, the removal waits for that prize to be cancelled: its return would give back points the
-- removal could not take. Refusals:
--   AN404 no such event   AE404 no such entry in it   AT422 not a credit entry   AS409 the event is not live or ended
--   AD409 already removed (another key)   AO409 an open reservation   AK422 the key was used for another removal
--   AR400 reason missing
CREATE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text, request uuid)
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
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  SELECT k.* INTO earlier FROM manual_award_key k
  WHERE k.event_id = ev.id AND k.staff_user_id = me AND k.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.kind <> 'removal' OR earlier.reverses <> target_entry THEN
      RAISE EXCEPTION 'this key was used for another removal' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true FROM ledger_entry l WHERE l.id = earlier.entry_id;
    RETURN;
  END IF;

  why := clean_reason(reason);
  SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = target_entry AND l.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such entry in this event' USING ERRCODE = 'AE404';
  END IF;
  IF credit.kind NOT IN ('quest', 'award', 'welcome') THEN
    RAISE EXCEPTION 'only an award can be removed' USING ERRCODE = 'AT422';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('live', 'ended') THEN
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
REVOKE ALL ON FUNCTION remove_award(uuid, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_award(uuid, bigint, text, text, uuid) TO questify_app;

-- ================================================================ bulk awards (FR-1712)
-- Matches a pasted or uploaded list to the event's members: each line by exact username or exact Saudi mobile. At
-- most 2000 lines. Owners and editors (AN404). `active` false: the line matched someone who cannot receive points.
CREATE FUNCTION resolve_bulk_targets(target_event uuid, usernames text[], phones text[])
  RETURNS TABLE (line text, enrollment_id uuid, username text, active boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF coalesce(cardinality(usernames), 0) + coalesce(cardinality(phones), 0) > 2000 THEN
    RAISE EXCEPTION 'at most 2000 lines' USING ERRCODE = 'AB400';
  END IF;
  RETURN QUERY
  SELECT u.line, m.id, m.username, m.active
  FROM unnest(coalesce(usernames, ARRAY[]::text[])) AS u(line)
  LEFT JOIN LATERAL (
    SELECT n.id, p.username, n.status = 'active' AND NOT EXISTS (
             SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = p.id AND NOT sa.can_play)
             AS active
    FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = ev.id AND n.status <> 'removed' AND username_fold(p.username) = username_fold(u.line)
    LIMIT 1) m ON true
  UNION ALL
  SELECT f.line, m.id, m.username, m.active
  FROM unnest(coalesce(phones, ARRAY[]::text[])) AS f(line)
  LEFT JOIN LATERAL (
    SELECT n.id, p.username, n.status = 'active' AND NOT EXISTS (
             SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = p.id AND NOT sa.can_play)
             AS active
    FROM enrollment n JOIN player p ON p.id = n.player_id JOIN player_contact pc ON pc.player_id = p.id
    WHERE n.event_id = ev.id AND n.status <> 'removed' AND pc.phone_e164 = f.line
    LIMIT 1) m ON true;
END $$;
REVOKE ALL ON FUNCTION resolve_bulk_targets(uuid, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_bulk_targets(uuid, text[], text[]) TO questify_app;

-- The members a quest target reaches: active, allowed to play, with a completion of the quest whose points were not
-- removed (a caught cheater gets no bonus).
CREATE FUNCTION quest_bulk_targets(ev event, target_quest uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT DISTINCT n.id
  FROM ledger_entry l
  JOIN enrollment n ON n.id = l.enrollment_id
  WHERE l.event_id = ev.id AND l.quest_id = target_quest AND l.kind = 'quest' AND n.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = l.id)
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = n.player_id
                    AND NOT sa.can_play)
$$;
REVOKE ALL ON FUNCTION quest_bulk_targets(event, uuid) FROM PUBLIC;

-- How many members a quest target would reach, for the preview. AN404, AQ404.
CREATE FUNCTION quest_bulk_count(target_event uuid, target_quest uuid) RETURNS integer
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  RETURN (SELECT count(*) FROM quest_bulk_targets(ev, target_quest));
END $$;
REVOKE ALL ON FUNCTION quest_bulk_count(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_bulk_count(uuid, uuid) TO questify_app;

-- The same points to many members in one step, outside the daily caps (FR-1712). The owner's is uncapped; an editor's
-- gives each member at most the per-award cap (ADR-152, Q-118). A list target is re-filtered here: ids outside the
-- event, inactive members and operators who may not play are skipped and counted. Members are locked in id order.
-- Refusals: AN404, AQ404, AR400, AP400, AC409 (each), QN403 (event not live), AB400 (more than 2000 ids, or both or
-- neither target), AK422 (the key was used for another bulk award).
CREATE FUNCTION bulk_award(target_event uuid, enrollments uuid[], target_quest uuid, amount integer, reason text,
                           request_key text, request uuid)
  RETURNS TABLE (bulk_id uuid, awarded integer, skipped integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  me        uuid := app_staff_user_id();
  earlier   bulk_award%ROWTYPE;
  why       text;
  asked     integer;
  targets   uuid[];
  made      uuid;
  got       integer;
BEGIN
  IF (enrollments IS NULL) = (target_quest IS NULL) OR coalesce(cardinality(enrollments), 0) > 2000 THEN
    RAISE EXCEPTION 'a list of at most 2000 members, or a quest' USING ERRCODE = 'AB400';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  asked := coalesce(cardinality(enrollments), 0);
  SELECT b.* INTO earlier FROM bulk_award b
  WHERE b.event_id = ev.id AND b.staff_user_id = me AND b.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.amount <> amount OR earlier.quest_id IS DISTINCT FROM target_quest OR earlier.requested <> asked THEN
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
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'live' THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF target_quest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
    END IF;
    targets := ARRAY(SELECT quest_bulk_targets(ev, target_quest));
    asked := 0;
  ELSE
    targets := ARRAY(
      SELECT DISTINCT n.id FROM enrollment n
      WHERE n.id = ANY (enrollments) AND n.event_id = ev.id AND n.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = n.player_id
                        AND NOT sa.can_play));
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = ANY (targets) ORDER BY n.id FOR NO KEY UPDATE;

  INSERT INTO bulk_award (organizer_id, event_id, staff_user_id, amount, reason, quest_id, requested, awarded, skipped,
                          idempotency_key)
  VALUES (ev.organizer_id, ev.id, me, amount, why, target_quest, asked, cardinality(targets),
          greatest(asked - cardinality(targets), 0), request_key)
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
          jsonb_build_object('amount', amount, 'quest', target_quest, 'awarded', got), request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, got, greatest(asked - got, 0), false;
END $$;
REVOKE ALL ON FUNCTION bulk_award(uuid, uuid[], uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bulk_award(uuid, uuid[], uuid, integer, text, text, uuid) TO questify_app;

-- ================================================================ caps (owner) and the report (FR-310, FR-311)
-- Outcomes: changed, unchanged, not_owner. AN404 for an event outside the caller's reach; a bad pair raises the
-- event_award_caps check.
CREATE FUNCTION set_award_caps(target_event uuid, cap_each integer, cap_day integer, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  IF ev.award_cap_each = cap_each AND ev.award_cap_day = cap_day THEN
    RETURN 'unchanged';
  END IF;
  UPDATE event SET award_cap_each = cap_each, award_cap_day = cap_day WHERE id = ev.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.award_caps', 'event', ev.id::text,
          jsonb_build_object('each', ev.award_cap_each, 'day', ev.award_cap_day),
          jsonb_build_object('each', cap_each, 'day', cap_day), request);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION set_award_caps(uuid, integer, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_award_caps(uuid, integer, integer, uuid) TO questify_app;

-- Every manual entry of the event, newest first (FR-311): awards, manual quests, bulk awards and removals, with the
-- player, the quest, the reason, who (an operator's username or a staff user's email) and whether it was removed.
-- `points` is the full amount: for a removal, the amount of the entry it reverses (FR-1601).
CREATE FUNCTION manual_awards(target_event uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, points bigint, score_delta bigint, balance_delta bigint,
                 reverses bigint, enrollment_id uuid, username text, quest_id uuid, title_ar text, title_en text,
                 reason text, bulk_id uuid, by_operator text, by_staff text, removed boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, coalesce(r.score_delta, l.score_delta), l.score_delta, l.balance_delta,
         l.reverses, l.enrollment_id, p.username, l.quest_id, q.title_ar, q.title_en, coalesce(n.reason, b.reason),
         n.bulk_id, op.username, su.email,
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id)
  FROM ledger_note n
  JOIN ledger_entry l ON l.id = n.entry_id
  JOIN enrollment e ON e.id = l.enrollment_id
  JOIN player p ON p.id = e.player_id
  LEFT JOIN ledger_entry r ON r.id = l.reverses
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE n.event_id = ev.id AND (before_id IS NULL OR n.entry_id < before_id)
  ORDER BY n.entry_id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION manual_awards(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION manual_awards(uuid, bigint, integer) TO questify_app;

-- One member's points record for the dashboard (owners and editors), newest first: what can be removed and what was.
CREATE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar), coalesce(q.title_en, w.name_en), coalesce(n.reason, b.reason),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome') AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id)
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION member_ledger(uuid, uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_ledger(uuid, uuid, bigint, integer) TO questify_app;
