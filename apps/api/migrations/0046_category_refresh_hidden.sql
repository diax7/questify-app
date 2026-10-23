-- Daily and weekly refresh, hidden categories (T-304c, ADR-204; plan docs/plans/2026-10-24-t-304c-refresh-hidden-categories.md).
-- Refresh: a category's quests count their repeat cap, "done", the gates and the bonus inside the current period (the
-- event's day, or 7-day blocks from its first day); the occurrence number stays lifetime and nothing paid is touched.
-- Hidden: a category opens per player once they scan its secret code (reveal_category) or are awarded one of its quests
-- by hand. Deny by default: category_reveal has no grant; the definers below are its only doors.

-- ================================================================ the category's settings
ALTER TABLE category
  ADD COLUMN refresh text NOT NULL DEFAULT 'none' CHECK (refresh IN ('none', 'daily', 'weekly')),
  ADD COLUMN hidden boolean NOT NULL DEFAULT false,
  -- The version its printed secret code carries; a regenerated code bumps it (FR-1711).
  ADD COLUMN reveal_version integer NOT NULL DEFAULT 1 CHECK (reveal_version >= 1);
GRANT UPDATE (refresh, hidden, reveal_version) ON category TO questify_app;

-- A daily quest over a long event passes 100 occurrences; repeat_cap (1 to 100) now counts per period.
ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_occurrence_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_occurrence_check CHECK (occurrence >= 1);

-- ================================================================ the period (FR-236, FR-1619)
-- When the category's current period started: -infinity for none; the start of today's event day for daily; for weekly
-- the start of the current 7-day block counted from the event's first day (week 1 is days 1 to 7 of the event, whatever
-- the weekday; a draft with no start counts from its creation). now() is the transaction's start, as a completion's
-- created_at, so a scan that began before the day turned counts in the old period.
CREATE FUNCTION category_period_start(cat category, ev event) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE cat.refresh
           WHEN 'daily' THEN event_day_start(ev, d.today)
           WHEN 'weekly' THEN event_day_start(ev, d.first + 7 * floor((d.today - d.first) / 7.0)::integer)
           ELSE '-infinity'::timestamptz
         END
  FROM (SELECT event_day(now(), ev) AS today, event_day(coalesce(ev.starts_at, ev.created_at), ev) AS first) d
$$;
REVOKE ALL ON FUNCTION category_period_start(category, event) FROM PUBLIC;

-- When the next period starts (the player's "resets in"), NULL for none.
CREATE FUNCTION category_resets_at(cat category, ev event) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE cat.refresh
           WHEN 'daily' THEN event_day_start(ev, d.today + 1)
           WHEN 'weekly' THEN event_day_start(ev, d.first + 7 * (floor((d.today - d.first) / 7.0)::integer + 1))
         END
  FROM (SELECT event_day(now(), ev) AS today, event_day(coalesce(ev.starts_at, ev.created_at), ev) AS first) d
$$;
REVOKE ALL ON FUNCTION category_resets_at(category, event) FROM PUBLIC;

-- The member's completions of this quest inside its category's current period (the lifetime for none).
CREATE FUNCTION period_count(member uuid, quest_row quest) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM quest_completion c
  WHERE c.enrollment_id = member AND c.quest_id = quest_row.id
    AND c.created_at >= (SELECT category_period_start(g, e) FROM category g JOIN event e ON e.id = g.event_id
                         WHERE g.id = quest_row.category_id)
$$;
REVOKE ALL ON FUNCTION period_count(uuid, quest) FROM PUBLIC;

-- As 0044, inside the period: done this period with a completion, or a quiz finished with no right answers (a quiz never
-- sits in a refreshing category). category_done, category_cleared, the gates and the bonus follow.
CREATE OR REPLACE FUNCTION quest_done(member uuid, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q WHERE q.id = target AND period_count(member, q) > 0)
      OR EXISTS (SELECT 1 FROM quiz_attempt a
                 WHERE a.enrollment_id = member AND a.quest_id = target AND a.status = 'finished'
                   AND a.completion_id IS NULL)
$$;

-- ================================================================ only repeatable types refresh
-- A refreshing category holds only scan, code and challenge quests: the other types are played once by design (QT422
-- 'refresh'). Both sides take the event's lock, so a quest moved in and a switch to refresh cannot cross.
CREATE FUNCTION quest_refresh_type() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('category_refresh:' || NEW.event_id, 0));
  IF NEW.type NOT IN ('scan_qr', 'enter_code', 'challenge')
     AND EXISTS (SELECT 1 FROM category c WHERE c.id = NEW.category_id AND c.refresh <> 'none') THEN
    RAISE EXCEPTION 'only scan, code and challenge quests sit in a refreshing category'
      USING ERRCODE = 'QT422', DETAIL = 'refresh';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_refresh_type() FROM PUBLIC;
