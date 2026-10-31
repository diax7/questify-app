-- The event's exports, sponsor totals and one-page report (T-608, FR-1206 to FR-1208, FR-1306, FR-1626, ADR-393).
-- Read doors for the event's team (an owner or an editor within their event limit; AN404 for anyone else, as the
-- analytics doors of 0102): a player, another organizer's team and the public key reach none. Deny by default: PUBLIC
-- holds no EXECUTE, the grant names the API's role alone, no table or column is granted. No table, no index.
--
-- An export lists only what the join card disclosed (FR-1207, PD-17): a username, the answers to the event's join
-- fields, and what the player did in the event (points, completions, redemptions, submissions). No door here selects
-- a phone number, an email address, an id of a person, a device or a redemption code, and the API checks every row
-- against a strict schema before it writes a file. Every export is audited (`event.export`, the kind and the sponsor,
-- never a row) by `export_start`, which the API calls before it reads a row.
SET LOCAL lock_timeout = '10s';

-- Opens an export: checks the caller's seat, writes the audit entry and answers the event's names and zone and, for the
-- players file, the join fields that are its columns. `export_kind` is a file of the exports page or `report` (the
-- one-page PDF's data). A sponsor's totals name their sponsor (AN404 when it is not of this event); no other export
-- does (AX400).
CREATE FUNCTION export_start(target_event uuid, export_kind text, target_sponsor uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF export_kind NOT IN ('players', 'completions', 'redemptions', 'submissions', 'surveys', 'sponsor', 'report') THEN
    RAISE EXCEPTION 'unknown export' USING ERRCODE = 'AX400';
  END IF;
  IF (export_kind = 'sponsor') <> (target_sponsor IS NOT NULL) THEN
    RAISE EXCEPTION 'only the sponsor export names a sponsor' USING ERRCODE = 'AX400';
  END IF;
  IF target_sponsor IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'AN404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.export', 'event', ev.id::text,
          jsonb_strip_nulls(jsonb_build_object('kind', export_kind, 'sponsor', target_sponsor)), request);
  RETURN jsonb_build_object(
    'name', jsonb_build_object('ar', ev.name_ar, 'en', ev.name_en),
    'startsAt', ev.starts_at,
    'endsAt', ev.ends_at,
    'zone', ev.timezone,
    'fields', CASE WHEN export_kind <> 'players' THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind,
                                          'label', jsonb_build_object('ar', f.label_ar, 'en', f.label_en))
                       ORDER BY f.position, f.id)
      FROM event_join_field f WHERE f.event_id = ev.id), '[]'::jsonb) END);
