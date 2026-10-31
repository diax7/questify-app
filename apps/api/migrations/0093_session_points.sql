-- T-505b: a session's points on check-in and the session bulk-award target (FR-1791, FR-1712; plan
-- docs/plans/2026-10-31-t-505b-t-602c-points-doors.md, plan review 86 folded; ADR-382). A session carries `points`
-- (0 = none); the door pays them once per player and session as ledger kind `session`, written by the operator who
-- checked the player in, in the same transaction as the attendance. The pair (session, enrollment) is the payment's
-- idempotency key (a unique index), so no client key can pay twice. The door is now a points door: it refuses while the
-- agenda switch is off (AG403) and outside the player's play phase (QN403), and pays nobody who may not play. The bulk
-- award gains a third target, everyone checked in to a session, filtered by the same helper its preview counts with.
-- Deny by default: no new table; every new function is closed to PUBLIC and only the doors are granted to the API role.
-- No EXCEPTION block. Migrations 0092 and earlier untouched: what changes is restated here.
SET LOCAL lock_timeout = '10s';
-- In live-path order: the door locks the session, then the enrollment (the ledger trigger), then writes the entry; a
-- bulk award locks enrollments, writes its row, then the entries.
LOCK TABLE event_session IN ACCESS EXCLUSIVE MODE;
LOCK TABLE enrollment IN EXCLUSIVE MODE;
LOCK TABLE bulk_award IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ledger_entry IN ACCESS EXCLUSIVE MODE;

-- ================================================================ the data
ALTER TABLE event_session
  ADD COLUMN points integer NOT NULL DEFAULT 0 CONSTRAINT event_session_points CHECK (points BETWEEN 0 AND 100000);

-- A session entry names its session and the operator who checked the player in, and nothing else; it moves the score
-- and the balance alike (an award's shape). A removal copies the session of the entry it reverses so its line names it.
ALTER TABLE ledger_entry ADD COLUMN session_id uuid;
ALTER TABLE ledger_entry
  ADD CONSTRAINT ledger_entry_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES event_session (id, event_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal', 'bonus',
                  'community', 'first_bonus', 'streak', 'session')) NOT VALID;
-- Plan review 86, MAJOR 1: without `session` here every session entry fails with 23514.
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_operator_quests_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_operator_quests_only
  CHECK (actor <> 'operator' OR kind IN ('quest', 'handover', 'redeem_return', 'award', 'session')) NOT VALID;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_session_shape
  CHECK (kind <> 'session' OR (session_id IS NOT NULL AND operator_id IS NOT NULL AND actor = 'operator'
                               AND score_delta > 0 AND balance_delta = score_delta AND completion_id IS NULL
                               AND quest_id IS NULL AND category_id IS NULL AND community_step_id IS NULL
                               AND redemption_id IS NULL AND boost_id IS NULL AND reverses IS NULL)) NOT VALID;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_session_kinds
  CHECK (session_id IS NULL OR kind IN ('session', 'removal')) NOT VALID;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_session_fkey;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_operator_quests_only;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_session_shape;
ALTER TABLE ledger_entry VALIDATE CONSTRAINT ledger_entry_session_kinds;
-- The payment's key: one session entry per player and session, whatever happens to the attendance row.
CREATE UNIQUE INDEX ledger_entry_session_key ON ledger_entry (session_id, enrollment_id) WHERE kind = 'session';
-- Plan review 86, MAJOR 2: the foreign-key check of a session delete and session_delete's "paid" lookup.
CREATE INDEX ledger_entry_session_idx ON ledger_entry (session_id) WHERE session_id IS NOT NULL;

-- A bulk award may name the session whose attendees it reached. The row outlives a session deleted after a rehearsal
-- wipe (the session is forgotten, the record stays), as it outlives a quest.
ALTER TABLE bulk_award
  ADD COLUMN session_id uuid,
  ADD CONSTRAINT bulk_award_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES event_session (id, event_id)
    ON DELETE SET NULL (session_id),
  ADD CONSTRAINT bulk_award_one_target CHECK (quest_id IS NULL OR session_id IS NULL);
