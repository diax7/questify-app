import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * T-804e (migration 0158, ADR-731 to ADR-733): the completion's cheaper bodies and enrollment triggers change nothing a
 * ledger writer sees. One scenario writes every ledger kind, for a real and a rehearsal member, with each guard's
 * refusal, through the completion door and raw ledger inserts. It runs twice in rolled-back transactions on one
 * database: once on 0158 as migrated, once after the rollback file put the 0157 bodies back. Every sequence is reset
 * to the same value before each run, so ids match; only times are left out. The two runs must agree on every answer,
 * SQLSTATE and row of the enrollments, ledger, XP, XP boards, levels, streak days and flags.
 */
const ROLLBACK = readFileSync(
  join(import.meta.dirname, "..", "..", "db", "rollback", "0158_completion_profile.sql"),
  "utf8",
);
const ASSERTION = (() => {
  const migration = readFileSync(
    join(import.meta.dirname, "..", "..", "migrations", "0158_completion_profile.sql"),
    "utf8",
  );
  return migration.slice(migration.lastIndexOf("DO $$"));
})();
const STAFF = "7d9a4c1e-0000-4000-8000-000000000001";
const OPERATOR = "7d9a4c1e-0000-4000-8000-000000000002";
const REDEMPTION = "7d9a4c1e-0000-4000-8000-000000000003";
const RAISE = "7d9a4c1e-0000-4000-8000-000000000004";
const LOWER = "7d9a4c1e-0000-4000-8000-000000000005";

type World = Readonly<{
  org: string;
  event: string;
  players: Readonly<Record<"real" | "rehearsal" | "banned" | "operator" | "waiting", string>>;
  members: Readonly<Record<"real" | "rehearsal" | "banned" | "operator" | "waiting", string>>;
  q1: string;
  q2: string;
  q3: string;
  step: string;
  session: string;
  reward: string;
  rehearsalBoost: string;
}>;
type Who = keyof World["members"];
type Step = Readonly<{
  name: string;
  sql: string;
  values?: (w: World) => unknown[];
  /** Runs with this player as app.player_id; `app` also switches to the API's role. */
  player?: Who;
  app?: boolean;
}>;

/** A ledger row for `who`'s membership, with the columns its kind's shape requires. */
const ledger = (name: string, who: Who, columns: string, values: string): Step => ({
  name,
  sql: `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, ${columns})
        VALUES ($1, $2, $3, ${values})`,
  values: (w) => [w.org, w.event, w.members[who]],
});
const complete = (name: string, quest: "q1" | "q2", key: string, who: Who = "real"): Step => ({
  name,
  sql: "SELECT * FROM complete_quest_answer($1, 'qr', 1, NULL, $2, NULL)",
  values: (w) => [w[quest], key],
  player: who,
});
/** The quest entry of the member in $3 for the quest in $4 and the given occurrence. */
const questEntryOf = (occurrence: number) =>
  `(SELECT l.id FROM ledger_entry l JOIN quest_completion c ON c.id = l.completion_id
    WHERE l.kind = 'quest' AND c.enrollment_id = $3 AND c.occurrence = ${occurrence} AND c.quest_id = $4)`;
const STAFF_AWARD = "kind, score_delta, balance_delta, actor, staff_user_id";

