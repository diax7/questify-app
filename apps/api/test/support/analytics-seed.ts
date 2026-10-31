import type { Client } from "pg";

/** The quests of one category, each with how many of the ten players completed it. */
const TRAIL = [
  ["الخطوة 1", "Step 1", 8],
  ["الخطوة 2", "Step 2", 6],
  ["الخطوة 3", "Step 3", 2],
  ["الخطوة 4", "Step 4", 1],
] as const;
const FREE = [
  ["مهمة حرة 1", "Free 1", 5],
  ["مهمة حرة 2", "Free 2", 3],
  ["مهمة حرة 3", "Free 3", 1],
  ["مهمة حرة 4", "Free 4", 0],
] as const;

async function addCategory(
  owner: Client,
  eventId: string,
  name: readonly [string, string],
  inOrder: boolean,
  position: number,
): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO category (event_id, name_ar, name_en, order_mode, position)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [eventId, name[0], name[1], inOrder ? "in_order" : "any", position],
  );
  return rows[0]?.id ?? "";
}

/**
 * What the analytics page's browser test reads (T-607), written as the owner on the throw-away database: ten players
 * who joined over three hours by every source, an in-order category whose players thin out step by step (the largest
 * drop is after the second step), a free category, and two rewards with three redemptions, two of them still waiting.
 * Test code only.
 */
export async function seedAnalytics(owner: Client, eventId: string): Promise<void> {
  // A username is unique, and the browser suite seeds one event per project on the same database.
  const tag = eventId.slice(0, 6);
  await owner.query(
    "INSERT INTO player (username) SELECT 'an' || n || '_' || $1::text FROM generate_series(1, 10) n",
    [tag],
  );
  await owner.query(
    `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, joined_at, score)
     SELECT e.organizer_id, e.id, p.id, (ARRAY['code', 'qr', 'link', 'public_list', 'invite'])[1 + p.n % 5],
            now() - (p.n || ' minutes')::interval * 18, 50
     FROM event e,
          (SELECT id, row_number() OVER (ORDER BY username) AS n FROM player WHERE username LIKE '%\\_' || $2::text) p
     WHERE e.id = $1`,
    [eventId, tag],
  );
  const groups = [
    [await addCategory(owner, eventId, ["الدرب", "Trail"], true, 1), TRAIL],
    [await addCategory(owner, eventId, ["حرة", "Free"], false, 2), FREE],
  ] as const;
  for (const [category, quests] of groups) {
    for (const [position, [titleAr, titleEn, players]] of quests.entries()) {
      await owner.query(
        `WITH quest_made AS (
           INSERT INTO quest (event_id, category_id, type, title_ar, title_en, points, repeat_cap, visible, position)
           VALUES ($1, $2, 'scan_qr', $3, $4, 5, 1, true, $5) RETURNING id)
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key)
         SELECT n.organizer_id, n.event_id, n.id, quest_made.id, 1, 'qr', gen_random_uuid()::text
         FROM quest_made,
              (SELECT *, row_number() OVER (ORDER BY id) AS r FROM enrollment WHERE event_id = $1) n
         WHERE n.r <= $6`,
        [eventId, category, titleAr, titleEn, position, players],
      );
    }
  }
  const rewards = await owner.query<{ id: string; price: number }>(
    `INSERT INTO reward (event_id, kind, name_ar, name_en, price, stock_total, units_out, position)
     SELECT $1, 'experience', v.name_ar, v.name_en, v.price, v.stock, v.out, v.position
     FROM (VALUES ('هودي الفعالية', 'Event hoodie', 30, 5, 2, 1), ('كوب الفعالية', 'Event mug', 10, 10, 1, 2))
       AS v(name_ar, name_en, price, stock, out, position)
     RETURNING id, price`,
    [eventId],
  );
  const [hoodie, mug] = rewards.rows.toSorted((a, b) => b.price - a.price);
  await owner.query(
    `INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, status, idempotency_key,
                             reserved_until, ended_at, ended_by)
     SELECT e.organizer_id, e.id, n.id, v.reward, v.price, v.status, gen_random_uuid()::text,
            CASE WHEN v.status = 'reserved' THEN now() + interval '1 day' END,
            CASE WHEN v.status = 'reserved' THEN NULL ELSE now() END,
            CASE WHEN v.status = 'reserved' THEN NULL ELSE 'delivery' END
     FROM event e
     JOIN (SELECT *, row_number() OVER (ORDER BY id) AS r FROM enrollment WHERE event_id = $1) n ON n.event_id = e.id
     JOIN (VALUES (1, $2::uuid, 30, 'reserved'), (2, $2::uuid, 30, 'delivered'), (3, $3::uuid, 10, 'reserved'))
       AS v(r, reward, price, status) ON v.r = n.r
     WHERE e.id = $1`,
    [eventId, hoodie?.id, mug?.id],
  );
}
