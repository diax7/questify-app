-- The kiosk (T-309b, F-107, FR-315, ADR-242, ADR-244, ADR-245; plan docs/plans/2026-10-24-t-309b-kiosk.md). A tablet
-- paired as a kiosk for one quest reads each player's live code (their id and the 30-second window of the database
-- clock, signed by the API) and pays them with no staff present. The kiosk door names no quest or event: both are the
-- device's own. Deny by default: `kiosk_scan` has row-level security forced, PUBLIC revoked and no grant; every new
-- function is closed to PUBLIC here, and only the kiosk door and its subject reader are granted.

-- ================================================================ the method (FR-315)
-- `kiosk` on scan quests only; it combines with any other scan method (each keeps its own proof and rules).
ALTER TABLE quest DROP CONSTRAINT quest_verification_known;
ALTER TABLE quest ADD CONSTRAINT quest_verification_known CHECK (
  verification <@ ARRAY['quest_qr', 'my_qr', 'nfc', 'screen_qr', 'kiosk']
  AND (type <> 'scan_qr' OR cardinality(verification) >= 1)
  AND (type <> 'challenge' OR verification = ARRAY['my_qr'])
  AND (type <> 'location' OR verification = ARRAY['quest_qr'])
  AND (type IN ('scan_qr', 'challenge', 'location') OR cardinality(verification) = 0)
  AND (NOT ('nfc' = ANY (verification)) OR (type = 'scan_qr' AND 'quest_qr' = ANY (verification)))
  AND (NOT ('screen_qr' = ANY (verification)) OR (type = 'scan_qr' AND NOT ('quest_qr' = ANY (verification))))
  AND (NOT ('kiosk' = ANY (verification)) OR type = 'scan_qr'));

ALTER TABLE quest_completion DROP CONSTRAINT quest_completion_method_check;
ALTER TABLE quest_completion ADD CONSTRAINT quest_completion_method_check
  CHECK (method IN ('qr', 'code', 'my_qr', 'manual', 'submission', 'vote', 'quiz', 'survey', 'share', 'passport',
                    'location', 'meet_scan', 'meet_shown', 'game', 'nfc', 'screen_qr', 'kiosk'));
-- The one-pay rule reads this enrollment's latest rotating-code completions of the quest (the screen QR and the kiosk).
DROP INDEX quest_completion_screen_idx;
CREATE INDEX quest_completion_window_idx ON quest_completion (enrollment_id, quest_id, created_at DESC)
  WHERE method IN ('screen_qr', 'kiosk');

-- ================================================================ which kiosk paid (ADR-244)
-- One row per kiosk completion: the completion and the kiosk that read the code. No personal data. It goes with its
-- completion (the rehearsal wipe, a quest or event delete); erasure keeps completions, so it keeps this too. A deleted
-- device leaves the row with no device. Written only by kiosk_complete_quest.
CREATE TABLE kiosk_scan (
  completion_id bigint PRIMARY KEY REFERENCES quest_completion (id) ON DELETE CASCADE,
  device_id     uuid REFERENCES paired_device (id) ON DELETE SET NULL,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kiosk_scan_device_idx ON kiosk_scan (device_id, created_at);
ALTER TABLE kiosk_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE kiosk_scan FORCE ROW LEVEL SECURITY;
REVOKE ALL ON kiosk_scan FROM PUBLIC;

-- ================================================================ what a paired page may show
-- As 0057's screen_quest_state, for the method of the device's kind: `screen_qr` for a station, `kiosk` for a kiosk.
CREATE FUNCTION device_quest_state(quest_row quest, device_kind text) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived') THEN
    RETURN 'event_ended';
  END IF;
  IF quest_row.type <> 'scan_qr'
     OR NOT ((CASE device_kind WHEN 'kiosk' THEN 'kiosk' ELSE 'screen_qr' END) = ANY (quest_row.verification)) THEN
    RETURN 'method_off';
  END IF;
  IF quest_row.opens_at IS NOT NULL AND quest_row.opens_at > now() THEN
    RETURN 'not_started';
  END IF;
  IF quest_row.closes_at IS NOT NULL AND quest_row.closes_at <= now() THEN
    RETURN 'ended';
  END IF;
  IF NOT quest_row.visible OR NOT flash_shown(quest_row) THEN
    RETURN 'hidden';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION device_quest_state(quest, text) FROM PUBLIC;

-- The station's reader, now the device reader for a station.
CREATE OR REPLACE FUNCTION screen_quest_state(quest_row quest) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT device_quest_state(quest_row, 'station')
$$;

-- As 0057, with a kiosk's shut reasons read for the kiosk method.
CREATE OR REPLACE FUNCTION device_view() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d         paired_device := current_device();
  ev        event%ROWTYPE;
  quest_row quest%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = d.event_id;
  SELECT * INTO quest_row FROM quest q WHERE q.id = d.quest_id;
  RETURN jsonb_build_object(
    'kind', d.kind, 'label', d.label,
    'event', jsonb_build_object('nameAr', ev.name_ar, 'nameEn', ev.name_en),
    'quest', CASE WHEN d.quest_id IS NULL THEN NULL
                  ELSE jsonb_build_object('titleAr', quest_row.title_ar, 'titleEn', quest_row.title_en,
                                          'points', quest_row.points) END,
    'shut', CASE WHEN d.kind = 'screen' THEN
                   CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
                        THEN 'event_ended' END
                 WHEN device_paused(d) THEN 'paused'
                 ELSE device_quest_state(quest_row, d.kind) END);
END $$;

-- ================================================================ the lists
-- As 0057, with a kiosk's completions in the last 24 hours (`scans`; NULL for a station or big screen).
CREATE OR REPLACE FUNCTION device_json(d paired_device) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', d.id, 'kind', d.kind, 'label', d.label, 'questId', d.quest_id,
    'questTitleAr', q.title_ar, 'questTitleEn', q.title_en, 'client', d.client,
    'pairedBy', CASE WHEN p.id IS NOT NULL THEN jsonb_build_object('type', 'operator', 'name', p.username)
                     WHEN s.id IS NOT NULL THEN jsonb_build_object('type', 'staff', 'name', s.email) END,
    'pairedAt', d.paired_at, 'lastSeenAt', d.last_seen_at, 'activated', d.activated_at IS NOT NULL,
    'status', CASE WHEN d.status = 'active' AND NOT device_alive(d) THEN 'ended' ELSE d.status END,
    'paused', d.status = 'active' AND device_paused(d), 'revokedAt', d.revoked_at,
    'scans', CASE WHEN d.kind = 'kiosk' THEN
                    (SELECT count(*) FROM kiosk_scan k
                     WHERE k.device_id = d.id AND k.created_at > now() - interval '24 hours') END)
  FROM (SELECT 1) one
  LEFT JOIN quest q ON q.id = d.quest_id
  LEFT JOIN staff_assignment sa ON sa.id = d.paired_by_operator
  LEFT JOIN player p ON p.id = sa.player_id
  LEFT JOIN staff_user s ON s.id = d.paired_by_staff