const STEPS: readonly Step[] = [
  // The completion door: a quest with its category bonus, first-N bonus and streak; a replay; a repeat.
  complete("first completion", "q1", "k1"),
  complete("replay", "q1", "k1"),
  complete("second quest", "q2", "k2"),
  complete("repeat", "q2", "k3"),
  {
    name: "rehearsal quest",
    sql: `WITH c AS (
            INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                          idempotency_key)
            VALUES ($1, $2, $3, $4, 1, 'qr', 'r1') RETURNING id)
          INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    completion_id, quest_id, actor)
          SELECT $1, $2, $3, 'quest', 10, 10, c.id, $4, 'player' FROM c`,
    values: (w) => [w.org, w.event, w.members.rehearsal, w.q2],
  },
  ledger("award", "real", STAFF_AWARD, `'award', 7, 7, 'staff', '${STAFF}'`),
  ledger("rehearsal award", "rehearsal", STAFF_AWARD, `'award', 6, 6, 'staff', '${STAFF}'`),
  {
    name: "community",
    sql: `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    community_step_id, actor)
          VALUES ($1, $2, $3, 'community', 5, 5, $4, 'system')`,
    values: (w) => [w.org, w.event, w.members.real, w.step],
  },
  {
    name: "session",
    sql: `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    session_id, operator_id, actor)
          VALUES ($1, $2, $3, 'session', 8, 8, $4, '${OPERATOR}', 'operator')`,
    values: (w) => [w.org, w.event, w.members.real, w.session],
  },
  {
    name: "redeem",
    sql: `WITH r AS (
            INSERT INTO redemption (id, organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key,
                                    reserved_until)
            VALUES ('${REDEMPTION}', $1, $2, $3, $4, 5, 'redeem-1', now() + interval '1 hour') RETURNING id)
          INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    redemption_id, actor)
          SELECT $1, $2, $3, 'redeem', 0, -5, r.id, 'player' FROM r`,
    values: (w) => [w.org, w.event, w.members.real, w.reward],
  },
  ledger(
    "redeem_return",
    "real",
    "kind, score_delta, balance_delta, redemption_id, actor",
    `'redeem_return', 0, 5, '${REDEMPTION}', 'system'`,
  ),
  {
    name: "removal",
    sql: `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    reverses, actor, staff_user_id)
          SELECT $1, $2, $3, 'removal', -l.score_delta, -l.balance_delta, l.id, 'staff', '${STAFF}'
          FROM ledger_entry l WHERE l.id = ${questEntryOf(1)}`,
    values: (w) => [w.org, w.event, w.members.real, w.q2],
  },
  {
    name: "rehearsal removal",
    sql: `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    reverses, actor, staff_user_id)
          SELECT $1, $2, $3, 'removal', -l.score_delta, -l.balance_delta, l.id, 'staff', '${STAFF}'
          FROM ledger_entry l WHERE l.id = ${questEntryOf(1)}`,
    values: (w) => [w.org, w.event, w.members.rehearsal, w.q2],
  },
  ...[
    { name: "adjust up", id: RAISE, to: 13, delta: 3 },
    { name: "adjust down", id: LOWER, to: 11, delta: -2 },
  ].map((change): Step => ({
    name: change.name,
    sql: `WITH p AS (
              INSERT INTO quest_points_change (id, organizer_id, event_id, quest_id, staff_user_id, from_points,
                                               to_points, completions, players, raised, lowered, clamped,
                                               idempotency_key)
              VALUES ('${change.id}', $1, $2, $4, '${STAFF}', 10, ${change.to}, 1, 1, 1, 0, 0, '${change.name}')
              RETURNING id)
            INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                      completion_id, quest_id, actor, staff_user_id, points_change_id)
            SELECT $1, $2, $3, 'adjust', ${change.delta}, ${change.delta}, c.id, $4, 'staff', '${STAFF}', p.id
            FROM p, quest_completion c WHERE c.enrollment_id = $3 AND c.quest_id = $4 AND c.occurrence = 1`,
    values: (w) => [w.org, w.event, w.members.real, w.q2],
  })),
  // Each ledger guard's refusal.
  ledger("banned player", "banned", STAFF_AWARD, `'award', 4, 4, 'staff', '${STAFF}'`),
  ledger(
    "operator who may not play",
    "operator",
    STAFF_AWARD,
    `'award', 4, 4, 'staff', '${STAFF}'`,
  ),
  {
    name: "live entry naming a rehearsal boost",
    sql: `WITH c AS (
            INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                          idempotency_key)
            VALUES ($1, $2, $3, $4, 1, 'qr', 'boosted') RETURNING id)
          INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    completion_id, quest_id, actor, boost_id)
          SELECT $1, $2, $3, 'quest', 10, 10, c.id, $4, 'player', $5 FROM c`,
    values: (w) => [w.org, w.event, w.members.real, w.q3, w.rehearsalBoost],
  },
  // The enrollment's row triggers: the status guard for the API's role, the waiting list on and off.
  {
    name: "a player bans themself",
    sql: "UPDATE enrollment SET status = 'banned' WHERE id = $1",
    values: (w) => [w.members.real],
    player: "real",
    app: true,
  },
  {
    name: "onto the waiting list",
    sql: "UPDATE enrollment SET status = 'pending', waitlisted = true WHERE id = $1 RETURNING status, waitlisted",
    values: (w) => [w.members.waiting],
  },
  {
    name: "a score-only write on the waiting list",
    sql: "UPDATE enrollment SET score = score WHERE id = $1 RETURNING status, waitlisted",
    values: (w) => [w.members.waiting],
  },
  ledger("award on the waiting list", "waiting", STAFF_AWARD, `'award', 4, 4, 'staff', '${STAFF}'`),
  {
    name: "a waiting player leaves",
    sql: "UPDATE enrollment SET status = 'left' WHERE id = $1 RETURNING status, waitlisted",
    values: (w) => [w.members.waiting],
    player: "waiting",
    app: true,
  },
  {
    name: "waitlisted outside pending",
    sql: "UPDATE enrollment SET waitlisted = true WHERE id = $1 RETURNING status, waitlisted",
    values: (w) => [w.members.waiting],
  },
  // A suspended event refuses payments and the completion door, but not a removal.
  {
    name: "suspend",
    sql: "UPDATE event SET suspended_at = now(), suspension_reason = 'Paused for the parity test' WHERE id = $1",
    values: (w) => [w.event],
  },
  ledger("award while suspended", "real", STAFF_AWARD, `'award', 4, 4, 'staff', '${STAFF}'`),
  {
    name: "removal while suspended",
    sql: `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                    reverses, actor, staff_user_id)
          SELECT $1, $2, $3, 'removal', -l.score_delta, -l.balance_delta, l.id, 'staff', '${STAFF}'
          FROM ledger_entry l WHERE l.enrollment_id = $3 AND l.kind = 'award'`,
    values: (w) => [w.org, w.event, w.members.real],
  },
  complete("completion while suspended", "q2", "k4"),
];

