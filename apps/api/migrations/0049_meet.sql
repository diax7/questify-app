-- Meet-someone quests (T-303c, ADR-209 to ADR-211; plan docs/plans/2026-10-24-t-303c-meet-someone.md). Two players
-- meet when one scans the other's meet code: a 128-bit random token the shown player's app asked for, alive one minute,
-- used by the first meeting that pays, kept here only as its SHA-256 hash. Both players are paid in one transaction or
-- neither; one meeting per unordered pair and quest; a daily cap per player counted from their own meet completions.
-- Deny by default: meet_pass and meeting have no grant and no policy; the definers below are their only doors.

-- ================================================================ the type (FR-212, FR-213)
ALTER TABLE quest DROP CONSTRAINT quest_type_known;
ALTER TABLE quest ADD CONSTRAINT quest_type_known
  CHECK (type IN ('scan_qr', 'enter_code', 'submission', 'vote', 'quiz', 'challenge', 'survey', 'share', 'passport',
                  'location', 'meet'));
-- A meet quest's organizer-set daily cap (ADR-210): 1 to 50 meetings a player may be paid for in one event day. Its
-- verification list stays empty (quest_verification_known's last clause): no quest QR, no My QR.
ALTER TABLE quest ADD CONSTRAINT quest_meet_cap CHECK (
  CASE WHEN type <> 'meet' THEN true
       WHEN jsonb_typeof(type_config -> 'dailyCap') = 'number' AND (type_config ->> 'dailyCap') ~ '^[0-9]{1,2}$'
         THEN (type_config ->> 'dailyCap')::integer BETWEEN 1 AND 50
       ELSE false END);

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport',
                    'location', 'meet_scan', 'meet_shown'));

-- ================================================================ the meet code (ADR-209)
-- One shown code: the hash of its token, the quest, the shown player's enrollment and the device that showed it. At
-- most one open (ended_at NULL) per player and quest; ended when used or replaced; an expired one stays past
-- expires_at until the next issue for that player deletes it after a day (unless a meeting names it).
CREATE TABLE meet_pass (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  quest_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  device_id     uuid,
  token_hash    bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  -- A quest deleted from the builder (it has no completion) takes its unused codes with it.
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE
);
CREATE INDEX meet_pass_open ON meet_pass (enrollment_id, quest_id) WHERE ended_at IS NULL;
CREATE INDEX meet_pass_enrollment ON meet_pass (enrollment_id, created_at);
ALTER TABLE meet_pass ENABLE ROW LEVEL SECURITY;
ALTER TABLE meet_pass FORCE ROW LEVEL SECURITY;
REVOKE ALL ON meet_pass FROM PUBLIC;

