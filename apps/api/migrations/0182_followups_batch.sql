-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 30): the players, redemptions and submissions export doors
-- read an event in pages, as the completions door does (T-608 review), and the ranking read's own row reads the
-- reader's level alone (batch 18 review). Three doors replaced with a cursor added to their arguments
-- (`export_players`, `export_redemptions`, `export_submissions`, diffed against 0103: the same rows, fields and order,
-- now in a page with the next page's start), one restated with the same signature, so its owner and grants stay
-- (`export_completions`, diffed against 0103), one new caller-bound read (`own_level_only`), three indexes. Deny by
-- default: each door is a definer with its search path pinned, PUBLIC holds no EXECUTE and the grant names the API's
-- role alone. No table, nothing that writes points or XP, changes a sign-in, a tenant rule or a redemption. 0181 and
-- earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ exports in pages (T-608 review, MINOR)
-- An event of 100,000 players was one answer of 14 to 17 MB per door, built and held whole by the database and the API.
-- Each door now reads a page in its file's order, oldest first by the table's own time and id, starting after the
-- (time, id) the last page ended on (the first after '-infinity'), up to 10,000 rows; the API reads 5,000. `next` is
-- the last row's time (to the microsecond, in UTC) and id, or null on a page shorter than asked. One index each keeps a
-- page a range read of the event's rows, not a sort of all of them.
CREATE INDEX enrollment_event_joined_idx ON enrollment (event_id, joined_at, id);
CREATE INDEX redemption_event_created_idx ON redemption (event_id, created_at, id);
CREATE INDEX submission_event_created_idx ON submission (event_id, created_at, id);

DROP FUNCTION export_players(uuid);
DROP FUNCTION export_redemptions(uuid);
DROP FUNCTION export_submissions(uuid);

-- As 0103: the event's members (not those still waiting for approval or turned down), oldest first: the username, the
-- answers to the join fields by field, the status, when they joined (in the event's zone) and their points.
CREATE FUNCTION export_players(target_event uuid, after_at timestamptz, after_id uuid, page_size integer)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  page jsonb;
  last_at timestamptz;
  last_id uuid;
  total integer;
BEGIN
  IF page_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'a page holds 1 to 10000 players' USING ERRCODE = 'AX400';
  END IF;
  WITH chunk AS MATERIALIZED (
    SELECT n.id, n.joined_at, n.player_id, n.status, n.score
    FROM enrollment n
    WHERE n.event_id = ev.id AND n.status NOT IN ('pending', 'declined') AND (n.joined_at, n.id) > (after_at, after_id)
    ORDER BY n.joined_at, n.id LIMIT page_size)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'username', p.username,
           'status', k.status,
           'joinedAt', to_char(k.joined_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
           'points', k.score,
           'answers', coalesce((SELECT jsonb_object_agg(a.field_id, a.value) FROM join_answer a
                                WHERE a.enrollment_id = k.id), '{}'::jsonb)) ORDER BY k.joined_at, k.id), '[]'::jsonb),
         count(*)::integer,
         (array_agg(k.joined_at ORDER BY k.joined_at DESC, k.id DESC))[1],
         (array_agg(k.id ORDER BY k.joined_at DESC, k.id DESC))[1]
  INTO page, total, last_at, last_id
  FROM chunk k
  JOIN player p ON p.id = k.player_id;
  RETURN jsonb_build_object(
    'rows', page,
    'next', CASE WHEN total < page_size THEN NULL ELSE jsonb_build_object(
      'at', to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', last_id) END);
END $$;
REVOKE ALL ON FUNCTION export_players(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_players(uuid, timestamptz, uuid, integer) TO questify_app;

-- As 0103, with the next page's id taken from the page's last row. 0103 took the page's largest id, which belongs to
-- another row when a completion written later has an earlier time (a transaction that began first commits last): the
-- next page then started past rows of the last time and the file left them out.
CREATE OR REPLACE FUNCTION export_completions(target_event uuid, after_at timestamptz, after_id bigint,
                                              page_size integer)
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
         (array_agg(k.id ORDER BY k.created_at DESC, k.id DESC))[1]
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

-- As 0103: the event's reward redemptions (a prize from the shop; a rank prize or a quest item is not one), oldest
-- first. No redemption code and no id of a person; the page's `next` carries the redemption's own id, which the file
-- never shows. A row without a reward is left out of the page itself (0103 left it out by its join), so a full page
-- is never cut short by one.
CREATE FUNCTION export_redemptions(target_event uuid, after_at timestamptz, after_id uuid, page_size integer)
  RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  page jsonb;
  last_at timestamptz;
  last_id uuid;
  total integer;
BEGIN
  IF page_size NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'a page holds 1 to 10000 redemptions' USING ERRCODE = 'AX400';
  END IF;
  WITH chunk AS MATERIALIZED (
    SELECT r.id, r.created_at, r.ended_at, r.reward_id, r.enrollment_id, r.price, r.status
    FROM redemption r
    WHERE r.event_id = ev.id AND r.reward_id IS NOT NULL AND (r.created_at, r.id) > (after_at, after_id)
    ORDER BY r.created_at, r.id LIMIT page_size)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'username', p.username,
           'reward', jsonb_build_object('ar', rw.name_ar, 'en', rw.name_en),
           'price', k.price,
           'status', k.status,
           'reservedAt', to_char(k.created_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
           'endedAt', CASE WHEN k.ended_at IS NULL THEN NULL
                           ELSE to_char(k.ended_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI') END)
           ORDER BY k.created_at, k.id), '[]'::jsonb),
         count(*)::integer,
         (array_agg(k.created_at ORDER BY k.created_at DESC, k.id DESC))[1],
         (array_agg(k.id ORDER BY k.created_at DESC, k.id DESC))[1]
  INTO page, total, last_at, last_id
  FROM chunk k
  JOIN reward rw ON rw.id = k.reward_id
  JOIN enrollment n ON n.id = k.enrollment_id
  JOIN player p ON p.id = n.player_id;
  RETURN jsonb_build_object(
    'rows', page,
    'next', CASE WHEN total < page_size THEN NULL ELSE jsonb_build_object(
      'at', to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'id', last_id) END);
END $$;
REVOKE ALL ON FUNCTION export_redemptions(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION export_redemptions(uuid, timestamptz, uuid, integer) TO questify_app;

-- As 0103: the event's submissions, oldest first: who sent what, to which quest, and where it stands. A submission
-- whose player deleted their account has its text erased (`erased_at`) and the file shows it blank. The reviewer's
-- reason is the team's own note and stays out.
CREATE FUNCTION export_submissions(target_event uuid, after_at timestamptz, after_id bigint, page_size integer)
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
    SELECT s.id, s.created_at, s.enrollment_id, s.quest_id, s.status, s.body, s.erased_at
    FROM submission s
    WHERE s.event_id = ev.id AND (s.created_at, s.id) > (after_at, after_id)
    ORDER BY s.created_at, s.id LIMIT page_size)
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'username', p.username,
           'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
           'submittedAt', to_char(k.created_at AT TIME ZONE ev.timezone, 'YYYY-MM-DD HH24:MI'),
           'status', k.status,
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

-- ================================================================ the reader's level (batch 18 review, MINOR)
-- The level field of `own_level(NULL)` (0168) alone: the caller's XP row while their account is active, its level by
-- `xp_level_of`, null for anyone else, with none of the next level, the titles or the level a scan reached. The ranking
-- read's own row takes it in place of `own_level(NULL)` (ADR-766). PL/pgSQL, as a definer on a request path
-- (ADR-670, ADR-682); it reads only the caller's own row, so it needs no event or organizer check.
CREATE FUNCTION own_level_only() RETURNS smallint
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_level smallint;
BEGIN
  SELECT cur.level INTO found_level
  FROM player_xp x
  JOIN player p ON p.id = x.player_id AND p.status = 'active'
  JOIN xp_level cur ON cur.level = xp_level_of(x.xp)
  WHERE x.player_id = app_player_id();
  RETURN found_level;
END $$;
REVOKE ALL ON FUNCTION own_level_only() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_level_only() TO questify_app;
