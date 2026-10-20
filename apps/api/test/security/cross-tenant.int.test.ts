import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { createStaff } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The cross-tenant suite at the database (T-012, NFR-016): with the API's own role, organizer A (or staff member A,
 * or player A) can read, change, delete or forge none of B's rows. Every table must be classified below; a new
 * table fails the first test until someone decides whose it is and proves it here.
 */

type Fixtures = Readonly<{
  orgA: string;
  orgB: string;
  eventA: string;
  eventB: string;
  publicEventB: string;
  playerA: string;
  playerB: string;
  staffA: string;
  staffB: string;
  /** The General category of organizer B's private event. */
  categoryB: string;
}>;

type Seat = "organizer" | "staff" | "player";

type Probe = Readonly<{
  /** Who asks: a member of organizer A, staff member A on their own, or player A. */
  seat: Seat;
  /** The column that says whose a row is, from this seat's point of view. */
  column: string;
  mine: (f: Fixtures) => string;
  theirs: (f: Fixtures) => string;
  /** B's rows that A may read by design (public pages), as a filter on top of the column; none when absent. */
  publicRows?: (f: Fixtures) => Readonly<{ sql: string; values: unknown[] }>;
  /** Why A cannot read even its own rows by this column, when that is so. */
  ownRowsHidden?: string;
  /** An insert that claims B's ownership, and the wall expected to refuse it. */
  forge: (f: Fixtures) => Readonly<{ sql: string; values: unknown[] }>;
  forgeRefusedBy?: RegExp;
}>;

type Owned = Readonly<{
  probes: readonly Probe[];
  /**
   * Rows any caller may delete by design (a retention sweep), as a filter on columns prefixed by `row` ("" in a
   * query, "OLD." in a trigger); a bare delete must stop exactly there.
   */
  sweep?: (row: string) => string;
}>;

const POLICY = /row-level security/;
const SIGNUP_A = "new.owner@najd.test";
const SIGNUP_B = "new.owner@tabuk.test";
const hash = () => `\\x${randomBytes(32).toString("hex")}`;