CREATE TRIGGER quest_refresh_type BEFORE INSERT OR UPDATE OF category_id, type ON quest
  FOR EACH ROW EXECUTE FUNCTION quest_refresh_type();

CREATE FUNCTION category_refresh_type() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('category_refresh:' || NEW.event_id, 0));
  IF EXISTS (SELECT 1 FROM quest q
             WHERE q.category_id = NEW.id AND q.type NOT IN ('scan_qr', 'enter_code', 'challenge')) THEN
    RAISE EXCEPTION 'only scan, code and challenge quests sit in a refreshing category'
      USING ERRCODE = 'QT422', DETAIL = 'refresh';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION category_refresh_type() FROM PUBLIC;
CREATE TRIGGER category_refresh_type BEFORE INSERT OR UPDATE OF refresh ON category
  FOR EACH ROW WHEN (NEW.refresh <> 'none') EXECUTE FUNCTION category_refresh_type();

-- ================================================================ the bonus once per period (ADR-204)
-- One row per player, category and period. A non-refreshing category's rows keep -infinity (one row, as before).
ALTER TABLE category_bonus ADD COLUMN period_start timestamptz NOT NULL DEFAULT '-infinity';
ALTER TABLE category_bonus DROP CONSTRAINT category_bonus_pkey;
ALTER TABLE category_bonus ADD PRIMARY KEY (enrollment_id, category_id, period_start);
-- The ledger holds no period: the once-only guard is category_bonus's key and the check in pay_category_bonus.
DROP INDEX ledger_entry_bonus_key;

-- As 0044, once per period: pays only when no bonus row of this period or a later one exists. A later row blocks a
-- switch from daily back to none (the period becomes -infinity), so the bonus is never repaid on a lifetime count; a
-- removed bonus keeps its row and is not repaid in its period. The check and the insert run under the enrollment lock
-- (FOR NO KEY UPDATE) that every caller holds (record_completion, pay_completion's callers, finish_quiz's callers), so
-- two transactions never both pass it; keep it that way.
CREATE OR REPLACE FUNCTION pay_category_bonus(enrolled enrollment, target_category uuid, completion bigint) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  group_row category%ROWTYPE;
  ev        event%ROWTYPE;
  period    timestamptz;
  entry     bigint;
BEGIN
  SELECT * INTO group_row FROM category c WHERE c.id = target_category;
  IF NOT FOUND OR group_row.completion_bonus = 0 OR NOT category_done(enrolled.id, group_row.id) THEN
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
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, category_id, actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'bonus', group_row.completion_bonus,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE group_row.completion_bonus END,
          group_row.id, 'system')
  RETURNING id INTO entry;
  UPDATE category_bonus b SET entry_id = entry
  WHERE b.enrollment_id = enrolled.id AND b.category_id = group_row.id AND b.period_start = period;
  RETURN entry;
END $$;