CREATE INDEX bulk_award_session_idx ON bulk_award (session_id) WHERE session_id IS NOT NULL;

-- ================================================================ the ledger's guard and readers know the kind
-- The repair mark for a door that moved points outside a quest completion. mark_ranking_repair marks only for the system
-- or an enrolled reader, so called by an operator or a staff user it marks nothing; this marks always. Internal.
CREATE FUNCTION ranking_repair_mark(target uuid) RETURNS void
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO ranking_repair (event_id) VALUES (target) ON CONFLICT (event_id) DO UPDATE SET marked_at = now()
$$;
REVOKE ALL ON FUNCTION ranking_repair_mark(uuid) FROM PUBLIC;

-- As 0068, with the session's points: an operator not allowed to play earns none.
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal
     AND NEW.kind IN ('quest', 'redeem', 'award', 'bonus', 'community', 'first_bonus', 'streak', 'session')
     AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- As 0068, with the session's points removable (the removal copies the session). Removing them never removes the
-- attendance: the player stays checked in and is never paid for that session again (ADR-382).
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus', 'streak', 'session') THEN
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
                            quest_id, category_id, community_step_id, actor, staff_user_id, reverses, boost_id,
                            session_id)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, credit.community_step_id, 'staff', me, credit.id, credit.boost_id, credit.session_id)
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
  PERFORM ranking_repair_mark(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false, credit_item_state(given);
END $$;

-- As 0068, with the session's title on a session line and on its removal. Same output.
CREATE OR REPLACE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, multiplier integer, bonus_slots integer, streak_days integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar, es.title_ar, es.title_en),
         coalesce(q.title_en, r.name_en, k.name_en, i.name_en, g.name_en, cg.title_en, es.title_en, es.title_ar),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus' THEN fb.slots END,
         sd.days
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
  LEFT JOIN event_session es ON es.id = l.session_id
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = l.quest_id AND l.kind = 'first_bonus'
  LEFT JOIN event_streak_day sd ON sd.entry_id = l.id AND l.kind = 'streak'
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;

-- As 0068, with the session's points removable and the session's title on its line and its removal. Same output.
CREATE OR REPLACE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean, multiplier integer, bonus_slots integer, bonus_place integer,
                 streak_days integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar, es.title_ar, es.title_en),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en, cg.title_en, es.title_en, es.title_ar),
         coalesce(n.reason, b.reason),
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
END $$;