const OWNED: Readonly<Record<string, Owned>> = {
  organizer: {
    probes: [
      {
        seat: "organizer",
        column: "id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        publicRows: () => ({ sql: "true", values: [] }),
        forge: () => ({
          sql: "INSERT INTO organizer (name, slug) VALUES ('Forged', 'forged-org')",
          values: [],
        }),
      },
    ],
  },
  organizer_member: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
          values: [f.orgB, f.staffA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  event: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        publicRows: (f) => ({ sql: "id = $2", values: [f.publicEventB] }),
        forge: (f) => ({
          sql: "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'FORGE1', 'Forged')",
          values: [f.orgB],
        }),
      },
    ],
  },
  category: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stolen')",
          values: [f.eventB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden: "players read quests through their own API (T-105, T-114), not these tables",
        forge: (f) => ({
          sql: "INSERT INTO category (event_id, name_en) VALUES ($1, 'Mine now')",
          values: [f.eventA],
        }),
      },
    ],
  },
  quest: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Stolen', 1)",
          values: [f.eventB, f.categoryB],
        }),
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        ownRowsHidden: "players read quests through their own API (T-105, T-114), not these tables",
        forge: (f) => ({
          sql: "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, gen_random_uuid(), 'scan_qr', 'Mine now', 1)",
          values: [f.eventA],
        }),
      },
    ],
  },
  quest_completion: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key) SELECT organizer_id, event_id, id, gen_random_uuid(), 1, 'qr', 'forged' FROM enrollment WHERE event_id = $1",
          values: [f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key) SELECT organizer_id, event_id, id, gen_random_uuid(), 1, 'qr', 'forged' FROM enrollment WHERE event_id = $1",
          values: [f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  ledger_entry: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor) VALUES ($1, $2, gen_random_uuid(), 'quest', 1000, 1000, 'player')",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
      {
        seat: "player",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor) VALUES ($1, $2, gen_random_uuid(), 'quest', 1000, 1000, 'player')",
          values: [f.orgB, f.eventB],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  enrollment: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          values: [f.orgB, f.publicEventB, f.playerA],
        }),
      },
      {
        seat: "player",
        column: "player_id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: (f) => ({
          sql: "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          values: [f.orgA, f.eventA, f.playerB],
        }),
      },
    ],
  },
  event_entitlement: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        publicRows: (f) => ({ sql: "event_id = $2", values: [f.publicEventB] }),
        forge: (f) => ({
          sql: "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'teleporter')",
          values: [f.publicEventB, f.orgB],
        }),
      },
    ],
  },
  audit_log: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type) VALUES ('staff', $1, $2, 'event.forged', 'event')",
          values: [f.staffA, f.orgB],
        }),
      },
    ],
  },
  staff_user: {
    probes: [
      {
        seat: "staff",
        column: "id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        forge: () => ({
          sql: "INSERT INTO staff_user (email, password_hash) VALUES ('forged@x.test', 'x')",
          values: [],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  staff_session: {
    sweep: (row) => `coalesce(${row}revoked_at, ${row}last_seen_at) < now() - interval '30 days'`,
    probes: [
      {
        seat: "staff",
        column: "staff_user_id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        forge: (f) => ({
          sql: "INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)",
          values: [f.staffB, hash()],
        }),
      },
    ],
  },
  staff_login_challenge: {
    sweep: (row) => `${row}created_at < now() - interval '1 day'`,
    probes: [
      {
        seat: "staff",
        column: "staff_user_id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        ownRowsHidden: "a challenge is read only by its own token, during sign-in",
        forge: (f) => ({
          sql: "INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')",
          values: [f.staffB, hash(), hash()],
        }),
      },
    ],
  },
  staff_password_reset: {
    sweep: (row) => `${row}created_at < now() - interval '1 day'`,
    probes: [
      {
        seat: "staff",
        column: "staff_user_id",
        mine: (f) => f.staffA,
        theirs: (f) => f.staffB,
        ownRowsHidden: "a reset link is read only by its own token, from the emailed link",
        forge: (f) => ({
          sql: "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
          values: [f.staffB, hash()],
        }),
      },
    ],
  },
  organizer_acceptance: {
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by) VALUES ($1, 'organizer_terms', '9.9', $2)",
          values: [f.orgB, f.staffA],
        }),
        forgeRefusedBy: /permission denied/,
      },
    ],
  },
  organizer_invite: {
    sweep: (row) => `${row}expires_at < now() - interval '30 days'`,
    probes: [
      {
        seat: "organizer",
        column: "organizer_id",
        mine: (f) => f.orgA,
        theirs: (f) => f.orgB,
        forge: (f) => ({
          sql: "INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, 'forged@x.test', 'editor', $2, $3, now() + interval '7 days')",
          values: [f.orgB, hash(), f.staffA],
        }),
      },
    ],
  },
  staff_signup: {
    sweep: (row) => `${row}created_at < now() - interval '1 day'`,
    probes: [
      {
        seat: "staff",
        column: "email",
        mine: () => SIGNUP_A,
        theirs: () => SIGNUP_B,
        ownRowsHidden: "a pending sign-up is read only by its own token, during sign-up",
        forge: () => ({
          sql: "INSERT INTO staff_signup (token_hash, code_hash, email, organizer_name, accepted_terms, accepted_dpa, accepted_content, expires_at) VALUES ($1, $2, 'forged@x.test', 'Forged', '0.1', '0.1', '0.1', now() + interval '10 minutes')",
          values: [hash(), hash()],
        }),
      },
    ],
  },
  player: {
    probes: [
      {
        seat: "player",
        column: "id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: () => ({ sql: "INSERT INTO player (username) VALUES ('forged_one')", values: [] }),
      },
      {
        seat: "organizer",
        column: "id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: () => ({ sql: "INSERT INTO player (username) VALUES ('forged_two')", values: [] }),
      },
    ],
  },
  player_contact: {
    probes: [
      {
        seat: "player",
        column: "player_id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        forge: (f) => ({
          sql: "INSERT INTO player_contact (player_id, email) VALUES ($1, 'forged@x.test')",
          values: [f.playerB],
        }),
      },
      {
        seat: "organizer",
        column: "player_id",
        mine: (f) => f.playerA,
        theirs: (f) => f.playerB,
        ownRowsHidden:
          "contact details are for the player and Questify admins only, even in your own events",
        forge: (f) => ({
          sql: "INSERT INTO player_contact (player_id, email) VALUES ($1, 'forged@x.test')",
          values: [f.playerA],
        }),
      },
    ],
  },
};