END $$;
REVOKE ALL ON FUNCTION export_start(uuid, text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_start(uuid, text, uuid, uuid) TO questify_app;

-- The event's members (not those still waiting for approval or turned down), oldest first: the username, the answers to
-- the join fields by field, the status, when they joined (in the event's zone) and their points.
CREATE FUNCTION export_players(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'username', p.username,
      'status', n.status,
      'joinedAt', to_char(n.joined_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
      'points', n.score,
      'answers', coalesce((SELECT jsonb_object_agg(a.field_id, a.value) FROM join_answer a
                           WHERE a.enrollment_id = n.id), '{}'::jsonb)) ORDER BY n.joined_at, n.id)
    FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = ev.id AND n.status NOT IN ('pending', 'declined')), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION export_players(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_players(uuid) TO questify_app;

-- Completions in pages, oldest first, by the index of the control room (0096). A page starts after the (time, id) the
-- last one ended on; the first starts after '-infinity' and 0. A completion whose award the team removed is marked
-- (found through the event's `ledger_note` rows, as the analytics do), not left out: the file lists every completion.
CREATE FUNCTION export_completions(target_event uuid, after_at timestamptz, after_id bigint, page_size integer)
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
    RAISE EXCEPTION 'a page holds 1 to 10000 completions' USING ERRCODE = 'AX400';
  END IF;
  WITH removed AS MATERIALIZED (
    SELECT x.completion_id FROM ledger_note t JOIN ledger_entry x ON x.id = t.entry_id
    WHERE t.event_id = ev.id AND t.bulk_id IS NULL AND x.kind = 'removal' AND x.completion_id IS NOT NULL),
  chunk AS MATERIALIZED (
    SELECT c.id, c.created_at, c.enrollment_id, c.quest_id, c.occurrence, c.method
    FROM quest_completion c
    WHERE c.event_id = ev.id AND (c.created_at, c.id) > (after_at, after_id)
    ORDER BY c.created_at, c.id LIMIT page_size)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'username', p.username,
           'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
           'category', jsonb_build_object('ar', g.name_ar, 'en', g.name_en),
           'completedAt', to_char(k.created_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
           'occurrence', k.occurrence,
           'method', k.method,
           'removed', k.id IN (SELECT r.completion_id FROM removed r)) ORDER BY k.created_at, k.id), '[]'::jsonb),
         count(*)::integer,
         (array_agg(k.created_at ORDER BY k.created_at DESC, k.id DESC))[1],
         max(k.id)
  INTO page, total, last_at, last_id
  FROM chunk k
  JOIN enrollment n ON n.id = k.enrollment_id
  JOIN player p ON p.id = n.player_id
  JOIN quest q ON q.id = k.quest_id
  JOIN category g ON g.id = q.category_id;
  RETURN jsonb_build_object(
    'rows', page,
    'next', CASE WHEN total < page_size THEN NULL ELSE jsonb_build_object(
      'at', to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', last_id) END);
END $$;
REVOKE ALL ON FUNCTION export_completions(uuid, timestamptz, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_completions(uuid, timestamptz, bigint, integer) TO questify_app;

-- The event's reward redemptions (a prize from the shop; a rank prize or a quest item is not one), oldest first. No
-- redemption code and no id of a person.
CREATE FUNCTION export_redemptions(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'username', p.username,
      'reward', jsonb_build_object('ar', rw.name_ar, 'en', rw.name_en),
      'price', r.price,
      'status', r.status,
      'reservedAt', to_char(r.created_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
      'endedAt', CASE WHEN r.ended_at IS NULL THEN NULL
                      ELSE to_char(r.ended_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI') END)
      ORDER BY r.created_at, r.id)
    FROM redemption r
    JOIN reward rw ON rw.id = r.reward_id
    JOIN enrollment n ON n.id = r.enrollment_id
    JOIN player p ON p.id = n.player_id
    WHERE r.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION export_redemptions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_redemptions(uuid) TO questify_app;

-- The event's submissions, oldest first: who sent what, to which quest, and where it stands. A submission whose player
-- deleted their account has its text erased (`erased_at`) and the file shows it blank. The reviewer's reason is the
-- team's own note and stays out.
CREATE FUNCTION export_submissions(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'username', p.username,
      'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
      'submittedAt', to_char(s.created_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
      'status', s.status,
      'answer', CASE WHEN s.erased_at IS NULL THEN s.body END) ORDER BY s.created_at, s.id)
    FROM submission s
    JOIN enrollment n ON n.id = s.enrollment_id
    JOIN player p ON p.id = n.player_id
    JOIN quest q ON q.id = s.quest_id
    WHERE s.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION export_submissions(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_submissions(uuid) TO questify_app;

-- The event's surveys with their results, in the quests' order: the same counts, averages and newest text answers the
-- survey results page shows (`survey_results_core`, 0089), names not shown.
CREATE FUNCTION export_surveys(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
      'results', survey_results_core(ev.id, q.id)) ORDER BY q.position, q.id)
    FROM quest q WHERE q.event_id = ev.id AND q.type = 'survey' AND q.deleted_at IS NULL), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION export_surveys(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_surveys(uuid) TO questify_app;

-- A sponsor's totals (FR-1306, FR-1626): only the items tagged to the sponsor. A quest is the sponsor's when it is
-- tagged to the sponsor, or sits in a category tagged to the sponsor and is tagged to no sponsor of its own. Visits are
-- the players with at least one standing completion of the sponsor's quests (a completion the team removed does not
-- count), completions their number, redemptions the rewards' standing redemptions (reserved, delivered, handed over).
-- A category lists the players who completed any of its visible quests; a removed reward is listed only when something
-- was redeemed from it. Exact counts and no player: the API leaves out the counts a sponsor may not see.
CREATE FUNCTION analytics_sponsor(target_event uuid, target_sponsor uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  sp sponsor;
BEGIN
  SELECT s.* INTO sp FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'AN404';
  END IF;
  RETURN (
    WITH removed AS MATERIALIZED (
      SELECT x.completion_id FROM ledger_note t JOIN ledger_entry x ON x.id = t.entry_id
      WHERE t.event_id = ev.id AND t.bulk_id IS NULL AND x.kind = 'removal' AND x.completion_id IS NOT NULL),
    sel AS MATERIALIZED (
      SELECT q.id, q.title_ar, q.title_en, q.position, q.category_id,
             (EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.quest_id = q.id AND t.sponsor_id = sp.id)
              OR (NOT EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.quest_id = q.id)
                  AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.category_id = q.category_id
                              AND t.sponsor_id = sp.id))) AS own
      FROM quest q
      WHERE q.event_id = ev.id AND q.visible AND q.deleted_at IS NULL
        AND (EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.quest_id = q.id AND t.sponsor_id = sp.id)
             OR EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.category_id = q.category_id AND t.sponsor_id = sp.id))),
    standing AS MATERIALIZED (
      SELECT c.quest_id, c.enrollment_id FROM quest_completion c
      WHERE c.quest_id IN (SELECT s.id FROM sel s) AND c.id NOT IN (SELECT r.completion_id FROM removed r)),
    quests AS (
      SELECT s.id, s.title_ar, s.title_en, s.position,
             (SELECT count(DISTINCT d.enrollment_id) FROM standing d WHERE d.quest_id = s.id)::integer AS players
      FROM sel s WHERE s.own),
    categories AS (
      SELECT g.id, g.name_ar, g.name_en, g.position,
             (SELECT count(DISTINCT d.enrollment_id) FROM standing d JOIN sel s ON s.id = d.quest_id
              WHERE s.category_id = g.id)::integer AS players
      FROM category g
      WHERE g.event_id = ev.id AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.category_id = g.id AND t.sponsor_id = sp.id)),
    rewards AS (
      SELECT rw.id, rw.name_ar, rw.name_en, rw.position,
             (SELECT count(*) FROM redemption r WHERE r.reward_id = rw.id
                AND r.status IN ('reserved', 'delivered', 'handed_over'))::integer AS redeemed
      FROM reward rw
      WHERE rw.event_id = ev.id
        AND EXISTS (SELECT 1 FROM sponsor_tag t WHERE t.reward_id = rw.id AND t.sponsor_id = sp.id)
        AND (rw.status = 'active' OR EXISTS (SELECT 1 FROM redemption r WHERE r.reward_id = rw.id
                                              AND r.status IN ('reserved', 'delivered', 'handed_over'))))
    SELECT jsonb_build_object(
      'sponsor', jsonb_build_object('id', sp.id, 'name', jsonb_build_object('ar', sp.name_ar, 'en', sp.name_en)),
      'visits', (SELECT count(DISTINCT d.enrollment_id) FROM standing d JOIN sel s ON s.id = d.quest_id WHERE s.own),
      'completions', (SELECT count(*) FROM standing d JOIN sel s ON s.id = d.quest_id WHERE s.own),
      'redemptions', (SELECT coalesce(sum(w.redeemed), 0) FROM rewards w),
      'quests', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'title', jsonb_build_object('ar', x.title_ar, 'en', x.title_en), 'players', x.players)
          ORDER BY x.position, x.id) FROM quests x), '[]'::jsonb),
      'categories', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'name', jsonb_build_object('ar', x.name_ar, 'en', x.name_en), 'players', x.players)
          ORDER BY x.position, x.id) FROM categories x), '[]'::jsonb),
      'rewards', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'id', x.id, 'name', jsonb_build_object('ar', x.name_ar, 'en', x.name_en), 'redeemed', x.redeemed)
          ORDER BY x.position, x.id) FROM rewards x), '[]'::jsonb)));
END $$;
REVOKE ALL ON FUNCTION analytics_sponsor(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_sponsor(uuid, uuid) TO questify_app;