-- One paid meeting: who scanned, who was shown, the code, the scanner's request key (the replay) and both completions.
-- Written after both payments; removed with either completion (the rehearsal wipe) and by erasure of either player.
CREATE TABLE meeting (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id       uuid NOT NULL,
  event_id           uuid NOT NULL,
  quest_id           uuid NOT NULL,
  scanner_enrollment uuid NOT NULL,
  shown_enrollment   uuid NOT NULL,
  pass_id            bigint NOT NULL UNIQUE REFERENCES meet_pass (id) ON DELETE RESTRICT,
  request_key        text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 255),
  scanner_completion bigint NOT NULL REFERENCES quest_completion (id) ON DELETE CASCADE,
  shown_completion   bigint NOT NULL REFERENCES quest_completion (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (scanner_enrollment <> shown_enrollment),
  UNIQUE (scanner_enrollment, request_key),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (scanner_enrollment, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (shown_enrollment, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT
);
-- One meeting per unordered pair and quest (FR-212's second case, FR-213's first).
CREATE UNIQUE INDEX meeting_pair ON meeting (quest_id, least(scanner_enrollment, shown_enrollment),
                                             greatest(scanner_enrollment, shown_enrollment));
CREATE INDEX meeting_shown ON meeting (shown_enrollment);
CREATE INDEX meeting_scanner_completion ON meeting (scanner_completion);
CREATE INDEX meeting_shown_completion ON meeting (shown_completion);
ALTER TABLE meeting ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting FORCE ROW LEVEL SECURITY;
REVOKE ALL ON meeting FROM PUBLIC;

-- ================================================================ the payers
-- As 0047, with an 8th parameter: the device the completion came from (a meeting's two sides each name their own).
-- Every existing caller passes 7 arguments and keeps working (the default). The signature changed: DROP and CREATE.
DROP FUNCTION pay_completion(enrollment, uuid, bigint, text, text, uuid, uuid);
CREATE FUNCTION pay_completion(enrolled enrollment, quest uuid, points bigint, method text, completion_key text,
                               operator uuid, staff uuid, device uuid DEFAULT NULL) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev         event%ROWTYPE;
  quest_row  quest%ROWTYPE;
  done_count integer;
  made       bigint;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = enrolled.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = pay_completion.quest;
  PERFORM lock_quest_items(quest_row);
  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = pay_completion.quest;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key,
                                device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, pay_completion.quest, done_count + 1, method,
          completion_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', points,
          CASE WHEN shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed' THEN 0
               ELSE points END,
          made, pay_completion.quest,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff);
  IF done_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION pay_completion(enrollment, uuid, bigint, text, text, uuid, uuid, uuid) FROM PUBLIC;

-- As 0048, with `meet:` reserved beside the other system keys: a meeting's two completions are keyed
-- `meet:<pass id>`, so no player's own key can take that key first and break a later meeting.
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
BEGIN
  IF request_key LIKE 'sub:%' OR request_key LIKE 'quiz:%' OR request_key LIKE 'pass:%'
     OR request_key LIKE 'meet:%' THEN
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
    IF NOT ((quest_row.type IN ('scan_qr', 'location') AND proof_method = 'qr'
             AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type IN ('scan_qr', 'challenge') AND proof_method = 'my_qr'
                AND 'my_qr' = ANY (quest_row.verification))
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

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, lifetime_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  PERFORM keep_position(made, enrolled, reading);
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
  IF lifetime_count = 0 THEN
    PERFORM give_item(enrolled, quest_row.item_id, made, NULL, NULL);
  END IF;
  PERFORM pay_category_bonus(enrolled, quest_row.category_id, made);

  RETURN QUERY SELECT made, quest_row.points::bigint, lifetime_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- ================================================================ internal helpers (no grant)
-- The event's own switch (`config.features.meetSomeone`, FR-1009), on unless set false. The platform's is composed by
-- the API (T-007), as share quests'.
CREATE FUNCTION meet_on(target_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT e.config -> 'features' -> 'meetSomeone' <> 'false'::jsonb FROM event e WHERE e.id = target_event),
                  true)
$$;
REVOKE ALL ON FUNCTION meet_on(uuid) FROM PUBLIC;

-- The member's meet completions of this quest (either side) since the start of today's event day (the event's zone,
-- T-216). Counted from the member's own rows, so another player's erasure never lowers it (CTO 6).
CREATE FUNCTION meet_today(member uuid, quest_row quest) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM quest_completion c
  WHERE c.enrollment_id = member AND c.quest_id = quest_row.id AND c.method IN ('meet_scan', 'meet_shown')
    AND c.created_at >= (SELECT event_day_start(e, event_day(now(), e)) FROM event e WHERE e.id = quest_row.event_id)
$$;
REVOKE ALL ON FUNCTION meet_today(uuid, quest) FROM PUBLIC;

-- 'done' at the quest's repeat cap (lifetime: meet never refreshes), 'daily_cap' at today's cap, else NULL. The payer
-- reads it under both enrollment locks; the issuer under its own, as an early answer only.
CREATE FUNCTION meet_caps(enrolled enrollment, quest_row quest) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN period_count(enrolled.id, quest_row) >= quest_row.repeat_cap THEN 'done'
              WHEN meet_today(enrolled.id, quest_row) >= (quest_row.type_config ->> 'dailyCap')::integer
                THEN 'daily_cap' END
$$;
REVOKE ALL ON FUNCTION meet_caps(enrollment, quest) FROM PUBLIC;

-- play_enter's checks (0041) for any member, without its lock (CTO 4): an active account (QC404), every open check
-- (quest_open_check: QC403, QN403), and an operator only where operators may play (QP403).
CREATE FUNCTION meet_may_play(enrolled enrollment, quest_row quest) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM player p WHERE p.id = enrolled.player_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  PERFORM quest_open_check(quest_row, enrolled);
  IF enrolled.joined_via IS DISTINCT FROM 'rehearsal' AND EXISTS (
    SELECT 1 FROM staff_assignment sa
    WHERE sa.event_id = enrolled.event_id AND sa.player_id = enrolled.player_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
END $$;
REVOKE ALL ON FUNCTION meet_may_play(enrollment, quest) FROM PUBLIC;

-- A code by its token's hash, or QM422 bad_code.
CREATE FUNCTION meet_pass_for(hash bytea) RETURNS meet_pass
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  found_pass meet_pass%ROWTYPE;
BEGIN
  SELECT * INTO found_pass FROM meet_pass p WHERE p.token_hash = hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not a meet code' USING ERRCODE = 'QM422', DETAIL = 'bad_code';
  END IF;
  RETURN found_pass;
END $$;
REVOKE ALL ON FUNCTION meet_pass_for(bytea) FROM PUBLIC;

-- The scanner's earlier meeting under this request key: the same code answers it as a replay; another code is QK422.
CREATE FUNCTION meet_replay(scanner uuid, key text, pass bigint) RETURNS meeting
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  met meeting%ROWTYPE;
BEGIN
  SELECT * INTO met FROM meeting m WHERE m.scanner_enrollment = scanner AND m.request_key = key;
  IF FOUND AND met.pass_id <> pass THEN
    RAISE EXCEPTION 'this key was used for another meeting' USING ERRCODE = 'QK422';
  END IF;
  RETURN met;
END $$;
REVOKE ALL ON FUNCTION meet_replay(uuid, text, bigint) FROM PUBLIC;

-- What the scanner is answered for a meeting: their completion, its points and occurrence, their score and balance,
-- the quest, and the shown player's completion, id, username and avatar (the id and completion are for the API's
-- ranking update only, never sent to the scanner).
CREATE FUNCTION meet_answer(met meeting, replay boolean)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean, quest_id uuid, other_completion bigint, other_player uuid, other_username text,
                 other_avatar text)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT c.id, l.score_delta, c.occurrence, n.score, n.balance, replay, c.quest_id, met.shown_completion, bp.id,
         bp.username, bp.avatar
  FROM quest_completion c
  JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
  JOIN enrollment n ON n.id = c.enrollment_id
  JOIN enrollment bn ON bn.id = met.shown_enrollment
  JOIN player bp ON bp.id = bn.player_id
  WHERE c.id = met.scanner_completion
$$;
REVOKE ALL ON FUNCTION meet_answer(meeting, boolean) FROM PUBLIC;

-- Every refusal read under the locks, in order: the code (expired, used), the scanner's own play checks (their own
-- codes), the shown player's (only ever not_for_them: the scanner never learns why), the pair, then both caps.
CREATE FUNCTION meet_refusal(pass meet_pass, mine enrollment, theirs enrollment, quest_row quest) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  why text;
BEGIN
  IF pass.ended_at IS NOT NULL AND EXISTS (SELECT 1 FROM meeting m WHERE m.pass_id = pass.id) THEN
    RAISE EXCEPTION 'code used' USING ERRCODE = 'QM422', DETAIL = 'used';
  END IF;
  IF pass.ended_at IS NOT NULL OR pass.expires_at <= now() THEN
    RAISE EXCEPTION 'code expired' USING ERRCODE = 'QM422', DETAIL = 'expired';
  END IF;
  PERFORM meet_may_play(mine, quest_row);
  -- The shown player's checks in their own block: whatever fails, only not_for_them leaves it, never their reason.
  BEGIN
    PERFORM meet_may_play(theirs, quest_row);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'not open for the shown player' USING ERRCODE = 'QM403', DETAIL = 'not_for_them';
  END;
  IF EXISTS (SELECT 1 FROM meeting m
             WHERE m.quest_id = quest_row.id
               AND least(m.scanner_enrollment, m.shown_enrollment) = least(mine.id, theirs.id)
               AND greatest(m.scanner_enrollment, m.shown_enrollment) = greatest(mine.id, theirs.id)) THEN
    RAISE EXCEPTION 'already met' USING ERRCODE = 'QM409', DETAIL = 'already_met',
      HINT = coalesce((SELECT p.username FROM player p WHERE p.id = theirs.player_id), '');
  END IF;
  why := meet_caps(mine, quest_row);
  IF why = 'daily_cap' THEN
    RAISE EXCEPTION 'cap reached' USING ERRCODE = 'QM409', DETAIL = why,
      HINT = quest_row.type_config ->> 'dailyCap';
  ELSIF why IS NOT NULL THEN
    RAISE EXCEPTION 'cap reached' USING ERRCODE = 'QM409', DETAIL = why;
  END IF;
  why := meet_caps(theirs, quest_row);
  IF why IS NOT NULL THEN
    RAISE EXCEPTION 'their cap reached' USING ERRCODE = 'QM409', DETAIL = 'their_' || why;
  END IF;