/** Tables that belong to nobody in particular, with the reason; their write rules are tested where they live. */
const SHARED: Readonly<Record<string, string>> = {
  platform_setting: "platform-wide settings; only a Questify admin writes (test/settings)",
  translation: "platform-wide texts; only a Questify admin writes (test/translations)",
  auth_throttle: "keyed by a one-way tag, not by a person; no data to leak (test/auth)",
  schema_migration: "the migration record; the API role has no rights on it (outsider suite)",
  player_login_challenge:
    "no right for the API role at all; a challenge is reached only through definers bound to its token (test/db/player-sign-in)",
  player_refresh:
    "no right for the API role at all; a refresh token is rotated only through a definer bound to it (test/db/player-sign-in)",
  player_session:
    "no right for the API role at all; a token is looked up only through player_session_owner(hash) (test/db/completion-engine)",
};

/** A seat holding ids that own no row anywhere, so any row a bare write reaches is someone else's. */
const emptyHanded = (seat: Seat): RequestContext =>
  seat === "organizer"
    ? { organizerId: randomUUID(), staffUserId: randomUUID() }
    : seat === "staff"
      ? { staffUserId: randomUUID() }
      : { playerId: randomUUID() };

/** Thrown to roll a probe back after reading its result. */
class Rollback extends Error {
  constructor(readonly rowCount: number) {
    super("rollback");
  }
}

/** Runs one statement in the seat's context, reports the rows it touched, and rolls it back. */
async function touched(
  db: TestDatabase,
  context: RequestContext,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  try {
    await withRequestContext(db.app, context, async () => {
      throw new Rollback((await db.app.query(sql, values)).rowCount ?? 0);
    });
  } catch (error) {
    if (error instanceof Rollback) {
      return error.rowCount;
    }
    throw error;
  }
  throw new Error("unreachable: the probe always rolls back");
}

/** Like `touched`, but a refusal by grant counts as reaching nothing; any other error fails the test. */
async function reached(
  db: TestDatabase,
  context: RequestContext,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  try {
    return await touched(db, context, sql, values);
  } catch (error) {
    expect(String(error), sql).toMatch(/permission denied/);
    return 0;
  }
}

