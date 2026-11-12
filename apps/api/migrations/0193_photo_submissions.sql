-- Photo storage, part 2: photo submissions and ticket photos (T-301b phase 1b and 1c; plan
-- docs/plans/2026-11-12-photo-storage.md, FR-204, FR-337). A submission quest accepts text, a photo, or either
-- (`accepts`); a photo submission holds one stored `media_object` (migration 0192) of its own player and event, with an
-- optional caption of at most 300 characters. An event ticket may hold one photo too.
--
-- Delete by construction: a submission's photo goes when its status turns rejected or removed, when its account is
-- erased, when the row is deleted (the rehearsal wipe), and 365 days after its event ends (media_purge_due, the interim
-- retention of Q-075). A ticket's photo goes with its ticket (erasure, the wipe, purge_ended_tickets) or with that
-- purge. Each path only clears `photo` or deletes the row: one AFTER trigger deletes the `media_object` row, whose own
-- trigger (0192) queues the key. The doors and sweeps that did this before need no change.
--
-- Lock order (rules.md): submission or ticket -> media_object -> media_delete. submit_quest and open_ticket take their
-- usual order (the rehearsal row, the quest pin, the enrollment), then the photo's `media_object` row FOR UPDATE (with
-- its age re-checked under the lock, so the sweep cannot delete it under them: the sweep skips locked rows), then
-- insert. Every reader that carries a key keeps its seat check (award_event_of, review_operator, help_operator,
-- inbox_abilities, ticket_admin) as in its latest definition; the API signs a URL only for a key one of them returned.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the kinds a quest accepts
ALTER TABLE quest DROP CONSTRAINT quest_submission_text_only;
ALTER TABLE quest ADD CONSTRAINT quest_submission_kinds CHECK (
  type <> 'submission'
  OR type_config -> 'accepts' IN ('["text"]'::jsonb, '["photo"]'::jsonb, '["text", "photo"]'::jsonb));

-- What a quest accepts is fixed once anyone has sent a submission for it (SA409): an approved text cannot become an
-- unanswered photo request, nor a pending photo a text the reviewer cannot see.
CREATE FUNCTION quest_accepts_fixed() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM submission s WHERE s.quest_id = NEW.id) THEN
    RAISE EXCEPTION 'what this quest accepts is fixed once it has submissions' USING ERRCODE = 'SA409',
      DETAIL = 'accepts';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_accepts_fixed() FROM PUBLIC;
CREATE TRIGGER quest_accepts_fixed BEFORE UPDATE OF type_config ON quest
  FOR EACH ROW WHEN (OLD.type = 'submission' AND NEW.type = 'submission'
                     AND OLD.type_config -> 'accepts' IS DISTINCT FROM NEW.type_config -> 'accepts')
  EXECUTE FUNCTION quest_accepts_fixed();

-- ================================================================ the submission's photo
ALTER TABLE submission DROP CONSTRAINT submission_kind_check;
ALTER TABLE submission ADD CONSTRAINT submission_kind_check CHECK (kind IN ('text', 'photo'));
ALTER TABLE submission
  ADD COLUMN photo uuid UNIQUE REFERENCES media_object (id),
  -- Set when the photo was deleted (a rejection, a removal, an erasure, the purge): the row says so to its readers.
  ADD COLUMN photo_gone_at timestamptz;
DO $$
DECLARE
  old_check text;
BEGIN
  SELECT c.conname INTO old_check FROM pg_constraint c
  WHERE c.conrelid = 'submission'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) = 'CHECK (((erased_at IS NOT NULL) OR (body IS NOT NULL)))';
  EXECUTE format('ALTER TABLE submission DROP CONSTRAINT %I', old_check);
