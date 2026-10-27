-- T-407c: the "set your interests" Questify quest (FR-710; ADR-320; plan docs/plans/2026-10-27-t-407c-interests-quest.md).
-- A new lifetime metric, `interests_set`, read by player_metrics and so by questify_due, questify_sync and
-- own_questify_quests by name at run time: none of them is restated. No new table, function or grant. Deployed
-- migrations and 0057 to 0070 untouched.
SET LOCAL lock_timeout = '10s';
-- The only table altered or written. Never player, player_xp, xp_entry or player_preference: nothing here writes them,
-- and a sync waits on questify_quest only in its unlocked pre-check, before it locks a player.
LOCK TABLE questify_quest IN ACCESS EXCLUSIVE MODE;

-- A state, not a dated fact: it has no window, so it is always-on, and it is met or not, so its target is 1.
ALTER TABLE questify_quest
 DROP CONSTRAINT questify_quest_metric_check,
 ADD CONSTRAINT questify_quest_metric_check CHECK (metric IN ('events', 'cities', 'quests', 'interests_set')),
 ADD CONSTRAINT questify_quest_interests_shape CHECK (metric <> 'interests_set' OR (campaign_id IS NULL AND target = 1));

-- Live from the deploy (ADR-279): a player who already chose interests is paid at the next sync. Q-290.
INSERT INTO questify_quest (metric, target, title_ar, title_en, xp, gems, position, status) VALUES
 ('interests_set', 1, 'اختر اهتماماتك', 'Set your interests', 100, 10, 3, 'active');

-- As 0066, plus `interests_set`: 1 when the player's preference row holds at least one interest, else 0. The city is
-- never read (a city alone is not "set your interests"). Lifetime only, like top10 and goals. Internal.
CREATE OR REPLACE FUNCTION player_metrics(who uuid, since timestamptz, until timestamptz) RETURNS TABLE (metric text, value integer)
 LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
 WITH credit AS MATERIALIZED (SELECT * FROM standing_credits(who, since, until)),
 played AS MATERIALIZED (SELECT DISTINCT c.event_id FROM credit c)
 SELECT 'events', (SELECT count(*) FROM played)::integer
 UNION ALL
 SELECT 'quests', (SELECT count(*) FROM credit)::integer
 UNION ALL
 SELECT 'cities', (SELECT count(DISTINCT e.city_id) FROM played p JOIN event e ON e.id = p.event_id)::integer
 UNION ALL
 -- A place counts only on a membership with a standing credit: welcome points alone rank a member who never played.
 SELECT 'top10', (SELECT count(*) FROM final_rank f
                  JOIN event_result r ON r.event_id = f.event_id AND r.revealed_at IS NOT NULL
                  WHERE f.rank <= 10 AND f.enrollment_id IN (SELECT c.enrollment_id FROM credit c))::integer
 WHERE since IS NULL AND until IS NULL
 UNION ALL
 SELECT 'goals', (SELECT count(DISTINCT c.goal_id) FROM enrollment n
                  JOIN community_contributor c ON c.enrollment_id = n.id
                  JOIN community_goal g ON g.id = c.goal_id AND g.status = 'reached'
                  WHERE n.player_id = who AND played_enrollment(n.status, n.joined_via))::integer
 WHERE since IS NULL AND until IS NULL
 UNION ALL
 SELECT 'interests_set', (SELECT count(*) FROM player_preference f
                          WHERE f.player_id = who AND cardinality(f.interests) > 0)::integer
 WHERE since IS NULL AND until IS NULL
$$;
REVOKE ALL ON FUNCTION player_metrics(uuid, timestamptz, timestamptz) FROM PUBLIC;
