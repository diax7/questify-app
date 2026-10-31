-- Pause a quest and skip a broken step (T-603b, FR-1026, ADR-386). An owner or an editor within their event limit pauses
-- an open quest (no new start of any kind is accepted, hand awards included; work already started finishes and pays) and
-- skips a broken step of an in-order category (it no longer holds the steps after it, the category's bonus or a category
-- unlocked after it; it stays completable and pays nobody). Neither writes points. Each is one door, audited, with
-- natural idempotency (setting the state it already has changes nothing and writes no audit row). Deny by default: the
-- new columns carry no grant to the API's role, so only the doors write them; PUBLIC holds no EXECUTE on anything here.
SET LOCAL lock_timeout = '10s';

-- Staff named without a foreign key, as ledger_entry.staff_user_id: a removed team member's pause stays explained.
ALTER TABLE quest
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN paused_by uuid,
  ADD COLUMN skipped_at timestamptz,
  ADD COLUMN skipped_by uuid,
  ADD CONSTRAINT quest_paused_named CHECK ((paused_at IS NULL) = (paused_by IS NULL)),
  ADD CONSTRAINT quest_skipped_named CHECK ((skipped_at IS NULL) = (skipped_by IS NULL));

-- A skip lives only in an in-order category: a quest moved to another category loses it.
CREATE FUNCTION quest_skip_moved() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    NEW.skipped_at := NULL;
    NEW.skipped_by := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_skip_moved() FROM PUBLIC;
CREATE TRIGGER quest_skip_moved BEFORE UPDATE OF category_id ON quest
  FOR EACH ROW WHEN (OLD.skipped_at IS NOT NULL) EXECUTE FUNCTION quest_skip_moved();

-- ... and a category switched to any order clears its quests' skips. Definer: the API's role switches the order but
-- holds no grant on the skip columns.
CREATE FUNCTION category_skip_cleared() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE quest q SET skipped_at = NULL, skipped_by = NULL
  WHERE q.category_id = NEW.id AND q.skipped_at IS NOT NULL;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION category_skip_cleared() FROM PUBLIC;
CREATE TRIGGER category_skip_cleared AFTER UPDATE OF order_mode ON category
  FOR EACH ROW WHEN (NEW.order_mode <> 'in_order') EXECUTE FUNCTION category_skip_cleared();

-- The quest of this event for the team's room doors, locked FOR UPDATE; the event not ended or archived (as the builder:
-- QE409 event_closed). AQ404 for a quest outside the event.
CREATE FUNCTION room_quest(ev event, target_quest uuid) RETURNS quest
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  found_row quest%ROWTYPE;
BEGIN
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'QE409', DETAIL = 'event_closed';
  END IF;
  SELECT q.* INTO found_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  RETURN found_row;
END $$;
REVOKE ALL ON FUNCTION room_quest(event, uuid) FROM PUBLIC;

-- Pauses (`paused` true) or resumes a quest. Open from the rehearsal on, as the control room (ADR-385). The state it
-- already has answers `changed: false` and writes nothing. Audited `quest.pause` / `quest.resume`.
CREATE FUNCTION set_quest_paused(target_event uuid, target_quest uuid, paused boolean, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  me        uuid := app_staff_user_id();
  quest_row quest%ROWTYPE;
BEGIN
  IF paused IS NULL THEN
    RAISE EXCEPTION 'paused is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  quest_row := room_quest(ev, target_quest);
  IF (quest_row.paused_at IS NOT NULL) = paused THEN
    RETURN jsonb_build_object('paused', paused, 'changed', false);
  END IF;
  UPDATE quest q
  SET paused_at = CASE WHEN paused THEN date_trunc('milliseconds', now()) END,
      paused_by = CASE WHEN paused THEN me END
  WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, CASE WHEN paused THEN 'quest.pause' ELSE 'quest.resume' END, 'quest',
          quest_row.id::text, jsonb_build_object('paused', NOT paused), jsonb_build_object('paused', paused), request);
  RETURN jsonb_build_object('paused', paused, 'changed', true);