const SNAPSHOT = {
  enrollments: `SELECT p.username, n.status, n.score, n.balance, n.score_version, n.waitlisted
                FROM enrollment n JOIN player p ON p.id = n.player_id WHERE n.event_id = $1 ORDER BY p.username`,
  ledger: `SELECT l.id, p.username, l.kind, l.score_delta, l.balance_delta, l.rehearsal, l.reverses, l.completion_id
           FROM ledger_entry l JOIN enrollment n ON n.id = l.enrollment_id JOIN player p ON p.id = n.player_id
           WHERE l.event_id = $1 ORDER BY l.id`,
  completions: `SELECT c.id, p.username, c.occurrence, c.method
                FROM quest_completion c JOIN enrollment n ON n.id = c.enrollment_id JOIN player p ON p.id = n.player_id
                WHERE c.event_id = $1 ORDER BY c.id`,
  xp: `SELECT x.id, p.username, x.delta, x.source, x.ledger_entry_id, x.reverses
       FROM xp_entry x JOIN player p ON p.id = x.player_id ORDER BY x.id`,
  boards: `SELECT b.board, p.username, b.xp, b.xp_version FROM xp_board b JOIN player p ON p.id = b.player_id
           ORDER BY b.board, p.username`,
  totals: `SELECT p.username, x.xp, x.level FROM player_xp x JOIN player p ON p.id = x.player_id ORDER BY p.username`,
  levels: `SELECT p.username, r.level, r.xp_entry_id FROM level_reached r JOIN player p ON p.id = r.player_id
           ORDER BY p.username, r.level`,
  eventDays: `SELECT p.username, d.day::text, d.days, d.completion_id, d.entry_id
              FROM event_streak_day d JOIN enrollment n ON n.id = d.enrollment_id JOIN player p ON p.id = n.player_id
              ORDER BY p.username, d.day`,
  questifyDays: `SELECT p.username, d.day::text FROM questify_streak_day d JOIN player p ON p.id = d.player_id
                 ORDER BY p.username, d.day`,
  flags: `SELECT f.kind, p.username, f.status, f.evidence
          FROM flag f JOIN enrollment n ON n.id = f.enrollment_id JOIN player p ON p.id = n.player_id
          ORDER BY f.kind, p.username`,
} as const;