-- As 0062, with the session's points in the rehearsal's points (plan review 86, MINOR 4).
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
          WHERE l.event_id = ev.id AND l.rehearsal
            AND l.kind IN ('quest', 'award', 'removal', 'bonus', 'first_bonus', 'session')),
         (SELECT count(*)::integer FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM flag f JOIN enrollment n ON n.id = f.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         coalesce(r.first_play_at, (SELECT min(l.created_at) FROM ledger_entry l
                                    WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest')),
         r.erased_at, r.erase_counts, r.live_wiped_at
  FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
END $$;

-- ================================================================ the session's points in the team's doors
-- As 0086, with `points` (0 to 100000; missing is 0).
CREATE OR REPLACE FUNCTION session_write(ev event, target uuid, draft jsonb) RETURNS uuid
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  existing  event_session;
  made      uuid := coalesce(target, gen_random_uuid());
  new_kind  text := CASE WHEN jsonb_typeof(draft) = 'object' AND jsonb_typeof(draft -> 'kind') = 'string'
                         THEN draft ->> 'kind' END;
  new_access text := CASE WHEN jsonb_typeof(draft) = 'object' AND jsonb_typeof(draft -> 'access') = 'string'
                          THEN draft ->> 'access' END;
  t_ar      text;
  t_en      text;
  starts    timestamptz;
  ends      timestamptz;
  new_seats integer;
  closes    timestamptz;
  walk      boolean;
  quest     uuid;
  registered integer;
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'check the session' USING ERRCODE = 'PS422', DETAIL = 'session';
  ELSIF new_kind IS NULL OR new_kind NOT IN ('talk', 'workshop', 'activity') THEN
    RAISE EXCEPTION 'check the session''s kind' USING ERRCODE = 'PS422', DETAIL = 'kind';
  ELSIF new_access IS NULL OR new_access NOT IN ('open', 'registration') THEN
    RAISE EXCEPTION 'check the session''s access' USING ERRCODE = 'PS422', DETAIL = 'access';
  END IF;
  t_ar := session_text(draft, 'titleAr', 120, false);
  t_en := session_text(draft, 'titleEn', 120, false);
  IF t_ar IS NULL AND t_en IS NULL THEN
    RAISE EXCEPTION 'a title is required' USING ERRCODE = 'PS422', DETAIL = 'title';
  END IF;
  starts := session_time(draft, 'startsAt', true);
  ends := session_time(draft, 'endsAt', true);
  IF ends <= starts THEN
    RAISE EXCEPTION 'the session must end after it starts' USING ERRCODE = 'PS422', DETAIL = 'endsAt:before_start';
  ELSIF ends - starts > interval '24 hours' THEN
    RAISE EXCEPTION 'a session lasts at most 24 hours' USING ERRCODE = 'PS422', DETAIL = 'endsAt:too_long';
  ELSIF (ev.starts_at IS NOT NULL AND starts < ev.starts_at) OR (ev.ends_at IS NOT NULL AND ends > ev.ends_at) THEN
    RAISE EXCEPTION 'the session is outside the event' USING ERRCODE = 'PS422', DETAIL = 'startsAt:outside_event';
  END IF;
  new_seats := CASE WHEN new_access = 'registration' THEN session_int(draft, 'seats', 1, 100000) END;
  closes := CASE WHEN new_access = 'registration' THEN session_time(draft, 'closesAt', false) END;
  IF closes > starts THEN
    RAISE EXCEPTION 'registration closes by the start' USING ERRCODE = 'PS422', DETAIL = 'closesAt';
  END IF;
  walk := new_access = 'registration' AND coalesce(draft -> 'walkIns' = 'true'::jsonb, false);
  IF coalesce(jsonb_typeof(draft -> 'questId'), 'null') <> 'null' THEN
    IF jsonb_typeof(draft -> 'questId') <> 'string'
       OR (draft ->> 'questId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'check the session''s quest' USING ERRCODE = 'PS422', DETAIL = 'questId';
    END IF;
    SELECT q.id INTO quest FROM quest q WHERE q.id = (draft ->> 'questId')::uuid AND q.event_id = ev.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'PS422', DETAIL = 'questId';
    END IF;
  END IF;
  IF target IS NULL THEN
    IF (SELECT count(*) FROM event_session s WHERE s.event_id = ev.id) >= 1000 THEN
      RAISE EXCEPTION 'an event holds at most 1,000 sessions' USING ERRCODE = 'PS409', DETAIL = 'limit';
    END IF;
  ELSE
    SELECT s.* INTO existing FROM event_session s WHERE s.id = target AND s.event_id = ev.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
    END IF;
    SELECT count(*)::integer INTO registered FROM session_registration r WHERE r.session_id = existing.id;
    IF new_access = 'open' AND registered > 0 THEN
      RAISE EXCEPTION 'players are registered' USING ERRCODE = 'PS409', DETAIL = 'has_registrations';
    ELSIF new_seats IS NOT NULL AND new_seats < registered THEN
      RAISE EXCEPTION '% are registered', registered USING ERRCODE = 'PS409', DETAIL = 'seats_below:' || registered;
    END IF;
  END IF;
  IF target IS NULL THEN
    INSERT INTO event_session (id, organizer_id, event_id, kind, title_ar, title_en, description_ar, description_en,
                               place_ar, place_en, speakers, starts_at, ends_at, access, seats, closes_at, walk_ins,
                               reminder_minutes, quest_id, points, created_by)
    VALUES (made, ev.organizer_id, ev.id, new_kind, t_ar, t_en, session_text(draft, 'descriptionAr', 2000, true),
            session_text(draft, 'descriptionEn', 2000, true), session_text(draft, 'placeAr', 120, false),
            session_text(draft, 'placeEn', 120, false), session_speakers(draft), starts, ends, new_access, new_seats,
            closes, walk, coalesce(session_int(draft, 'reminderMinutes', 1, 1440), 15), quest,
            coalesce(session_int(draft, 'points', 0, 100000), 0), app_staff_user_id());
  ELSE
    UPDATE event_session SET kind = new_kind, title_ar = t_ar, title_en = t_en,
      description_ar = session_text(draft, 'descriptionAr', 2000, true),
      description_en = session_text(draft, 'descriptionEn', 2000, true), place_ar = session_text(draft, 'placeAr', 120, false),
      place_en = session_text(draft, 'placeEn', 120, false), speakers = session_speakers(draft), starts_at = starts,
      ends_at = ends, access = new_access, seats = new_seats, closes_at = closes, walk_ins = walk,
      reminder_minutes = coalesce(session_int(draft, 'reminderMinutes', 1, 1440), 15), quest_id = quest,
      points = coalesce(session_int(draft, 'points', 0, 100000), 0), updated_at = now()
    WHERE id = made;
  END IF;
  RETURN made;
END $$;

-- As 0086, with `points`.
CREATE OR REPLACE FUNCTION session_team_item(s event_session) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'kind', s.kind, 'titleAr', s.title_ar, 'titleEn', s.title_en, 'descriptionAr', s.description_ar,
    'descriptionEn', s.description_en, 'placeAr', s.place_ar, 'placeEn', s.place_en, 'speakers', to_jsonb(s.speakers),
    'startsAt', s.starts_at, 'endsAt', s.ends_at, 'access', s.access, 'seats', s.seats, 'closesAt', s.closes_at,
    'registrationOpen', s.registration_open, 'walkIns', s.walk_ins, 'reminderMinutes', s.reminder_minutes,
    'questId', s.quest_id, 'points', s.points,
    'registered', (SELECT count(*) FROM session_registration r WHERE r.session_id = s.id),
    'attended', (SELECT count(*) FROM session_attendance a WHERE a.session_id = s.id),
    'walkInCount', (SELECT count(*) FROM session_attendance a WHERE a.session_id = s.id AND a.walk_in),
    'noShows', CASE WHEN now() < s.starts_at THEN 0 ELSE
                 (SELECT count(*) FROM session_registration r
                  WHERE r.session_id = s.id
                    AND NOT EXISTS (SELECT 1 FROM session_attendance a
                                    WHERE a.session_id = s.id AND a.player_id = r.player_id)) END)
$$;

-- As 0086, with the points in the audit: `before` (an edit's earlier points) and `after` (plan review 86, MINOR 7).
-- An edit locks the session first, so `before` is the value the edit replaced. Editing the points changes future
-- check-ins only; what was paid stays (the ledger is append-only).
CREATE OR REPLACE FUNCTION session_save(target_event uuid, draft jsonb, target_session uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := award_event_of(target_event);
  made uuid;
  was  integer;
  item event_session;
BEGIN
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR SHARE;
  ev := award_event_of(target_event);
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  END IF;
  IF target_session IS NOT NULL THEN
    SELECT s.points INTO was FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id FOR UPDATE;
  END IF;
  made := session_write(ev, target_session, draft);
  SELECT s.* INTO item FROM event_session s WHERE s.id = made;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.save', 'event_session', made::text,
          CASE WHEN target_session IS NOT NULL THEN jsonb_build_object('points', was) END,
          jsonb_build_object('created', target_session IS NULL, 'kind', item.kind, 'access', item.access,
                             'points', item.points), request);
  RETURN session_team_item(item);
END $$;

-- As 0086, under the event's share lock (as session_save): an archived event is PE409 `event_closed`, and a session
-- whose points were paid is PS409 `has_attendance` too (the entries name it; the ledger is never rewritten).
CREATE OR REPLACE FUNCTION session_delete(target_event uuid, target_session uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  existing   event_session;
  registered integer;
BEGIN
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR SHARE;
  ev := award_event_of(target_event);
  SELECT s.* INTO existing FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  ELSIF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'PE409', DETAIL = 'event_closed';
  ELSIF EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = existing.id)
        OR EXISTS (SELECT 1 FROM ledger_entry l WHERE l.session_id = existing.id) THEN
    RAISE EXCEPTION 'players were checked in' USING ERRCODE = 'PS409', DETAIL = 'has_attendance';
  END IF;
  SELECT count(*)::integer INTO registered FROM session_registration r WHERE r.session_id = existing.id;
  DELETE FROM event_session WHERE id = existing.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'session.delete', 'event_session', existing.id::text,
          jsonb_build_object('registrations', registered), request);
  RETURN registered;
END $$;

-- As 0092, with the session's points copied.
CREATE OR REPLACE FUNCTION event_copy_extras(src event, tgt event, shift interval) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
         copy_id(s.quest_id, tgt.id), s.points, who
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
  FROM map_pin p WHERE p.event_id = src.id;
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
  WHERE t.event_id = src.id
    AND (t.reward_id IS NULL OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'));
  GET DIAGNOSTICS tags = ROW_COUNT;

  INSERT INTO big_screen (event_id, organizer_id, scenes, updated_by)
  SELECT tgt.id, tgt.organizer_id, b.scenes, who FROM big_screen b WHERE b.event_id = src.id;

  RETURN jsonb_build_object('sessions', sessions, 'maps', maps, 'pins', pins, 'sponsors', sponsors,
                            'sponsorTags', tags);
END $$;

-- ================================================================ the session's points in the player's doors
-- As 0086, with `points` on each session.
CREATE OR REPLACE FUNCTION member_sessions(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := session_member(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.starts_at, x.id)
    FROM (SELECT s.id, s.starts_at, jsonb_build_object(
            'id', s.id, 'kind', s.kind,
            'title', jsonb_build_object('ar', coalesce(s.title_ar, s.title_en), 'en', coalesce(s.title_en, s.title_ar)),
            'description', jsonb_build_object('ar', coalesce(s.description_ar, s.description_en),
                                              'en', coalesce(s.description_en, s.description_ar)),
            'place', jsonb_build_object('ar', coalesce(s.place_ar, s.place_en), 'en', coalesce(s.place_en, s.place_ar)),
            'speakers', to_jsonb(s.speakers), 'startsAt', s.starts_at, 'endsAt', s.ends_at, 'access', s.access,
            'seats', s.seats, 'seatsLeft', CASE WHEN s.seats IS NULL THEN NULL ELSE greatest(s.seats - c.n, 0) END,
            'points', s.points,
            'registered', me.id IS NOT NULL, 'checkedIn', att.id IS NOT NULL,
            'started', now() >= s.starts_at,
            'cancellable', me.id IS NOT NULL AND att.id IS NULL AND now() < s.starts_at,
            'status', CASE WHEN s.access = 'open' THEN 'open'
                           WHEN me.id IS NOT NULL THEN 'registered'
                           WHEN now() >= s.starts_at OR NOT s.registration_open
                                OR (s.closes_at IS NOT NULL AND now() >= s.closes_at) THEN 'closed'
                           WHEN s.seats IS NOT NULL AND c.n >= s.seats THEN 'full'
                           ELSE 'available' END,
            'quest', CASE WHEN q.id IS NULL THEN NULL ELSE jsonb_build_object(
                       'id', q.id, 'title', jsonb_build_object('ar', coalesce(q.title_ar, q.title_en),
                                                               'en', coalesce(q.title_en, q.title_ar))) END) AS item
          FROM event_session s
          CROSS JOIN LATERAL (SELECT count(*)::integer AS n FROM session_registration r WHERE r.session_id = s.id) c
          LEFT JOIN session_registration me ON me.session_id = s.id AND me.player_id = member.player_id
          LEFT JOIN session_attendance att ON att.session_id = s.id AND att.player_id = member.player_id
          LEFT JOIN quest q ON q.id = s.quest_id AND q.event_id = s.event_id AND q.visible
          WHERE s.event_id = target_event) x), '[]'::jsonb);
END $$;

-- As 0086, plus PS409 `checked_in`: a player checked in (early, within the hour before the start) keeps the
-- registration the attendance stands on.
CREATE OR REPLACE FUNCTION session_cancel(target_event uuid, target_session uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment;
  target event_session;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  member := session_member(target_event);
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session AND s.event_id = target_event FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  ELSIF now() >= target.starts_at THEN
    RAISE EXCEPTION 'the session has started' USING ERRCODE = 'PS409', DETAIL = 'started';
  ELSIF EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = target.id AND a.player_id = member.player_id)
  THEN
    RAISE EXCEPTION 'already checked in' USING ERRCODE = 'PS409', DETAIL = 'checked_in';
  END IF;
  DELETE FROM session_registration r WHERE r.session_id = target.id AND r.player_id = member.player_id;
  RETURN 'cancelled';
END $$;

-- ================================================================ the door pays (ADR-382)
-- The points a player still holds from a session: the session entry's points, 0 when there is none or a removal
-- reversed it (plan review 86, MINOR 3). Internal.
CREATE FUNCTION session_points_held(target_session uuid, target_enrollment uuid) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT l.score_delta::integer FROM ledger_entry l
                   WHERE l.session_id = target_session AND l.enrollment_id = target_enrollment AND l.kind = 'session'
                     AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = l.id)), 0)