END $$;
ALTER TABLE submission
  ADD CONSTRAINT submission_text_has_body CHECK (erased_at IS NOT NULL OR kind = 'photo' OR body IS NOT NULL),
  ADD CONSTRAINT submission_caption_short CHECK (kind <> 'photo' OR body IS NULL OR char_length(body) <= 300),
  ADD CONSTRAINT submission_photo_kind CHECK (kind = 'photo' OR (photo IS NULL AND photo_gone_at IS NULL)),
  ADD CONSTRAINT submission_photo_or_gone CHECK (photo IS NULL OR photo_gone_at IS NULL),
  -- A pending photo submission shows its photo, unless the account or the photo is gone.
  ADD CONSTRAINT submission_pending_photo CHECK (
    kind <> 'photo' OR status <> 'pending' OR photo IS NOT NULL OR erased_at IS NOT NULL OR photo_gone_at IS NOT NULL);

-- A rejection, a removal or an erasure lets go of the photo; clearing it by hand (the purge) marks it gone.
CREATE FUNCTION submission_photo_release() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.photo IS NOT DISTINCT FROM OLD.photo
     AND ((NEW.status IN ('rejected', 'removed') AND NEW.status IS DISTINCT FROM OLD.status)
          OR (NEW.erased_at IS NOT NULL AND OLD.erased_at IS NULL)) THEN
    NEW.photo := NULL;
  END IF;
  IF NEW.photo IS NULL THEN
    NEW.photo_gone_at := coalesce(NEW.photo_gone_at, now());
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION submission_photo_release() FROM PUBLIC;
CREATE TRIGGER submission_photo_release BEFORE UPDATE ON submission
  FOR EACH ROW WHEN (OLD.photo IS NOT NULL) EXECUTE FUNCTION submission_photo_release();

-- The object row goes once nothing holds it (after the row is written, so the foreign key sees it let go); its key is
-- queued by media_object_forget. Shared by submissions and tickets.
CREATE FUNCTION photo_holder_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM media_object m WHERE m.id = OLD.photo;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION photo_holder_forget() FROM PUBLIC;
CREATE TRIGGER submission_photo_forget AFTER UPDATE ON submission
  FOR EACH ROW WHEN (OLD.photo IS NOT NULL AND NEW.photo IS NULL) EXECUTE FUNCTION photo_holder_forget();
CREATE TRIGGER submission_photo_delete AFTER DELETE ON submission
  FOR EACH ROW WHEN (OLD.photo IS NOT NULL) EXECUTE FUNCTION photo_holder_forget();

-- ================================================================ the ticket's photo
ALTER TABLE ticket ADD COLUMN photo uuid UNIQUE REFERENCES media_object (id);
CREATE TRIGGER ticket_photo_forget AFTER UPDATE ON ticket
  FOR EACH ROW WHEN (OLD.photo IS NOT NULL AND NEW.photo IS NULL) EXECUTE FUNCTION photo_holder_forget();
CREATE TRIGGER ticket_photo_delete AFTER DELETE ON ticket
  FOR EACH ROW WHEN (OLD.photo IS NOT NULL) EXECUTE FUNCTION photo_holder_forget();

-- ================================================================ attaching
-- The calling player's stored upload of this event and purpose, locked, not yet attached and younger than the sweep
-- (re-checked under the lock); one answer, SM404, for anything else. Internal.
CREATE FUNCTION photo_to_attach(target uuid, me uuid, target_event uuid, wanted_purpose text) RETURNS media_object
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  pic media_object%ROWTYPE;
BEGIN
  SELECT * INTO pic FROM media_object m WHERE m.id = target FOR UPDATE;
  IF NOT FOUND OR pic.uploaded_by_player <> me OR pic.event_id <> target_event OR pic.purpose <> wanted_purpose
     OR pic.state <> 'stored' OR pic.created_at <= now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'no such photo' USING ERRCODE = 'SM404';
  END IF;
  UPDATE media_object m SET state = 'attached', attached_at = now() WHERE m.id = target;
  RETURN pic;
END $$;
REVOKE ALL ON FUNCTION photo_to_attach(uuid, uuid, uuid, text) FROM PUBLIC;

