-- The photo wall (T-504b; plan docs/plans/2026-11-12-organizer-images.md sections 4 and 7, ADR-830; FR-635 to FR-637).
-- A player allows one photo submission on screen (`submission.on_screen`, off by default, ADR-084's per-photo choice);
-- the event's team picks up to 20 approved, allowed photos in order (`photo_wall`); the big screen shows them as its
-- `photo` scene and the event's members see the same photos in the app, where each one can be reported (and its owner
-- blocked). No name is shown on the screen; the app names the username only, for Block (M5).
--
-- One rule decides what may show, checked at every read (`photo_wall_ok`): the photo is of this event, approved, a photo
-- kind with its photo still there, allowed on screen, not erased, its player and enrollment active, and neither the photo
-- (`media` hold, new here) nor its quest held by Questify. A withdrawal deletes the pick in the same transaction, and a
-- rejection, a removal or an erasure (the photo let go) deletes it by trigger; a ban, a hold or a quest hold only hides
-- it, so a republish or an unban brings it back.
--
-- Reports and holds take a `media` kind: the target is the `media_object` id; a member may report a photo only while it
-- is on their event's wall (RP404 otherwise); the snapshot keeps the quest's title, never the key. Questify's console
-- reads the key of a reported photo through `admin_report_media_key` and signs it.
--
-- Lock order (rules.md): `set_photo_wall` takes the transaction advisory lock `photo_wall:<event>` (two saves of one
-- event queue, the later one replacing the earlier, never a 23505 on the delete-then-insert), then the event's
-- submissions it names FOR SHARE in id order, then writes `photo_wall` (its inserts key-share those submissions); no
-- other path takes that key; `own_photo_on_screen` takes its submission FOR UPDATE, then
-- deletes its pick; the release trigger runs under the submission's own update. `hold_target('media')` takes the
-- `media_object` row FOR UPDATE and never a submission, so no path holds an object row and then waits on a submission.
--
-- Deny by default: `photo_wall` keeps row-level security forced and no grant; every new function is revoked from PUBLIC
-- in its group, and only the doors are granted to questify_app. Deployed migrations untouched; restated functions say
-- which migration they restate.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the player's choice
ALTER TABLE submission
  ADD COLUMN on_screen boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT submission_on_screen_photo CHECK (kind = 'photo' OR NOT on_screen);
-- The pick's composite key: a pick names a submission of its own event (B1).
CREATE UNIQUE INDEX submission_id_event ON submission (id, event_id);

