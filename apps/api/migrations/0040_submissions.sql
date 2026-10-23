-- Submission quests, text only (T-301, ADR-183, ADR-184, ADR-187 to ADR-189; plan
-- docs/plans/2026-10-24-t-301-submissions.md). A player sends text for a submission quest; its points wait on the
-- submission row, outside the ledger, until a reviewer approves it (or at once on an auto-approve quest). Approval
-- writes the ordinary completion and quest entry, so score, balance, ranking and XP follow with no new path; a
-- rejection writes nothing. Photos are T-301b. Deny by default: no table is granted to the API role; the definers below
-- are its only doors, and no door gives a player another player's submission (FR-205).

-- ================================================================ the type
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known CHECK (type IN ('scan_qr', 'enter_code', 'submission'));
-- Text only until T-301b (FR-1006: never video in v1). The API refuses photo and video with a clear message first.
ALTER TABLE quest ADD CONSTRAINT quest_submission_text_only
  CHECK (type <> 'submission' OR type_config -> 'accepts' = '["text"]'::jsonb);

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission'));

-- ================================================================ the submissions
CREATE TABLE submission (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id         uuid NOT NULL,
  event_id             uuid NOT NULL,
  enrollment_id        uuid NOT NULL,
  quest_id             uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('text')),
  -- Personal data a player wrote: account deletion clears it (erased_at).
  body                 text CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000),
  -- Fixed when it is sent (ADR-184): a later edit of the quest changes nothing already sent.
  points               integer NOT NULL CHECK (points BETWEEN 0 AND 100000),
  status               text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'removed')),
  auto                 boolean NOT NULL DEFAULT false,
  -- A word-list hit (FR-1628): marked for the reviewer, never blocked.
  marked               boolean NOT NULL DEFAULT false,
  reason               text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 300),
  -- Closed by the system (the player left the event): `reason` is then a code, not a person's words.
  reason_system        boolean NOT NULL DEFAULT false,
  reviewed_by_staff    uuid,
  reviewed_by_operator uuid,
  review_key           text CHECK (review_key IS NULL OR length(review_key) BETWEEN 1 AND 255),
  reviewed_at          timestamptz,
  seen_at              timestamptz,
  removed_at           timestamptz,
  completion_id        bigint REFERENCES quest_completion (id) ON DELETE RESTRICT,
  idempotency_key      text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  erased_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, idempotency_key),
  CHECK (reviewed_by_staff IS NULL OR reviewed_by_operator IS NULL),
  CHECK ((status IN ('approved', 'removed')) = (completion_id IS NOT NULL)),
  CHECK (erased_at IS NOT NULL OR body IS NOT NULL),
  CHECK (erased_at IS NOT NULL OR status NOT IN ('rejected', 'removed') OR reason IS NOT NULL),
  CHECK (NOT reason_system OR status = 'rejected'),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
-- One pending submission per player and quest (ADR-188).
CREATE UNIQUE INDEX submission_one_pending ON submission (enrollment_id, quest_id) WHERE status = 'pending';
CREATE UNIQUE INDEX submission_completion_key ON submission (completion_id) WHERE completion_id IS NOT NULL;
-- A reviewer's key answers their first outcome; unique per reviewer and event.
CREATE UNIQUE INDEX submission_review_key_staff ON submission (event_id, reviewed_by_staff, review_key)
  WHERE review_key IS NOT NULL AND reviewed_by_staff IS NOT NULL;
CREATE UNIQUE INDEX submission_review_key_operator ON submission (event_id, reviewed_by_operator, review_key)
  WHERE review_key IS NOT NULL AND reviewed_by_operator IS NOT NULL;
CREATE INDEX submission_queue_idx ON submission (event_id, status, id);
CREATE INDEX submission_quest_idx ON submission (quest_id);
ALTER TABLE submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission FORCE ROW LEVEL SECURITY;
REVOKE ALL ON submission FROM PUBLIC;