$$;

-- As 0057, with the quests the operator may pair a kiosk for (`kioskQuests`: scan quests with the kiosk on, inside
-- their quest limit, while `scan_quests` is on), beside the stations' (`quests`).
CREATE OR REPLACE FUNCTION operator_devices(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  assignment staff_assignment%ROWTYPE;
BEGIN
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me;
  IF me IS NULL OR NOT FOUND THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  RETURN jsonb_build_object(
    'devices', coalesce((
      SELECT jsonb_agg(device_json(x) ORDER BY x.status, x.paired_at DESC, x.id)
      FROM (SELECT * FROM paired_device d WHERE d.event_id = target_event AND d.paired_by_operator = assignment.id
            ORDER BY d.status, d.paired_at DESC, d.id LIMIT 50) x), '[]'::jsonb),
    'quests', CASE WHEN NOT ('show_rotating_qr' = ANY (assignment.abilities)) THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'titleAr', q.title_ar, 'titleEn', q.title_en,
                                          'points', q.points)
                       ORDER BY c.position, q.position, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target_event AND q.type = 'scan_qr' AND 'screen_qr' = ANY (q.verification)
        AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
             OR EXISTS (SELECT 1 FROM staff_assignment_quest s
                        WHERE s.assignment_id = assignment.id AND s.quest_id = q.id))), '[]'::jsonb) END,
    'kioskQuests', CASE WHEN NOT ('scan_quests' = ANY (assignment.abilities)) THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', q.id, 'titleAr', q.title_ar, 'titleEn', q.title_en,
                                          'points', q.points)
                       ORDER BY c.position, q.position, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target_event AND q.type = 'scan_qr' AND 'kiosk' = ANY (q.verification)
        AND (NOT EXISTS (SELECT 1 FROM staff_assignment_quest s WHERE s.assignment_id = assignment.id)
             OR EXISTS (SELECT 1 FROM staff_assignment_quest s
                        WHERE s.assignment_id = assignment.id AND s.quest_id = q.id))), '[]'::jsonb) END);
END $$;

