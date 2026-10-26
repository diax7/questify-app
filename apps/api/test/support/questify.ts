import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

export type Phase = "scheduled" | "live" | "ended" | "archived";
export type EventOptions = Readonly<{
  phase?: Phase;
  access?: "public" | "unlisted" | "private";
  kind?: "physical" | "virtual" | "workplace";
  cityId?: string | null;
  /** Days before now that the event started (default 2); orders events in the passport. */
  startedDaysAgo?: number;
  organizer?: string;
}>;

/**
 * Fixtures for T-403's database suites (achievements, passport, history, final ranks): events in a phase, players,
 * quest credits written as the ledger writes them (so the XP trigger pays them), confirm and reveal as the owner.
 */
export async function questifyFixture() {
  const db: TestDatabase = await createTestDatabase();
  const pool = new Pool({ connectionString: db.appUrl, max: 8 });
  const ids = await seedTwoTenants(db.owner);
  const ownerA = await addMember(db.owner, ids.orgA, "owner");
  let counter = 0;

  const owner = async <T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ) => (await db.owner.query<T>(sql, values)).rows;
  const run = async <T extends QueryResultRow = Record<string, unknown>>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };
  const team = (staff = ownerA, organizer = ids.orgA): RequestContext => ({
    organizerId: organizer,
    staffUserId: staff,
  });
  const asPlayer = <T extends QueryResultRow = Record<string, unknown>>(
    player: string,
    sql: string,
    values: unknown[] = [],
  ) => run<T>({ playerId: player }, sql, values);

  const newEvent = async (options: EventOptions = {}): Promise<string> => {
    counter += 1;
    const phase = options.phase ?? "ended";
    const day = 24 * 3600 * 1000;
    const startsAt =
      phase === "scheduled"
        ? new Date(Date.now() + day)
        : new Date(Date.now() - (options.startedDaysAgo ?? 2) * day);
    const endsAt =
      phase === "ended" || phase === "archived"
        ? new Date(startsAt.getTime() + day / 2)
        : new Date(Date.now() + 3 * day);
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, name_ar, status, access, kind, city_id, starts_at, ends_at,
                          desk_location_en)
       VALUES ($1, $2, $3, 'فعالية', $4, $5, $6, $7, $8, $9, 'Hall B') RETURNING id`,
      [
        options.organizer ?? ids.orgA,
        `QFY${counter}`,
        `Event ${counter}`,
        phase === "ended" ? "live" : phase,
        options.access ?? "public",
        options.kind ?? "physical",
        options.cityId ?? null,
        startsAt,
        endsAt,
      ],
    );
    await owner("INSERT INTO category (event_id, name_en) VALUES ($1, 'General')", [event?.id]);
    return event?.id ?? "";
  };

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`qfy_player_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `q${counter}@mail${counter}.test`,
    ]);
    return player?.id ?? "";
  };
  const usernameOf = async (player: string) =>
    (await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [player]))[0]
      ?.username ?? "";

  const organizerOf = async (event: string) =>
    (
      await owner<{ organizer_id: string }>("SELECT organizer_id FROM event WHERE id = $1", [event])
    )[0]?.organizer_id ?? "";

  const join = async (
    event: string,
    player: string,
    joinedVia: string | null = null,
  ): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4) RETURNING id",
      [await organizerOf(event), event, player, joinedVia],
    );
    return row?.id ?? "";
  };

  /** One first completion of a new quest, written as the ledger writes it; returns the ledger entry's id. */
  const earn = async (
    event: string,
    enrollment: string,
    options: Readonly<{ points?: number; operator?: string }> = {},
  ): Promise<string> => {
    const organizer = await organizerOf(event);
    const points = options.points ?? 10;
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Quest', $2, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1
       RETURNING id`,
      [event, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, created_at)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5, now() - interval '2 hours') RETURNING id`,
      [organizer, event, enrollment, quest?.id, randomUUID()],
    );
    const [entry] = await owner<{ id: string }>(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor, operator_id)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, $7, $8) RETURNING id`,
      [
        organizer,
        event,
        enrollment,
        points,
        done?.id,
        quest?.id,
        options.operator === undefined ? "player" : "operator",
        options.operator ?? null,
      ],
    );
    return entry?.id ?? "";
  };

  /** Plays an event: joins and earns `quests` first completions. Returns the enrollment. */
  const play = async (event: string, player: string, quests = 1): Promise<string> => {
    const enrollment = await join(event, player);
    for (let i = 0; i < quests; i += 1) await earn(event, enrollment);
    return enrollment;
  };

  const removeEntry = (event: string, entry: string) =>
    run(team(), "SELECT * FROM remove_award($1, $2, 'cheat', $3, $4)", [
      event,
      entry,
      randomUUID(),
      randomUUID(),
    ]);

  const confirm = async (event: string) => {
    const places = await run<{ enrollment_id: string }>(
      team(),
      "SELECT * FROM results_places($1)",
      [event],
    );
    const [row] = await run<{ outcome: string }>(
      team(),
      "SELECT confirm_results($1, $2, $3) AS outcome",
      [event, places.map((p) => p.enrollment_id), randomUUID()],
    );
    return row?.outcome;
  };
  const reveal = async (event: string) =>
    (
      await run<{ outcome: string }>(team(), "SELECT reveal_results($1, $2, $3) AS outcome", [
        event,
        new Date(Date.now() + 24 * 3600 * 1000),
        randomUUID(),
      ])
    )[0]?.outcome;

  const sync = async (player: string) =>
    (
      await asPlayer<{ r: { achievements: { id: string; tier: string }[] } }>(
        player,
        "SELECT questify_sync() AS r",
      )
    )[0]?.r.achievements;
  const earned = async (player: string) =>
    (
      await owner<{ achievement_id: string; tier: string }>(
        `SELECT achievement_id, tier FROM achievement_earned WHERE player_id = $1
         ORDER BY achievement_id, array_position(ARRAY['bronze', 'silver', 'gold'], tier)`,
        [player],
      )
    ).map((row) => `${row.achievement_id}:${row.tier}`);

  /** A deletion token for erase_player (as profile-items does). */
  const deletionToken = async (player: string): Promise<Buffer> => {
    const hash = randomBytes(32);
    await owner(
      `INSERT INTO player_deletion_challenge(id,token_hash,player_id,contact_key,code_hash,expires_at,deletion_hash,deletion_expires_at)
       VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',$6,now()+interval '1 hour')`,
      [randomUUID(), randomBytes(32), player, randomBytes(32), randomBytes(32), hash],
    );
    return hash;
  };

  /** Runs `first` on a held transaction, starts `second` on another connection, waits until it blocks, commits. */
  const crossed = async (
    first: Readonly<{ context: RequestContext; sql: string; values?: unknown[] }>,
    second: Readonly<{ context: RequestContext; sql: string; values?: unknown[] }>,
  ): Promise<{ first: unknown; second: unknown; waited: boolean }> => {
    const a: PoolClient = await pool.connect();
    const b: PoolClient = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await a.query("BEGIN");
      for (const [key, value] of Object.entries({
        "app.player_id": first.context.playerId,
        "app.organizer_id": first.context.organizerId,
        "app.staff_user_id": first.context.staffUserId,
      })) {
        if (value !== undefined) await a.query("SELECT set_config($1, $2, true)", [key, value]);
      }
      const firstResult = (await a.query(first.sql, first.values ?? [])).rows[0];
      const pid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      pending = withRequestContext(b, second.context, () =>
        b.query(second.sql, second.values ?? []),
      ).then(
        (result) => result.rows[0],
        (error: unknown) => error,
      );
      let waited = false;
      for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
        const blocked = await owner(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pid],
        );
        waited = blocked.length === 1;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await a.query("COMMIT");
      return { first: firstResult, second: await pending, waited };
    } finally {
      await a.query("ROLLBACK");
      await pending;
      a.release();
      b.release();
    }
  };

  const close = async () => {
    await pool.end();
    await db.close();
  };

  return {
    db,
    pool,
    ids,
    ownerA,
    owner,
    run,
    team,
    asPlayer,
    newEvent,
    newPlayer,
    usernameOf,
    join,
    earn,
    play,
    removeEntry,
    confirm,
    reveal,
    sync,
    earned,
    deletionToken,
    crossed,
    close,
  };
}

export type QuestifyFixture = Awaited<ReturnType<typeof questifyFixture>>;