$$;
REVOKE ALL ON FUNCTION session_points_held(uuid, uuid) FROM PUBLIC;

-- Whether a member may receive points: a rehearsal account always (the play switch governs the live game), anyone
-- else unless they staff the event without leave to play (FR-906). Internal.
CREATE FUNCTION member_may_play(ev event, member enrollment) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT member.joined_via IS NOT DISTINCT FROM 'rehearsal'
      OR NOT EXISTS (SELECT 1 FROM staff_assignment sa
                     WHERE sa.event_id = ev.id AND sa.player_id = member.player_id AND NOT sa.can_play)
$$;
REVOKE ALL ON FUNCTION member_may_play(event, enrollment) FROM PUBLIC;

-- As 0086, and the door now pays the session's points (FR-1791). In this order: the session FOR SHARE (a delete or an
-- edit waits for the check-in to commit, so the points paid are the committed value and a racing delete ends as
-- SS404 or PS409, never 23503); the operator's checks as before; the agenda switch (AG403 `feature_off`); the scanned
-- player's code, enrollment and account (QC403 for either not active, plan review 86 MINOR 5); the event's phase (QN403
-- `event_not_live`: scheduled or live for real players, because the door opens an hour before a session and a session
-- cannot start before its event; before go-live for rehearsal accounts); then the outcomes as before. A new
-- attendance pays `points` when the session has any and the player may play (a staff member who may not play is
-- checked in with 0). `already` carries the points the player still holds from the session. Each answer that names
-- the player carries `points` once the time window is passed.
CREATE OR REPLACE FUNCTION session_check_in(target_session uuid, scanned uuid, scanned_version integer) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  target     event_session;
  assignment staff_assignment;
  ev         event;
  current    integer;
  member     enrollment;
  who        jsonb;
  registered boolean;
  walk       boolean;
  made       uuid;
  paid       integer := 0;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO target FROM event_session s WHERE s.id = target_session FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such session' USING ERRCODE = 'SS404';
  END IF;
  SELECT sa.* INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = target.event_id AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  ELSIF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  ELSIF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id) THEN
    RAISE EXCEPTION 'this operator works quest stations' USING ERRCODE = 'OS403';
  ELSIF scanned = me THEN
    RAISE EXCEPTION 'an operator cannot scan their own code' USING ERRCODE = 'OY409';
  END IF;
  PERFORM ensure_rehearsal_wiped(target.event_id);
  SELECT e.* INTO ev FROM event e WHERE e.id = target.event_id;
  IF NOT feature_enabled(ev, 'agenda') THEN
    RAISE EXCEPTION 'the agenda is switched off' USING ERRCODE = 'AG403', DETAIL = 'feature_off';
  END IF;
  SELECT p.my_qr_version INTO current FROM player p WHERE p.id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  ELSIF current IS DISTINCT FROM scanned_version THEN
    RAISE EXCEPTION 'an earlier My QR' USING ERRCODE = 'OM422';
  END IF;
  SELECT n.* INTO member FROM enrollment n WHERE n.event_id = target.event_id AND n.player_id = scanned;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QC404';
  ELSIF member.status <> 'active' THEN
    RAISE EXCEPTION 'the enrollment is not active' USING ERRCODE = 'QC403', DETAIL = member.status;
  ELSIF NOT EXISTS (SELECT 1 FROM player p WHERE p.id = scanned AND p.status = 'active') THEN
    RAISE EXCEPTION 'the account is not active' USING ERRCODE = 'QC403', DETAIL = 'account';
  ELSIF NOT (CASE WHEN member.joined_via IS NOT DISTINCT FROM 'rehearsal'
                  THEN play_phase(ev, member) IS NOT NULL
                  ELSE event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('scheduled', 'live') END) THEN
    RAISE EXCEPTION 'the event is not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  SELECT jsonb_build_object('username', p.username, 'avatar', p.avatar) INTO who FROM player p WHERE p.id = scanned;
  IF now() < target.starts_at - interval '1 hour' THEN
    RETURN jsonb_build_object('outcome', 'too_early', 'player', who);
  ELSIF now() >= target.ends_at THEN
    RETURN jsonb_build_object('outcome', 'ended', 'player', who);
  ELSIF EXISTS (SELECT 1 FROM session_attendance a WHERE a.session_id = target.id AND a.player_id = scanned) THEN
    RETURN jsonb_build_object('outcome', 'already', 'points', session_points_held(target.id, member.id), 'player', who);
  END IF;
  registered := EXISTS (SELECT 1 FROM session_registration r WHERE r.session_id = target.id AND r.player_id = scanned);
  IF target.access = 'registration' AND NOT registered AND NOT target.walk_ins THEN
    RETURN jsonb_build_object('outcome', 'not_registered', 'player', who);
  END IF;
  walk := target.access = 'registration' AND NOT registered;
  INSERT INTO session_attendance (organizer_id, event_id, session_id, enrollment_id, player_id, operator_id, walk_in)
  VALUES (target.organizer_id, target.event_id, target.id, member.id, scanned, me, walk)
  ON CONFLICT (session_id, player_id) DO NOTHING
  RETURNING id INTO made;
  IF made IS NULL THEN
    RETURN jsonb_build_object('outcome', 'already', 'points', session_points_held(target.id, member.id), 'player', who);
  END IF;
  IF target.points > 0 AND member_may_play(ev, member) THEN
    -- A plain insert: a second entry for the pair is a broken invariant and must fail loudly (23505).
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              operator_id, session_id)
    VALUES (target.organizer_id, target.event_id, member.id, 'session', target.points, target.points, 'operator', me,
            target.id);
    paid := target.points;
    PERFORM ranking_repair_mark(ev.id);
  END IF;
  RETURN jsonb_build_object('outcome', 'checked_in', 'walkIn', walk, 'points', paid, 'player', who);