/** Times differ between the two runs (each transaction has its own now()); everything else must match. */
function timeless(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof Date ? "<time>" : value]),
    ),
  );
}

type Run = Readonly<{
  steps: { name: string; code: string | null; rows: Record<string, unknown>[] }[];
  tables: Record<string, Record<string, unknown>[]>;
}>;

async function runStep(owner: Client, world: World, step: Step): Promise<Run["steps"][number]> {
  await owner.query("SAVEPOINT step");
  try {
    if (step.player !== undefined) {
      await owner.query("SELECT set_config('app.player_id', $1, true)", [
        world.players[step.player],
      ]);
    }
    if (step.app === true) {
      await owner.query("SET LOCAL ROLE questify_app");
    }
    const { rows } = await owner.query<Record<string, unknown>>(
      step.sql,
      step.values?.(world) ?? [],
    );
    await owner.query("RESET ROLE");
    await owner.query("SELECT set_config('app.player_id', '', true)");
    await owner.query("RELEASE SAVEPOINT step");
    return { name: step.name, code: null, rows: timeless(rows) };
  } catch (error) {
    await owner.query("ROLLBACK TO SAVEPOINT step");
    await owner.query("RESET ROLE");
    return { name: step.name, code: (error as { code?: string }).code ?? "none", rows: [] };
  }
}

/** The scenario in one transaction that is rolled back, after the sequences are put back where `sequences` says. */
async function play(
  owner: Client,
  world: World,
  sequences: readonly { name: string; value: string | null }[],
  restoreOld: boolean,
): Promise<Run> {
  await owner.query("BEGIN");
  try {
    if (restoreOld) {
      await owner.query(ROLLBACK);
    }
    // setval is not undone by a rollback, so each run starts every sequence from the same value.
    for (const sequence of sequences) {
      await owner.query("SELECT setval($1::regclass, $2, $3)", [
        sequence.name,
        sequence.value ?? 1,
        sequence.value !== null,
      ]);
    }
    const steps: Run["steps"] = [];
    for (const step of STEPS) {
      steps.push(await runStep(owner, world, step));
    }
    const tables: Run["tables"] = {};
    for (const [name, sql] of Object.entries(SNAPSHOT)) {
      const params = sql.includes("$1") ? [world.event] : [];
      tables[name] = timeless((await owner.query<Record<string, unknown>>(sql, params)).rows);
    }
    return { steps, tables };
  } finally {
    await owner.query("ROLLBACK");
  }
}

