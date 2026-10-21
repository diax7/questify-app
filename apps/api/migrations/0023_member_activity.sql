-- The activity history (T-115, FR-410): a player's own points record in one event, newest first, read from the
-- append-only ledger. Only an active member reads it; each entry names its reason (a quest today, with its title even
-- when the quest is now hidden: FR-410 lists every point). Spends, awards and removals add kinds later (T-207).

CREATE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id, q.title_ar, q.title_en
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;
REVOKE ALL ON FUNCTION member_activity(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_activity(uuid, bigint, integer) TO questify_app;