-- As 0044, with the bonus of the current period only.
CREATE OR REPLACE FUNCTION own_category_bonus(target uuid)
  RETURNS TABLE (category_id uuid, points bigint, name_ar text, name_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT b.category_id, l.score_delta, c.name_ar, c.name_en
  FROM quest q
  JOIN event e ON e.id = q.event_id
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id()
  JOIN quiz_attempt a ON a.enrollment_id = n.id AND a.quest_id = q.id AND a.status = 'finished'
  JOIN category_bonus b ON b.enrollment_id = n.id AND b.category_id = q.category_id
    AND b.period_start = category_period_start(c, e)
    AND (b.completion_id = a.completion_id
         OR (a.completion_id IS NULL AND b.completion_id IS NULL AND b.created_at = a.finished_at))
  JOIN ledger_entry l ON l.id = b.entry_id
  WHERE q.id = target
$$;

-- ================================================================ hidden categories (FR-237)
-- One row per player and category they found. Deleted with the category (it holds no points), with a rehearsal
-- account and with an erased account.
CREATE TABLE category_reveal (
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  category_id   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, category_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id, event_id) REFERENCES category (id, event_id) ON DELETE CASCADE
);
CREATE INDEX category_reveal_category_idx ON category_reveal (category_id);
ALTER TABLE category_reveal ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_reveal FORCE ROW LEVEL SECURITY;
REVOKE ALL ON category_reveal FROM PUBLIC;

-- Whether the member sees the category: in its audience, and not hidden or found by them.
CREATE FUNCTION sees_category(member uuid, cat category) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT in_audience(member, cat.audience_kind, cat.audience_field_id, cat.audience_values)
     AND (NOT cat.hidden
          OR EXISTS (SELECT 1 FROM category_reveal r WHERE r.enrollment_id = member AND r.category_id = cat.id))
$$;
REVOKE ALL ON FUNCTION sees_category(uuid, category) FROM PUBLIC;

-- The calling player finds a hidden category with its secret code's version (the API checked the signature and that the
-- code is this category's). Pays nothing; a second find answers `revealed` false and writes nothing.
CREATE FUNCTION reveal_category(target uuid, proof_version integer)
  RETURNS TABLE (category_id uuid, name_ar text, name_en text, revealed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  group_row category%ROWTYPE;
  ev        event%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  made      boolean;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO group_row FROM category c WHERE c.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'category not found' USING ERRCODE = 'QC404';
  END IF;
  PERFORM ensure_rehearsal_wiped(group_row.event_id);
  SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = group_row.event_id AND n.player_id = me;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'category not found' USING ERRCODE = 'QC404';
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = group_row.event_id;
  IF play_phase(ev, enrolled) IS NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF NOT group_row.hidden THEN
    RAISE EXCEPTION 'this category is not hidden' USING ERRCODE = 'QH422';
  END IF;
  IF NOT in_audience(enrolled.id, group_row.audience_kind, group_row.audience_field_id, group_row.audience_values) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_for_you';
  END IF;
  IF proof_version IS DISTINCT FROM group_row.reveal_version THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
  END IF;
  INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, group_row.id)
  ON CONFLICT DO NOTHING;
  made := FOUND;
  RETURN QUERY SELECT group_row.id, group_row.name_ar, group_row.name_en, made;