END $$;
REVOKE ALL ON FUNCTION set_quest_paused(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_quest_paused(uuid, uuid, boolean, uuid) TO questify_app;

-- Skips (`skipped` true) or restores a step of an in-order category: never a flash quest or a live poll, which are
-- outside the order already (SP422 not_in_order). Same idempotency and phase as the pause. Audited `quest.skip` /
-- `quest.unskip`.
CREATE FUNCTION set_step_skipped(target_event uuid, target_quest uuid, skipped boolean, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  me        uuid := app_staff_user_id();
  quest_row quest%ROWTYPE;
BEGIN
  IF skipped IS NULL THEN
    RAISE EXCEPTION 'skipped is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  quest_row := room_quest(ev, target_quest);
  IF skipped AND (quest_row.flash OR is_live_poll(quest_row.type, quest_row.type_config) OR NOT EXISTS (
       SELECT 1 FROM category c WHERE c.id = quest_row.category_id AND c.order_mode = 'in_order')) THEN
    RAISE EXCEPTION 'only a step of an in-order category can be skipped' USING ERRCODE = 'SP422',
      DETAIL = 'not_in_order';
  END IF;
  IF (quest_row.skipped_at IS NOT NULL) = skipped THEN
    RETURN jsonb_build_object('skipped', skipped, 'changed', false);
  END IF;
  UPDATE quest q
  SET skipped_at = CASE WHEN skipped THEN date_trunc('milliseconds', now()) END,
      skipped_by = CASE WHEN skipped THEN me END
  WHERE q.id = quest_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, CASE WHEN skipped THEN 'quest.skip' ELSE 'quest.unskip' END, 'quest',
          quest_row.id::text, jsonb_build_object('skipped', NOT skipped), jsonb_build_object('skipped', skipped),
          request);
  RETURN jsonb_build_object('skipped', skipped, 'changed', true);
END $$;
REVOKE ALL ON FUNCTION set_step_skipped(uuid, uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_step_skipped(uuid, uuid, boolean, uuid) TO questify_app;

-- Each quest's completions (restated from 0096), plus its pause and skip and, for a skipped step, the active members
-- past it who have not done it: restoring the step holds them again at it (the restore's confirmation says how many).
DROP FUNCTION control_done(uuid);
CREATE FUNCTION control_done(target_event uuid)
  RETURNS TABLE (quest_id uuid, done integer, paused boolean, skipped boolean, behind integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  WITH firsts AS (
    SELECT c.quest_id, count(*)::integer AS n FROM quest_completion c
    WHERE c.event_id = ev.id AND c.occurrence = 1
    GROUP BY c.quest_id
  )
  SELECT q.id, coalesce(f.n, 0), q.paused_at IS NOT NULL, q.skipped_at IS NOT NULL,
         CASE WHEN q.skipped_at IS NULL THEN 0 ELSE (
           SELECT count(DISTINCT c.enrollment_id)::integer
           FROM quest_completion c
           JOIN quest later ON later.id = c.quest_id
           JOIN enrollment n ON n.id = c.enrollment_id AND n.status = 'active'
           WHERE later.category_id = q.category_id AND (later.position, later.id) > (q.position, q.id)
             AND NOT later.flash AND NOT is_live_poll(later.type, later.type_config)
             AND NOT EXISTS (SELECT 1 FROM quest_completion m
                             WHERE m.enrollment_id = c.enrollment_id AND m.quest_id = q.id)) END
  FROM quest q
  LEFT JOIN firsts f ON f.quest_id = q.id
  WHERE q.event_id = ev.id AND (f.n IS NOT NULL OR q.paused_at IS NOT NULL OR q.skipped_at IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION control_done(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_done(uuid) TO questify_app;

-- The open check of 0055 with one more argument: a paused quest refuses every start (QN403 paused), right after
-- the hidden check, unless `allow_paused` (a quiz attempt started before the pause goes on to its end, ADR-386).
CREATE FUNCTION quest_open_check(quest_row quest, enrolled enrollment, skip_category boolean,
                                 allow_paused boolean)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  ev        event%ROWTYPE;
  group_row category%ROWTYPE;
  shut      text;
  stored    quest%ROWTYPE;
BEGIN
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF play_phase(ev, enrolled) IS NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  SELECT * INTO stored FROM quest q WHERE q.id = quest_row.id;
  IF NOT FOUND OR NOT stored.visible
     OR (stored.flash_launched_at, stored.poll_sent_at)
        IS DISTINCT FROM (quest_row.flash_launched_at, quest_row.poll_sent_at) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  IF stored.paused_at IS NOT NULL AND NOT allow_paused THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'paused';
  END IF;
  IF stored.flash AND NOT flash_on(ev) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'switched_off';
  END IF;
  IF stored.opens_at IS NOT NULL AND stored.opens_at > now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_started';
  END IF;
  IF stored.closes_at IS NOT NULL AND stored.closes_at <= now() THEN
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
END $$
;
REVOKE ALL ON FUNCTION quest_open_check(quest, enrollment, boolean, boolean) FROM PUBLIC;

-- Restated from 0055: the three-argument check is the four-argument one with the pause enforced.
CREATE OR REPLACE FUNCTION quest_open_check(quest_row quest, enrolled enrollment, skip_category boolean) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM quest_open_check(quest_row, enrolled, skip_category, false);
END $$;


-- Restated from 0041: a quiz attempt already open goes on while the quest is paused (its answers and its end pay
-- what it earned); a new attempt, a vote or a game round is refused.
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


-- Restated from 0055: a skipped step no longer holds the steps after it.
CREATE OR REPLACE FUNCTION public.category_rule_lock(quest_row quest, member uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $$
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
  IF group_row.order_mode = 'in_order' AND NOT quest_row.flash
     AND NOT is_live_poll(quest_row.type, quest_row.type_config) AND EXISTS (
    SELECT 1 FROM quest q
    WHERE q.category_id = group_row.id AND q.visible AND (q.position, q.id) < (quest_row.position, quest_row.id)
      AND (q.closes_at IS NULL OR q.closes_at > now()) AND NOT q.flash AND NOT is_live_poll(q.type, q.type_config)
      AND NOT quest_lock_missed(q) AND q.skipped_at IS NULL
      AND NOT quest_done(member, q.id)) THEN
    RETURN 'order_locked';
  END IF;
  RETURN NULL;
END $$
;


-- Restated from 0055: a skipped step is left out of the category's bonus, as flash quests and live polls.
CREATE OR REPLACE FUNCTION public.category_done(member uuid, target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.category_id = target AND q.visible AND NOT q.flash AND NOT is_live_poll(q.type, q.type_config)
                   AND NOT quest_lock_missed(q)
                   AND q.skipped_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND NOT q.flash
                       AND NOT is_live_poll(q.type, q.type_config) AND NOT quest_lock_missed(q)
                       AND q.skipped_at IS NULL AND NOT quest_done(member, q.id))
$$
;


-- Restated from 0055: a skipped step no longer holds a category unlocked after its own.
CREATE OR REPLACE FUNCTION public.category_cleared(member uuid, target uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM quest q
                     WHERE q.category_id = target AND q.visible AND (q.closes_at IS NULL OR q.closes_at > now())
                       AND NOT q.flash AND NOT is_live_poll(q.type, q.type_config) AND NOT quest_lock_missed(q)
                       AND q.skipped_at IS NULL AND NOT quest_done(member, q.id))
$$
;


-- Restated from 0068 (DROP and CREATE for the new column): `paused`, so the app shows the quest paused and offers no
-- start.
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
 RETURNS TABLE(category_id uuid, category_name_ar text, category_name_en text, category_position integer, quest_id uuid, title_ar text, title_en text, description_ar text, description_en text, type text, points integer, repeat_cap integer, opens_at timestamp with time zone, closes_at timestamp with time zone, quest_position integer, done integer, earned bigint, verification text[], order_mode text, category_opens_at timestamp with time zone, unlock_after uuid, unlock_after_name_ar text, unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean, lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamp with time zone, item_ar text, item_en text, bonus_item_ar text, bonus_item_en text, place_lat numeric, place_lng numeric, place_radius_m integer, daily_cap integer, met_today integer, game_left integer, game_passed boolean, community_lock jsonb, category_community_lock jsonb, flash_closes_at timestamp with time zone, boost jsonb, first_bonus_points integer, first_bonus_slots integer, first_bonus_place integer, paused boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
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
          LEFT JOIN ledger_entry rv ON l.kind = 'removal' AND rv.id = l.reverses
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id AND l.kind <> 'streak'
            AND rv.kind IS DISTINCT FROM 'streak'),
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
         CASE WHEN fs.quest_id IS NOT NULL THEN first_bonus_place(fs) END,
         q.paused_at IS NOT NULL
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
$$
;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;


-- Restated from 0062: a pause or skip tried in the rehearsal never opens the live event paused or skipped (the
-- audit rows stay).
CREATE OR REPLACE FUNCTION public.wipe_rehearsal(target uuid, reason text, request uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
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
  UPDATE quest q SET paused_at = NULL, paused_by = NULL, skipped_at = NULL, skipped_by = NULL
  WHERE q.event_id = target AND (q.paused_at IS NOT NULL OR q.skipped_at IS NOT NULL);
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
END $$
;

