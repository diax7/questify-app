-- Today's ranking for multi-day events (T-216, ADR-166; FR-608, FR-610, FR-1611). No new table and no change to the
-- ledger: today's points are the sum of the enrollment's ledger entries created inside the current event day (FR-1714),
-- ordered as the overall ranking is (points, then the ledger id that last changed them, lowest first). Redis holds a
-- copy per event day; every function here reads PostgreSQL for rebuilds and for the fallback.

-- ================================================================ helpers (not executable by questify_app)
-- The moment an event day starts.
CREATE FUNCTION event_day_start(ev event, day date) RETURNS timestamptz
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  RETURN (day + make_interval(hours => ev.day_start_hour)) AT TIME ZONE ev.timezone;
REVOKE ALL ON FUNCTION event_day_start(event, date) FROM PUBLIC;

-- Whether the event spans more than one event day. An end exactly at a day start belongs to the day before.
CREATE FUNCTION event_multi_day(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  RETURN ev.starts_at IS NOT NULL AND ev.ends_at IS NOT NULL
    AND event_day(ev.starts_at, ev) <> event_day(ev.ends_at - interval '1 microsecond', ev);
REVOKE ALL ON FUNCTION event_multi_day(event) FROM PUBLIC;

-- Every enrollment with points overall and ledger entries that moved its points on the given day: its points that day,
-- the entry that last changed them, and whether it is ranked today (the overall rule, and today's points above 0).
CREATE FUNCTION ranked_day(target uuid, day date)
  RETURNS TABLE (id uuid, player_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH today AS (
    SELECT l.enrollment_id, sum(l.score_delta)::bigint AS score, max(l.id) AS version
    FROM event ev JOIN ledger_entry l ON l.event_id = ev.id
    WHERE ev.id = target AND l.score_delta <> 0
      AND l.created_at >= event_day_start(ev, day) AND l.created_at < event_day_start(ev, day + 1)
    GROUP BY l.enrollment_id
  )
  SELECT r.id, r.player_id, t.score, t.version, r.ranked AND t.score > 0
  FROM ranked_enrollments(target) r JOIN today t ON t.enrollment_id = r.id
$$;
REVOKE ALL ON FUNCTION ranked_day(uuid, date) FROM PUBLIC;

-- ================================================================ reading the day
-- The event's day now, whether the event is multi-day and live, and the reader's own points today. For the system (no
-- reader; `my_score` NULL) or an active player of the event; no row for anyone else.
CREATE FUNCTION ranking_today(target uuid)
  RETURNS TABLE (day date, multi_day boolean, live boolean, my_score bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT event_day(now(), ev), event_multi_day(ev),
         event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live',
         CASE WHEN reader.id IS NOT NULL THEN
           (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
            WHERE l.enrollment_id = reader.id
              AND l.created_at >= event_day_start(ev, event_day(now(), ev))
              AND l.created_at < event_day_start(ev, event_day(now(), ev) + 1))
         END
  FROM event ev, reader
  WHERE ev.id = target AND (ranking_system() OR reader.id IS NOT NULL)
$$;
REVOKE ALL ON FUNCTION ranking_today(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_today(uuid) TO questify_app;

-- Every enrollment with points on the day, for a rebuild of that day's copy (system context only).
CREATE FUNCTION ranking_day_entries(target uuid, day date)
  RETURNS TABLE (enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.score, r.score_version, r.ranked FROM ranked_day(target, day) r WHERE ranking_system()
$$;
REVOKE ALL ON FUNCTION ranking_day_entries(uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_day_entries(uuid, date) TO questify_app;

-- Where the caller's own just-committed completion leaves them on its event day's board, for a multi-day event only.
-- Someone else's completion, or a single-day event, gives nothing.
CREATE FUNCTION ranking_day_entry_of(completion bigint)
  RETURNS TABLE (event_id uuid, day date, enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH mine AS (
    SELECT e, ev, event_day(c.created_at, ev) AS day
    FROM quest_completion c
    JOIN enrollment e ON e.id = c.enrollment_id
    JOIN event ev ON ev.id = e.event_id
    WHERE c.id = completion AND e.player_id = app_player_id() AND event_multi_day(ev)
  )
  SELECT (m.e).event_id, m.day, (m.e).id, t.score, t.version, ranking_eligible(m.e) AND t.score > 0
  FROM mine m,
  LATERAL (SELECT coalesce(sum(l.score_delta), 0)::bigint AS score, max(l.id) AS version
           FROM ledger_entry l
           WHERE l.enrollment_id = (m.e).id AND l.score_delta <> 0
             AND l.created_at >= event_day_start(m.ev, m.day)
             AND l.created_at < event_day_start(m.ev, m.day + 1)) t
  WHERE t.version IS NOT NULL
$$;
REVOKE ALL ON FUNCTION ranking_day_entry_of(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_day_entry_of(bigint) TO questify_app;

-- The fallback when Redis cannot answer: today's top straight from PostgreSQL, with the same rule.
CREATE FUNCTION ranking_day_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, p.username, p.avatar, r.score, r.score_version
  FROM reader, event ev,
       LATERAL ranked_day(target, event_day(now(), ev)) r JOIN player p ON p.id = r.player_id
  WHERE reader.id IS NOT NULL AND ev.id = target AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_day_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_day_top(uuid, integer) TO questify_app;

-- The caller's own place today (NULL when not ranked today), the caller's enrollment, and how many are ranked today. No
-- row for someone who is not an active player of the event.
CREATE FUNCTION ranking_day_position(target uuid)
  RETURNS TABLE (enrollment_id uuid, place bigint, total bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id),
  board AS MATERIALIZED (
    SELECT r.* FROM reader, event ev, LATERAL ranked_day(target, event_day(now(), ev)) r
    WHERE reader.id IS NOT NULL AND ev.id = target AND r.ranked
  ),
  mine AS MATERIALIZED (SELECT b.score, b.score_version FROM board b, reader WHERE b.id = reader.id)
  SELECT reader.id,
         CASE WHEN EXISTS (SELECT 1 FROM mine) THEN
           (SELECT count(*) + 1 FROM board b, mine m
            WHERE b.score > m.score OR (b.score = m.score AND b.score_version < m.score_version))
         END,
         (SELECT count(*) FROM board)
  FROM reader
  WHERE reader.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION ranking_day_position(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_day_position(uuid) TO questify_app;
