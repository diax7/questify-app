import type { createTestDatabase } from "#test/support/test-db";

/** One operator to seed: a username and the minutes ago of each station scan, newest first or not. */
export type SeededOperator = Readonly<{ username: string; scans: readonly number[] }>;

/**
 * Operators for the Operators page's activity (T-617): each new player staffs the event and has scanned the event's one
 * station (a scan quest taking My QR) at the given minutes ago, as the station scan writes it, one served player per
 * scan. An operator with no scans is quiet from the start. Test code only.
 */
export async function seedOperators(
  db: Awaited<ReturnType<typeof createTestDatabase>>,
  eventId: string,
  operators: readonly SeededOperator[],
): Promise<void> {
  // The event's day starts 12 hours before now, so a scan minutes ago is "today" whatever the wall clock reads.
  await db.owner.query(
    `UPDATE event SET day_start_hour = (extract(hour FROM now() AT TIME ZONE timezone)::integer + 12) % 24
     WHERE id = $1`,
    [eventId],
  );
  const [station] = (
    await db.owner.query<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, title_ar, points, repeat_cap, visible, verification,
                          type_config)
       SELECT $1, id, 'scan_qr', 'Main gate', 'البوابة الرئيسية', 10, 100, true, ARRAY['my_qr'], '{}'
       FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [eventId],
    )
  ).rows;
  for (const operator of operators) {
    await db.owner.query(
      `WITH who AS (INSERT INTO player (username) VALUES ($2) RETURNING id)
       INSERT INTO staff_assignment (organizer_id, event_id, player_id)
       SELECT e.organizer_id, e.id, who.id FROM event e, who WHERE e.id = $1`,
      [eventId, operator.username],
    );
    for (const [index, minutesAgo] of operator.scans.entries()) {
      await db.owner.query(
        `WITH served AS (INSERT INTO player (username) VALUES ($5) RETURNING id),
              joined AS (INSERT INTO enrollment (organizer_id, event_id, player_id)
                         SELECT e.organizer_id, e.id, served.id FROM event e, served WHERE e.id = $1
                         RETURNING id, organizer_id),
              done AS (INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                                     idempotency_key, created_at)
                       SELECT j.organizer_id, $1, j.id, $3, 1, 'my_qr', gen_random_uuid()::text,
                              now() - make_interval(mins => $4)
                       FROM joined j RETURNING id, enrollment_id, organizer_id, created_at)
         INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                   completion_id, quest_id, actor, operator_id, created_at)
         SELECT d.organizer_id, $1, d.enrollment_id, 'quest', 10, 10, d.id, $3, 'operator',
                (SELECT player_id FROM staff_assignment WHERE event_id = $1 AND player_id =
                  (SELECT id FROM player WHERE username = $2)), d.created_at
         FROM done d`,
        [
          eventId,
          operator.username,
          station?.id,
          minutesAgo,
          `served_${operator.username}_${index}`,
        ],
      );
    }
  }
}