-- ================================================================ the one door
-- As 0057, with the kiosk (T-309b): a `kiosk:` key only with the kiosk method and the kiosk method only with one; the
-- kiosk method on a scan quest that offers it; its live code's window judged as the screen QR's (QV422 expired); and
-- one pay per player per method within 45 seconds. Only kiosk_complete_quest passes `kiosk`.
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
  -- A `kiosk:` key is the kiosk door's alone, and the kiosk method takes no other key (ADR-244).
  IF (coalesce(request_key, '') LIKE 'kiosk:%') IS DISTINCT FROM (proof_method = 'kiosk') THEN
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
            OR (quest_row.type = 'scan_qr' AND proof_method = 'screen_qr'
                AND 'screen_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'kiosk' AND 'kiosk' = ANY (quest_row.verification))
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
    IF proof_method IN ('screen_qr', 'kiosk') AND NOT screen_window_ok(proof_version, now()) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'expired';
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
  -- One pay per player per screen window (CTO 6), read under the enrollment lock taken above; a live code likewise,
  -- each method on its own (the first condition keeps quest_completion_window_idx usable).
  IF proof_method IN ('screen_qr', 'kiosk') AND EXISTS (
    SELECT 1 FROM quest_completion c
    WHERE c.enrollment_id = enrolled.id AND c.quest_id = target AND c.method IN ('screen_qr', 'kiosk')
      AND c.method = proof_method
      AND c.created_at > now() - interval '45 seconds') THEN
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

-- ================================================================ the kiosk door (FR-315, ADR-242, ADR-244)
-- A kiosk pays the player whose live code it read (`POST /v1/device/kiosk-scans`; the API opened the code and passes
-- the player and the window). The device is this request's (app_device_id), read FOR SHARE so a Revoke or a removal
-- trigger waits for a scan in flight: paid before, refused after. DV401 not a live, activated kiosk; DV403 paused (its
-- operator lost `scan_quests` or the quest; the assignment is read without a lock, so a removal never cycles with a
-- scan); OY409 the pairing operator's own player; QK422 a key that is not a UUID; then record_completion's refusals.
-- The key is namespaced `kiosk:{device}:{key}`; the install id is NULL (a kiosk is not the player's phone); the
-- ledger's actor is the player. A fresh completion is named in `kiosk_scan`. `boosted` is read from the ledger entry,
-- on a replay too. Lock order: the device FOR SHARE, the rehearsal row, the enrollment, the items; never the assignment.
CREATE FUNCTION kiosk_complete_quest(scanned uuid, live_window integer, request_key text)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, replayed boolean, boosted boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d    paired_device%ROWTYPE;
  paid record;
BEGIN
  SELECT * INTO d FROM paired_device p WHERE p.id = app_device_id() FOR SHARE;
  IF NOT FOUND OR d.activated_at IS NULL OR d.kind <> 'kiosk' OR NOT device_alive(d) THEN
    RAISE EXCEPTION 'no such device' USING ERRCODE = 'DV401';
  END IF;
  IF device_paused(d) THEN
    RAISE EXCEPTION 'this kiosk is paused' USING ERRCODE = 'DV403', DETAIL = 'paused';
  END IF;
  IF EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.id = d.paired_by_operator AND sa.player_id = scanned) THEN
    RAISE EXCEPTION 'a kiosk never pays the operator who paired it' USING ERRCODE = 'OY409';
  END IF;
  IF request_key IS NULL OR request_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'a kiosk key is a UUID' USING ERRCODE = 'QK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(d.event_id);
  SELECT * INTO paid FROM record_completion(d.quest_id, scanned, 'kiosk', live_window, NULL,
                                            'kiosk:' || d.id || ':' || lower(request_key), NULL, NULL, NULL, NULL,
                                            d.event_id);
  IF NOT paid.replayed THEN
    INSERT INTO kiosk_scan (completion_id, device_id, organizer_id, event_id)
    VALUES (paid.completion_id, d.id, d.organizer_id, d.event_id);
  END IF;
  RETURN QUERY SELECT paid.completion_id, paid.points, paid.occurrence, paid.replayed,
                      EXISTS (SELECT 1 FROM ledger_entry l
                              WHERE l.completion_id = paid.completion_id AND l.kind = 'quest'
                                AND l.boost_id IS NOT NULL);
END $$;
REVOKE ALL ON FUNCTION kiosk_complete_quest(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kiosk_complete_quest(uuid, integer, text) TO questify_app;

-- Who the kiosk just paid, for its green or orange card: the @username and avatar of a player who joined this kiosk's
-- event (any status), else no row. Read after the door, in the same transaction. Nobody else's name leaves it.
CREATE FUNCTION kiosk_scan_subject(scanned uuid) RETURNS TABLE (username text, avatar text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d paired_device := current_device();
BEGIN
  IF d.kind <> 'kiosk' THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT p.username, p.avatar
    FROM enrollment e JOIN player p ON p.id = e.player_id
    WHERE e.event_id = d.event_id AND e.player_id = scanned;
END $$;
REVOKE ALL ON FUNCTION kiosk_scan_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kiosk_scan_subject(uuid) TO questify_app;

-- ================================================================ the live code's window (ADR-242)
-- The window now and the milliseconds until it changes, for the signed-in player's live code (`GET /v1/me/live-code`;
-- the API signs). The database's clock, never the phone's. A read: nothing is written.
CREATE FUNCTION live_code_window(OUT window_number integer, OUT ms_to_next integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app_player_id() IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT w.window_number, w.ms_to_next INTO window_number, ms_to_next FROM screen_window() w;
END $$;
REVOKE ALL ON FUNCTION live_code_window() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_code_window() TO questify_app;
