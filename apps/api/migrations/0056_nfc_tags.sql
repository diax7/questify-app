-- NFC tags (T-308, F-105, FR-312, FR-313, FR-621, ADR-234, ADR-237; plan
-- docs/plans/2026-10-24-t-308-nfc-tags.md). An operator writes a quest's tag from staff mode: the tag holds a signed
-- Questify URL of its own (the tag's id; the quest is found here, so a tag can be moved), registered with the sticker's
-- id. A player taps it in the app; the tap is a completion of method `nfc` through the one door, record_completion. A
-- tap whose sticker id differs from the registered one is paid and counted on the tag, and the account is flagged from
-- its second such tap (ADR-041). The quest QR stays on with NFC (FR-313). Deny by default: both tables have row-level
-- security forced, PUBLIC revoked and no grant; every new function is closed to PUBLIC here, and only the operator,
-- player and team doors are granted.

-- ================================================================ the method (FR-313)
-- NFC on scan quests only, and only with the quest QR: the backup can never be switched off.
ALTER TABLE quest DROP CONSTRAINT quest_verification_known;
ALTER TABLE quest ADD CONSTRAINT quest_verification_known CHECK (
  verification <@ ARRAY['quest_qr', 'my_qr', 'nfc']
  AND (type <> 'scan_qr' OR cardinality(verification) >= 1)
  AND (type <> 'challenge' OR verification = ARRAY['my_qr'])
  AND (type <> 'location' OR verification = ARRAY['quest_qr'])
  AND (type IN ('scan_qr', 'challenge', 'location') OR cardinality(verification) = 0)
  AND (NOT ('nfc' = ANY (verification)) OR (type = 'scan_qr' AND 'quest_qr' = ANY (verification))));

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport',
                    'location', 'meet_scan', 'meet_shown', 'game', 'nfc'));

-- One open copy case per account; evidence {"completions": [ids]} (the taps whose sticker id did not match), the
-- newest 50, read by event_flags and flag_detail as a location case's.
ALTER TABLE flag DROP CONSTRAINT flag_kind_check;
ALTER TABLE flag ADD CONSTRAINT flag_kind_check
  CHECK (kind IN ('shared_device', 'burst', 'far_from_venue', 'impossible_speed', 'minigame', 'nfc_copy'));
CREATE UNIQUE INDEX flag_nfc_open ON flag (enrollment_id, kind) WHERE kind = 'nfc_copy' AND status = 'open';

