-- A batch of review follow-ups (docs/FOLLOWUPS.md, 2026-11-06 batch 7; ADR-800 to ADR-802). Nothing here writes points,
-- changes what a sign-in does or touches a redemption. Seven restated functions keep their arguments, results and grants
-- (internal or the API role's door, closed to PUBLIC next to each); one new column on `change_set`, one new foreign key
-- and one new index on `sponsor_tag`. No new table, no new function. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration alters, up front, in one order: the event is the new foreign key's target.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE change_set IN ACCESS EXCLUSIVE MODE;
LOCK TABLE sponsor_tag IN ACCESS EXCLUSIVE MODE;

-- ================================================================ Prepare's lock order (T-710)
-- As 0144, with one change: the numbers' open challenges end before the reviewer's player row is locked. An SMS sign-in
-- on the reviewer number holds its challenge and then needs a key-share lock on that row, so Prepare locking the row
-- first and the challenge second could deadlock (40P01). The later call stays for a challenge opened during Prepare,
-- which no sign-in can hold yet: its code has not been typed.
CREATE OR REPLACE FUNCTION console_review_demo_prepare(phone text, key bytea, fp bytea, code bytea, days integer, version text,
                                            request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  demo   review_demo;
  target player;
BEGIN
  IF days IS NULL OR days NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'a review window is 1 to 30 days' USING ERRCODE = 'RD400', DETAIL = 'days';
  END IF;
  IF version IS NULL OR length(btrim(version)) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'the version is 1 to 20 characters' USING ERRCODE = 'RD400', DETAIL = 'version';
  END IF;
  IF code IS NULL OR octet_length(code) <> 32 THEN
    RAISE EXCEPTION 'a code hash is required' USING ERRCODE = 'RD400', DETAIL = 'code';
  END IF;
  SELECT d.* INTO demo FROM review_demo d FOR UPDATE;
  IF demo.id IS NULL THEN
    RAISE EXCEPTION 'no review demo' USING ERRCODE = 'RD404';
  END IF;
  IF phone IS DISTINCT FROM demo.contact THEN
    RAISE EXCEPTION 'the reviewer number changed' USING ERRCODE = 'RD409', DETAIL = 'stale';
  END IF;
  PERFORM review_demo_check_contact(demo.contact);
  PERFORM review_demo_cancel_challenges(demo.contact_key);
  PERFORM review_demo_cancel_challenges(key);
  IF demo.player_id IS NOT NULL THEN
    target := erase_target(demo.player_id);
    IF target.status <> 'deleted' THEN
      PERFORM erase_account(target, demo.contact_key, true, NULL);
    END IF;
  END IF;
  UPDATE review_demo
  SET contact_key = key, contact_fp = fp, code_hash = code, window_until = now() + make_interval(days => days),
      prepared_for = btrim(version), prepared_at = now(), prepared_by = me;
  PERFORM review_demo_cancel_challenges(demo.contact_key);
  PERFORM review_demo_cancel_challenges(key);
  PERFORM review_demo_provision();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, demo.organizer_id, 'review_demo.prepare', 'review_demo', demo.event_id::text,
          jsonb_build_object('version', btrim(version), 'windowUntil', now() + make_interval(days => days)), request);
  RETURN console_review_demo();
END $$;
REVOKE ALL ON FUNCTION console_review_demo_prepare(text, bytea, bytea, bytea, integer, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_review_demo_prepare(text, bytea, bytea, bytea, integer, text, uuid) TO questify_app;

-- ================================================================ two self-erases of one player (T-708)
-- As 0129, with one change: every deletion challenge of the player is locked in id order before anything else, as
-- erase_target does (with NOWAIT there). A self-erase holding its own challenge and then deleting the others could
-- deadlock (40P01) against one doing the same from another challenge. The second now waits, then finds its challenge
-- gone (expired) or, for the same token, the tombstone (replayed). The owner is read without a lock: a challenge with no
-- owner (a tombstone) locks nothing here.
CREATE OR REPLACE FUNCTION erase_player(deletion bytea, forfeit boolean, request uuid)
  RETURNS TABLE (outcome text, player_id uuid, events uuid[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held  player_deletion_challenge%ROWTYPE;
  owner uuid;
  me    player%ROWTYPE;
  done  record;
BEGIN
  SELECT c.player_id INTO owner FROM player_deletion_challenge c WHERE c.deletion_hash = deletion;
  PERFORM 1 FROM player_deletion_challenge c WHERE c.player_id = owner ORDER BY c.id FOR UPDATE;
  SELECT c.* INTO held FROM player_deletion_challenge c WHERE c.deletion_hash = deletion FOR UPDATE;
  IF FOUND AND held.erased_at IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  IF NOT FOUND OR held.deletion_expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  SELECT p.* INTO me FROM player p WHERE p.id = held.player_id FOR UPDATE;
  IF me.status NOT IN ('active', 'banned') THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  SELECT * INTO done FROM erase_account(me, held.contact_key, forfeit, held.id);
  IF done.outcome = 'handover_pending' THEN
    RETURN QUERY SELECT 'handover_pending'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.delete', 'player', me.id::text,
          jsonb_build_object('events', done.enrolled, 'forfeited', done.forfeited, 'marks', done.marks), request);
  RETURN QUERY SELECT 'erased'::text, me.id, done.events;
END $$;
REVOKE ALL ON FUNCTION erase_player(bytea, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_player(bytea, boolean, uuid) TO questify_app;

-- ================================================================ a change set's apply claim (T-604b, ADR-800)
-- While set, an apply is working through the set and another apply or a close answers busy. It replaces a session
-- advisory lock that kept one pooled connection for the whole apply while each item took a second one. A process that
-- dies leaves it to run out; a late overlap cannot apply an item twice, because an item's decision commits with its
-- write and takes the item only while it is pending. Writable by the API's role alone, through the set's own policy.
ALTER TABLE change_set ADD COLUMN applying_until timestamptz;
GRANT UPDATE (applying_until) ON change_set TO questify_app;

-- ================================================================ sponsor tags (T-507)
-- A tag's organizer is its event's organizer, by the database as well as by the door that writes it.
ALTER TABLE sponsor_tag
  ADD CONSTRAINT sponsor_tag_event_fk
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE;
CREATE INDEX sponsor_tag_event ON sponsor_tag (event_id, organizer_id);

-- As 0088, with one change: the count a deletion reports leaves out tags on removed rewards, which sponsor_team_item
-- does not list either, so the number matches what the dialog showed.
CREATE OR REPLACE FUNCTION sponsor_delete(target_event uuid, target_sponsor uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := sponsor_event_for_write(target_event);
  lost integer;
BEGIN
  SELECT count(*)::integer INTO lost FROM sponsor_tag t
  WHERE t.sponsor_id = target_sponsor AND t.event_id = ev.id
    AND (t.kind <> 'reward' OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'));
  DELETE FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'SO404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.delete', 'sponsor', target_sponsor::text,
          jsonb_build_object('tags', lost), request);
  RETURN lost;
END $$;
REVOKE ALL ON FUNCTION sponsor_delete(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sponsor_delete(uuid, uuid, uuid) TO questify_app;

-- ================================================================ the rehearsal's points (T-505b, ADR-801)
-- Read-only reporting: both sums now take the same list. `session` and `adjust` were missing from the wipe's summary (a
-- rehearsal's session points were on the card and not in the summary); `streak` and `community` were missing from both
-- (neither is paid in a rehearsal today, but a sum must not hide a row). The wipe itself is as 0107.
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
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal', 'bonus', 'first_bonus',
                                                                       'session', 'adjust', 'streak', 'community')), 0),
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
  DELETE FROM desk_sale s WHERE s.enrollment_id = ANY (accounts);
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
END $$;
REVOKE ALL ON FUNCTION wipe_rehearsal(uuid, text, uuid) FROM PUBLIC;

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
            AND l.kind IN ('quest', 'award', 'removal', 'bonus', 'first_bonus', 'session', 'adjust', 'streak',
                           'community')),
         (SELECT count(*)::integer FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM flag f JOIN enrollment n ON n.id = f.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         coalesce(r.first_play_at, (SELECT min(l.created_at) FROM ledger_entry l
                                    WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest')),
         r.erased_at, r.erase_counts, r.live_wiped_at
  FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
END $$;
REVOKE ALL ON FUNCTION rehearsal_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rehearsal_card(uuid) TO questify_app;

-- ================================================================ a held reward's name (T-705b, Q-397)
-- As 0054, with one change: a player no longer reads the name of a reward Questify unpublished in a goal's unlock marker,
-- as for a reward outside their audience. A held quest was already left out (a hold keeps it hidden). The team's own
-- `community_goals` keeps the name: the team sees its held items and the reason on its own lists (ADR-434).
CREATE OR REPLACE FUNCTION community_unlock_target(step community_step, member uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN step.unlock_quest_id IS NOT NULL THEN
      (SELECT jsonb_build_object('kind', 'quest', 'id', q.id, 'name', jsonb_build_object('ar', q.title_ar, 'en', q.title_en))
       FROM quest q JOIN category c ON c.id = q.category_id
       WHERE q.id = step.unlock_quest_id AND q.visible AND sees_category(member, c))
    WHEN step.unlock_category_id IS NOT NULL THEN
      (SELECT jsonb_build_object('kind', 'category', 'id', c.id, 'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en))
       FROM category c WHERE c.id = step.unlock_category_id AND sees_category(member, c))
    WHEN step.unlock_reward_id IS NOT NULL THEN
      (SELECT jsonb_build_object('kind', 'reward', 'id', r.id, 'name', jsonb_build_object('ar', r.name_ar, 'en', r.name_en))
       FROM reward r
       WHERE r.id = step.unlock_reward_id AND r.status = 'active' AND r.held_at IS NULL
         AND in_audience(member, r.audience_kind, r.audience_field_id, r.audience_values))
  END
$$;
REVOKE ALL ON FUNCTION community_unlock_target(community_step, uuid) FROM PUBLIC;

-- ================================================================ duplicating the big screen (T-601, ADR-802)
-- As 0143, with one change: the scenes are copied only from an event that holds the add-on. The new event never holds it
-- at this moment (Questify unlocks it per event), so gating on the new event would lose an add-on buyer's scenes.
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
  -- A tag on a reward that was removed has nothing to point at, and a souvenir's rule is not copied.
  INSERT INTO sponsor_tag (id, organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, created_by)
  SELECT copy_id(t.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(t.sponsor_id, tgt.id), t.kind,
         copy_id(t.quest_id, tgt.id), copy_id(t.category_id, tgt.id), copy_id(t.reward_id, tgt.id), who
  FROM sponsor_tag t
  WHERE t.event_id = src.id AND t.kind <> 'souvenir'
    AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = t.quest_id AND d.deleted_at IS NOT NULL)
    AND (t.reward_id IS NULL OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'));
  GET DIAGNOSTICS tags = ROW_COUNT;

  INSERT INTO big_screen (event_id, organizer_id, scenes, updated_by)
  SELECT tgt.id, tgt.organizer_id, b.scenes, who FROM big_screen b
  WHERE b.event_id = src.id
    AND EXISTS (SELECT 1 FROM event_entitlement x WHERE x.event_id = src.id AND x.feature = 'bigScreen');

  RETURN jsonb_build_object('sessions', sessions, 'maps', maps, 'pins', pins, 'sponsors', sponsors,
                            'sponsorTags', tags);
END $$;
REVOKE ALL ON FUNCTION event_copy_extras(event, event, interval) FROM PUBLIC;