async function updatableColumns(db: TestDatabase, table: string): Promise<string[]> {
  const { rows } = await db.owner.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.column_privileges
     WHERE grantee = 'questify_app' AND privilege_type = 'UPDATE' AND table_schema = 'public' AND table_name = $1
     ORDER BY 1`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function mayDelete(db: TestDatabase, table: string): Promise<boolean> {
  const { rows } = await db.owner.query<{ ok: boolean }>(
    "SELECT has_table_privilege('questify_app', $1, 'DELETE') AS ok",
    [`public.${table}`],
  );
  return rows[0]?.ok === true;
}

/** A value of the column taken from any row, to write without reading the column (no read rule applies). */
async function sampleValue(
  db: TestDatabase,
  table: string,
  column: string,
): Promise<string | null> {
  const { rows } = await db.owner.query<{ value: string | null }>(
    `SELECT "${column}"::text AS value FROM ${table} LIMIT 1`,
  );
  return rows[0]?.value ?? null;
}

/** Two organizers, each with an owner, a session, a sign-in challenge, a reset link, an audit entry and add-ons. */
async function seedFixtures(db: TestDatabase): Promise<Fixtures> {
  const base = await seedTwoTenants(db.owner);
  const run = (sql: string, values: unknown[]) => db.owner.query<{ id: string }>(sql, values);
  const publicEventB = (
    await run(
      "INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at) VALUES ($1, 'TABUK2', 'Open Day', 'live', now() - interval '1 hour', now() + interval '30 days') RETURNING id",
      [base.orgB],
    )
  ).rows[0]?.id;
  if (publicEventB === undefined) {
    throw new Error("Fixture: the public event of organizer B was not created.");
  }
  const staffA = await createStaff(db.owner, { email: "owner@najd.test" });
  const staffB = await createStaff(db.owner, { email: "owner@tabuk.test" });
  const categoryB = (await run("SELECT id FROM category WHERE event_id = $1", [base.eventB]))
    .rows[0]?.id;
  if (categoryB === undefined) {
    throw new Error("Fixture: organizer B's event has no General category.");
  }
  const f: Fixtures = { ...base, publicEventB, staffA, staffB, categoryB };
  for (const [org, staff, events] of [
    [f.orgA, staffA, [f.eventA]],
    [f.orgB, staffB, [f.eventB, publicEventB]],
  ] as const) {
    await run(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org, staff],
    );
    await run("INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)", [
      staff,
      hash(),
    ]);
    await run(
      "INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '5 minutes')",
      [staff, hash(), hash()],
    );
    await run(
      "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')",
      [staff, hash()],
    );
    for (const document of ["organizer_terms", "organizer_dpa", "organizer_content_rules"]) {
      await run(
        "INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by) VALUES ($1, $2, '0.1', $3)",
        [org, document, staff],
      );
    }
    await run(
      "INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, $2, 'editor', $3, $4, now() + interval '7 days')",
      [org, `invited.${org.slice(0, 8)}@team.test`, hash(), staff],
    );
    await run(
      "INSERT INTO audit_log (actor_type, actor_id, organizer_id, action, target_type) VALUES ('staff', $1, $2, 'event.seed', 'event')",
      [staff, org],
    );
    for (const event of events) {
      await run(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event, org],
      );
      await run(
        "INSERT INTO quest (event_id, category_id, type, title_en, points) SELECT $1, id, 'scan_qr', 'Seeded', 5 FROM category WHERE event_id = $1",
        [event],
      );
    }
  }
  // One real completion and its points on each side, made by the completion engine itself (migration 0012).
  for (const [player, event] of [
    [f.playerA, f.eventA],
    [f.playerB, f.eventB],
  ] as const) {
    await db.owner.query("BEGIN");
    await db.owner.query("SELECT set_config('app.player_id', $1, true)", [player]);
    await db.owner.query(
      "SELECT complete_quest((SELECT id FROM quest WHERE event_id = $1 LIMIT 1), 'qr', 1, NULL, 'seed', NULL)",
      [event],
    );
    await db.owner.query("COMMIT");
  }
  // Rows past their retention, which the sweeps may remove whoever runs them.
  await run(
    "INSERT INTO staff_session (staff_user_id, token_hash, created_at, last_seen_at, revoked_at) VALUES ($1, $2, now() - interval '40 days', now() - interval '40 days', now() - interval '35 days')",
    [staffB, hash()],
  );
  await run(
    "INSERT INTO staff_login_challenge (staff_user_id, token_hash, code_hash, expires_at, created_at) VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '2 days')",
    [staffB, hash(), hash()],
  );
  await run(
    "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at, created_at) VALUES ($1, $2, now() - interval '2 days', now() - interval '2 days')",
    [staffB, hash()],
  );
  await run(
    "INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, 'aged@team.test', 'editor', $2, $3, now() - interval '40 days')",
    [f.orgB, hash(), staffB],
  );
  for (const [email, age] of [
    [SIGNUP_A, "0 seconds"],
    [SIGNUP_B, "0 seconds"],
    [SIGNUP_B, "2 days"],
  ] as const) {
    await run(
      `INSERT INTO staff_signup (token_hash, code_hash, email, organizer_name, accepted_terms, accepted_dpa, accepted_content, expires_at, created_at)
       VALUES ($1, $2, $3, 'Pending Co', '0.1', '0.1', '0.1', now() + interval '10 minutes', now() - interval '${age}')`,
      [hash(), hash(), email],
    );
  }
  return f;
}

const contextFor = (f: Fixtures, seat: Seat): RequestContext =>
  seat === "organizer"
    ? { organizerId: f.orgA, staffUserId: f.staffA }
    : seat === "staff"
      ? { staffUserId: f.staffA }
      : { playerId: f.playerA };

const probes = Object.entries(OWNED).flatMap(([table, owned]) =>
  owned.probes.map((probe) => [table, probe.seat, probe] as const),
);

describe.skipIf(TEST_DATABASE_URL === undefined)("cross-tenant isolation (database)", () => {
  let db: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedFixtures(db);
  });
  afterAll(async () => {
    await db.close();
  });

  const asA = <T extends Record<string, unknown>>(seat: Seat, sql: string, values: unknown[]) =>
    withRequestContext(db.app, contextFor(f, seat), async () => db.app.query<T>(sql, values));

  const count = async (seat: Seat | "owner", sql: string, values: unknown[]): Promise<number> => {
    const query = `SELECT count(*)::int AS n FROM ${sql}`;
    const result =
      seat === "owner"
        ? await db.owner.query<{ n: number }>(query, values)
        : await asA<{ n: number }>(seat, query, values);
    return result.rows[0]?.n ?? -1;
  };

  it("classifies every table as owned (tested here) or shared (with a reason)", async () => {
    const { rows } = await db.owner.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
    );
    expect(rows.map((row) => row.name)).toEqual(
      [...Object.keys(OWNED), ...Object.keys(SHARED)].toSorted(),
    );
  });

  describe.each(probes)("%s, from the %s seat", (table, _seat, spec) => {
    const theirs = () => spec.theirs(f);
    const where = `${table} WHERE ${spec.column} = $1`;

    it("has rows of both sides to test against", async () => {
      expect(await count("owner", where, [spec.mine(f)])).toBeGreaterThan(0);
      expect(await count("owner", where, [theirs()])).toBeGreaterThan(0);
      if (spec.ownRowsHidden === undefined) {
        expect(await count(spec.seat, where, [spec.mine(f)])).toBeGreaterThan(0);
      }
    });

    it("shows A none of B's rows, apart from what is public by design", async () => {
      const open = spec.publicRows?.(f);
      const expected =
        open === undefined
          ? 0
          : await count("owner", `${where} AND (${open.sql})`, [theirs(), ...open.values]);
      expect(await count(spec.seat, where, [theirs()])).toBe(expected);
    });

    it("lets A change none of B's rows it can see, through any column it may update", async () => {
      for (const column of await updatableColumns(db, table)) {
        const result = await asA(
          spec.seat,
          `UPDATE ${table} SET "${column}" = "${column}" WHERE ${spec.column} = $1`,
          [theirs()],
        );
        expect(result.rowCount, `${table}.${column}`).toBe(0);
      }
    });

    it("refuses A writing a row in B's name", async () => {
      const forged = spec.forge(f);
      await expect(asA(spec.seat, forged.sql, forged.values)).rejects.toThrow(
        spec.forgeRefusedBy ?? POLICY,
      );
    });
  });

  describe.each(probes)("%s, bare writes from an empty-handed %s seat", (table, seat) => {
    // No WHERE and no column read, so the read rule does not narrow the rows: only the update and delete rules do.
    it("reaches no row through any column it may update", async () => {
      for (const column of await updatableColumns(db, table)) {
        const value = await sampleValue(db, table, column);
        const sql = `UPDATE ${table} SET "${column}" = $1`;
        expect(await reached(db, emptyHanded(seat), sql, [value]), column).toBe(0);
      }
    });

    it("deletes nothing, or only rows past their retention", async () => {
      const sweep = OWNED[table]?.sweep;
      const expected =
        sweep === undefined ? 0 : await count("owner", `${table} WHERE ${sweep("")}`, []);
      if (sweep !== undefined) {
        expect(expected, "an aged row is seeded to test the sweep boundary").toBeGreaterThan(0);
      }
      if (await mayDelete(db, table)) {
        expect(await reached(db, emptyHanded(seat), `DELETE FROM ${table}`)).toBe(expected);
      } else {
        await expect(touched(db, emptyHanded(seat), `DELETE FROM ${table}`)).rejects.toThrow(
          /permission denied/,
        );
      }
    });
  });
});

/**
 * Bare writes from A's real seats. A real member can be widened by a rule that the empty-handed seat never meets
 * (for example an owner check on the caller's organizer instead of the row's), and A's own rows make the row count
 * useless. So this database gets test-only detector triggers: for the API's role, touching one of B's rows (outside a
 * retention sweep) raises, and every other row is skipped so no guard of A's own rows can hide it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("cross-tenant isolation (real seats)", () => {
  const DETECTED = "cross-tenant detector";
  let db: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    db = await createTestDatabase();
    f = await seedFixtures(db);
    await db.owner.query(`
      CREATE FUNCTION test_detect_reach() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION '${DETECTED}: % reached a row of B', TG_TABLE_NAME;
      END $$;
      CREATE FUNCTION test_skip_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RETURN NULL;
      END $$;`);
    for (const [table, owned] of Object.entries(OWNED)) {
      for (const [index, probe] of owned.probes.entries()) {
        const sweep = owned.sweep === undefined ? "" : ` AND NOT (${owned.sweep("OLD.")})`;
        // Trigger names sort first ("a0", "a1"), so they run before the table's own guards.
        await db.owner.query(
          `CREATE TRIGGER a0_detect_${index} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW
           WHEN (current_user = 'questify_app' AND OLD.${probe.column}::text = '${probe.theirs(f)}'${sweep})
           EXECUTE FUNCTION test_detect_reach()`,
        );
      }
      await db.owner.query(
        `CREATE TRIGGER a1_skip BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW
         WHEN (current_user = 'questify_app') EXECUTE FUNCTION test_skip_row()`,
      );
    }
  });
  afterAll(async () => {
    await db.close();
  });

  it("has a detector on every owned table, and it fires when a B row is reached", async () => {
    const { rows } = await db.owner.query<{ table: string; n: number }>(
      `SELECT c.relname AS table, count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname LIKE 'a0_detect_%' GROUP BY 1 ORDER BY 1`,
    );
    expect(rows).toEqual(
      Object.entries(OWNED)
        .map(([table, owned]) => ({ table, n: owned.probes.length }))
        .toSorted((a, b) => a.table.localeCompare(b.table)),
    );
    // A Questify admin may remove any team member, so this reaches B's row on purpose.
    await expect(
      touched(db, { isAdmin: true }, "DELETE FROM organizer_member WHERE organizer_id = $1", [
        f.orgB,
      ]),
    ).rejects.toThrow(new RegExp(DETECTED));
  });

  describe.each(probes)("%s, bare writes from A's %s seat", (table, seat) => {
    it("touches none of B's rows through any column it may update", async () => {
      for (const column of await updatableColumns(db, table)) {
        const value = await sampleValue(db, table, column);
        const sql = `UPDATE ${table} SET "${column}" = $1`;
        expect(await reached(db, contextFor(f, seat), sql, [value]), column).toBe(0);
      }
    });

    it("deletes none of B's rows", async () => {
      expect(await reached(db, contextFor(f, seat), `DELETE FROM ${table}`)).toBe(0);
    });
  });
});
