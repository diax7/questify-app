-- The player's goal (T-213; FR-517, FR-803, FR-1616, ADR-161). A member pins one reward of the event; Home shows what
-- is left to earn for it. A view preference only: it touches no points, stock or reservation. Written only through
-- set_goal (not in the API role's grants); read with the player's own enrollment.

ALTER TABLE enrollment ADD COLUMN goal_reward_id uuid;
-- A deleted reward forgets the pin; a removed one (status 'removed') stays pinned but is not shown (the API ignores
-- a pin that is not in the shop).
ALTER TABLE enrollment ADD FOREIGN KEY (goal_reward_id, event_id) REFERENCES reward (id, event_id)
  ON DELETE SET NULL (goal_reward_id);
CREATE INDEX enrollment_goal_reward_idx ON enrollment (goal_reward_id) WHERE goal_reward_id IS NOT NULL;

-- Pins `target_reward` as the caller's goal in the event, or clears it with NULL. The caller's active enrollment of an
-- active player, and a reward in the shop of that event; RN404 otherwise, the same answer for a stranger, an unknown,
-- removed or other event's reward. Returns the goal now set.
CREATE FUNCTION set_goal(target_event uuid, target_reward uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine uuid;
BEGIN
  IF target_reward IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM reward r WHERE r.id = target_reward AND r.event_id = target_event AND r.status = 'active') THEN
    RAISE EXCEPTION 'no such reward in this event' USING ERRCODE = 'RN404';
  END IF;
  UPDATE enrollment n SET goal_reward_id = target_reward
  FROM player p
  WHERE p.id = n.player_id AND n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active'
    AND p.status = 'active'
  RETURNING n.id INTO mine;
  IF mine IS NULL THEN
    RAISE EXCEPTION 'not a member of this event' USING ERRCODE = 'RN404';
  END IF;
  RETURN target_reward;
END $$;
REVOKE ALL ON FUNCTION set_goal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_goal(uuid, uuid) TO questify_app;