END $$;
REVOKE ALL ON FUNCTION reveal_category(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reveal_category(uuid, integer) TO questify_app;

-- ================================================================ the gates see what the player sees
-- As 0044, with an unrevealed hidden unlock category counted as met (no dead end on a category the player cannot see).
CREATE OR REPLACE FUNCTION category_lock(quest_row quest, member uuid) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  group_row category%ROWTYPE;
  first_row category%ROWTYPE;
BEGIN
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF group_row.opens_at IS NOT NULL AND group_row.opens_at > now() THEN
    RETURN 'category_not_started';
  END IF;
  IF group_row.unlock_after IS NOT NULL THEN
    SELECT * INTO first_row FROM category c WHERE c.id = group_row.unlock_after;
    IF sees_category(member, first_row) AND NOT category_cleared(member, first_row.id) THEN
      RETURN 'category_locked';
    END IF;
  END IF;
  IF group_row.order_mode = 'in_order' AND EXISTS (
    SELECT 1 FROM quest q
    WHERE q.category_id = group_row.id AND q.visible AND (q.position, q.id) < (quest_row.position, quest_row.id)
      AND (q.closes_at IS NULL OR q.closes_at > now()) AND NOT quest_done(member, q.id)) THEN
    RETURN 'order_locked';
  END IF;
  RETURN NULL;
END $$;

-- As 0044: an unrevealed hidden category is outside the player's audience (not_for_you). An owner's or editor's manual
-- award (`skip_category`) checks the audience only; record_completion then reveals the category to that player.
CREATE OR REPLACE FUNCTION quest_open_check(quest_row quest, enrolled enrollment, skip_category boolean) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev        event%ROWTYPE;
  group_row category%ROWTYPE;
  shut      text;
BEGIN
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF play_phase(ev, enrolled) IS NULL THEN
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
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF NOT (CASE WHEN skip_category
               THEN in_audience(enrolled.id, group_row.audience_kind, group_row.audience_field_id,
                                group_row.audience_values)
               ELSE sees_category(enrolled.id, group_row) END) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_for_you';
  END IF;
  IF NOT skip_category THEN
    shut := category_lock(quest_row, enrolled.id);
    IF shut IS NOT NULL THEN
      RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = shut;
    END IF;
  END IF;
END $$;

-- ================================================================ the completion engine
-- As 0045, with two counts: the lifetime one numbers the occurrence (its UNIQUE key never repeats), the period's is
-- held to repeat_cap. A manual award of a hidden quest reveals its category to the player, on a fresh payment only
-- (after the cap check, never on a replay), so a refused award reveals nothing.
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
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);

  RETURN QUERY SELECT made, quest_row.points::bigint, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- ================================================================ what the player reads
-- As 0045, with each category's refresh and next reset; `done` and `bonus_settled` are this period's (`earned` and
-- `bonus_earned` stay lifetime); only the categories the player sees; an unlock category's name only when the player
-- sees it. The output changed: DROP and CREATE, with the REVOKE and GRANT repeated.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz)
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
         category_resets_at(c, e)
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- As 0037, without hidden categories: the public page never lists them.
CREATE OR REPLACE FUNCTION public_event_quests(code text)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, opens_at timestamptz, closes_at timestamptz, quest_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.opens_at, q.closes_at, q.position
  FROM event e
  JOIN category c ON c.event_id = e.id AND c.audience_kind IS NULL AND NOT c.hidden
  JOIN quest q ON q.category_id = c.id AND q.event_id = e.id AND q.visible
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND e.access <> 'private'
  ORDER BY c.position, c.id, q.position, q.id
$$;

-- As 0041, for a category the player sees.
CREATE OR REPLACE FUNCTION member_vote(target uuid)
  RETURNS TABLE (option_id text, text_ar text, text_en text, mine boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, q.type_config FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'vote' AND q.visible AND sees_category(n.id, c)
  )
  SELECT o ->> 'id', o -> 'text' ->> 'ar', o -> 'text' ->> 'en',
         EXISTS (SELECT 1 FROM quest_vote v WHERE v.enrollment_id = me.id AND v.quest_id = target
                   AND v.option_id = o ->> 'id')
  FROM me, jsonb_array_elements(me.type_config -> 'options') WITH ORDINALITY AS t(o, i)
  ORDER BY i
$$;