-- ================================================================ text: cleaned, then checked by the word lists
-- NFC, trimmed, 1 to 1000 characters; control characters (a line break aside) and bidi overrides refused (SV422).
CREATE FUNCTION clean_submission_text(body text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  cleaned text;
BEGIN
  IF body IS NULL THEN
    RAISE EXCEPTION 'text is required' USING ERRCODE = 'SV422', DETAIL = 'empty';
  END IF;
  cleaned := btrim(normalize(replace(body, E'\r\n', E'\n'), NFC), E' \n\t');
  IF cleaned ~ '[\x01-\x09\x0B-\x1F\x7F‪-‮⁦-⁩]' THEN
    RAISE EXCEPTION 'text holds characters that are not allowed' USING ERRCODE = 'SV422', DETAIL = 'characters';
  END IF;
  IF char_length(cleaned) = 0 THEN
    RAISE EXCEPTION 'text is required' USING ERRCODE = 'SV422', DETAIL = 'empty';
  END IF;
  IF char_length(cleaned) > 1000 THEN
    RAISE EXCEPTION 'text is too long' USING ERRCODE = 'SV422', DETAIL = 'too_long';
  END IF;
  RETURN cleaned;
END $$;
REVOKE ALL ON FUNCTION clean_submission_text(text) FROM PUBLIC;

-- FR-1628: Arabic marks and tatweel dropped, then split on every run of non-letters; each piece folded like a
-- username. `word` entries match a whole piece, `part` entries anywhere inside one. A hit marks; it never blocks.
CREATE FUNCTION text_marked(body text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH pieces AS (
    SELECT username_fold(p) AS piece
    FROM regexp_split_to_table(regexp_replace(body, '[ـً-ْٰ]', '', 'g'), '[^A-Za-zء-غف-ي]+') AS p
    WHERE p <> '')
  SELECT EXISTS (
    SELECT 1 FROM pieces, username_word w
    WHERE (w.match = 'word' AND w.word = pieces.piece)
       OR (w.match = 'part' AND position(w.word IN pieces.piece) > 0))
$$;
REVOKE ALL ON FUNCTION text_marked(text) FROM PUBLIC;

-- ================================================================ one set of open checks for every completion path
-- The checks a player's own play must pass now: an active member, the event live for them, the quest visible, inside its
-- window and in their audience. Raises QC403 / QN403 as record_completion always did. Internal.
CREATE FUNCTION quest_open_check(quest_row quest, enrolled enrollment) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev        event%ROWTYPE;
  group_row category%ROWTYPE;
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
  IF NOT in_audience(enrolled.id, group_row.audience_kind, group_row.audience_field_id,
                     group_row.audience_values) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_for_you';
  END IF;
END $$;
REVOKE ALL ON FUNCTION quest_open_check(quest, enrollment) FROM PUBLIC;

-- As 0037, with the open checks in quest_open_check and the `sub:` key prefix reserved for approvals. A submission
-- quest offers no scan or code (wrong_method); the team's manual award still completes it.
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row     quest%ROWTYPE;
  enrolled      enrollment%ROWTYPE;
  earlier       quest_completion%ROWTYPE;
  earlier_by    uuid;
  earlier_staff uuid;
  done_count    integer;
  made          bigint;
  entry         bigint;
BEGIN
  IF request_key LIKE 'sub:%' THEN
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

  PERFORM quest_open_check(quest_row, enrolled);

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

-- ================================================================ approval (internal)
-- Pays an approved submission: the completion under the fixed key 'sub:<id>' (no second payment can ever exist), and the
-- quest entry at the frozen points; the balance only while the shop window is open (FR-1710). The cap and the quest's
-- window were checked when it was sent (ADR-184). The caller holds the enrollment lock and has checked who may approve.
CREATE FUNCTION pay_submission(sub submission, operator uuid, staff uuid) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  done_count integer;
  made       bigint;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = sub.event_id;
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = sub.enrollment_id AND c.quest_id = sub.quest_id;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
  VALUES (sub.organizer_id, sub.event_id, sub.enrollment_id, sub.quest_id, done_count + 1, 'submission',
          'sub:' || sub.id)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id)
  VALUES (sub.organizer_id, sub.event_id, sub.enrollment_id, 'quest', sub.points,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE sub.points END,
          made, sub.quest_id,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION pay_submission(submission, uuid, uuid) FROM PUBLIC;

-- ================================================================ sending (FR-206, FR-327, FR-1706, FR-1709)
-- The player's text for a submission quest. `guidelines` is the version of the community guidelines in force (the API
-- passes it); a first submission needs it accepted (SG403). Refusals: QC404, QC403, QN403, QP403 (an operator who does
-- not play), SQ422 (not a submission quest), SV422 (the text), SP409 (one already waiting), QD409 (the cap, or
-- `closed` after a rejection with resubmit off), QK422 (the key used for another submission).
CREATE FUNCTION submit_quest(target uuid, body text, guidelines text, request_key text)
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
  done_count integer;
  paid       bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 OR request_key LIKE 'sub:%' THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
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
END $$;
REVOKE ALL ON FUNCTION submit_quest(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_quest(uuid, text, text, text) TO questify_app;

-- ================================================================ reviewing (FR-324, FR-325)
-- One review by a staff member (`staff`) or an operator (`operator`), already checked by the entry points. The event
-- first, then the enrollment, then the submission. Approval re-checks the player (active in the event and on the
-- platform) and the event (live or ended;
-- draft or scheduled for a rehearsal account): SE409 otherwise; RF409 once the results are final. Refusals: SN404 (no
-- such submission here), SR409 (already reviewed), SK422 (the key used for another review), AR400 (a rejection without
-- a reason), SS403 (an operator reviewing their own), OS403 (outside the operator's quests). An approval answers the
-- completion and its player, so the API can move the player's place. Operators are not audited here: the ledger's
-- operator_id and the submission's reviewed_by_operator record them (SECURITY.md).
CREATE FUNCTION review_core(ev event, target bigint, decision text, reason text, request_key text, operator uuid,
                            staff uuid, request uuid)
  RETURNS TABLE (submission_id bigint, status text, points integer, replayed boolean, completion_id bigint,
                 player_id uuid)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
END $$;
REVOKE ALL ON FUNCTION review_core(event, bigint, text, text, text, uuid, uuid, uuid) FROM PUBLIC;

-- An operator's quest limit applies to reviewing too: with a list, only those quests. Internal.
CREATE FUNCTION operator_reviews_quest(target_event uuid, me uuid, target_quest uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT EXISTS (SELECT 1 FROM staff_assignment_quest q JOIN staff_assignment sa ON sa.id = q.assignment_id
                     WHERE sa.event_id = target_event AND sa.player_id = me)
      OR EXISTS (SELECT 1 FROM staff_assignment_quest q JOIN staff_assignment sa ON sa.id = q.assignment_id
                 WHERE sa.event_id = target_event AND sa.player_id = me AND q.quest_id = target_quest)
$$;
REVOKE ALL ON FUNCTION operator_reviews_quest(uuid, uuid, uuid) FROM PUBLIC;

-- The calling operator of this event with the review ability: OP403 not an operator, OA403 the ability is off.
CREATE FUNCTION review_operator(target_event uuid) RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT ('review' = ANY (assignment.abilities)) THEN
    RAISE EXCEPTION 'reviewing is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  RETURN me;
END $$;
REVOKE ALL ON FUNCTION review_operator(uuid) FROM PUBLIC;

-- The dashboard's review (owners and editors in the event's scope; AN404 otherwise).
CREATE FUNCTION staff_review_submission(target_event uuid, target bigint, decision text, reason text,
                                        request_key text, request uuid)
  RETURNS TABLE (submission_id bigint, status text, points integer, replayed boolean, completion_id bigint,
                 player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY SELECT * FROM review_core(award_event_of(target_event), target, decision, reason, request_key, NULL,
                                         app_staff_user_id(), request);
END $$;
REVOKE ALL ON FUNCTION staff_review_submission(uuid, bigint, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION staff_review_submission(uuid, bigint, text, text, text, uuid) TO questify_app;

-- The operator's review in the app (OP403, OA403 first).
CREATE FUNCTION operator_review_submission(target_event uuid, target bigint, decision text, reason text,
                                           request_key text)
  RETURNS TABLE (submission_id bigint, status text, points integer, replayed boolean, completion_id bigint,
                 player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := review_operator(target_event);
  ev event;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  RETURN QUERY SELECT * FROM review_core(ev, target, decision, reason, request_key, me, NULL, NULL);
END $$;
REVOKE ALL ON FUNCTION operator_review_submission(uuid, bigint, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_review_submission(uuid, bigint, text, text, text) TO questify_app;

-- Auto-approved items the team has looked at (ADR-187). Answers how many were newly marked.
CREATE FUNCTION mark_submissions_seen(target_event uuid, ids bigint[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  changed integer;
BEGIN
  UPDATE submission s SET seen_at = now()
  WHERE s.event_id = ev.id AND s.id = ANY (coalesce(ids, '{}')) AND s.seen_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION mark_submissions_seen(uuid, bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_submissions_seen(uuid, bigint[]) TO questify_app;

-- ================================================================ removal (FR-328): one path through remove_award
-- As 0034, plus: removing the entry of an approved submission marks the submission removed, with the reason.
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
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
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true FROM ledger_entry l WHERE l.id = earlier.entry_id;
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome') THEN
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
  IF credit.kind = 'quest' THEN
    UPDATE submission s SET status = 'removed', reason = why, removed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.completion_id = credit.completion_id AND s.status = 'approved';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false;
END $$;

-- The dashboard's removal of an approved submission (owners and editors, ADR-189): finds its quest entry and removes it
-- through remove_award. SN404 no such submission; SR409 not approved (pending, rejected, already removed).
CREATE FUNCTION remove_submission(target_event uuid, target bigint, reason text, request_key text, request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := award_event_of(target_event);
  item  submission%ROWTYPE;
  entry bigint;
BEGIN
  SELECT s.* INTO item FROM submission s WHERE s.id = target AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such submission in this event' USING ERRCODE = 'SN404';
  END IF;
  SELECT l.id INTO entry FROM ledger_entry l WHERE l.completion_id = item.completion_id AND l.kind = 'quest';
  IF entry IS NULL OR (item.status <> 'approved' AND NOT EXISTS (
    SELECT 1 FROM manual_award_key k
    WHERE k.event_id = ev.id AND k.staff_user_id = app_staff_user_id() AND k.idempotency_key = request_key
      AND k.reverses = entry)) THEN
    RAISE EXCEPTION 'only an approved submission can be removed' USING ERRCODE = 'SR409', DETAIL = item.status;
  END IF;
  RETURN QUERY SELECT * FROM remove_award(target_event, entry, reason, request_key, request);
END $$;
REVOKE ALL ON FUNCTION remove_submission(uuid, bigint, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_submission(uuid, bigint, text, text, uuid) TO questify_app;

-- ================================================================ leaving closes what waits
-- A member who stops being active (ban, removal, leaving, account deletion) can no longer be paid: their pending
-- submissions are rejected by the system with a code the app explains (`left_event`). Re-joining does not reopen them,
-- and a system rejection never closes the quest (submit_quest skips it).
CREATE FUNCTION close_pending_submissions() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE submission s
  SET status = 'rejected', reason = 'left_event', reason_system = true, reviewed_at = now()
  WHERE s.enrollment_id = NEW.id AND s.status = 'pending';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION close_pending_submissions() FROM PUBLIC;
CREATE TRIGGER enrollment_close_submissions AFTER UPDATE OF status ON enrollment
  FOR EACH ROW WHEN (OLD.status = 'active' AND NEW.status <> 'active')
  EXECUTE FUNCTION close_pending_submissions();

-- ================================================================ burst flags skip a reviewer's approvals
-- As 0031, but a completion paid by a reviewer's approval is the team's pace, not the player's: it neither raises a
-- burst nor counts toward one. An auto-approved one still counts. The submission is found by the fixed key, because the
-- trigger runs before the submission row points at its completion.
CREATE OR REPLACE FUNCTION raise_completion_flags() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tuning  record;
  since   timestamptz;
  recent  jsonb;
BEGIN
  IF NEW.method = 'manual' OR reviewer_paid(NEW.method, NEW.idempotency_key) THEN
    RETURN NULL;
  END IF;
  IF NEW.device_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('device:' || NEW.event_id || ':' || NEW.device_id, 0));
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, device_id)
    SELECT NEW.organizer_id, NEW.event_id, s.enrollment_id, 'shared_device', NEW.device_id
    FROM (SELECT DISTINCT c.enrollment_id FROM quest_completion c
          JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
          WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id) s
    WHERE EXISTS (SELECT 1 FROM quest_completion c
                  JOIN enrollment n ON n.id = c.enrollment_id AND n.status <> 'removed'
                  WHERE c.event_id = NEW.event_id AND c.device_id = NEW.device_id
                    AND c.enrollment_id <> NEW.enrollment_id)
    ORDER BY s.enrollment_id
    ON CONFLICT (enrollment_id, device_id) WHERE kind = 'shared_device' DO NOTHING;
  END IF;

  SELECT * INTO tuning FROM flag_tuning();
  SELECT max(f.resolved_at) INTO since FROM flag f
  WHERE f.enrollment_id = NEW.enrollment_id AND f.kind = 'burst' AND f.status <> 'open';
  SELECT jsonb_agg(c.id ORDER BY c.id) INTO recent FROM quest_completion c
  WHERE c.enrollment_id = NEW.enrollment_id AND c.method <> 'manual'
    AND NOT reviewer_paid(c.method, c.idempotency_key)
    AND c.created_at > now() - tuning.burst_window AND c.created_at > coalesce(since, '-infinity');
  IF jsonb_array_length(coalesce(recent, '[]'::jsonb)) >= tuning.burst_count THEN
    INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, evidence)
    VALUES (NEW.organizer_id, NEW.event_id, NEW.enrollment_id, 'burst', jsonb_build_object('completions', recent))
    ON CONFLICT (enrollment_id) WHERE kind = 'burst' AND status = 'open' DO UPDATE
    SET last_seen_at = now(),
        evidence = jsonb_build_object('completions', (
          SELECT jsonb_agg(x ORDER BY x) FROM (
            SELECT DISTINCT x FROM jsonb_array_elements((flag.evidence -> 'completions') || (EXCLUDED.evidence -> 'completions')) x
            ORDER BY x DESC LIMIT 50) newest));
  END IF;
  RETURN NULL;
END $$;

-- A submission completion paid by a reviewer (not auto-approved), found by its fixed key 'sub:<id>'. Internal.
CREATE FUNCTION reviewer_paid(method text, completion_key text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT method = 'submission' AND completion_key ~ '^sub:[0-9]{1,18}$' AND EXISTS (
    SELECT 1 FROM submission s WHERE s.id = substr(completion_key, 5)::bigint AND NOT s.auto)
$$;
REVOKE ALL ON FUNCTION reviewer_paid(text, text) FROM PUBLIC;

-- ================================================================ the rehearsal wipe takes submissions too
-- As 0032, with the rehearsal accounts' submissions deleted before their completions.
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
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)),
           'submissions', (SELECT count(*) FROM submission s WHERE s.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

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

-- ================================================================ account deletion clears the words
-- As 0038, plus: the account's submission text and the reviewers' reasons about it are cleared (the rows stay for the
-- ledger). The enrollment update above them has already closed anything pending.
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
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;

-- ================================================================ reading
-- The calling player's own submissions in an event (FR-206, FR-409, FR-1709): newest first, with whether the quest
-- takes another one after a rejection. Nothing for a non-member; never anyone else's.
CREATE FUNCTION own_submissions(target_event uuid)
  RETURNS TABLE (id bigint, quest_id uuid, status text, points integer, body text, reason text, reason_system boolean,
                 resubmit boolean, created_at timestamptz, reviewed_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.quest_id, s.status, s.points, s.body, s.reason, s.reason_system,
         coalesce((q.type_config ->> 'resubmit')::boolean, false), s.created_at, s.reviewed_at
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN submission s ON s.enrollment_id = n.id
  JOIN quest q ON q.id = s.quest_id
  WHERE n.event_id = target_event AND n.player_id = app_player_id()
  ORDER BY s.id DESC
  LIMIT 200
$$;
REVOKE ALL ON FUNCTION own_submissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_submissions(uuid) TO questify_app;

-- The points the calling player's pending submissions in an event will pay (FR-409), over all of them (the list above
-- stops at 200). 0 for a non-member.
CREATE FUNCTION own_pending_points(target_event uuid) RETURNS bigint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(s.points), 0)
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN submission s ON s.enrollment_id = n.id AND s.status = 'pending'
  WHERE n.event_id = target_event AND n.player_id = app_player_id()
$$;
REVOKE ALL ON FUNCTION own_pending_points(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_pending_points(uuid) TO questify_app;

-- One queue row, for the team and for operators.
CREATE FUNCTION queue_rows(target_event uuid, wanted text, cursor_id bigint, page integer, only_operator uuid)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT s.id, s.quest_id, q.title_ar, q.title_en, s.enrollment_id, p.username, p.avatar, s.body, s.points, s.status,
         s.auto, s.marked, s.reason, s.reason_system, s.created_at, s.reviewed_at, s.seen_at
  FROM submission s
  JOIN quest q ON q.id = s.quest_id
  JOIN enrollment n ON n.id = s.enrollment_id
  JOIN player p ON p.id = n.player_id
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
  LIMIT least(greatest(coalesce(page, 50), 1), 100)
$$;
REVOKE ALL ON FUNCTION queue_rows(uuid, text, bigint, integer, uuid) FROM PUBLIC;

-- The team's queue (owners and editors in the event's scope; AN404 otherwise). Filters: pending, unseen (auto-approved
-- and not yet seen, ADR-187), marked, done. Pending, unseen and marked go oldest first; done newest first.
CREATE FUNCTION event_submissions(target_event uuid, wanted text, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY SELECT * FROM queue_rows(ev.id, wanted, cursor_id, page, NULL);
END $$;
REVOKE ALL ON FUNCTION event_submissions(uuid, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_submissions(uuid, text, bigint, integer) TO questify_app;

-- The operator's queue: pending only, inside their quest limit, never their own (OP403, OA403 first).
CREATE FUNCTION operator_submissions(target_event uuid, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := review_operator(target_event);
BEGIN
  RETURN QUERY SELECT * FROM queue_rows(target_event, 'pending', cursor_id, page, me);
END $$;
REVOKE ALL ON FUNCTION operator_submissions(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_submissions(uuid, bigint, integer) TO questify_app;

-- Who sent a submission for any of these quests, for the quest builder's delete guard (has_completions): the caller's
-- own organizer's quests only. Enrollment ids only, never the text.
CREATE FUNCTION submitters_of(quests uuid[]) RETURNS TABLE (enrollment_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT DISTINCT s.enrollment_id FROM submission s
  WHERE s.quest_id = ANY (quests) AND s.organizer_id = app_organizer_id()
$$;
REVOKE ALL ON FUNCTION submitters_of(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submitters_of(uuid[]) TO questify_app;
