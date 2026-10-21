-- The event Home (T-113): the quest an organizer pins as Up next (FR-1748), and the quests an event's members read
-- (Home's Up next and progress, the Quests tab of T-114). Only an active member of the event reads them: a pending
-- member of a private event sees its name and "waiting for approval" only (FR-1819), as the ranking and the
-- completion paths already require.

-- ================================================================ the pinned quest
-- A quest of the same event, or none; deleting the quest clears the pin (the column only, not the event's other keys).
ALTER TABLE event ADD COLUMN focus_quest_id uuid;
ALTER TABLE event ADD CONSTRAINT event_focus_quest_fkey
  FOREIGN KEY (focus_quest_id, id) REFERENCES quest (id, event_id) ON DELETE SET NULL (focus_quest_id);
-- The organizer seat pins and unpins through the event's update policy (0008), within its event limit.
GRANT UPDATE (focus_quest_id) ON event TO questify_app;

-- ================================================================ what an event's members read
-- The event's categories and visible quests by named columns (never type_config: an enter_code answer lives there),
-- each with how many times the calling player completed it. Nothing for anyone but an active member of the event.
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         (SELECT count(*)::int FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
  FROM me
  JOIN category c ON c.event_id = target
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;
