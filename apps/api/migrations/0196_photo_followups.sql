-- Photo and organizer image followups (FOLLOWUPS 2026-11-12: T-301b, organizer images review, T-504b photo wall).
--
-- 1. `quest_images_ok` (0194) answers false, never null, for any shape its CASE leaves open, so a CHECK cannot pass a
--    game's `images` object (`images: {}` among them) that names no known field.
-- 2. `media_image_release` (0194) gives back only a slot still `reserved`: a retry with the same key that is refused
--    (415 or 422) no longer deletes the image its first try stored, which the dashboard may be about to name.
-- 3. `export_submissions` (0182) carries each submission's `kind`, so a photo sent with no caption reads "photo" in the
--    file instead of a blank answer. The file never carries the photo or its key.
-- 4. `queue_rows` (0193) and its two seat-checked readers carry `on_screen` (0195), the player's "allowed on screen"
--    choice, so the dashboard's queue can show it.
--
-- Deny by default: every function keeps its PUBLIC revoke and only the doors are granted to questify_app, as before;
-- `queue_rows` stays internal (no grant). Deployed migrations untouched; restated functions say which they restate.
SET LOCAL lock_timeout = '10s';

-- ================================================================ 1. game images: false, never null
-- As 0194, with the CASE coalesced to false.
CREATE OR REPLACE FUNCTION quest_images_ok(quest_type text, config jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  images jsonb := CASE WHEN jsonb_typeof(config) = 'object' THEN config -> 'images' END;
BEGIN
  IF quest_type = 'vote' AND jsonb_typeof(config -> 'options') = 'array' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(config -> 'options') AS o(v)
       WHERE jsonb_typeof(o.v) = 'object' AND o.v ? 'image' AND NOT quest_image_id(o.v -> 'image')) THEN
    RETURN false;
  END IF;
  IF images IS NULL THEN
    RETURN true;
  END IF;
  IF quest_type IS DISTINCT FROM 'game' OR jsonb_typeof(images) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN coalesce(CASE config ->> 'game'
    WHEN 'memory_match' THEN (SELECT array_agg(k) FROM jsonb_object_keys(images) k) = ARRAY['faces']
                             AND quest_image_list(images -> 'faces', 10)
    WHEN 'slide_puzzle' THEN (SELECT array_agg(k) FROM jsonb_object_keys(images) k) = ARRAY['picture']
                             AND quest_image_id(images -> 'picture')
    WHEN 'catch' THEN (SELECT array_agg(k) FROM jsonb_object_keys(images) k) = ARRAY['items']
                      AND quest_image_list(images -> 'items', 5)
    ELSE false END, false);
END $$;
REVOKE ALL ON FUNCTION quest_images_ok(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION quest_images_ok(text, jsonb) TO questify_app;

-- ================================================================ 2. releasing only a reserved slot
-- As 0194, for a slot still `reserved` only: a stored image is the sweep's to delete once nothing names it.
CREATE OR REPLACE FUNCTION media_image_release(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := media_staff();
BEGIN
  DELETE FROM media_object m
  WHERE m.id = target AND m.uploaded_by_staff = me AND m.used_at IS NULL AND m.state = 'reserved';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION media_image_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_image_release(uuid) TO questify_app;

-- ================================================================ 3. the submissions export, with the kind
-- As 0182, with `kind` ('text' or 'photo').
CREATE OR REPLACE FUNCTION export_submissions(target_event uuid, after_at timestamptz, after_id bigint, page_size integer)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  page jsonb;
  last_at timestamptz;
  last_id bigint;
  total integer;
BEGIN
  IF page_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'a page holds 1 to 10000 submissions' USING ERRCODE = 'AX400';
  END IF;
  WITH chunk AS MATERIALIZED (
    SELECT s.id, s.created_at, s.enrollment_id, s.quest_id, s.status, s.kind, s.body, s.erased_at
    FROM submission s
    WHERE s.event_id = ev.id AND (s.created_at, s.id) > (after_at, after_id)
    ORDER BY s.created_at, s.id LIMIT page_size)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'username', p.username,
           'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
           'submittedAt', to_char(k.created_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
           'status', k.status,
           'kind', k.kind,
           'answer', CASE WHEN k.erased_at IS NULL THEN k.body END) ORDER BY k.created_at, k.id), '[]'::jsonb),
         count(*)::integer,
         (array_agg(k.created_at ORDER BY k.created_at DESC, k.id DESC))[1],
         (array_agg(k.id ORDER BY k.created_at DESC, k.id DESC))[1]
  INTO page, total, last_at, last_id
  FROM chunk k
  JOIN enrollment n ON n.id = k.enrollment_id
  JOIN player p ON p.id = n.player_id
  JOIN quest q ON q.id = k.quest_id;
  RETURN jsonb_build_object(
    'rows', page,
    'next', CASE WHEN total < page_size THEN NULL ELSE jsonb_build_object(
      'at', to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', last_id) END);
END $$;
REVOKE ALL ON FUNCTION export_submissions(uuid, timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_submissions(uuid, timestamptz, bigint, integer) TO questify_app;

-- ================================================================ 4. the review queue, with "allowed on screen"
-- As 0193, with `on_screen` last. Internal: only the two seat-checked readers below call it.
DROP FUNCTION event_submissions(uuid, text, bigint, integer);
DROP FUNCTION operator_submissions(uuid, bigint, integer);
DROP FUNCTION queue_rows(uuid, text, bigint, integer, uuid);
CREATE FUNCTION queue_rows(target_event uuid, wanted text, cursor_id bigint, page integer, only_operator uuid)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz, kind text, photo_key text, photo_gone boolean, on_screen boolean)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.quest_id, q.title_ar, q.title_en, s.enrollment_id, p.username, p.avatar, s.body, s.points, s.status,
         s.auto, s.marked, s.reason, s.reason_system, s.created_at, s.reviewed_at, s.seen_at, s.kind, m.key,
         s.photo_gone_at IS NOT NULL, s.on_screen
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

-- As 0193, with `on_screen`.
CREATE FUNCTION event_submissions(target_event uuid, wanted text, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz, kind text, photo_key text, photo_gone boolean, on_screen boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY SELECT * FROM queue_rows(ev.id, wanted, cursor_id, page, NULL);
END $$;
REVOKE ALL ON FUNCTION event_submissions(uuid, text, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_submissions(uuid, text, bigint, integer) TO questify_app;

-- As 0193, with `on_screen`.
CREATE FUNCTION operator_submissions(target_event uuid, cursor_id bigint, page integer)
  RETURNS TABLE (id bigint, quest_id uuid, quest_title_ar text, quest_title_en text, enrollment_id uuid,
                 username text, avatar text, body text, points integer, status text, auto boolean, marked boolean,
                 reason text, reason_system boolean, created_at timestamptz, reviewed_at timestamptz,
                 seen_at timestamptz, kind text, photo_key text, photo_gone boolean, on_screen boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := review_operator(target_event);
BEGIN
  RETURN QUERY SELECT * FROM queue_rows(target_event, 'pending', cursor_id, page, me);
END $$;
REVOKE ALL ON FUNCTION operator_submissions(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_submissions(uuid, bigint, integer) TO questify_app;