-- As 0041, for a category the player sees.
CREATE OR REPLACE FUNCTION member_quiz(target uuid)
  RETURNS TABLE (status text, total integer, points_each integer, timer_seconds integer, right_count integer,
                 earned bigint, completion_id bigint, server_now timestamptz, current jsonb, answered jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id AS enrollment_id, q.id AS quest_id, q.points, q.type_config
    FROM quest q
    JOIN category c ON c.id = q.category_id
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    WHERE q.id = target AND q.type = 'quiz' AND q.visible AND sees_category(n.id, c)
  ), served AS (
    SELECT a.*, t.timer_seconds, quiz_question(me.type_config, a.position) AS asked,
           a.answered_at IS NULL AND NOT a.closed AND NOT quiz_overdue(a.served_at, t.timer_seconds) AS open_now
    FROM me
    JOIN quiz_attempt t ON t.enrollment_id = me.enrollment_id AND t.quest_id = me.quest_id
    JOIN quiz_answer a ON a.attempt_id = t.id
  )
  SELECT coalesce(t.status, 'none'),
         jsonb_array_length(me.type_config -> 'questions'),
         coalesce(t.points_each, me.points),
         coalesce(t.timer_seconds, (me.type_config ->> 'timerSeconds')::integer),
         coalesce(t.right_count, 0),
         coalesce(t.right_count::bigint * t.points_each, 0),
         t.completion_id,
         now(),
         (SELECT jsonb_build_object(
                   'position', r.position, 'id', r.question_id, 'text', r.asked -> 'text',
                   'choices', (SELECT jsonb_agg(jsonb_build_object('id', c -> 'id', 'text', c -> 'text') ORDER BY j)
                               FROM jsonb_array_elements(r.asked -> 'choices') WITH ORDINALITY AS u(c, j)),
                   'servedAt', r.served_at,
                   'closesAt', CASE WHEN r.timer_seconds IS NOT NULL
                                    THEN r.served_at + make_interval(secs => r.timer_seconds) END)
          FROM served r WHERE r.open_now),
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'position', r.position, 'id', r.question_id, 'text', r.asked -> 'text',
                     'choices', (SELECT jsonb_agg(jsonb_build_object('id', c -> 'id', 'text', c -> 'text') ORDER BY j)
                                 FROM jsonb_array_elements(r.asked -> 'choices') WITH ORDINALITY AS u(c, j)),
                     'choiceId', r.choice_id, 'rightChoiceId', r.asked -> 'right', 'right', r.correct,
                     'closed', r.answered_at IS NULL) ORDER BY r.position)
                   FROM served r WHERE NOT r.open_now), '[]'::jsonb)
  FROM me
  LEFT JOIN quiz_attempt t ON t.enrollment_id = me.enrollment_id AND t.quest_id = me.quest_id
$$;

-- As 0042, for a category the player sees.
CREATE OR REPLACE FUNCTION member_survey(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'questions', q.type_config -> 'questions',
           'answered', EXISTS (SELECT 1 FROM survey_response r WHERE r.enrollment_id = n.id AND r.quest_id = q.id))
  FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type = 'survey' AND q.visible AND sees_category(n.id, c)
$$;

-- As 0042, for a category the player sees.
CREATE OR REPLACE FUNCTION member_share(target uuid)
  RETURNS TABLE (event_id uuid, message_ar text, message_en text, link text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT q.event_id, q.type_config -> 'message' ->> 'ar', q.type_config -> 'message' ->> 'en', q.type_config ->> 'link',
         EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = n.id AND qc.quest_id = q.id)
  FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type = 'share' AND q.visible AND share_quests_on(q.event_id) AND sees_category(n.id, c)
$$;

-- As 0045, for a category the player sees.
CREATE OR REPLACE FUNCTION member_passport(target uuid)
  RETURNS TABLE (needed integer, step_id uuid, name_ar text, name_en text, done boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM quest q
    JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
    JOIN player p ON p.id = n.player_id AND p.status = 'active'
    JOIN category c ON c.id = q.category_id
    WHERE q.id = target AND q.type = 'passport' AND q.visible AND sees_category(n.id, c)
  )
  SELECT (q.type_config ->> 'needed')::int, s.id, s.name_ar, s.name_en,
         EXISTS (SELECT 1 FROM passport_stamp p WHERE p.enrollment_id = me.id AND p.step_id = s.id)
  FROM me
  JOIN quest q ON q.id = target
  JOIN passport_step s ON s.quest_id = q.id
  ORDER BY s.position, s.id
$$;

-- ================================================================ cleanup
-- As 0045, with the rehearsal's reveals counted and deleted.
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
           'reveals', (SELECT count(*) FROM category_reveal r WHERE r.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  DELETE FROM category_bonus b WHERE b.enrollment_id = ANY (accounts);
  DELETE FROM category_reveal r WHERE r.enrollment_id = ANY (accounts);
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

-- As 0045, plus: the account's reveals are deleted.
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
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