async function seed(owner: Client): Promise<World> {
  const tenants = await seedTwoTenants(owner);
  const one = async (sql: string, values: unknown[] = []): Promise<string> =>
    String((await owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "");
  const org = tenants.orgA;
  const event = tenants.eventA;
  // A multi-day event (day entries, streaks) that started two days ago.
  await owner.query(
    "UPDATE event SET starts_at = now() - interval '2 days', ends_at = now() + interval '3 days' WHERE id = $1",
    [event],
  );
  const player = (name: string, status = "active") =>
    one("INSERT INTO player (username, status) VALUES ($1, $2) RETURNING id", [name, status]);
  const enroll = (who: string, via: string | null = null) =>
    one(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [org, event, who, via],
    );
  const players = {
    real: tenants.playerA,
    rehearsal: await player("parity_rehearsal"),
    banned: await player("parity_banned"),
    operator: await player("parity_operator"),
    waiting: await player("parity_waiting"),
  };
  const members = {
    real: await one("SELECT id FROM enrollment WHERE player_id = $1", [players.real]),
    rehearsal: await enroll(players.rehearsal, "rehearsal"),
    banned: await enroll(players.banned),
    operator: await enroll(players.operator),
    waiting: await enroll(players.waiting),
  };
  await owner.query("UPDATE player SET status = 'banned' WHERE id = $1", [players.banned]);
  await owner.query(
    "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, false)",
    [org, event, players.operator],
  );
  const category = await one(
    `INSERT INTO category (event_id, name_ar, name_en, completion_bonus) VALUES ($1, 'تطابق', 'Parity', 20)
     RETURNING id`,
    [event],
  );
  const quest = (title: string, points: number, inCategory: string | null) =>
    one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       SELECT $1, coalesce($4::uuid, (SELECT id FROM category WHERE event_id = $1 AND id <> $5 LIMIT 1)),
              'scan_qr', $2, $3, 5, '{}'
       RETURNING id`,
      [event, title, points, inCategory, category],
    );
  const q1 = await quest("Parity one", 50, category);
  const q2 = await quest("Parity two", 10, null);
  const q3 = await quest("Parity three", 10, null);
  await owner.query(
    `INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots) VALUES ($1, $2, $3, 5, 1);
     INSERT INTO quest_bonus_slot (quest_id, place, organizer_id, event_id) VALUES ($1, 1, $2, $3);
     INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points) VALUES ($3, $2, true, 4)`
      .replaceAll("$1", `'${q1}'`)
      .replaceAll("$2", `'${org}'`)
      .replaceAll("$3", `'${event}'`),
  );
  // Yesterday's streak day (on a completion of a hidden quest), so today's first completion pays the streak bonus.
  const hidden = await quest("Parity seed", 1, null);
  await owner.query(
    `WITH c AS (
       INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($2, $3, $1, $4, 1, 'qr', 'seed') RETURNING id)
     INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
     SELECT $1, event_day(now(), e) - 1, $2, $3, 1, c.id FROM c, event e WHERE e.id = $3`,
    [members.real, org, event, hidden],
  );
  const goal = await one(
    `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
     VALUES ($1, $2, 'Together', 'points', 100, now() - interval '1 hour', now() + interval '1 hour') RETURNING id`,
    [org, event],
  );
  const step = await one(
    `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points)
     VALUES ($1, $2, 100, true, 'points', 5) RETURNING id`,
    [event, goal],
  );
  const session = await one(
    `INSERT INTO event_session (organizer_id, event_id, kind, title_en, starts_at, ends_at, access, created_by)
     VALUES ($1, $2, 'talk', 'Keynote', now(), now() + interval '1 hour', 'open', $3) RETURNING id`,
    [org, event, STAFF],
  );
  const reward = await one(
    "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'experience', 'Tour', 5, 8) RETURNING id",
    [event],
  );
  const rehearsalBoost = await one(
    `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at, rehearsal)
     VALUES ($1, $2, $3, now() - interval '1 hour', now() + interval '1 hour', true) RETURNING id`,
    [org, event, category],
  );
  return { org, event, players, members, q1, q2, q3, step, session, reward, rehearsalBoost };
}

describe.skipIf(TEST_DATABASE_URL === undefined)(
  "completion profile equivalence (T-804e, migration 0158)",
  () => {
    let db: TestDatabase;
    let world: World;
    let sequences: { name: string; value: string | null }[];

    beforeAll(async () => {
      db = await createTestDatabase();
      world = await seed(db.owner);
      sequences = (
        await db.owner.query<{ name: string; value: string | null }>(
          `SELECT format('%I.%I', schemaname, sequencename) AS name, last_value::text AS value
           FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
        )
      ).rows;
    });

    afterAll(async () => {
      await db.close();
    });

    it("writes the same rows and answers, and refuses with the same SQLSTATEs, as the 0157 bodies", async () => {
      const before = await play(db.owner, world, sequences, true);
      const after = await play(db.owner, world, sequences, false);
      expect(after.steps).toEqual(before.steps);
      expect(after.tables).toEqual(before.tables);
    });

    it("refuses to migrate while a row is waitlisted outside pending (the check before the WHEN, ADR-733 E)", async () => {
      await db.owner.query("BEGIN");
      try {
        await db.owner.query(ASSERTION);
        // Written past the triggers, as a row from before 0036's rule could be.
        await db.owner.query("SET LOCAL session_replication_role = replica");
        await db.owner.query("UPDATE enrollment SET waitlisted = true WHERE id = $1", [
          world.members.banned,
        ]);
        await expect(db.owner.query(ASSERTION)).rejects.toMatchObject({ code: "23514" });
      } finally {
        await db.owner.query("ROLLBACK");
      }
    });

    it("runs a scenario that reaches every ledger kind, both rehearsal states and every refusal", async () => {
      const run = await play(db.owner, world, sequences, false);
      const codes = Object.fromEntries(run.steps.map((step) => [step.name, step.code]));
      expect(codes).toMatchObject({
        "first completion": null,
        replay: null,
        repeat: null,
        "rehearsal quest": null,
        "adjust down": null,
        "banned player": "PB423",
        "operator who may not play": "QP403",
        "live entry naming a rehearsal boost": "LB500",
        "a player bans themself": "42501",
        "a waiting player leaves": null,
        "award while suspended": "ES423",
        "removal while suspended": null,
      });
      expect(codes["completion while suspended"]).not.toBeNull();
      const kinds = new Set(run.tables["ledger"]?.map((row) => row["kind"]));
      for (const kind of [
        "quest",
        "redeem",
        "redeem_return",
        "award",
        "bonus",
        "community",
        "first_bonus",
        "streak",
        "session",
        "removal",
        "adjust",
      ]) {
        expect(kinds, kind).toContain(kind);
      }
      const ledgerRows = run.tables["ledger"] ?? [];
      expect(ledgerRows.some((row) => row["rehearsal"] === true)).toBe(true);
      expect(ledgerRows.some((row) => row["rehearsal"] === false)).toBe(true);
      expect(run.tables["xp"]?.map((row) => row["source"])).toEqual(
        expect.arrayContaining(["quest", "removal"]),
      );
      expect(run.tables["boards"]?.length).toBeGreaterThan(1);
      expect(run.tables["eventDays"]?.length).toBeGreaterThan(1);
      // The waiting flag survives a score write and an award, and goes on any status or flag change (ADR-733 E).
      const waiting = (name: string) => run.steps.find((step) => step.name === name)?.rows;
      expect(waiting("onto the waiting list")).toEqual([{ status: "pending", waitlisted: true }]);
      expect(waiting("a score-only write on the waiting list")).toEqual([
        { status: "pending", waitlisted: true },
      ]);
      expect(waiting("a waiting player leaves")).toEqual([{ status: "left", waitlisted: false }]);
      expect(waiting("waitlisted outside pending")).toEqual([
        { status: "left", waitlisted: false },
      ]);
      expect(
        run.tables["enrollments"]?.find((row) => row["username"] === "parity_waiting"),
      ).toMatchObject({ status: "left", waitlisted: false, score: "4" });
      const first = run.steps.find((step) => step.name === "first completion")?.rows[0];
      expect(first).toMatchObject({ rank_ranked: true, day_ranked: true, ranking_failed: false });
    });
  },
);
