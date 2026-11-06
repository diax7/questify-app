import type { createTestDatabase } from "#test/support/test-db";

/**
 * A quest that real players have completed (T-604 browser test): each new player joins the event and has completed the
 * event's quest titled `titleAr` once, paid the quest's points as the engine pays a scan. Returns how many players were
 * seeded, so a missing quest is a failed call and not an empty page. Test code only.
 */
export async function seedPlayedQuest(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  eventId: string,
  titleAr: string,
  usernames: readonly string[],
): Promise<number> {
  const { rowCount } = await db.owner.query(
    `WITH picked AS (SELECT id, points FROM quest WHERE event_id = $1 AND title_ar = $2 AND deleted_at IS NULL),
          made AS (INSERT INTO player (username) SELECT unnest($3::text[]) RETURNING id),
          joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                     SELECT e.organizer_id, e.id, made.id FROM event e, made, picked WHERE e.id = $1
                     RETURNING id, organizer_id),
          done AS (INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                                 idempotency_key)
                   SELECT j.organizer_id, $1, j.id, p.id, 1, 'qr', gen_random_uuid()::text
                   FROM joined j, picked p RETURNING id, organizer_id, enrollment_id, quest_id)
     INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                               quest_id, actor)
     SELECT d.organizer_id, $1, d.enrollment_id, 'quest', p.points, p.points, d.id, d.quest_id, 'player'
     FROM done d, picked p`,
    [eventId, titleAr, usernames],
  );
  return rowCount ?? 0;
}