-- A photo submission's caption: optional, cleaned like any text, at most 300 characters (SV422 too_long). Internal.
CREATE FUNCTION clean_caption(body text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  cleaned text;
BEGIN
  IF body IS NULL OR btrim(body, E' \n\t\r') = '' THEN
    RETURN NULL;
  END IF;
  cleaned := clean_submission_text(body);
  IF char_length(cleaned) > 300 THEN
    RAISE EXCEPTION 'the caption is too long' USING ERRCODE = 'SV422', DETAIL = 'too_long';
  END IF;
  RETURN cleaned;
END $$;
REVOKE ALL ON FUNCTION clean_caption(text) FROM PUBLIC;

-- The kind a send is allowed for its quest (SM422): a photo-only quest needs a photo, a text-only one takes none.
CREATE FUNCTION submission_kind_allowed(quest_row quest, photo_id uuid) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF photo_id IS NULL AND NOT coalesce(quest_row.type_config -> 'accepts' ? 'text', false) THEN
    RAISE EXCEPTION 'this quest takes a photo' USING ERRCODE = 'SM422', DETAIL = 'photo_required';
  END IF;
  IF photo_id IS NOT NULL AND NOT coalesce(quest_row.type_config -> 'accepts' ? 'photo', false) THEN
    RAISE EXCEPTION 'this quest takes no photo' USING ERRCODE = 'SM422', DETAIL = 'photo_not_accepted';
  END IF;
  RETURN CASE WHEN photo_id IS NULL THEN 'text' ELSE 'photo' END;
END $$;
REVOKE ALL ON FUNCTION submission_kind_allowed(quest, uuid) FROM PUBLIC;

-- ================================================================ sending
-- As 0098, with a photo: text, a photo, or a photo with a caption, as the quest accepts. A replay compares the photo
-- too (unless it was deleted since). The photo is locked after the enrollment and attached before the insert.
CREATE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text, photo_id uuid)
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
                          marked, idempotency_key)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, sent_kind, cleaned, photo_id, quest_row.points,
          'pending', coalesce((quest_row.type_config ->> 'autoApprove')::boolean, false),
          cleaned IS NOT NULL AND text_marked(cleaned), request_key)
  RETURNING * INTO made;
  IF made.auto THEN
    paid := pay_submission(made, NULL, NULL);
    UPDATE submission s SET status = 'approved', completion_id = paid, reviewed_at = now()
    WHERE s.id = made.id RETURNING * INTO made;
  END IF;
  RETURN QUERY SELECT made.id, made.status, made.points, made.completion_id, n.score, n.balance, false
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION submit_quest(uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_quest(uuid, text, text, text, uuid) TO questify_app;

-- The four-argument door of 0098 stays for an API that has not restarted yet during a deploy: a text send.
CREATE OR REPLACE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text)
  RETURNS TABLE (submission_id bigint, status text, points integer, completion_id bigint, score bigint,
                 balance bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM submit_quest(target, body, guidelines, request_key, NULL::uuid);
END $$;

-- ================================================================ asking for a ticket with a photo
-- As 0061, with an optional photo of the caller's own upload for this event (purpose `ticket`), locked after the
-- enrollment and the caps, attached before the insert. A replay compares the photo too.
CREATE FUNCTION open_ticket(target_event uuid, ticket_kind text, target_quest uuid, reported_username text, body text,
                            request_key text, photo_id uuid)
  RETURNS TABLE (ticket_id bigint, status text, created_at timestamptz, marked boolean, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me       uuid := app_player_id();
  enrolled enrollment%ROWTYPE;
  earlier  ticket%ROWTYPE;
  ev       event%ROWTYPE;
  made     ticket%ROWTYPE;
  reported uuid;
  cleaned  text;
  tenth    timestamptz;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  IF ticket_kind IS NULL OR ticket_kind NOT IN ('question', 'problem', 'prize', 'report_player') THEN
    RAISE EXCEPTION 'a kind the event team receives' USING ERRCODE = 'HK422';
  END IF;
  IF ticket_kind = 'report_player' AND reported_username IS NULL THEN
    RAISE EXCEPTION 'a report names a username' USING ERRCODE = 'HR422', DETAIL = 'username_required';
  END IF;
  IF ticket_kind <> 'report_player' AND reported_username IS NOT NULL THEN
    RAISE EXCEPTION 'only a report names a username' USING ERRCODE = 'HR422', DETAIL = 'username_unexpected';
  END IF;
  PERFORM ensure_rehearsal_wiped(target_event);
  IF NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = target_event AND n.player_id = me)
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'not a member of this event' USING ERRCODE = 'HT403', DETAIL = 'not_member';
  END IF;
  SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = target_event AND n.player_id = me FOR NO KEY UPDATE;

  SELECT * INTO earlier FROM ticket t WHERE t.player_id = me AND t.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.event_id IS DISTINCT FROM target_event OR earlier.kind <> ticket_kind
       OR earlier.quest_id IS DISTINCT FROM target_quest OR earlier.photo IS DISTINCT FROM photo_id
       OR (ticket_kind = 'report_player' AND NOT EXISTS (
             SELECT 1 FROM enrollment n JOIN player p ON p.id = n.player_id
             WHERE n.id = earlier.reported_enrollment_id
               AND username_fold(p.username) = username_fold(reported_username))) THEN
      RAISE EXCEPTION 'this key was used for another ticket' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.status, earlier.created_at, earlier.marked, true;
    RETURN;
  END IF;

  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  IF NOT help_desk_on(ev) THEN
    RAISE EXCEPTION 'the help desk is off for this event' USING ERRCODE = 'HT403', DETAIL = 'feature_off';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live', 'ended')
     OR (ev.ends_at IS NOT NULL AND ev.ends_at + interval '30 days' <= now()) THEN
    RAISE EXCEPTION 'sending is closed for this event' USING ERRCODE = 'HT403', DETAIL = 'sending_closed';
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'not an active member of this event' USING ERRCODE = 'HT403', DETAIL = 'not_member';
  END IF;
  IF target_quest IS NOT NULL AND ticket_kind = 'report_player' THEN
    RAISE EXCEPTION 'a report is about a player, not a quest' USING ERRCODE = 'HQ422';
  END IF;
  IF target_quest IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = target_event) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'HQ404';
  END IF;
  IF ticket_kind = 'report_player' THEN
    SELECT n.id INTO reported FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target_event AND n.status = 'active' AND p.status = 'active'
      AND username_fold(p.username) = username_fold(reported_username);
    IF reported IS NULL THEN
      RAISE EXCEPTION 'no such player in this event' USING ERRCODE = 'HR404', DETAIL = 'unknown_player';
    END IF;
    IF reported = enrolled.id THEN
      RAISE EXCEPTION 'not yourself' USING ERRCODE = 'HR403', DETAIL = 'self_report';
    END IF;
    IF EXISTS (SELECT 1 FROM ticket t
               WHERE t.player_id = me AND t.kind = 'report_player' AND t.reported_enrollment_id = reported
                 AND t.status = 'open') THEN
      RAISE EXCEPTION 'this player is already reported' USING ERRCODE = 'HT409', DETAIL = 'already_reported';
    END IF;
  END IF;
  cleaned := clean_submission_text(body);
  IF (SELECT count(*) FROM ticket t
      WHERE t.player_id = me AND t.event_id = target_event AND t.status = 'open') >= 3 THEN
    RAISE EXCEPTION 'three requests are waiting' USING ERRCODE = 'HT409', DETAIL = 'too_many_open';
  END IF;
  SELECT t.created_at INTO tenth FROM ticket t
  WHERE t.player_id = me AND t.event_id = target_event AND t.created_at > now() - interval '24 hours'
  ORDER BY t.created_at DESC OFFSET 9 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ten requests in a day' USING ERRCODE = 'HT429',
      DETAIL = greatest(1, ceil(extract(epoch FROM tenth + interval '24 hours' - now())))::bigint::text;
  END IF;
  IF photo_id IS NOT NULL THEN
    PERFORM photo_to_attach(photo_id, me, target_event, 'ticket');
  END IF;

  INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, quest_id, reported_enrollment_id, kind, body,
                      marked, idempotency_key, photo)
  VALUES (me, enrolled.organizer_id, target_event, enrolled.id, target_quest, reported, ticket_kind, cleaned,
          text_marked(cleaned), request_key, photo_id)
  RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.status, made.created_at, made.marked, false;