-- ================================================================ the tag (ADR-234)
-- One registration of a physical sticker for one quest. `uid` is the sticker's id as the writing phone read it
-- (4 to 10 bytes). `version` is in the tag's signed URL. A revoked row stays (its taps name it); one active row per
-- sticker and event. A quest with tags is not deleted (RESTRICT: the builder answers tags_in_use). Written only by its
-- definers; never by the rehearsal wipe (a tag on a wall is organizer data).
CREATE TABLE nfc_tag (
  id           uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  quest_id     uuid NOT NULL,
  uid          bytea NOT NULL CHECK (length(uid) BETWEEN 4 AND 10),
  label        text NOT NULL DEFAULT '' CHECK (char_length(label) <= 40),
  locked       boolean NOT NULL,
  version      integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  written_by   uuid REFERENCES staff_assignment (id) ON DELETE SET NULL,
  written_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT nfc_tag_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX nfc_tag_uid_active ON nfc_tag (event_id, uid) WHERE status = 'active';
CREATE INDEX nfc_tag_quest_idx ON nfc_tag (quest_id) WHERE status = 'active';
CREATE INDEX nfc_tag_writer_idx ON nfc_tag (written_by, written_at DESC);
ALTER TABLE nfc_tag ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfc_tag FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nfc_tag FROM PUBLIC;

-- One row per tap that paid. `uid_ok`: the sticker id the phone read is the registered one (false: another sticker,
-- or none sent); NULL when the phone said it cannot read one (`platform`, the iPhone's fallback): not checked. Goes
-- with its completion (the rehearsal wipe); nothing personal in it.
CREATE TABLE nfc_tap (
  completion_id bigint PRIMARY KEY REFERENCES quest_completion (id) ON DELETE CASCADE,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  tag_id        uuid NOT NULL REFERENCES nfc_tag (id) ON DELETE RESTRICT,
  uid_ok        boolean,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nfc_tap_tag_idx ON nfc_tap (tag_id, created_at);
ALTER TABLE nfc_tap ENABLE ROW LEVEL SECURITY;
ALTER TABLE nfc_tap FORCE ROW LEVEL SECURITY;
REVOKE ALL ON nfc_tap FROM PUBLIC;

-- As 0055, plus the event's taps and tags: a draft event's delete would reach its quests (RESTRICT from a tag) before
-- its tags (CTO 4).
CREATE OR REPLACE FUNCTION event_delete_goals() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM community_goal g WHERE g.event_id = OLD.id;
  DELETE FROM boost b WHERE b.event_id = OLD.id;
  DELETE FROM nfc_tap t WHERE t.event_id = OLD.id;
  DELETE FROM nfc_tag t WHERE t.event_id = OLD.id;
  RETURN OLD;
END $$;

-- ================================================================ the one door
-- As 0055, with `nfc` on a scan quest that offers it. Only tap_quest passes `nfc`; complete_quest still refuses it.
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

  RETURN QUERY SELECT made, paid, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- ================================================================ writing a tag (FR-312)
-- The calling operator's assignment for writing a tag of this quest, or a refusal: OP403 not an operator of the event,
-- OA403 write_nfc off, OQ404 no such quest in the event, OS403 outside the operator's quests, NT409 event_closed
-- (ended or archived) and not_nfc (not a scan quest with NFC on). Reads only; the assignment is held FOR SHARE, so a
-- removal waits for the write. Internal.
CREATE FUNCTION nfc_writer(target_event uuid, target_quest uuid) RETURNS staff_assignment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
  quest_row  quest%ROWTYPE;
  ev         event%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa
  WHERE sa.event_id = target_event AND sa.player_id = me FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('write_nfc' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'writing tags is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = target_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'OQ404';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_assignment_quest q WHERE q.assignment_id = assignment.id)
     AND NOT EXISTS (SELECT 1 FROM staff_assignment_quest q
                     WHERE q.assignment_id = assignment.id AND q.quest_id = target_quest) THEN
    RAISE EXCEPTION 'outside this operator''s quests' USING ERRCODE = 'OS403';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'NT409', DETAIL = 'event_closed';
  END IF;
  IF quest_row.type <> 'scan_qr' OR NOT ('nfc' = ANY (quest_row.verification)) THEN
    RAISE EXCEPTION 'this quest has no NFC tag' USING ERRCODE = 'NT409', DETAIL = 'not_nfc';
  END IF;
  RETURN assignment;
END $$;
REVOKE ALL ON FUNCTION nfc_writer(uuid, uuid) FROM PUBLIC;

-- Step 1 of a write: checks the operator may write this quest's tag and answers a fresh tag id. Nothing is stored; the
-- API signs the id into the tag's URL and into a short-lived ticket that confirm requires.
CREATE FUNCTION prepare_nfc_tag(target_event uuid, target_quest uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM nfc_writer(target_event, target_quest);
  RETURN gen_random_uuid();
END $$;
REVOKE ALL ON FUNCTION prepare_nfc_tag(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prepare_nfc_tag(uuid, uuid) TO questify_app;

-- Step 3 of a write: registers the written tag (the API opened its signed URL and its ticket). Under the quest row
-- (counts exact) and the event's tag lock: an active tag with the same sticker id in this event is revoked (audited
-- `nfc_tag.revoke`, answered as `replaced`), then the row is inserted (audited `nfc_tag.write`; never the sticker id).
-- Refusals: nfc_writer's, NT422 (uid, label), NT409 already_registered (this tag id is registered: a second confirm
-- of one prepared tag, CTO C), limit_reached (50 active tags a quest, 2,000 an event).
CREATE FUNCTION register_nfc_tag(target_event uuid, target_quest uuid, tag uuid, seen_uid bytea, tag_label text,
                                 is_locked boolean, request uuid)
  RETURNS TABLE (tag_id uuid, quest_id uuid, replaced_label text, replaced_quest uuid, replaced_title_ar text,
                 replaced_title_en text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  assignment staff_assignment%ROWTYPE := nfc_writer(target_event, target_quest);
  quest_row  quest%ROWTYPE;
  label_text text := btrim(coalesce(tag_label, ''));
  old        nfc_tag%ROWTYPE;
  old_quest  quest%ROWTYPE;
BEGIN
  IF seen_uid IS NULL OR length(seen_uid) NOT BETWEEN 4 AND 10 THEN
    RAISE EXCEPTION 'a tag id is 4 to 10 bytes' USING ERRCODE = 'NT422', DETAIL = 'uid';
  END IF;
  IF char_length(label_text) > 40 THEN
    RAISE EXCEPTION 'a label is at most 40 characters' USING ERRCODE = 'NT422', DETAIL = 'label';
  END IF;
  IF tag IS NULL OR is_locked IS NULL THEN
    RAISE EXCEPTION 'the tag and its lock are required' USING ERRCODE = 'NT422', DETAIL = 'tag';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest FOR NO KEY UPDATE;
  -- Read again under the lock: the builder may have switched NFC off since nfc_writer's read.
  IF quest_row.type <> 'scan_qr' OR NOT ('nfc' = ANY (quest_row.verification)) THEN
    RAISE EXCEPTION 'this quest has no NFC tag' USING ERRCODE = 'NT409', DETAIL = 'not_nfc';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('nfc:' || target_event, 0));
  IF EXISTS (SELECT 1 FROM nfc_tag t WHERE t.id = tag) THEN
    RAISE EXCEPTION 'this tag is registered' USING ERRCODE = 'NT409', DETAIL = 'already_registered';
  END IF;

  UPDATE nfc_tag t SET status = 'revoked', revoked_at = now()
  WHERE t.event_id = target_event AND t.uid = seen_uid AND t.status = 'active'
  RETURNING t.* INTO old;
  IF old.id IS NOT NULL THEN
    SELECT * INTO old_quest FROM quest q WHERE q.id = old.quest_id;
    INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after, request_id)
    VALUES ('system', old.organizer_id, target_event, 'nfc_tag.revoke', 'nfc_tag', old.id::text,
            jsonb_build_object('operatorId', assignment.id, 'questId', old.quest_id, 'label', old.label,
                               'replacedBy', tag), request);
  END IF;
  IF (SELECT count(*) FROM nfc_tag t WHERE t.quest_id = target_quest AND t.status = 'active') >= 50
     OR (SELECT count(*) FROM nfc_tag t WHERE t.event_id = target_event AND t.status = 'active') >= 2000 THEN
    RAISE EXCEPTION 'too many tags' USING ERRCODE = 'NT409', DETAIL = 'limit_reached';
  END IF;

  INSERT INTO nfc_tag (id, organizer_id, event_id, quest_id, uid, label, locked, written_by)
  VALUES (tag, quest_row.organizer_id, target_event, target_quest, seen_uid, label_text, is_locked, assignment.id);
  INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('system', quest_row.organizer_id, target_event, 'nfc_tag.write', 'nfc_tag', tag::text,
          jsonb_build_object('operatorId', assignment.id, 'questId', target_quest, 'label', label_text,
                             'locked', is_locked), request);
  RETURN QUERY SELECT tag, target_quest, old.label, old.quest_id, old_quest.title_ar, old_quest.title_en;
END $$;
REVOKE ALL ON FUNCTION register_nfc_tag(uuid, uuid, uuid, bytea, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_nfc_tag(uuid, uuid, uuid, bytea, text, boolean, uuid) TO questify_app;

-- The Tools screen's write page for the calling operator (OP403, OA403 as nfc_writer): the quests they may write a tag
-- for (scan quests with NFC on, inside their quest limit) with each one's active tag count, and their own 50 latest
-- writes.
CREATE FUNCTION operator_nfc_tags(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
BEGIN
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF me IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('write_nfc' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'writing tags is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  RETURN jsonb_build_object(
    'quests', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'titleAr', q.title_ar, 'titleEn', q.title_en,
                                          'tags', (SELECT count(*) FROM nfc_tag t
                                                   WHERE t.quest_id = q.id AND t.status = 'active'))
                       ORDER BY c.position, q.position, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target_event AND q.type = 'scan_qr' AND 'nfc' = ANY (q.verification)
        AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
             OR EXISTS (SELECT 1 FROM staff_assignment_quest s
                        WHERE s.assignment_id = assignment.id AND s.quest_id = q.id))), '[]'::jsonb),
    'tags', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', w.id, 'questId', w.quest_id, 'titleAr', w.title_ar,
                                          'titleEn', w.title_en, 'label', w.label, 'locked', w.locked,
                                          'status', w.status, 'writtenAt', w.written_at)
                       ORDER BY w.written_at DESC, w.id)
      FROM (SELECT t.id, t.quest_id, q.title_ar, q.title_en, t.label, t.locked, t.status, t.written_at
            FROM nfc_tag t JOIN quest q ON q.id = t.quest_id
            WHERE t.event_id = target_event AND t.written_by = assignment.id
            ORDER BY t.written_at DESC, t.id LIMIT 50) w), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION operator_nfc_tags(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_nfc_tags(uuid) TO questify_app;

-- ================================================================ tapping a tag (FR-313, FR-621)
-- Opens the account's copy case, or adds this tap to its open one (the newest 50 kept), from the second tap since the
-- last closed case whose sticker id did not match (CTO 9): one bad read never flags a player. Paid all the same.
CREATE FUNCTION raise_nfc_flag(done quest_completion) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  since  timestamptz;
  copies jsonb;
BEGIN
  SELECT max(f.resolved_at) INTO since FROM flag f
  WHERE f.enrollment_id = done.enrollment_id AND f.kind = 'nfc_copy' AND f.status <> 'open';
  SELECT jsonb_agg(x.id ORDER BY x.id) INTO copies FROM (
    SELECT c.id FROM nfc_tap t JOIN quest_completion c ON c.id = t.completion_id
    WHERE c.enrollment_id = done.enrollment_id AND t.uid_ok = false AND (since IS NULL OR t.created_at > since)
    ORDER BY c.id DESC LIMIT 50) x;
  IF jsonb_array_length(coalesce(copies, '[]'::jsonb)) < 2 THEN
    RETURN;
  END IF;
  INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
  VALUES (done.organizer_id, done.event_id, done.enrollment_id, 'nfc_copy', jsonb_build_object('completions', copies))
  ON CONFLICT (enrollment_id, kind) WHERE kind = 'nfc_copy' AND status = 'open' DO UPDATE
  SET last_seen_at = now(), evidence = EXCLUDED.evidence;
END $$;
REVOKE ALL ON FUNCTION raise_nfc_flag(quest_completion) FROM PUBLIC;

-- A player's tap (the API opened the tag's signed URL: its id and version). `seen_uid` is the sticker id the phone
-- read, NULL when none was sent; `uid_unreadable` is the phone saying it cannot read one (the iPhone's `platform`
-- fallback): not checked, never flagged. In order: an unknown tag, or one of an event the player is not in, is NT404
-- unknown_tag (one answer, nothing learned about other tags or tenants); a retry of a tap already paid replays it on
-- its own quest, whatever became of the tag since (CTO 1); a revoked tag or an old version is NT404; then the one door,
-- record_completion, with method `nfc` (the wipe, the enrollment lock, every open check and cap, the boost). A fresh
-- completion writes its tap row (taking KEY SHARE on the tag row: a Revoke in flight does not wait or block) and may
-- flag the account. Answers the completion with its quest.
CREATE FUNCTION tap_quest(tag uuid, tag_version integer, seen_uid bytea, uid_unreadable boolean, request_key text,
                          device uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean, quest_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := app_player_id();
  tag_row nfc_tag%ROWTYPE;
  earlier uuid;
  result  record;
  done    quest_completion%ROWTYPE;
  checked boolean;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO tag_row FROM nfc_tag t WHERE t.id = tag;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = tag_row.event_id AND n.player_id = me) THEN
    RAISE EXCEPTION 'unknown tag' USING ERRCODE = 'NT404';
  END IF;
  SELECT c.quest_id INTO earlier FROM quest_completion c JOIN enrollment n ON n.id = c.enrollment_id
  WHERE n.event_id = tag_row.event_id AND n.player_id = me AND c.idempotency_key = request_key;
  IF earlier IS NOT NULL THEN
    RETURN QUERY SELECT r.*, earlier FROM record_completion(earlier, me, 'nfc', NULL, NULL, request_key, device, NULL,
                                                            NULL, NULL, tag_row.event_id, reading) r;
    RETURN;
  END IF;
  IF tag_row.status <> 'active' OR tag_row.version IS DISTINCT FROM tag_version THEN
    RAISE EXCEPTION 'unknown tag' USING ERRCODE = 'NT404';
  END IF;

  SELECT * INTO result FROM record_completion(tag_row.quest_id, me, 'nfc', NULL, NULL, request_key, device, NULL, NULL,
                                              NULL, tag_row.event_id, reading);
  IF NOT result.replayed THEN
    checked := CASE WHEN coalesce(uid_unreadable, false) THEN NULL
                    ELSE coalesce(seen_uid = tag_row.uid, false) END;
    INSERT INTO nfc_tap (completion_id, organizer_id, event_id, tag_id, uid_ok)
    VALUES (result.completion_id, tag_row.organizer_id, tag_row.event_id, tag_row.id, checked);
    IF checked = false THEN
      SELECT * INTO done FROM quest_completion c WHERE c.id = result.completion_id;
      PERFORM raise_nfc_flag(done);
    END IF;
  END IF;
  RETURN QUERY SELECT result.completion_id, result.points, result.occurrence, result.score, result.balance,
                      result.replayed, tag_row.quest_id;
