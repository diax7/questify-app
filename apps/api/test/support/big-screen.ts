import type { Client } from "pg";

/**
 * What the big screen's browser test needs in an event (T-504), written as the owner on the throw-away database: the
 * big-screen add-on unlocked the way Questify's admin would, a community goal running at 40 of 100 with a milestone
 * reached, and a live poll sent a moment ago that three new players voted in through the real door. Test code only.
 */
export async function seedBigScreen(owner: Client, eventId: string): Promise<void> {
  // The go-live wipe resets every poll sent before it, so it runs first (the event is live, as the test left it).
  await owner.query("SELECT ensure_rehearsal_wiped($1)", [eventId]);
  await owner.query(
    `INSERT INTO event_entitlement (event_id, organizer_id, feature)
     SELECT id, organizer_id, 'bigScreen' FROM event WHERE id = $1 ON CONFLICT DO NOTHING`,
    [eventId],
  );
  const goal = await owner.query<{ id: string }>(
    `INSERT INTO community_goal (organizer_id, event_id, title_ar, title_en, measure, target, starts_at, ends_at,
                                 status, settled_until, progress)
     SELECT organizer_id, id, 'أضيئوا البرج', 'Light the tower', 'points', 100, now() - interval '1 hour',
            now() + interval '1 hour', 'running', now(), 40
     FROM event WHERE id = $1 RETURNING id`,
    [eventId],
  );
  const steps = await owner.query<{ id: string }>(
    `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward)
     VALUES ($1, $2, 25, false, 'nothing'), ($1, $2, 100, true, 'nothing') RETURNING id`,
    [eventId, goal.rows[0]?.id],
  );
  await owner.query(
    "INSERT INTO community_reach (step_id, event_id, reached_at, progress) VALUES ($1, $2, now(), 30)",
    [steps.rows[0]?.id, eventId],
  );
  await owner.query(
    `INSERT INTO category (event_id, name_ar, name_en)
     SELECT $1, 'عام', 'General' WHERE NOT EXISTS (SELECT 1 FROM category WHERE event_id = $1)`,
    [eventId],
  );
  const poll = await owner.query<{ id: string }>(
    `INSERT INTO quest (event_id, category_id, type, title_ar, title_en, points, type_config, visible, opens_at,
                        closes_at, poll_sent_at)
     SELECT $1, c.id, 'vote', 'ما المجال الأجمل؟', 'Which field is best?', 0,
            '{"options": [{"id": "a", "text": {"ar": "الروبوتات", "en": "Robots"}},
                          {"id": "b", "text": {"ar": "الفضاء", "en": "Space"}}],
              "live": {"choices": "one", "results": "after_vote", "minutes": 30}}'::jsonb,
            true, now() - interval '1 minute', now() + interval '30 minutes', now() - interval '1 minute'
     FROM (SELECT id FROM category WHERE event_id = $1 LIMIT 1) c RETURNING id`,
    [eventId],
  );
  for (const [index, option] of ["a", "a", "b"].entries()) {
    const voter = await owner.query<{ id: string }>(
      `WITH made AS (INSERT INTO player (username) VALUES ($2) RETURNING id),
            joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                       SELECT e.organizer_id, e.id, made.id FROM event e, made WHERE e.id = $1)
       SELECT id FROM made`,
      [eventId, `voter_${Date.now() % 1e6}_${index}`],
    );
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('app.player_id', $1, true)", [voter.rows[0]?.id]);
      await owner.query("SELECT * FROM vote_quest($1, $2, gen_random_uuid()::text)", [
        poll.rows[0]?.id,
        [option],
      ]);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  }
}