-- ================================================================ the team's pick
CREATE TABLE photo_wall (
  submission_id bigint PRIMARY KEY,
  event_id      uuid NOT NULL,
  organizer_id  uuid NOT NULL,
  position      smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  picked_by     uuid REFERENCES staff_user (id) ON DELETE SET NULL,
  picked_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, position),
  FOREIGN KEY (submission_id, event_id) REFERENCES submission (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE photo_wall ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_wall FORCE ROW LEVEL SECURITY;
REVOKE ALL ON photo_wall FROM PUBLIC, questify_app;

-- A photo let go (a rejection, a removal, an erasure, the purge) leaves the wall in the same statement.
CREATE FUNCTION photo_wall_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM photo_wall w WHERE w.submission_id = OLD.id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_wall_forget() FROM PUBLIC;
CREATE TRIGGER submission_wall_forget AFTER UPDATE ON submission
  FOR EACH ROW WHEN (OLD.photo IS NOT NULL AND NEW.photo IS NULL) EXECUTE FUNCTION photo_wall_forget();

-- The one rule of the wall (plan sections 4 and 7 B1), for every reader at every read. Internal.
CREATE FUNCTION photo_wall_ok(s submission, target_event uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF s.id IS NULL OR s.event_id <> target_event OR s.kind <> 'photo' OR s.photo IS NULL OR s.status <> 'approved'
     OR NOT s.on_screen OR s.erased_at IS NOT NULL THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id
                 WHERE n.id = s.enrollment_id AND n.status = 'active' AND p.status = 'active') THEN
    RETURN false;
  END IF;
  RETURN NOT content_held('media', s.photo) AND NOT content_held('quest', s.quest_id);
END $$;
REVOKE ALL ON FUNCTION photo_wall_ok(submission, uuid) FROM PUBLIC;

-- ================================================================ the big screen's fourth scene
-- As 0083, with `photo`: at most four scenes, each once. No row still means the three old scenes.
CREATE OR REPLACE FUNCTION big_screen_scenes_ok(scenes text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT scenes IS NOT NULL AND cardinality(scenes) <= 4
     AND scenes <@ ARRAY['ranking', 'community', 'poll', 'photo']::text[]
     AND cardinality(scenes) = (SELECT count(DISTINCT s) FROM unnest(scenes) s)
$$;

-- As 0083, offering `photo` too.
CREATE OR REPLACE FUNCTION big_screen_json(ev event) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'scenes', to_jsonb(big_screen_plan(ev)),
    'offered', CASE WHEN ranking_on(ev) THEN '["ranking", "community", "poll", "photo"]'::jsonb
                    ELSE '["community", "poll", "photo"]'::jsonb END,
    'enabled', big_screen_on(ev))
$$;

-- Whether the wall runs for the event now: the screen is not shut, the photo scene is picked, the event not suspended.
-- Internal.
CREATE FUNCTION photo_wall_live(ev event) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN ev.id IS NOT NULL AND screen_shut(ev) IS NULL AND 'photo' = ANY (big_screen_plan(ev))
     AND NOT event_suspended(ev.id);
END $$;
REVOKE ALL ON FUNCTION photo_wall_live(event) FROM PUBLIC;

-- ================================================================ sending with the choice
-- As 0193's five-argument door, with `show_on_screen`: stored only for a photo (a text send stores false). A replay
-- answers the first send whatever it asks now; the choice changes later through own_photo_on_screen.
CREATE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text, photo_id uuid,
                             show_on_screen boolean)
  RETURNS TABLE (submission_id bigint, status text, points integer, completion_id bigint, score bigint,
                 balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  earlier    submission%ROWTYPE;
  made       submission%ROWTYPE;
  cleaned    text;
  sent_kind  text;
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
  cleaned := CASE WHEN photo_id IS NULL THEN clean_submission_text(body) ELSE clean_caption(body) END;

  SELECT * INTO earlier FROM submission s WHERE s.enrollment_id = enrolled.id AND s.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.quest_id <> target OR earlier.body IS DISTINCT FROM cleaned
       OR (earlier.kind = 'photo') <> (photo_id IS NOT NULL)
       OR (earlier.photo_gone_at IS NULL AND earlier.photo IS DISTINCT FROM photo_id) THEN
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
  sent_kind := submission_kind_allowed(quest_row, photo_id);
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
  IF photo_id IS NOT NULL THEN
    PERFORM photo_to_attach(photo_id, me, enrolled.event_id, 'submission');
  END IF;

  INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, photo, points, status, auto,
                          marked, idempotency_key, on_screen)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, sent_kind, cleaned, photo_id, quest_row.points,
          'pending', coalesce((quest_row.type_config ->> 'autoApprove')::boolean, false),
          cleaned IS NOT NULL AND text_marked(cleaned), request_key,
          photo_id IS NOT NULL AND coalesce(show_on_screen, false))
  RETURNING * INTO made;
  IF made.auto THEN
    paid := pay_submission(made, NULL, NULL);
    UPDATE submission s SET status = 'approved', completion_id = paid, reviewed_at = now()
    WHERE s.id = made.id RETURNING * INTO made;
  END IF;
  RETURN QUERY SELECT made.id, made.status, made.points, made.completion_id, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION submit_quest(uuid, text, text, text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_quest(uuid, text, text, text, uuid, boolean) TO questify_app;

-- The five-argument door of 0193 stays for an API that has not restarted yet during a deploy: the photo stays off the
-- screen (the private choice). FOLLOWUPS: drop the four- and five-argument doors once no old API can call them.
CREATE OR REPLACE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text, photo_id uuid)
  RETURNS TABLE (submission_id bigint, status text, points integer, completion_id bigint, score bigint,
                 balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM submit_quest(target, body, guidelines, request_key, photo_id, false);
END $$;

-- The player changes the choice for one of their own photo submissions of this event (M6): PW404 for anything else
-- (another player's, another event's, an unknown id, an erased one), PW422 `not_photo` for a text submission. Off
-- deletes the pick in the same transaction; on again shows nothing until the team picks it again. Answers the choice.
CREATE FUNCTION own_photo_on_screen(target_event uuid, target bigint, allowed boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me  uuid := app_player_id();
  sub submission%ROWTYPE;
BEGIN
  IF me IS NULL OR app_device_id() IS NOT NULL OR allowed IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.* INTO sub FROM submission s JOIN enrollment n ON n.id = s.enrollment_id
  WHERE s.id = target AND s.event_id = target_event AND n.player_id = me AND s.erased_at IS NULL
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such submission' USING ERRCODE = 'PW404';
  END IF;
  IF sub.kind <> 'photo' THEN
    RAISE EXCEPTION 'only a photo goes on screen' USING ERRCODE = 'PW422', DETAIL = 'not_photo';
  END IF;
  UPDATE submission s SET on_screen = allowed WHERE s.id = sub.id;
  IF NOT allowed THEN
    DELETE FROM photo_wall w WHERE w.submission_id = sub.id;
  END IF;
  RETURN allowed;
END $$;
REVOKE ALL ON FUNCTION own_photo_on_screen(uuid, bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_photo_on_screen(uuid, bigint, boolean) TO questify_app;

-- As 0193, with `on_screen`.
DROP FUNCTION own_submissions(uuid);
CREATE FUNCTION own_submissions(target_event uuid)
  RETURNS TABLE (id bigint, quest_id uuid, status text, points integer, body text, reason text, reason_system boolean,
                 resubmit boolean, created_at timestamptz, reviewed_at timestamptz, kind text, photo_gone boolean,
                 on_screen boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.quest_id, s.status,
         coalesce((SELECT l.score_delta::integer FROM ledger_entry l WHERE l.completion_id = s.completion_id
                     AND l.kind = 'quest'),
                  s.points * coalesce((quest_boost(q, n, s.created_at)).multiplier, 1)),
         s.body, s.reason, s.reason_system,
         coalesce((q.type_config ->> 'resubmit')::boolean, false), s.created_at, s.reviewed_at, s.kind,
         s.photo_gone_at IS NOT NULL, s.on_screen
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN submission s ON s.enrollment_id = n.id
  JOIN quest q ON q.id = s.quest_id
  WHERE n.event_id = target_event AND n.player_id = app_player_id()
  ORDER BY s.id DESC
  LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION own_submissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_submissions(uuid) TO questify_app;

-- ================================================================ the team's doors
-- The photos the team may pick (AN404 for another event): eligible now, newest first, a page after `cursor_id`, with
-- their quest's title, their key (the API signs it) and their place on the wall when picked. No player's name (M5).
CREATE FUNCTION event_wall_candidates(target_event uuid, cursor_id bigint, page integer)
  RETURNS TABLE (submission_id bigint, photo_key text, quest_title_ar text, quest_title_en text, wall_position smallint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT s.id, m.key, q.title_ar, q.title_en, w.position
  FROM submission s
  JOIN media_object m ON m.id = s.photo
  JOIN quest q ON q.id = s.quest_id
  LEFT JOIN photo_wall w ON w.submission_id = s.id
  WHERE s.event_id = ev.id AND s.kind = 'photo' AND s.status = 'approved' AND s.on_screen
    AND (cursor_id IS NULL OR s.id < cursor_id) AND photo_wall_ok(s, ev.id)
  ORDER BY s.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION event_wall_candidates(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_wall_candidates(uuid, bigint, integer) TO questify_app;

-- The current pick in order, still eligible (AN404 for another event).
CREATE FUNCTION event_photo_wall(target_event uuid)
  RETURNS TABLE (submission_id bigint, photo_key text, quest_title_ar text, quest_title_en text, wall_position smallint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT s.id, m.key, q.title_ar, q.title_en, w.position
  FROM photo_wall w
  JOIN submission s ON s.id = w.submission_id AND s.event_id = w.event_id
  JOIN media_object m ON m.id = s.photo
  JOIN quest q ON q.id = s.quest_id
  WHERE w.event_id = ev.id AND photo_wall_ok(s, ev.id)
  ORDER BY w.position;
END $$;
REVOKE ALL ON FUNCTION event_photo_wall(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_photo_wall(uuid) TO questify_app;

-- Saves the pick, in order, replacing the last (AN404 other event; BS403 add-on off; PW422 `picks` repeated or more
-- than 20, `not_eligible` an id that is not an eligible photo of this event). Audited `photo_wall.update`, ids only.
CREATE FUNCTION set_photo_wall(target_event uuid, picks bigint[], request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  before bigint[];
BEGIN
  IF NOT big_screen_on(ev) THEN
    RAISE EXCEPTION 'the big screen is not active for this event' USING ERRCODE = 'BS403';
  END IF;
  IF picks IS NULL OR cardinality(picks) > 20 OR array_position(picks, NULL) IS NOT NULL
     OR cardinality(picks) <> (SELECT count(DISTINCT p) FROM unnest(picks) p) THEN
    RAISE EXCEPTION 'at most 20 photos, each once' USING ERRCODE = 'PW422', DETAIL = 'picks';
  END IF;
  -- One save of an event at a time: a second waits here, and its later statements see the first one's rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('photo_wall:' || ev.id, 0));
  PERFORM 1 FROM submission s WHERE s.id = ANY (picks) AND s.event_id = ev.id ORDER BY s.id FOR SHARE;
  IF EXISTS (SELECT 1 FROM unnest(picks) p
             WHERE NOT coalesce((SELECT photo_wall_ok(s, ev.id) FROM submission s
                                 WHERE s.id = p AND s.event_id = ev.id), false)) THEN
    RAISE EXCEPTION 'a photo that cannot go on screen' USING ERRCODE = 'PW422', DETAIL = 'not_eligible';
  END IF;
  SELECT coalesce(array_agg(w.submission_id ORDER BY w.position), '{}') INTO before
  FROM photo_wall w WHERE w.event_id = ev.id;
  DELETE FROM photo_wall w WHERE w.event_id = ev.id;
  INSERT INTO photo_wall (submission_id, event_id, organizer_id, position, picked_by)
  SELECT u.id, ev.id, ev.organizer_id, u.pos, app_staff_user_id()
  FROM unnest(picks) WITH ORDINALITY AS u(id, pos);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'photo_wall.update', 'event', ev.id::text,
          jsonb_build_object('submissions', to_jsonb(before)), jsonb_build_object('submissions', to_jsonb(picks)),
          request);
  RETURN cardinality(picks);
END $$;
REVOKE ALL ON FUNCTION set_photo_wall(uuid, bigint[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_photo_wall(uuid, bigint[], uuid) TO questify_app;

-- ================================================================ the readers
-- The screen's photo scene: the calling device's own event only (screen_event: a paired, activated big screen, DV401
-- otherwise; never a player seat), up to 20 picked, eligible photos in order, as {mediaId, key}. No name at all (M5).
-- The API signs each key and drops it from the answer.
CREATE FUNCTION screen_photos() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := screen_event();
  shut text := screen_shut(ev);
BEGIN
  IF shut IS NOT NULL THEN
    RETURN jsonb_build_object('shut', shut);
  END IF;
  IF NOT 'photo' = ANY (big_screen_plan(ev)) THEN
    RETURN jsonb_build_object('shut', NULL, 'photos', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object('shut', NULL, 'photos', coalesce((
    SELECT jsonb_agg(jsonb_build_object('mediaId', x.photo, 'key', x.key) ORDER BY x.position)
    FROM (SELECT s.photo, m.key, w.position
          FROM photo_wall w
          JOIN submission s ON s.id = w.submission_id AND s.event_id = w.event_id
          JOIN media_object m ON m.id = s.photo
          WHERE w.event_id = ev.id AND photo_wall_ok(s, ev.id)
          ORDER BY w.position LIMIT 20) x), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION screen_photos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION screen_photos() TO questify_app;

-- The same photos for an active member in the app, while the wall runs (PW404 otherwise; AM403 for a non-member),
-- leaving out a player the reader blocked; each with its owner's username, for Block (M4, M5: never a full name).
CREATE FUNCTION member_photo_wall(target_event uuid)
  RETURNS TABLE (media_id uuid, photo_key text, username text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine enrollment := session_member(target_event);
  ev   event;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = mine.event_id;
  IF NOT photo_wall_live(ev) THEN
    RAISE EXCEPTION 'the photo wall is not on' USING ERRCODE = 'PW404';
  END IF;
  RETURN QUERY
  SELECT s.photo, m.key, p.username
  FROM photo_wall w
  JOIN submission s ON s.id = w.submission_id AND s.event_id = w.event_id
  JOIN media_object m ON m.id = s.photo
  JOIN enrollment n ON n.id = s.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE w.event_id = ev.id AND photo_wall_ok(s, ev.id) AND NOT blocked_by_me(p.id)
  ORDER BY w.position
  LIMIT 20;
END $$;
REVOKE ALL ON FUNCTION member_photo_wall(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_photo_wall(uuid) TO questify_app;

-- Whether the wall runs for the calling member (Home and the send form ask): false for anyone else, never an error.
CREATE FUNCTION member_photo_wall_on(target_event uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
BEGIN
  SELECT e.* INTO ev FROM event e
  JOIN enrollment n ON n.event_id = e.id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE e.id = target_event AND e.status <> 'archived' AND app_device_id() IS NULL;
  RETURN coalesce(photo_wall_live(ev), false);
END $$;
REVOKE ALL ON FUNCTION member_photo_wall_on(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_photo_wall_on(uuid) TO questify_app;

-- ================================================================ reports and holds of a wall photo (M1)
ALTER TABLE content_hold DROP CONSTRAINT content_hold_kind_check;
ALTER TABLE content_hold ADD CONSTRAINT content_hold_kind_check
  CHECK (kind IN ('quest', 'reward', 'announcement', 'media'));
ALTER TABLE content_report DROP CONSTRAINT content_report_target_kind_check;
ALTER TABLE content_report ADD CONSTRAINT content_report_target_kind_check
  CHECK (target_kind IN ('quest', 'reward', 'announcement', 'category', 'session', 'sponsor', 'event', 'username',
                         'media'));

-- Whether a submission photo is on the member's event wall now (the report rule of a `media` target). Internal.
CREATE FUNCTION photo_on_member_wall(target uuid, mine enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = mine.event_id;
  IF mine.id IS NULL OR NOT photo_wall_live(ev) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (SELECT 1 FROM photo_wall w
                 JOIN submission s ON s.id = w.submission_id AND s.event_id = w.event_id
                 WHERE w.event_id = ev.id AND s.photo = target AND photo_wall_ok(s, ev.id));
END $$;
REVOKE ALL ON FUNCTION photo_on_member_wall(uuid, enrollment) FROM PUBLIC;

-- As 0121, with `media`: a submission photo's quest title (never its key).
CREATE OR REPLACE FUNCTION report_snapshot(target_kind text, target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE target_kind
    WHEN 'quest' THEN (SELECT jsonb_build_object('title', report_pair(q.title_ar, q.title_en, 120),
                                                 'text', report_pair(q.description_ar, q.description_en, 300))
                       FROM quest q WHERE q.id = target)
    WHEN 'reward' THEN (SELECT jsonb_build_object('title', report_pair(r.name_ar, r.name_en, 120),
                                                  'text', report_pair(r.description_ar, r.description_en, 300))
                        FROM reward r WHERE r.id = target)
    WHEN 'announcement' THEN (SELECT jsonb_build_object('title', report_pair(a.title_ar, a.title_en, 120),
                                                        'text', report_pair(a.body_ar, a.body_en, 300))
                              FROM announcement a WHERE a.id = target)
    WHEN 'category' THEN (SELECT jsonb_build_object('title', report_pair(c.name_ar, c.name_en, 120))
                          FROM category c WHERE c.id = target)
    WHEN 'session' THEN (SELECT jsonb_build_object('title', report_pair(s.title_ar, s.title_en, 120),
                                                   'text', report_pair(s.description_ar, s.description_en, 300))
                         FROM event_session s WHERE s.id = target)
    WHEN 'sponsor' THEN (SELECT jsonb_build_object('title', report_pair(s.name_ar, s.name_en, 120))
                         FROM sponsor s WHERE s.id = target)
    WHEN 'event' THEN (SELECT jsonb_build_object('title', report_pair(e.name_ar, e.name_en, 120),
                                                 'text', report_pair(e.rules_ar, e.rules_en, 300))
                       FROM event e WHERE e.id = target)
    WHEN 'username' THEN (SELECT jsonb_build_object('username', p.username)
                          FROM player p WHERE p.id = target AND p.username IS NOT NULL)
    WHEN 'media' THEN (SELECT jsonb_build_object('title', report_pair(q.title_ar, q.title_en, 120))
                       FROM submission s JOIN quest q ON q.id = s.quest_id WHERE s.photo = target)
  END
$$;

-- As 0121, with `media`: a submission photo's event.
CREATE OR REPLACE FUNCTION report_event(target_kind text, target uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE target_kind
    WHEN 'quest' THEN (SELECT q.event_id FROM quest q WHERE q.id = target)
    WHEN 'reward' THEN (SELECT r.event_id FROM reward r WHERE r.id = target)
    WHEN 'announcement' THEN (SELECT a.event_id FROM announcement a WHERE a.id = target)
    WHEN 'category' THEN (SELECT c.event_id FROM category c WHERE c.id = target)
    WHEN 'session' THEN (SELECT s.event_id FROM event_session s WHERE s.id = target)
    WHEN 'sponsor' THEN (SELECT s.event_id FROM sponsor s WHERE s.id = target)
    WHEN 'event' THEN (SELECT e.id FROM event e WHERE e.id = target)
    WHEN 'media' THEN (SELECT m.event_id FROM media_object m WHERE m.id = target AND m.purpose = 'submission')
  END
$$;

-- As 0121, with `media`: the photo is on the reader's current wall.
CREATE OR REPLACE FUNCTION report_target_seen(target_kind text, target uuid, mine enrollment) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE target_kind
    WHEN 'quest' THEN member_sees_quest(mine.id, target)
    WHEN 'reward' THEN EXISTS (SELECT 1 FROM reward r
                               WHERE r.id = target AND r.status = 'active' AND r.held_at IS NULL
                                 AND in_audience(mine.id, r.audience_kind, r.audience_field_id, r.audience_values))
    WHEN 'announcement' THEN EXISTS (SELECT 1 FROM announcement a
                                     WHERE a.id = target AND a.status = 'sent'
                                       AND a.rehearsal = (mine.joined_via IS NOT DISTINCT FROM 'rehearsal')
                                       AND NOT content_held('announcement', a.id))
    WHEN 'category' THEN EXISTS (SELECT 1 FROM category c WHERE c.id = target AND sees_category(mine.id, c))
    WHEN 'media' THEN photo_on_member_wall(target, mine)
    ELSE true
  END
$$;
-- As 0121, with `media` in the kind list (its event, sight rule and snapshot are the restated helpers above).
CREATE OR REPLACE FUNCTION report_content(target_kind text, target uuid, chosen_name text, in_event uuid, why text, note text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := app_player_id();
  ev_id   uuid;
  mine    enrollment;
  theirs  enrollment;
  named   uuid := target;
  cleaned text;
  shot    jsonb;
  made    uuid;
BEGIN
  IF me IS NULL OR app_device_id() IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF target_kind IS NULL OR target_kind NOT IN ('quest', 'reward', 'announcement', 'category', 'session', 'sponsor',
                                                'event', 'username', 'media')
     OR why IS NULL OR why NOT IN ('offensive', 'hateful', 'sexual', 'spam', 'misleading', 'other') THEN
    RAISE EXCEPTION 'a kind and a reason from the lists' USING ERRCODE = 'RP422';
  END IF;
  IF note IS NOT NULL AND btrim(note) <> '' THEN
    cleaned := clean_submission_text(note);
    IF char_length(cleaned) > 500 THEN
      RAISE EXCEPTION 'a note of at most 500 characters' USING ERRCODE = 'RP422';
    END IF;
  END IF;
  IF target_kind = 'username' THEN
    SELECT p.id INTO named FROM player p
    WHERE username_fold(p.username) = username_fold(chosen_name) AND p.status = 'active' AND p.id <> me;
    ev_id := in_event;
  ELSE
    ev_id := report_event(target_kind, target);
  END IF;
  IF ev_id IS NOT NULL THEN
    SELECT n.* INTO mine FROM enrollment n WHERE n.event_id = ev_id AND n.player_id = me AND n.status = 'active';
  END IF;
  IF named IS NULL OR (ev_id IS NULL AND (target_kind <> 'username' OR in_event IS NOT NULL))
     OR (ev_id IS NOT NULL AND mine.id IS NULL) THEN
    RAISE EXCEPTION 'nothing to report there' USING ERRCODE = 'RP404';
  END IF;
  IF target_kind = 'username' AND ev_id IS NOT NULL THEN
    SELECT n.* INTO theirs FROM enrollment n WHERE n.event_id = ev_id AND n.player_id = named AND n.status = 'active';
    IF theirs.id IS NULL THEN
      RAISE EXCEPTION 'nothing to report there' USING ERRCODE = 'RP404';
    END IF;
  ELSIF target_kind <> 'username' AND NOT report_target_seen(target_kind, target, mine) THEN
    RAISE EXCEPTION 'nothing to report there' USING ERRCODE = 'RP404';
  END IF;

  -- One reporter at a time: the duplicate check and the caps hold under concurrent reports.
  PERFORM pg_advisory_xact_lock(hashtextextended('content_report:' || me, 0));
  IF EXISTS (SELECT 1 FROM content_report r
             WHERE r.reporter_id = me AND r.target_kind = report_content.target_kind AND r.target_id = named
               AND r.status = 'open') THEN
    RETURN 'already_reported';
  END IF;
  PERFORM report_caps(me);
  shot := report_snapshot(target_kind, named);
  INSERT INTO content_report (reporter_id, event_id, target_kind, target_id, snapshot, reason, note, marked)
  VALUES (me, ev_id, target_kind, named, shot, why, cleaned, cleaned IS NOT NULL AND text_marked(cleaned))
  RETURNING id INTO made;
  IF theirs.id IS NOT NULL THEN
    PERFORM report_open_ticket(me, mine, theirs.id, why, made);
  END IF;
  RETURN 'reported';
END $$;

-- As 0121, with `media`: the submission photo's object row FOR UPDATE (two admins one after the other; a rejection that
-- deletes the row waits, and the hold then finds nothing). HD404 for an unknown or unattached photo.
CREATE OR REPLACE FUNCTION hold_target(hold_kind text, target uuid, OUT ev_id uuid, OUT org_id uuid, OUT shown boolean)
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
BEGIN
  IF hold_kind = 'quest' THEN
    SELECT q.event_id, q.organizer_id, q.visible INTO ev_id, org_id, shown FROM quest q WHERE q.id = target FOR UPDATE;
  ELSIF hold_kind = 'reward' THEN
    SELECT r.event_id, r.organizer_id INTO ev_id, org_id FROM reward r
    WHERE r.id = target AND r.status = 'active' FOR UPDATE;
  ELSIF hold_kind = 'announcement' THEN
    SELECT a.event_id, a.organizer_id INTO ev_id, org_id FROM announcement a WHERE a.id = target FOR UPDATE;
  ELSIF hold_kind = 'media' THEN
    SELECT m.event_id, m.organizer_id INTO ev_id, org_id FROM media_object m
    WHERE m.id = target AND m.purpose = 'submission' AND m.state = 'attached' FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'only a quest, a reward, an announcement or a photo is unpublished' USING ERRCODE = 'HD400';
  END IF;
  IF ev_id IS NULL THEN
    RAISE EXCEPTION 'nothing to unpublish there' USING ERRCODE = 'HD404';
  END IF;
END $$;

-- As 0171, with `media` among the kinds a hold closes.
CREATE OR REPLACE FUNCTION admin_report_resolve(target_kind text, target uuid, resolution text, request uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  closed integer;
  ev_id  uuid;
BEGIN
  IF resolution IS NULL OR resolution NOT IN ('dismissed', 'unpublished', 'event_suspended', 'username_changed',
                                              'player_banned') THEN
    RAISE EXCEPTION 'an outcome from the list' USING ERRCODE = 'RP422';
  END IF;
  PERFORM report_target_lock(admin_report_resolve.target_kind, target);
  IF NOT (CASE resolution
    WHEN 'dismissed' THEN true
    WHEN 'unpublished' THEN admin_report_resolve.target_kind IN ('quest', 'reward', 'announcement', 'media')
                            AND content_held(admin_report_resolve.target_kind, target)
    WHEN 'event_suspended' THEN admin_report_resolve.target_kind <> 'username'
                                AND coalesce(event_suspended(coalesce(
                                      report_event(admin_report_resolve.target_kind, target),
                                      (SELECT r.event_id FROM content_report r
                                       WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target
                                         AND r.event_id IS NOT NULL LIMIT 1))), false)
    WHEN 'username_changed' THEN admin_report_resolve.target_kind = 'username'
                                 AND NOT EXISTS (SELECT 1 FROM content_report r JOIN player p ON p.id = r.target_id
                                                 WHERE r.target_kind = 'username' AND r.target_id = target
                                                   AND r.status = 'open'
                                                   AND username_fold(r.snapshot ->> 'username') = username_fold(p.username))
    WHEN 'player_banned' THEN admin_report_resolve.target_kind = 'username'
                              AND EXISTS (SELECT 1 FROM player p WHERE p.id = target AND p.status = 'banned')
  END) THEN
    RAISE EXCEPTION 'take the action first, then close the reports with it' USING ERRCODE = 'RP409';
  END IF;
  WITH done AS (
    UPDATE content_report r
    SET status = CASE WHEN resolution = 'dismissed' THEN 'dismissed' ELSE 'actioned' END, outcome = resolution,
        handled_by = me, handled_at = now()
    WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target AND r.status = 'open'
    RETURNING r.event_id)
  SELECT count(*), max(d.event_id::text)::uuid INTO closed, ev_id FROM done d;
  IF closed > 0 THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'report.resolve', target_kind,
            target::text, jsonb_build_object('outcome', resolution, 'closed', closed), request);
  END IF;
  RETURN closed;
END $$;

-- The key of a reported submission photo, for Questify's console to sign (the console's report page shows it). NULL for
-- a photo nobody reported or one already deleted; the console's own seat check first (console_admin).
CREATE FUNCTION admin_report_media_key(target uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  found text;
BEGIN
  SELECT m.key INTO found FROM media_object m
  WHERE m.id = target AND m.purpose = 'submission' AND m.state = 'attached' AND me IS NOT NULL
    AND EXISTS (SELECT 1 FROM content_report r WHERE r.target_kind = 'media' AND r.target_id = target);
  RETURN found;
END $$;
REVOKE ALL ON FUNCTION admin_report_media_key(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_report_media_key(uuid) TO questify_app;

-- ================================================================ the data export
-- As 0129, with each submission's `onScreen`.
CREATE OR REPLACE FUNCTION data_export_event_play(n enrollment) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'completions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'questId', c.quest_id, 'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
                                      'method', c.method, 'at', data_export_time(c.created_at)) ORDER BY c.created_at, c.id)
                             FROM quest_completion c JOIN quest q ON q.id = c.quest_id
                             WHERE c.enrollment_id = n.id), '[]'),
    'completionPlaces', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                           'accuracyM', l.accuracy_m, 'venueDistanceM', l.venue_distance_m,
                                           'mocked', l.mocked, 'at', data_export_time(l.created_at))
                                         ORDER BY l.created_at, l.completion_id)
                                  FROM completion_position l WHERE l.enrollment_id = n.id), '[]'),
    'ledger', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                 'kind', l.kind, 'score', l.score_delta, 'balance', l.balance_delta,
                                 'questId', l.quest_id, 'quest', CASE WHEN q.id IS NOT NULL
                                   THEN jsonb_build_object('ar', q.title_ar, 'en', q.title_en) END,
                                 'at', data_export_time(l.created_at)) ORDER BY l.created_at, l.id)
                        FROM ledger_entry l LEFT JOIN quest q ON q.id = l.quest_id
                        WHERE l.enrollment_id = n.id), '[]'),
    'redemptions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'item', jsonb_build_object('ar', coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                                 'en', coalesce(r.name_en, k.name_en, i.name_en)),
                                      'price', d.price, 'status', d.status, 'endedBy', d.ended_by,
                                      'at', data_export_time(d.created_at), 'endedAt', data_export_time(d.ended_at))
                                    ORDER BY d.created_at, d.id)
                             FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id
                             LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
                             LEFT JOIN quest_item i ON i.id = d.quest_item_id
                             WHERE d.enrollment_id = n.id), '[]'),
    'deskSales', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                    'item', jsonb_build_object('ar', r.name_ar, 'en', r.name_en), 'price', s.price,
                                    'status', s.status, 'at', data_export_time(s.created_at)) ORDER BY s.created_at, s.id)
                           FROM desk_sale s JOIN reward r ON r.id = s.reward_id WHERE s.enrollment_id = n.id), '[]'),
    'submissions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'questId', s.quest_id, 'kind', s.kind, 'body', s.body, 'status', s.status,
                                      'points', s.points, 'reason', s.reason, 'onScreen', s.on_screen,
                                      'at', data_export_time(s.created_at))
                                    ORDER BY s.created_at, s.id)
                             FROM submission s WHERE s.enrollment_id = n.id), '[]'),
    'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', v.quest_id, 'option', v.option_id,
                                                           'at', data_export_time(v.created_at)) ORDER BY v.created_at)
                       FROM quest_vote v WHERE v.enrollment_id = n.id), '[]'),
    'surveyResponses', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', v.quest_id, 'answers', v.answers,
                                                                     'at', data_export_time(v.created_at))
                                                  ORDER BY v.created_at)
                                 FROM survey_response v WHERE v.enrollment_id = n.id), '[]'),
    'quizAnswers', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'questId', t.quest_id, 'status', t.status, 'right', t.right_count,
                                      'startedAt', data_export_time(t.started_at),
                                      'answers', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                                                    'question', a.question_id, 'choice', a.choice_id,
                                                                    'correct', a.correct) ORDER BY a.position)
                                                           FROM quiz_answer a WHERE a.attempt_id = t.id), '[]'))
                                    ORDER BY t.started_at, t.id)
                             FROM quiz_attempt t WHERE t.enrollment_id = n.id), '[]'),
    'gameRounds', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                     'questId', g.quest_id, 'game', g.game, 'level', g.level, 'points', g.points,
                                     'status', g.status, 'result', g.result, 'at', data_export_time(g.issued_at))
                                   ORDER BY g.issued_at, g.id)
                            FROM game_round g WHERE g.enrollment_id = n.id), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', r.quest_id, 'thumb', r.thumb,
                                                             'at', data_export_time(r.updated_at)) ORDER BY r.created_at)
                         FROM quest_rating r WHERE r.enrollment_id = n.id), '[]'),
    'cheers', coalesce((SELECT jsonb_agg(jsonb_build_object('reaction', c.reaction, 'at', data_export_time(c.created_at))
                                         ORDER BY c.created_at, c.id)
                        FROM cheer c WHERE c.enrollment_id = n.id), '[]'))
$$;