END $$;
REVOKE ALL ON FUNCTION tap_quest(uuid, integer, bytea, boolean, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tap_quest(uuid, integer, bytea, boolean, text, uuid, jsonb) TO questify_app;

-- ================================================================ the Tags panel (owners and editors)
-- The quest's tags for its event's team, newest first: the label, who wrote it and when, locked, the status, and the
-- taps: all of them, the ones whose sticker id did not match (`copies`, CTO 9), the ones the phone could not check
-- (`unchecked`, CTO A), and the last. AN404 outside the caller's event; an unknown quest answers an empty list.
CREATE FUNCTION quest_nfc_tags(target_event uuid, target_quest uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', t.id, 'label', t.label, 'locked', t.locked, 'status', t.status, 'writtenAt', t.written_at,
      'revokedAt', t.revoked_at, 'writtenBy', p.username, 'taps', s.taps, 'copies', s.copies,
      'unchecked', s.unchecked, 'lastTapAt', s.last_at)
      ORDER BY t.status, t.written_at DESC, t.id)
    FROM nfc_tag t
    LEFT JOIN staff_assignment sa ON sa.id = t.written_by
    LEFT JOIN player p ON p.id = sa.player_id
    CROSS JOIN LATERAL (
      SELECT count(*) AS taps, count(*) FILTER (WHERE a.uid_ok = false) AS copies,
             count(*) FILTER (WHERE a.uid_ok IS NULL) AS unchecked, max(a.created_at) AS last_at
      FROM nfc_tap a WHERE a.tag_id = t.id) s
    WHERE t.event_id = ev.id AND t.quest_id = target_quest), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION quest_nfc_tags(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_nfc_tags(uuid, uuid) TO questify_app;

-- An active tag of the caller's event, locked FOR NO KEY UPDATE (a tap holding its key never waits), or NT404
-- (unknown, revoked, or another event's). Internal.
CREATE FUNCTION team_nfc_tag(ev event, target_tag uuid) RETURNS nfc_tag
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  tag_row nfc_tag%ROWTYPE;
BEGIN
  SELECT * INTO tag_row FROM nfc_tag t WHERE t.id = target_tag AND t.event_id = ev.id AND t.status = 'active'
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown tag' USING ERRCODE = 'NT404';
  END IF;
  RETURN tag_row;
END $$;
REVOKE ALL ON FUNCTION team_nfc_tag(event, uuid) FROM PUBLIC;

-- Moves an active tag to another scan quest of the event with NFC on, without rewriting it. Lock order as register:
-- the target quest row, then the tag row. NT404, AN404, NT409 not_nfc (also an unknown quest) and limit_reached; the
-- tag's own quest changes nothing. Audited `nfc_tag.move`.
CREATE FUNCTION move_nfc_tag(target_event uuid, target_tag uuid, target_quest uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  quest_row quest%ROWTYPE;
  tag_row   nfc_tag%ROWTYPE;
BEGIN
  SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id FOR NO KEY UPDATE;
  IF NOT FOUND OR quest_row.type <> 'scan_qr' OR NOT ('nfc' = ANY (quest_row.verification)) THEN
    RAISE EXCEPTION 'that quest has no NFC tag' USING ERRCODE = 'NT409', DETAIL = 'not_nfc';
  END IF;
  tag_row := team_nfc_tag(ev, target_tag);
  IF tag_row.quest_id = target_quest THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM nfc_tag t WHERE t.quest_id = target_quest AND t.status = 'active') >= 50 THEN
    RAISE EXCEPTION 'too many tags' USING ERRCODE = 'NT409', DETAIL = 'limit_reached';
  END IF;
  UPDATE nfc_tag t SET quest_id = target_quest WHERE t.id = tag_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'nfc_tag.move', 'nfc_tag', tag_row.id::text,
          jsonb_build_object('questId', tag_row.quest_id, 'label', tag_row.label),
          jsonb_build_object('questId', target_quest), request);
END $$;
REVOKE ALL ON FUNCTION move_nfc_tag(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION move_nfc_tag(uuid, uuid, uuid, uuid) TO questify_app;

-- Revokes an active tag: a later tap answers unknown_tag; its taps stay. NT404. Audited `nfc_tag.revoke`.
CREATE FUNCTION revoke_nfc_tag(target_event uuid, target_tag uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  tag_row nfc_tag%ROWTYPE := team_nfc_tag(ev, target_tag);
BEGIN
  UPDATE nfc_tag t SET status = 'revoked', revoked_at = now() WHERE t.id = tag_row.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'nfc_tag.revoke', 'nfc_tag', tag_row.id::text,
          jsonb_build_object('questId', tag_row.quest_id, 'label', tag_row.label), request);
END $$;
REVOKE ALL ON FUNCTION revoke_nfc_tag(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_nfc_tag(uuid, uuid, uuid) TO questify_app;

-- Revokes every active tag of a quest of the caller's event ("Revoke all tags"), under the quest row as register.
-- Answers how many. Audited once, `nfc_tag.revoke_all`, with the count.
CREATE FUNCTION revoke_quest_nfc_tags(target_event uuid, target_quest uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  revoked integer;
BEGIN
  PERFORM 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AN404';
  END IF;
  UPDATE nfc_tag t SET status = 'revoked', revoked_at = now()
  WHERE t.quest_id = target_quest AND t.event_id = ev.id AND t.status = 'active';
  GET DIAGNOSTICS revoked = ROW_COUNT;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'nfc_tag.revoke_all', 'quest', target_quest::text,
          jsonb_build_object('revoked', revoked), request);
  RETURN revoked;
END $$;
REVOKE ALL ON FUNCTION revoke_quest_nfc_tags(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_quest_nfc_tags(uuid, uuid, uuid) TO questify_app;
