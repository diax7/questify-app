-- The live control room's reads (T-603, FR-1024, FR-1028): the newest completions of an event, the counters, and how many
-- players completed each quest. Read-only: no table, no write, nothing about points changes. Each is a door for the
-- event's team (an owner or an editor within their event limit, AN404 for anyone else, as `event_flags` and
-- `event_ticket_counts`); a player, another organizer's team and the public key reach none. Deny by default: PUBLIC holds
-- no EXECUTE, the grant names the API's role alone.
--
-- What the team may see: the username and avatar they already read on the Players page, the quest, the method and the
-- time. Never a phone, an email, an install id, a note or the points.
SET LOCAL lock_timeout = '10s';

-- One walk of this index answers the feed (the newest rows of one event) and the "active in the last 15 minutes"
-- count, however many completions the other events hold.
CREATE INDEX quest_completion_event_recent_idx ON quest_completion (event_id, created_at DESC, id DESC);

-- One walk of this index answers the per-quest completions (`control_done`): only the first completion of each player
-- and quest, however many repeats the event holds.
CREATE INDEX quest_completion_event_first_idx ON quest_completion (event_id, quest_id) WHERE occurrence = 1;

-- The newest completions of the event, newest first: the page asks for 30 (at most 100). An erased player (no username,
-- the tombstone of migration 0038) is left out: the completion stays in the record, the name is gone.
CREATE FUNCTION control_feed(target_event uuid, page integer)
  RETURNS TABLE (id bigint, at timestamptz, quest_id uuid, title_ar text, title_en text, method text, username text,
                 avatar text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT c.id, c.created_at, c.quest_id, q.title_ar, q.title_en, c.method, p.username, p.avatar
  FROM quest_completion c
  JOIN quest q ON q.id = c.quest_id
  JOIN enrollment n ON n.id = c.enrollment_id
  JOIN player p ON p.id = n.player_id
  WHERE c.event_id = ev.id AND p.username IS NOT NULL
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT least(greatest(coalesce(page, 30), 1), 100);
END $$;
REVOKE ALL ON FUNCTION control_feed(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_feed(uuid, integer) TO questify_app;

-- The counters (FR-1028). `players` are the active members; `online` the active members with a completion in the last 15
-- minutes (the app keeps no presence); `low_stock` the active rewards at or under the stock-low alert's line (at most
-- max(1, 10% of the total) left, the rule of migration 0082); `inbox` the open help requests of the event's queue and the
-- submissions waiting for review; `flags` the open cases.
CREATE FUNCTION control_counts(target_event uuid)
  RETURNS TABLE (players integer, online integer, low_stock integer, inbox integer, flags integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT
    (SELECT count(*)::integer FROM enrollment n WHERE n.event_id = ev.id AND n.status = 'active'),
    (SELECT count(DISTINCT c.enrollment_id)::integer FROM quest_completion c
      JOIN enrollment n ON n.id = c.enrollment_id AND n.status = 'active'
      WHERE c.event_id = ev.id AND c.created_at >= now() - interval '15 minutes'),
    (SELECT count(*)::integer FROM reward r
      WHERE r.event_id = ev.id AND r.status = 'active' AND r.stock_total > 0
        AND r.stock_total - r.units_out <= greatest(1, ceil(r.stock_total * 0.1))),
    (SELECT count(*)::integer FROM ticket t
      WHERE t.event_id = ev.id AND t.queue = 'event' AND t.status = 'open')
      + (SELECT count(*)::integer FROM submission s WHERE s.event_id = ev.id AND s.status = 'pending'),
    (SELECT count(*)::integer FROM flag f WHERE f.event_id = ev.id AND f.status = 'open');
END $$;
REVOKE ALL ON FUNCTION control_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_counts(uuid) TO questify_app;

-- How many players completed each quest at least once (FR-1024's completion rate, over `players`). A quest nobody
-- completed has no row. This is the one read that walks every first completion of the event, so the API keeps its
-- answer for 30 seconds and shares it among the event's team.
CREATE FUNCTION control_done(target_event uuid) RETURNS TABLE (quest_id uuid, done integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT c.quest_id, count(*)::integer FROM quest_completion c
  WHERE c.event_id = ev.id AND c.occurrence = 1
  GROUP BY c.quest_id;
END $$;
REVOKE ALL ON FUNCTION control_done(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION control_done(uuid) TO questify_app;
