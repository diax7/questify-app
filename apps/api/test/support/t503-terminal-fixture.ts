import { randomUUID } from "node:crypto";
import type { Client } from "pg";

export type Fixture = {
  event: string;
  quest: string;
  participants: { id: string; player_id: string }[];
};

export const stats = (samples: number[]) => {
  const ordered = samples.toSorted((left, right) => left - right);
  return {
    count: samples.length,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50: ordered[Math.floor(samples.length * 0.5)],
    p95: ordered[Math.floor(samples.length * 0.95)],
    p99: ordered[Math.floor(samples.length * 0.99)],
    max: ordered.at(-1),
  };
};

export async function fixture(
  owner: Client,
  organizer: string,
  count: number,
  prefix: string,
): Promise<Fixture> {
  const event =
    (
      await owner.query<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, activated_at)
     VALUES ($1, $2, 'Probe', 'live', now() - interval '1 hour', now() + interval '1 day', now()) RETURNING id`,
        [organizer, prefix.toUpperCase() + "1"],
      )
    ).rows[0]?.id ?? "";
  await owner.query(
    `INSERT INTO player (username) SELECT $1 || '_' || series
    FROM generate_series(1, $2::integer) series`,
    [prefix, count],
  );
  await owner.query(
    `INSERT INTO player_contact (player_id, email)
    SELECT id, username || '@gate.test' FROM player WHERE username LIKE $1`,
    [prefix + "_%"],
  );
  await owner.query(
    `INSERT INTO enrollment (organizer_id, event_id, player_id, score, balance, score_version)
    SELECT $1, $2, id, ($3::bigint + 1 - split_part(username, '_', 2)::integer) * 10, 0,
    split_part(username, '_', 2)::integer FROM player WHERE username LIKE $4`,
    [organizer, event, count, prefix + "_%"],
  );
  const participants = (
    await owner.query<{ id: string; player_id: string }>(
      "SELECT id, player_id FROM enrollment WHERE event_id = $1 ORDER BY score DESC, score_version",
      [event],
    )
  ).rows;
  const quest =
    (
      await owner.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
     SELECT $1, id, 'enter_code', 'Probe', 25, 100, jsonb_build_object('code', 'GATE')
     FROM category WHERE event_id = $1 RETURNING id`,
        [event],
      )
    ).rows[0]?.id ?? "";
  return { event, quest, participants };
}

export async function source(client: Client, target: Fixture, index: number) {
  const participant = target.participants[index];
  if (participant === undefined) throw new Error("missing synthetic participant");
  await client.query("SELECT set_config('app.player_id', $1, true)", [participant.player_id]);
  const result = await client.query(
    "SELECT * FROM complete_quest($1, 'code', NULL, 'GATE', $2, NULL)",
    [target.quest, randomUUID()],
  );
  if (
    result.rows.length !== 1 ||
    result.rows[0]?.replayed !== false ||
    Number(result.rows[0]?.points) !== 25
  ) {
    throw new Error("probe must execute a real paid non-replay completion");
  }
  return result;
}

export async function blocked(observer: Client, waiter: number, holder: number) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
      [waiter, holder],
    );
    if (result.rows[0]?.blocked === true) return;
  }
  throw new Error("expected held-lock blocking edge not observed");
}