END $$;
REVOKE ALL ON FUNCTION meet_refusal(meet_pass, enrollment, enrollment, quest) FROM PUBLIC;

-- Pays both sides (ADR-211's order): the quest's items, then both device keys in ascending key order before any insert
-- (CTO 3), then the two payments in player id order (XP rows are per player across events, so two meetings of the same
-- two players in two events never cross), the scanner's reading, the meeting row with both completions (CTO 1), and the
-- code ended. The caller holds both enrollments and the code.
CREATE FUNCTION pay_meeting(pass meet_pass, mine enrollment, theirs enrollment, quest_row quest, key text,
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
                                 device);
    shown_id := pay_completion(theirs, quest_row.id, quest_row.points, 'meet_shown', 'meet:' || pass.id, NULL, NULL,
                               pass.device_id);
  ELSE
    shown_id := pay_completion(theirs, quest_row.id, quest_row.points, 'meet_shown', 'meet:' || pass.id, NULL, NULL,
                               pass.device_id);
    scanner_id := pay_completion(mine, quest_row.id, quest_row.points, 'meet_scan', 'meet:' || pass.id, NULL, NULL,
                                 device);
  END IF;
  PERFORM keep_position(scanner_id, mine, reading);
  INSERT INTO meeting (organizer_id, event_id, quest_id, scanner_enrollment, shown_enrollment, pass_id, request_key,
                       scanner_completion, shown_completion)
  VALUES (pass.organizer_id, pass.event_id, quest_row.id, mine.id, theirs.id, pass.id, key, scanner_id, shown_id)
  RETURNING * INTO met;
  UPDATE meet_pass p SET ended_at = now() WHERE p.id = pass.id;
  RETURN met;
END $$;
REVOKE ALL ON FUNCTION pay_meeting(meet_pass, enrollment, enrollment, quest, text, uuid, jsonb) FROM PUBLIC;

-- ================================================================ the players' doors (granted)
-- Shows a fresh code for the calling player (ADR-209): the quest must be a meet quest of an event they belong to
-- (QC404), the switch on (QF403), the quest open for them (play_enter's checks), and they under both caps (QD409 at
-- the repeat cap, QM409 daily_cap with the cap in HINT). Ends their earlier open code for this quest, deletes their
-- codes older than a day that no meeting names, and keeps only the token's hash.
CREATE FUNCTION issue_meet_pass(target uuid, token_hash bytea, device uuid)
  RETURNS TABLE (pass_id bigint, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  quest_row quest%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  why       text;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO quest_row FROM quest q WHERE q.id = target;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = quest_row.event_id AND n.player_id = me) THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.type <> 'meet' THEN
    RAISE EXCEPTION 'not this kind of quest' USING ERRCODE = 'QT422', DETAIL = 'meet';
  END IF;
  IF NOT meet_on(quest_row.event_id) THEN
    RAISE EXCEPTION 'meet quests are off for this event' USING ERRCODE = 'QF403';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment n
  WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
  PERFORM meet_may_play(enrolled, quest_row);
  why := meet_caps(enrolled, quest_row);
  IF why = 'done' THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  ELSIF why = 'daily_cap' THEN
    RAISE EXCEPTION 'cap reached' USING ERRCODE = 'QM409', DETAIL = 'daily_cap',
      HINT = quest_row.type_config ->> 'dailyCap';
  END IF;
  UPDATE meet_pass p SET ended_at = now()
  WHERE p.enrollment_id = enrolled.id AND p.quest_id = target AND p.ended_at IS NULL;
  DELETE FROM meet_pass p
  WHERE p.enrollment_id = enrolled.id AND p.created_at < now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM meeting m WHERE m.pass_id = p.id);
  RETURN QUERY
  INSERT INTO meet_pass AS p (organizer_id, event_id, quest_id, enrollment_id, device_id, token_hash, expires_at)
  VALUES (enrolled.organizer_id, enrolled.event_id, target, enrolled.id, device, issue_meet_pass.token_hash,
          now() + interval '60 seconds')
  RETURNING p.id, p.expires_at;
