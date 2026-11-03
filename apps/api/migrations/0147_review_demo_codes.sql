-- The App Review demo's QR picker (T-710b, FR-303's review half, FR-1407; ADR-565, ADR-640; plan section 9 of
-- docs/plans/2026-11-03-t-710-review-demo.md). The reviewer has no printed stickers, so the app lists the demo event's
-- printable codes and feeds the picked one to the scanner's own handler: no new completion path, every completion rule
-- unchanged. Three doors answer only the reviewer account, in the demo event, while the window is open, as an active
-- member (`review_demo_here`); anyone else gets RD404, the same as an event that does not exist.
--
-- Deny by default: every function is revoked from PUBLIC in this file and granted to the API's role alone; the rule
-- itself reads `app_player_id()`, so the API cannot ask it about anyone but the caller. New, undeployed.
SET LOCAL lock_timeout = '10s';

-- Whether the calling player is the reviewer, in `ev`, the demo event, while the window is open, an active member with
-- an active account. Home reads it for its `reviewDemo` flag; the two doors below call it first.
CREATE FUNCTION review_demo_here(ev uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM review_demo d
    JOIN player p ON p.id = d.player_id AND p.status = 'active'
    JOIN enrollment n ON n.event_id = d.event_id AND n.player_id = d.player_id AND n.status = 'active'
    WHERE d.event_id = ev AND d.player_id = app_player_id()
      AND d.window_until > now() AND d.code_hash IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION review_demo_here(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_demo_here(uuid) TO questify_app;

-- The demo event's printable codes, for the reviewer only (RD404 otherwise): a visible quest's own QR (its type carries
-- one, `qr_types` from the registry, and it is verified by quest QR), each passport step's, each hidden category's
-- secret code, and each meet quest (its code is issued on demand, below). Ids, versions and titles only; the API signs
-- them with the keys a printed sticker uses. NFC tags are not listed (ADR-640): a picked tag carries no chip id, which
-- `tap_quest` records as a copied tag on Android; a tag quest always takes its quest QR, which is listed.
CREATE FUNCTION review_demo_codes(ev uuid, qr_types text[])
  RETURNS TABLE (kind text, id uuid, version integer, quest_id uuid, title_ar text, title_en text, label_ar text,
                 label_en text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT review_demo_here(ev) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'RD404';
  END IF;
  RETURN QUERY
  SELECT c.kind, c.id, c.version, c.quest_id, c.title_ar, c.title_en, c.label_ar, c.label_en
  FROM (
    SELECT 'quest'::text AS kind, q.id, q.qr_version AS version, q.id AS quest_id, q.title_ar, q.title_en,
           NULL::text AS label_ar, NULL::text AS label_en, ca.position AS c_pos, q.position AS q_pos, 0 AS s_pos
    FROM quest q JOIN category ca ON ca.id = q.category_id
    WHERE q.event_id = ev AND q.deleted_at IS NULL AND q.visible
      AND q.type = ANY (qr_types) AND 'quest_qr' = ANY (q.verification)
    UNION ALL
    SELECT 'step', s.id, s.qr_version, q.id, q.title_ar, q.title_en, s.name_ar, s.name_en, ca.position, q.position,
           s.position
    FROM passport_step s JOIN quest q ON q.id = s.quest_id JOIN category ca ON ca.id = q.category_id
    WHERE q.event_id = ev AND q.deleted_at IS NULL AND q.visible
    UNION ALL
    SELECT 'reveal', ca.id, ca.reveal_version, NULL, ca.name_ar, ca.name_en, NULL, NULL, ca.position, -1, 0
    FROM category ca
    WHERE ca.event_id = ev AND ca.hidden
    UNION ALL
    SELECT 'meet', q.id, 1, q.id, q.title_ar, q.title_en, NULL, NULL, ca.position, q.position, 0
    FROM quest q JOIN category ca ON ca.id = q.category_id
    WHERE q.event_id = ev AND q.deleted_at IS NULL AND q.visible AND q.type = 'meet'
  ) c
  ORDER BY c.c_pos, c.q_pos, c.s_pos, c.kind, c.id;
END $$;
REVOKE ALL ON FUNCTION review_demo_codes(uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_demo_codes(uuid, text[]) TO questify_app;

-- A one-minute meet code shown by one of the demo's fictional players, for the reviewer only (RD404 otherwise), so a
-- meet quest is playable without a second phone. The quest must be a visible meet quest of the demo event (RD404
-- otherwise; QT422 for another type) with meet on (QF403). The fictional player is the first active one, in id order,
-- who has not met the reviewer on this quest and is under its caps; none left is RD409 `none_left`. The pass is written
-- as `issue_meet_pass` writes one, that player's day-old unused passes deleted (no device, so `same_device` never
-- applies); the reviewer then scans it through `meet_player`, which checks everything again for both sides.
CREATE FUNCTION review_demo_meet_code(ev uuid, target uuid, token_hash bytea)
  RETURNS TABLE (pass_id bigint, expires_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  mine      uuid;
  shown     enrollment%ROWTYPE;
BEGIN
  IF NOT review_demo_here(ev) THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'RD404';
  END IF;
  SELECT q.* INTO quest_row FROM quest q WHERE q.id = target AND q.event_id = ev AND q.deleted_at IS NULL
    AND q.visible;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'RD404';
  END IF;
  IF quest_row.type <> 'meet' THEN
    RAISE EXCEPTION 'not this kind of quest' USING ERRCODE = 'QT422', DETAIL = 'meet';
  END IF;
  IF NOT meet_on(ev) THEN
    RAISE EXCEPTION 'meet quests are off for this event' USING ERRCODE = 'QF403';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev);
  SELECT n.id INTO mine FROM enrollment n WHERE n.event_id = ev AND n.player_id = app_player_id();
  SELECT n.* INTO shown FROM enrollment n
  JOIN review_demo_player r ON r.player_id = n.player_id AND r.role = 'fictional'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = ev AND n.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM meeting m
                    WHERE m.quest_id = target
                      AND least(m.scanner_enrollment, m.shown_enrollment) = least(n.id, mine)
                      AND greatest(m.scanner_enrollment, m.shown_enrollment) = greatest(n.id, mine))
    AND meet_caps(n, quest_row) IS NULL
  ORDER BY n.id
  LIMIT 1
  FOR NO KEY UPDATE OF n SKIP LOCKED;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no one left to meet' USING ERRCODE = 'RD409', DETAIL = 'none_left';
  END IF;
  UPDATE meet_pass p SET ended_at = now()
  WHERE p.enrollment_id = shown.id AND p.quest_id = target AND p.ended_at IS NULL;
  DELETE FROM meet_pass p
  WHERE p.enrollment_id = shown.id AND p.created_at < now() - interval '1 day'
    AND NOT EXISTS (SELECT 1 FROM meeting m WHERE m.pass_id = p.id);
  RETURN QUERY
  INSERT INTO meet_pass AS p (organizer_id, event_id, quest_id, enrollment_id, device_id, token_hash, expires_at)
  VALUES (shown.organizer_id, shown.event_id, target, shown.id, NULL, review_demo_meet_code.token_hash,
          now() + interval '60 seconds')
  RETURNING p.id, p.expires_at;
END $$;
REVOKE ALL ON FUNCTION review_demo_meet_code(uuid, uuid, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_demo_meet_code(uuid, uuid, bytea) TO questify_app;