END $$;
REVOKE ALL ON FUNCTION open_ticket(uuid, text, uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_ticket(uuid, text, uuid, text, text, text, uuid) TO questify_app;

-- The six-argument door of 0061 stays for an API that has not restarted yet during a deploy: a ticket with no photo.
CREATE OR REPLACE FUNCTION open_ticket(target_event uuid, ticket_kind text, target_quest uuid, reported_username text,
                                       body text, request_key text)
  RETURNS TABLE (ticket_id bigint, status text, created_at timestamptz, marked boolean, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM open_ticket(target_event, ticket_kind, target_quest, reported_username, body,
                                         request_key, NULL::uuid);
END $$;

-- ================================================================ the interim retention (Q-075)
-- Every object of an event that ended 365 days ago goes, whatever its state or purpose. A holder is let go first
-- (submission, then ticket), so the order stays holder -> media_object -> media_delete; the AFTER triggers delete
-- the held rows, and the rest is deleted here. At most `batch` objects a call. The system seat only.
CREATE FUNCTION media_purge_due(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due uuid[];
BEGIN
  PERFORM media_system();
  due := ARRAY(
    SELECT m.id FROM media_object m JOIN event e ON e.id = m.event_id
    WHERE e.ends_at IS NOT NULL AND e.ends_at < now() - interval '365 days'
    ORDER BY m.id LIMIT least(greatest(coalesce(batch, 500), 1), 1000));
  UPDATE submission s SET photo = NULL WHERE s.photo = ANY (due);
  UPDATE ticket t SET photo = NULL WHERE t.photo = ANY (due);
  DELETE FROM media_object m WHERE m.id = ANY (due);
  RETURN cardinality(due);
END $$;
REVOKE ALL ON FUNCTION media_purge_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_purge_due(integer) TO questify_app;

-- ================================================================ reading
-- As 0055, PL/pgSQL now (a definer on a request path, ADR-670), with the kind, whether the send held a photo and
-- whether that photo was deleted since. The player never gets a key: their own list shows the state only (FR-205).
DROP FUNCTION own_submissions(uuid);
CREATE FUNCTION own_submissions(target_event uuid)
  RETURNS TABLE (id bigint, quest_id uuid, status text, points integer, body text, reason text, reason_system boolean,
                 resubmit boolean, created_at timestamptz, reviewed_at timestamptz, kind text, photo_gone boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.quest_id, s.status,
         coalesce((SELECT l.score_delta::integer FROM ledger_entry l WHERE l.completion_id = s.completion_id
                     AND l.kind = 'quest'),
                  s.points * coalesce((quest_boost(q, n, s.created_at)).multiplier, 1)),
         s.body, s.reason, s.reason_system,
         coalesce((q.type_config ->> 'resubmit')::boolean, false), s.created_at, s.reviewed_at, s.kind,
         s.photo_gone_at IS NOT NULL
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

-- As 0040, PL/pgSQL now, with the kind, the photo's key and whether it was deleted. Internal: only the two seat-checked
-- readers below call it.
DROP FUNCTION event_submissions(uuid, text, bigint, integer);
DROP FUNCTION operator_submissions(uuid, bigint, integer);
DROP FUNCTION queue_rows(uuid, text, bigint, integer, uuid);
CREATE FUNCTION queue_rows(target_event uuid, wanted text, cursor_id bigint, page integer, only_operator uuid)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz, kind text, photo_key text, photo_gone boolean)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.quest_id, q.title_ar, q.title_en, s.enrollment_id, p.username, p.avatar, s.body, s.points, s.status,
         s.auto, s.marked, s.reason, s.reason_system, s.created_at, s.reviewed_at, s.seen_at, s.kind, m.key,
         s.photo_gone_at IS NOT NULL
  FROM submission s
  JOIN quest q ON q.id = s.quest_id
  JOIN enrollment n ON n.id = s.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN media_object m ON m.id = s.photo AND m.event_id = s.event_id
  WHERE s.event_id = target_event
    AND CASE wanted
          WHEN 'pending' THEN s.status = 'pending' AND (cursor_id IS NULL OR s.id > cursor_id)
          WHEN 'unseen' THEN s.auto AND s.status = 'approved' AND s.seen_at IS NULL
                             AND (cursor_id IS NULL OR s.id > cursor_id)
          WHEN 'marked' THEN s.marked AND s.status = 'pending' AND (cursor_id IS NULL OR s.id > cursor_id)
          WHEN 'done' THEN s.status <> 'pending' AND (cursor_id IS NULL OR s.id < cursor_id)
          ELSE false
        END
    AND (only_operator IS NULL OR (n.player_id <> only_operator
                                   AND operator_reviews_quest(target_event, only_operator, s.quest_id)))
  ORDER BY CASE WHEN wanted = 'done' THEN -s.id ELSE s.id END
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION queue_rows(uuid, text, bigint, integer, uuid) FROM PUBLIC;

CREATE FUNCTION event_submissions(target_event uuid, wanted text, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz, kind text, photo_key text, photo_gone boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY SELECT * FROM queue_rows(ev.id, wanted, cursor_id, page, NULL);
END $$;
REVOKE ALL ON FUNCTION event_submissions(uuid, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_submissions(uuid, text, bigint, integer) TO questify_app;

CREATE FUNCTION operator_submissions(target_event uuid, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz, kind text, photo_key text, photo_gone boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := review_operator(target_event);
BEGIN
  RETURN QUERY SELECT * FROM queue_rows(target_event, 'pending', cursor_id, page, me);
END $$;
REVOKE ALL ON FUNCTION operator_submissions(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_submissions(uuid, bigint, integer) TO questify_app;

-- ================================================================ the ticket readers, with the photo's key
-- As 0114, with the photo's key.
DROP FUNCTION event_tickets(uuid, text, text, bigint, integer);
CREATE FUNCTION event_tickets(target_event uuid, wanted text, wanted_kind text, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, kind text, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, marked boolean, status text, queue text, outcome text,
                 reply text, answered_by text, answerer text, answerer_deleted boolean, created_at timestamptz,
                 closed_at timestamptz, reported_enrollment_id uuid, reported_username text,
                 escalated_at timestamptz, escalation_note text, escalated_by text, returned_at timestamptz,
                 return_note text, photo_key text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT t.id, t.kind, t.quest_id, q.title_ar, q.title_en, t.enrollment_id, p.username, p.avatar, t.body, t.marked,
         t.status, t.queue, t.outcome, t.reply,
         CASE WHEN t.answered_by_operator IS NOT NULL THEN 'operator'
              WHEN t.answered_by_staff IS NOT NULL THEN 'staff'
              WHEN t.answered_by_admin IS NOT NULL THEN 'admin' END,
         coalesce(op.username, staff_shown(su.id, ev.organizer_id)), coalesce(op.status = 'deleted', false), t.created_at, t.closed_at,
         t.reported_enrollment_id, rp.username, t.escalated_at, t.escalation_note, staff_shown(es.id, ev.organizer_id), t.returned_at,
         t.return_note, m.key
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN player op ON op.id = t.answered_by_operator
  LEFT JOIN staff_user su ON su.id = t.answered_by_staff
  LEFT JOIN staff_user es ON es.id = t.escalated_by_staff
  LEFT JOIN enrollment rn ON rn.id = t.reported_enrollment_id
  LEFT JOIN player rp ON rp.id = rn.player_id
  LEFT JOIN media_object m ON m.id = t.photo AND m.event_id = t.event_id
  WHERE t.event_id = ev.id
    AND (wanted_kind IS NULL OR t.kind = wanted_kind)
    AND CASE wanted
          WHEN 'open' THEN t.status = 'open' AND t.queue = 'event' AND (cursor_id IS NULL OR t.id > cursor_id)
          WHEN 'with_questify' THEN t.status = 'open' AND t.queue = 'questify'
                                    AND (cursor_id IS NULL OR t.id > cursor_id)
          WHEN 'closed' THEN t.status = 'closed' AND (cursor_id IS NULL OR t.id < cursor_id)
          ELSE false
        END
  ORDER BY CASE WHEN wanted = 'closed' THEN -t.id ELSE t.id END
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION event_tickets(uuid, text, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_tickets(uuid, text, text, bigint, integer) TO questify_app;

-- As 0059, with the photo's key.
DROP FUNCTION operator_ticket(uuid, bigint);
CREATE FUNCTION operator_ticket(target_event uuid, target bigint)
  RETURNS TABLE (id bigint, kind text, quest_id uuid, quest_title_ar text, quest_title_en text, username text,
                 avatar text, body text, marked boolean, status text, outcome text, reply text,
                 created_at timestamptz, closed_at timestamptz, photo_key text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me uuid := help_operator(target_event);
BEGIN
  RETURN QUERY
  SELECT t.id, t.kind, t.quest_id, q.title_ar, q.title_en, p.username, p.avatar, t.body, t.marked, t.status,
         t.outcome, t.reply, t.created_at, t.closed_at, m.key
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN media_object m ON m.id = t.photo AND m.event_id = t.event_id
  WHERE t.id = target AND t.event_id = target_event AND operator_sees_ticket(t, me)
    AND (t.status = 'open' OR t.answered_by_operator = me);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such ticket in this event' USING ERRCODE = 'HT404';
  END IF;
END $$;
REVOKE ALL ON FUNCTION operator_ticket(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_ticket(uuid, bigint) TO questify_app;

-- As 0059, PL/pgSQL now, with whether the item holds a photo (the Inbox shows a mark; the item's own read signs it).
DROP FUNCTION operator_inbox(uuid, bigint, text, bigint, integer);
DROP FUNCTION inbox_rows(uuid, uuid, boolean, boolean);
CREATE FUNCTION inbox_rows(target_event uuid, me uuid, review boolean, help boolean)
  RETURNS TABLE (kind text, id bigint, created_at timestamptz, quest_id uuid, quest_title_ar text, quest_title_en text,
                 username text, avatar text, preview text, marked boolean, ticket_kind text, has_photo boolean)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT 'submission'::text, s.id, s.created_at, s.quest_id, q.title_ar, q.title_en, p.username, p.avatar,
         left(s.body, 120), s.marked, NULL::text, s.photo IS NOT NULL
  FROM submission s
  JOIN quest q ON q.id = s.quest_id
  JOIN enrollment n ON n.id = s.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE review AND s.event_id = target_event AND s.status = 'pending' AND n.player_id <> me
    AND operator_reviews_quest(target_event, me, s.quest_id)
  UNION ALL
  SELECT 'ticket'::text, t.id, t.created_at, t.quest_id, q.title_ar, q.title_en, p.username, p.avatar,
         left(t.body, 120), t.marked, t.kind, t.photo IS NOT NULL
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN quest q ON q.id = t.quest_id
  WHERE help AND t.event_id = target_event AND t.status = 'open' AND operator_sees_ticket(t, me);
END $$;
REVOKE ALL ON FUNCTION inbox_rows(uuid, uuid, boolean, boolean) FROM PUBLIC;

CREATE FUNCTION operator_inbox(target_event uuid, cursor_position bigint, cursor_kind text, cursor_id bigint,
                               page integer)
  RETURNS TABLE (kind text, id bigint, created_at timestamptz, quest_id uuid, quest_title_ar text, quest_title_en text,
                 username text, avatar text, preview text, marked boolean, ticket_kind text, has_photo boolean,
                 "position" bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  seat record;
BEGIN
  SELECT * INTO seat FROM inbox_abilities(target_event);
  RETURN QUERY
  SELECT x.*, (extract(epoch FROM x.created_at) * 1000000)::bigint
  FROM inbox_rows(target_event, seat.me, seat.review, seat.help) x
  WHERE cursor_position IS NULL
     OR ((extract(epoch FROM x.created_at) * 1000000)::bigint, x.kind, x.id)
        > (cursor_position, coalesce(cursor_kind, ''), coalesce(cursor_id, 0))
  ORDER BY x.created_at, x.kind, x.id
  LIMIT least(greatest(coalesce(page, 30), 1), 100);
END $$;
REVOKE ALL ON FUNCTION operator_inbox(uuid, bigint, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_inbox(uuid, bigint, text, bigint, integer) TO questify_app;

-- As 0061, with the photo's key: Questify sees an escalated ticket's photo with the rest of it (audited as before).
DROP FUNCTION console_ticket(bigint, uuid);
CREATE FUNCTION console_ticket(target bigint, request uuid)
  RETURNS TABLE (id bigint, kind text, body text, marked boolean, status text, outcome text, reply text,
                 created_at timestamptz, closed_at timestamptz, username text, organizer_id uuid,
                 organizer_name text, event_id uuid, event_name_ar text, event_name_en text, event_status text,
                 quest_title_ar text, quest_title_en text, reported_username text, escalated_at timestamptz,
                 escalated_by text, escalation_note text, returned_at timestamptz, return_note text,
                 answered_by text, app_version text, platform text, os_version text, device_model text,
                 photo_key text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  admin uuid := ticket_admin();
  item  ticket%ROWTYPE;
BEGIN
  SELECT t.* INTO item FROM ticket t WHERE t.id = target AND t.queue = 'questify';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such ticket in the queue' USING ERRCODE = 'HT404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('admin', admin, item.organizer_id, item.event_id, 'console.ticket_read', 'ticket', item.id::text, request);
  RETURN QUERY
  SELECT t.id, t.kind, t.body, t.marked, t.status, t.outcome, t.reply, t.created_at, t.closed_at, p.username,
         t.organizer_id, o.name, t.event_id, e.name_ar, e.name_en,
         CASE WHEN e.id IS NOT NULL THEN event_status_now(e.status, e.starts_at, e.ends_at) END,
         q.title_ar, q.title_en, rp.username, t.escalated_at, es.email, t.escalation_note, t.returned_at,
         t.return_note, ad.email, t.app_version, t.platform, t.os_version, t.device_model, m.key
  FROM ticket t
  JOIN player p ON p.id = t.player_id
  LEFT JOIN organizer o ON o.id = t.organizer_id
  LEFT JOIN event e ON e.id = t.event_id
  LEFT JOIN quest q ON q.id = t.quest_id
  LEFT JOIN staff_user es ON es.id = t.escalated_by_staff
  LEFT JOIN staff_user ad ON ad.id = t.answered_by_admin
  LEFT JOIN enrollment rn ON rn.id = t.reported_enrollment_id
  LEFT JOIN player rp ON rp.id = rn.player_id
  LEFT JOIN media_object m ON m.id = t.photo AND m.event_id = t.event_id
  WHERE t.id = item.id;
END $$;
REVOKE ALL ON FUNCTION console_ticket(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_ticket(bigint, uuid) TO questify_app;