END $$;
REVOKE ALL ON FUNCTION issue_meet_pass(uuid, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION issue_meet_pass(uuid, bytea, uuid) TO questify_app;

-- The calling player's own code (no row for anyone else's): open, expired, or used with the scanner's username and
-- avatar and the points this player got, for the shown player's screen. Nothing else about the scanner.
CREATE FUNCTION meet_pass_state(pass bigint)
  RETURNS TABLE (state text, username text, avatar text, points bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN m.id IS NOT NULL THEN 'used'
              WHEN p.ended_at IS NOT NULL OR p.expires_at <= now() THEN 'expired'
              ELSE 'open' END,
         ap.username, ap.avatar, l.score_delta
  FROM meet_pass p
  JOIN enrollment n ON n.id = p.enrollment_id AND n.player_id = app_player_id()
  LEFT JOIN meeting m ON m.pass_id = p.id
  LEFT JOIN enrollment an ON an.id = m.scanner_enrollment
  LEFT JOIN player ap ON ap.id = an.player_id
  LEFT JOIN ledger_entry l ON l.completion_id = m.shown_completion AND l.kind = 'quest'
  WHERE p.id = pass
$$;
REVOKE ALL ON FUNCTION meet_pass_state(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION meet_pass_state(bigint) TO questify_app;

-- The calling player scanned another's meet code (FR-212, FR-213). Refusals: QM422 (bad_code, expired, used, self,
-- same_device), QM409 (already_met with the other's username in HINT, daily_cap with the cap in HINT,
-- their_daily_cap, done, their_done), QM403 (not_in_event, not_for_them), QF403 (switch off), QK422 (a key reused for
-- another code), and the scanner's own play refusals. A duplicate request answers the first meeting (replayed).
CREATE FUNCTION meet_player(token_hash bytea, request_key text, device uuid, reading jsonb DEFAULT NULL)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean, quest_id uuid, other_completion bigint, other_player uuid, other_username text,
                 other_avatar text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  pass      meet_pass%ROWTYPE;
  quest_row quest%ROWTYPE;
  mine      enrollment%ROWTYPE;
  theirs    enrollment%ROWTYPE;
  met       meeting%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  pass := meet_pass_for(meet_player.token_hash);
  SELECT * INTO quest_row FROM quest q WHERE q.id = pass.quest_id;
  IF quest_row.type <> 'meet' THEN
    RAISE EXCEPTION 'not a meet code' USING ERRCODE = 'QM422', DETAIL = 'bad_code';
  END IF;
  IF NOT meet_on(pass.event_id) THEN
    RAISE EXCEPTION 'meet quests are off for this event' USING ERRCODE = 'QF403';
  END IF;
  SELECT * INTO mine FROM enrollment n WHERE n.event_id = pass.event_id AND n.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not in this event' USING ERRCODE = 'QM403', DETAIL = 'not_in_event';
  END IF;
  met := meet_replay(mine.id, meet_player.request_key, pass.id);
  IF met.id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM meet_answer(met, true);
    RETURN;
  END IF;
  IF pass.enrollment_id = mine.id THEN
    RAISE EXCEPTION 'own code' USING ERRCODE = 'QM422', DETAIL = 'self';
  END IF;
  IF device = pass.device_id THEN
    RAISE EXCEPTION 'same device' USING ERRCODE = 'QM422', DETAIL = 'same_device';
  END IF;
  IF pass.expires_at <= now() THEN
    RAISE EXCEPTION 'code expired' USING ERRCODE = 'QM422', DETAIL = 'expired';
  END IF;

  -- ADR-211: the rehearsal row shared, both enrollments in one id-ordered statement, then the code.
  PERFORM ensure_rehearsal_wiped(pass.event_id);
  PERFORM 1 FROM enrollment n WHERE n.id IN (mine.id, pass.enrollment_id) ORDER BY n.id FOR NO KEY UPDATE;
  SELECT * INTO mine FROM enrollment n WHERE n.id = mine.id;
  SELECT * INTO theirs FROM enrollment n WHERE n.id = pass.enrollment_id;
  SELECT * INTO pass FROM meet_pass p WHERE p.id = pass.id FOR UPDATE;
  -- A duplicate that waited on the first request's locks answers its meeting, never `used` (CTO 2).
  met := meet_replay(mine.id, meet_player.request_key, pass.id);
  IF met.id IS NOT NULL THEN
    RETURN QUERY SELECT * FROM meet_answer(met, true);
    RETURN;
  END IF;
  PERFORM meet_refusal(pass, mine, theirs, quest_row);
  met := pay_meeting(pass, mine, theirs, quest_row, meet_player.request_key, device, reading);
  RETURN QUERY SELECT * FROM meet_answer(met, false);
END $$;
REVOKE ALL ON FUNCTION meet_player(bytea, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION meet_player(bytea, text, uuid, jsonb) TO questify_app;

-- ================================================================ the flags (ADR-211)
-- As 0048, with the shown side of a meeting left out of the burst count (the shown player did not act at that moment)
-- and its own burst check skipped; it still counts for the shared device.
CREATE OR REPLACE FUNCTION raise_completion_flags() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  tuning  record;
  since   timestamptz;
  recent  jsonb;
BEGIN
  IF NEW.method = 'manual' OR system_paid(NEW.method, NEW.idempotency_key) THEN
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

  IF NEW.method <> 'meet_shown' THEN
    SELECT * INTO tuning FROM flag_tuning();
    SELECT max(f.resolved_at) INTO since FROM flag f
    WHERE f.enrollment_id = NEW.enrollment_id AND f.kind = 'burst' AND f.status <> 'open';
    SELECT jsonb_agg(c.id ORDER BY c.id) INTO recent FROM quest_completion c
    WHERE c.enrollment_id = NEW.enrollment_id AND c.method NOT IN ('manual', 'meet_shown')
      AND NOT system_paid(c.method, c.idempotency_key)
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
  END IF;

  IF EXISTS (SELECT 1 FROM event e WHERE e.id = NEW.event_id AND e.kind <> 'virtual') THEN
    PERFORM raise_speed_flag(NEW);
  END IF;
  RETURN NULL;
END $$;

-- ================================================================ the player's quest list
-- As 0048, with a meet quest's daily cap and the player's meetings today (either side), for its sheet. The output
-- changed: DROP and CREATE.
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
                 place_lng numeric, place_radius_m integer, daily_cap integer, met_today integer)
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
         CASE WHEN q.type = 'meet' THEN meet_today(me.id, q) END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;

-- ================================================================ erasure and the rehearsal wipe
-- As 0048, plus: every meeting with the account on either side (who met whom is personal data of both; the other
-- player's completion and points stay and still count towards their caps), then the account's codes.
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
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
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
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;

-- As 0047, with the rehearsal accounts' meet codes deleted after their completions (their meetings go with those, by
-- the cascade). Its JSON is unchanged.
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
           'reveals', (SELECT count(*) FROM category_reveal r WHERE r.enrollment_id = ANY (accounts)),
           'item_misses', (SELECT count(*) FROM quest_item_miss m WHERE m.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

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
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
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