END $$;

-- As 0086, refused while the agenda is switched off (AG403, so the door app shows why), with each session's points.
CREATE OR REPLACE FUNCTION operator_sessions(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment;
  ev         event;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT sa.* INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  ELSIF NOT ('scan_quests' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'scanning is off for this operator' USING ERRCODE = 'OA403';
  ELSIF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id) THEN
    RAISE EXCEPTION 'this operator works quest stations' USING ERRCODE = 'OS403';
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = target_event;
  IF NOT feature_enabled(ev, 'agenda') THEN
    RAISE EXCEPTION 'the agenda is switched off' USING ERRCODE = 'AG403', DETAIL = 'feature_off';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'id', s.id, 'kind', s.kind,
             'title', jsonb_build_object('ar', s.title_ar, 'en', s.title_en),
             'startsAt', s.starts_at, 'endsAt', s.ends_at, 'access', s.access, 'walkIns', s.walk_ins,
             'points', s.points)
           ORDER BY s.starts_at, s.id)
    FROM event_session s
    WHERE s.event_id = target_event AND now() >= s.starts_at - interval '1 hour' AND now() < s.ends_at), '[]'::jsonb);
END $$;

-- ================================================================ the session bulk target (FR-1712)
-- The members a bulk award's final filter keeps, from `candidates`: in the event, active, in the phase's audience
-- (rehearsal accounts before go-live, real members live) and allowed to play. One helper for bulk_award and its
-- session preview, so the preview counts exactly what the award pays (plan review 86, MINOR 7). Internal.
CREATE FUNCTION bulk_award_eligible(ev event, candidates uuid[], rehearsing boolean) RETURNS SETOF uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT n.id FROM enrollment n
  WHERE n.id = ANY (candidates) AND n.event_id = ev.id AND n.status = 'active'
    AND (n.joined_via IS NOT DISTINCT FROM 'rehearsal') = rehearsing
    AND member_may_play(ev, n)
  ORDER BY n.id
