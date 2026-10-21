-- The Quests tab (T-114): each quest also says how many points the calling player earned from it (FR-230), read from
-- the ledger, so a points change by the organizer after a completion never misstates what was earned. The return type
-- changes, so the function is dropped and created again, with the same guard, columns and grants as 0021.

DROP FUNCTION member_event_quests(uuid);

CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         (SELECT count(*)::int FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id)
  FROM me
  JOIN category c ON c.event_id = target
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;