$$;
REVOKE ALL ON FUNCTION bulk_award_eligible(event, uuid[], boolean) FROM PUBLIC;

-- Everyone checked in to the session, minus those whose session points were removed (as a quest target drops a removed
-- completion). bulk_award_eligible does the rest. Internal.
CREATE FUNCTION session_bulk_targets(ev event, target_session uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT a.enrollment_id FROM session_attendance a
  WHERE a.session_id = target_session AND a.event_id = ev.id
    AND NOT EXISTS (SELECT 1 FROM ledger_entry l JOIN ledger_entry r ON r.reverses = l.id
                    WHERE l.session_id = target_session AND l.enrollment_id = a.enrollment_id AND l.kind = 'session')
$$;
REVOKE ALL ON FUNCTION session_bulk_targets(event, uuid) FROM PUBLIC;

-- The session target's preview: how many members it reaches now, through the award's own filter, and how many bulk
-- awards this phase already sent to the session (`earlier`; a second one pays everyone again). AN404, SS404.
CREATE FUNCTION session_bulk_count(target_event uuid, target_session uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  rehearsing boolean := event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('draft', 'scheduled');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM event_session s WHERE s.id = target_session AND s.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such session in this event' USING ERRCODE = 'SS404';
  END IF;
  RETURN jsonb_build_object(
    'count', (SELECT count(*) FROM bulk_award_eligible(ev, ARRAY(SELECT session_bulk_targets(ev, target_session)),
                                                       rehearsing)),
    'earlier', (SELECT count(*) FROM bulk_award b
                WHERE b.event_id = ev.id AND b.session_id = target_session AND b.rehearsal = rehearsing));
END $$;
REVOKE ALL ON FUNCTION session_bulk_count(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION session_bulk_count(uuid, uuid) TO questify_app;

-- As 0032, with a third target: exactly one of a list, a quest or a session (AB400 otherwise); SS404 for a session not
-- in the event; the replay compares the session too. The candidates are locked in id order, then filtered by
-- bulk_award_eligible. The entries are the same `award` entries with one note each; the audit names the session.
DROP FUNCTION bulk_award(uuid, uuid[], uuid, integer, text, text, uuid);
CREATE FUNCTION bulk_award(target_event uuid, enrollments uuid[], target_quest uuid, target_session uuid,
                           amount integer, reason text, request_key text, request uuid)
  RETURNS TABLE (bulk_id uuid, awarded integer, skipped integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
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
END $$;
REVOKE ALL ON FUNCTION bulk_award(uuid, uuid[], uuid, uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bulk_award(uuid, uuid[], uuid, uuid, integer, text, text, uuid) TO questify_app;
