import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Opened = { ticket_id: string; status: string; replayed: boolean };

const codeOf = (result: PromiseSettledResult<unknown>) =>
  result.status === "rejected"
    ? `${(result.reason as { code?: string }).code}:${(result.reason as { detail?: string }).detail ?? ""}`
    : "ok";

const signal = () => {
  const settles: (() => void)[] = [];
  const promise = new Promise<void>((settle) => {
    settles.push(settle);
  });
  return { promise, resolve: () => settles.forEach((settle) => settle()) };
};

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return pg.detail === undefined || pg.detail === "" ? `${pg.code}` : `${pg.code}:${pg.detail}`;
  }
};

const idsOf = (rows: Row[]) => rows.map((row) => String(row["id"]));
const sqlState = async (work: Promise<unknown>) => (await refusal(work)).split(":")[0];

const DEVICE = ["1.4.0", "ios", "18.1", "iPhone 15 Pro"] as const;

/**
 * The ticket center in the database (T-312, migration 0061, ADR-255 to ADR-259): routing by kind and the table's
 * CHECKs, Report a player, app problems and suggestions outside an event, escalation by the team, Questify's queue
 * (read, answer, solve, send back, every read audited), who reads what, retention, erasure, and the crossed locks.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("ticket center (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let admin = "";
  let otherAdmin = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 8 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    const made = await db.owner.query<{ id: string }>(
      `INSERT INTO staff_user (email, password_hash, platform_role)
       VALUES ('help@questify.test', 'h', 'admin'), ('second@questify.test', 'h', 'admin') RETURNING id`,
    );
    admin = made.rows[0]?.id ?? "";
    otherAdmin = made.rows[1]?.id ?? "";
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
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
  const team = (staff = ownerA): RequestContext => ({ organizerId: ids.orgA, staffUserId: staff });
  const adminSeat = (who = admin): RequestContext => ({ isAdmin: true, staffUserId: who });

  const newEvent = async (options: { status?: string; endsIn?: string } = {}) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Center Fest', $3, least(now() - interval '2 hours', now() + $4::interval - interval '1 hour'),
               now() + $4::interval) RETURNING id`,
      [ids.orgA, `CNTR${counter}`, options.status ?? "live", options.endsIn ?? "1 day"],
    );
    return event?.id ?? "";
  };
  const newPlayer = async () => {
    counter += 1;
    const [player] = await owner<{ id: string; username: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id, username",
      [`center_player_${counter}`],
    );
    return { id: player?.id ?? "", username: player?.username ?? "" };
  };
  const member = async (event: string, status = "active") => {
    const player = await newPlayer();
    const [made] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via, status)
       VALUES ($1, $2, $3, 'code', $4) RETURNING id`,
      [ids.orgA, event, player.id, status],
    );
    return { player: player.id, username: player.username, enrollment: made?.id ?? "" };
  };
  const operator = async (event: string) => {
    const player = await newPlayer();
    await owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{help_desk}')",
      [ids.orgA, event, player.id],
    );
    return player.id;
  };
  const open = async (
    player: string,
    event: string,
    options: { kind?: string; username?: string | null; quest?: string | null; key?: string } = {},
  ) =>
    (
      await query<Opened>(
        { playerId: player },
        "SELECT * FROM open_ticket($1, $2, $3, $4, 'Please look', $5)",
        [
          event,
          options.kind ?? "question",
          options.quest ?? null,
          options.username ?? null,
          options.key ?? randomUUID(),
        ],
      )
    )[0] as Opened;
  const platform = async (
    player: string,
    options: {
      kind?: string;
      device?: readonly (string | null)[];
      key?: string;
      body?: string;
    } = {},
  ) =>
    (
      await query<Opened>(
        { playerId: player },
        "SELECT * FROM open_platform_ticket($1, $2, $3, $4, $5, $6, $7)",
        [
          options.kind ?? "app_problem",
          options.body ?? "The map is blank",
          ...(options.device ?? DEVICE),
          options.key ?? randomUUID(),
        ],
      )
    )[0] as Opened;
  const escalate = async (
    event: string,
    ticket: string,
    note = "We tried a restart",
    staff = ownerA,
  ) =>
    (
      await query<Row>(team(staff), "SELECT * FROM staff_escalate_ticket($1, $2, $3, $4)", [
        event,
        ticket,
        note,
        randomUUID(),
      ])
    )[0];
  const adminAnswer = async (
    ticket: string,
    reply: string | null = "Fixed in 1.4.1",
    key = randomUUID(),
    who = admin,
  ) =>
    (
      await query<Row>(adminSeat(who), "SELECT * FROM admin_answer_ticket($1, $2, $3, $4)", [
        ticket,
        reply,
        key,
        randomUUID(),
      ])
    )[0];
  const sendBack = async (ticket: string, note = "This is about your venue", who = admin) =>
    (
      await query<Row>(adminSeat(who), "SELECT * FROM admin_return_ticket($1, $2, $3)", [
        ticket,
        note,
        randomUUID(),
      ])
    )[0];
  const staffAnswer = (event: string, ticket: string) =>
    query<Row>(team(), "SELECT * FROM staff_answer_ticket($1, $2, 'Hi', $3, NULL)", [
      event,
      ticket,
      randomUUID(),
    ]);
  const opAnswer = (op: string, event: string, ticket: string) =>
    query<Row>({ playerId: op }, "SELECT * FROM operator_answer_ticket($1, $2, 'Hi', $3)", [
      event,
      ticket,
      randomUUID(),
    ]);
  const queue = (wanted = "open", kind: string | null = null, source: string | null = null) =>
    query<Row>(adminSeat(), "SELECT * FROM console_tickets($1, $2, $3, NULL, 100, $4)", [
      wanted,
      kind,
      source,
      randomUUID(),
    ]);
  const consoleOne = (ticket: string, who = admin) =>
    query<Row>(adminSeat(who), "SELECT * FROM console_ticket($1, $2)", [ticket, randomUUID()]);
  const teamTab = (event: string, wanted: string) =>
    query<Row>(team(), "SELECT * FROM event_tickets($1, $2, NULL, NULL, 100)", [event, wanted]);
  const consolePage = (wanted: string, cursor: string | null) =>
    query<Row>(
      adminSeat(),
      "SELECT * FROM console_tickets($1, 'app_problem', 'direct', $2, 2, NULL)",
      [wanted, cursor],
    );
  const ticketRow = async (ticket: string) =>
    (await owner<Row>("SELECT * FROM ticket WHERE id = $1", [ticket]))[0];
  const seesOperator = async (op: string, event: string, ticket: string) => {
    const inbox = await query<Row>(
      { playerId: op },
      "SELECT * FROM operator_inbox($1, NULL, NULL, NULL, 100)",
      [event],
    );
    const [count] = await query<{ tickets: number }>(
      { playerId: op },
      "SELECT * FROM operator_inbox_count($1)",
      [event],
    );
    const one = await refusal(
      query({ playerId: op }, "SELECT * FROM operator_ticket($1, $2)", [event, ticket]),
    );
    return { listed: idsOf(inbox).includes(ticket), count: count?.tickets ?? 0, one };
  };
  const lockWait = async (): Promise<void> => {
    for (let tries = 0; tries < 250; tries += 1) {
      const [row] = await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if ((row?.n ?? 0) > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No session waited on a lock.");
  };
  /** Runs `first` in a transaction and holds it open until `second` waits on a lock, then commits it. */
  const crossed = async (
    first: [RequestContext, string, unknown[]],
    second: () => Promise<unknown>,
  ): Promise<[PromiseSettledResult<unknown>, PromiseSettledResult<unknown>]> => {
    const client = await pool.connect();
    const gate = signal();
    const started = signal();
    const held = withRequestContext(client, first[0], async () => {
      const rows = (await client.query(first[1], first[2])).rows;
      started.resolve();
      await gate.promise;
      return rows;
    }).finally(() => client.release());
    await started.promise;
    const waiting = second();
    await lockWait();
    gate.resolve();
    const settled = await Promise.allSettled([held, waiting]);
    return [
      settled[0] as PromiseSettledResult<unknown>,
      settled[1] as PromiseSettledResult<unknown>,
    ];
  };

  describe("routing", () => {
    it("routes each kind to its queue: the event team's four with the event, Questify's two without", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const rows = [
        await open(sender.player, event),
        await open(sender.player, event, { kind: "problem" }),
        await open(sender.player, event, { kind: "prize" }),
      ];
      await owner(
        "UPDATE ticket SET status = 'closed', outcome = 'solved', answered_by_staff = $2, answer_key = 'x' || id, closed_at = now() WHERE id = ANY ($1)",
        [idsOf(rows.map((row) => ({ id: row.ticket_id }))), ownerA],
      );
      const report = await open(sender.player, event, {
        kind: "report_player",
        username: target.username,
      });
      for (const made of [...rows, report]) {
        expect(await ticketRow(made.ticket_id)).toMatchObject({ queue: "event", event_id: event });
      }
      expect(await ticketRow(report.ticket_id)).toMatchObject({
        kind: "report_player",
        reported_enrollment_id: target.enrollment,
      });
      for (const kind of ["app_problem", "suggestion"]) {
        const made = await platform(sender.player, { kind });
        expect(await ticketRow(made.ticket_id)).toMatchObject({
          kind,
          queue: "questify",
          event_id: null,
          organizer_id: null,
          enrollment_id: null,
        });
      }
      expect(await refusal(open(sender.player, event, { kind: "app_problem" }))).toBe("HK422");
      expect(await refusal(platform(sender.player, { kind: "question" }))).toBe("HK422");
    });

    it("refuses forged rows by the table's CHECKs and the one-open-report index", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const insert = (columns: string, values: string) =>
        sqlState(
          owner(
            `INSERT INTO ticket (player_id, kind, body, idempotency_key${columns})
             VALUES ($1, $2, 'forged', gen_random_uuid()::text${values})`,
            [sender.player, "question"],
          ),
        );
      const eventCols = `, organizer_id, event_id, enrollment_id`;
      const eventVals = `, '${ids.orgA}', '${event}', '${sender.enrollment}'`;
      // An event kind without its event, and Questify's kinds with one.
      expect(await insert("", "")).toBe("23514");
      expect(
        await sqlState(
          owner(
            `INSERT INTO ticket (player_id, kind, queue, body, idempotency_key, app_version, platform, os_version
                                 ${eventCols})
             VALUES ($1, 'app_problem', 'questify', 'forged', 'k1', '1', 'ios', '1'${eventVals})`,
            [sender.player],
          ),
        ),
      ).toBe("23514");
      // The CTO re-review's case: in Questify's queue with no escalation at all.
      expect(await insert(`, queue${eventCols}`, `, 'questify'${eventVals}`)).toBe("23514");
      // In Questify's queue while the latest hop is a return.
      expect(
        await insert(
          `, queue, escalated_at, escalated_by_staff, escalation_note, returned_at, returned_by_admin, return_note${eventCols}`,
          `, 'questify', now() - interval '2 hours', '${ownerA}', 'n', now() - interval '1 hour', '${admin}', 'r'${eventVals}`,
        ),
      ).toBe("23514");
      // Back in the event queue, a return older than the escalation (the re-review's nit).
      expect(
        await insert(
          `, escalated_at, escalated_by_staff, escalation_note, returned_at, returned_by_admin, return_note${eventCols}`,
          `, now() - interval '1 hour', '${ownerA}', 'n', now() - interval '2 hours', '${admin}', 'r'${eventVals}`,
        ),
      ).toBe("23514");
      // A return with no escalation, and Questify answering in the event queue.
      expect(
        await insert(
          `, returned_at, returned_by_admin, return_note${eventCols}`,
          `, now(), '${admin}', 'r'${eventVals}`,
        ),
      ).toBe("23514");
      expect(
        await insert(
          `, status, outcome, answered_by_admin, answer_key, closed_at${eventCols}`,
          `, 'closed', 'solved', '${admin}', 'k', now()${eventVals}`,
        ),
      ).toBe("23514");
      // Device facts on a question, and an app problem without them.
      expect(
        await insert(
          `, app_version, platform, os_version${eventCols}`,
          `, '1', 'ios', '1'${eventVals}`,
        ),
      ).toBe("23514");
      expect(
        await sqlState(
          owner(
            "INSERT INTO ticket (player_id, kind, queue, body, idempotency_key) VALUES ($1, 'app_problem', 'questify', 'x', 'k2')",
            [sender.player],
          ),
        ),
      ).toBe("23514");
      // A second open report of the same member by the same sender.
      await open(sender.player, event, { kind: "report_player", username: target.username });
      expect(
        await sqlState(
          owner(
            `INSERT INTO ticket (player_id, kind, body, idempotency_key, reported_enrollment_id${eventCols})
             VALUES ($1, 'report_player', 'again', 'k3', $2${eventVals})`,
            [sender.player, target.enrollment],
          ),
        ),
      ).toBe("23505");
      // An escalated ticket is the shape the escalation door writes.
      expect(
        await insert(
          `, queue, escalated_at, escalated_by_staff, escalation_note${eventCols}`,
          `, 'questify', now(), '${ownerA}', 'n'${eventVals}`,
        ),
      ).toBe("none");
    });

    it("hides reports from operators by list, count, id and answer; a prize problem reaches them", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const op = await operator(event);
      const report = await open(sender.player, event, {
        kind: "report_player",
        username: target.username,
      });
      const prize = await open(sender.player, event, { kind: "prize" });
      expect(await seesOperator(op, event, report.ticket_id)).toEqual({
        listed: false,
        count: 1,
        one: "HT404",
      });
      expect(await refusal(opAnswer(op, event, report.ticket_id))).toBe("HT404");
      expect(await seesOperator(op, event, prize.ticket_id)).toMatchObject({
        listed: true,
        one: "none",
      });
      expect(await opAnswer(op, event, prize.ticket_id)).toHaveLength(1);
      expect(await staffAnswer(event, report.ticket_id)).toHaveLength(1);
    });
  });

  describe("report a player", () => {
    it("names an active member of this event only, never oneself, once while open, folded", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const outside = await member(other);
      const pending = await member(event, "pending");
      const removed = await member(event, "removed");
      const report = (username: string | null, extra: { quest?: string; key?: string } = {}) =>
        open(sender.player, event, { kind: "report_player", username, ...extra });
      for (const name of ["nobody_here", outside.username, pending.username, removed.username]) {
        expect(await refusal(report(name)), name).toBe("HR404:unknown_player");
      }
      const gone = await member(event);
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [gone.player]);
      expect(await refusal(report(gone.username))).toBe("HR404:unknown_player");
      expect(await refusal(report(sender.username))).toBe("HR403:self_report");
      expect(await refusal(report(null))).toBe("HR422:username_required");
      expect(
        await refusal(open(sender.player, event, { kind: "question", username: target.username })),
      ).toBe("HR422:username_unexpected");
      const [category] = await owner<{ id: string }>(
        "INSERT INTO category (event_id, name_en) VALUES ($1, 'G') RETURNING id",
        [event],
      );
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
         VALUES ($1, $2, 'enter_code', 'Q', 10, '{"code": "ABCD"}') RETURNING id`,
        [event, category?.id],
      );
      expect(await refusal(report(target.username, { quest: quest?.id ?? "" }))).toBe("HQ422");
      const key = randomUUID();
      const first = await report(target.username.toUpperCase(), { key });
      expect(await ticketRow(first.ticket_id)).toMatchObject({
        reported_enrollment_id: target.enrollment,
      });
      expect(await report(target.username, { key })).toMatchObject({
        ticket_id: first.ticket_id,
        replayed: true,
      });
      const third = await member(event);
      expect(await refusal(report(third.username, { key }))).toBe("QK422");
      expect(await refusal(report(target.username))).toBe("HT409:already_reported");
      await staffAnswer(event, first.ticket_id);
      expect(await report(target.username)).toMatchObject({ status: "open", replayed: false });
    });
  });

  describe("sending outside an event", () => {
    it("needs no enrollment; checks the device facts of an app problem; a suggestion keeps none", async () => {
      const { id: player } = await newPlayer();
      const made = await platform(player, { device: ["1.4.0", "android", "14", null] });
      expect(await ticketRow(made.ticket_id)).toMatchObject({
        app_version: "1.4.0",
        platform: "android",
        os_version: "14",
        device_model: null,
      });
      const cases: [readonly (string | null)[], string][] = [
        [[null, "ios", "18", null], "HD422:app_version"],
        [["1.4 beta", "ios", "18", null], "HD422:app_version"],
        [["x".repeat(33), "ios", "18", null], "HD422:app_version"],
        [["1.4.0", null, "18", null], "HD422:platform"],
        [["1.4.0", "windows", "18", null], "HD422:platform"],
        [["1.4.0", "ios", null, null], "HD422:os_version"],
        [["1.4.0", "ios", "18;1", null], "HD422:os_version"],
        [["1.4.0", "ios", "18", "x".repeat(65)], "HD422:device_model"],
        [["1.4.0", "ios", "18", "   "], "HD422:device_model"],
        [["1.4.0", "ios", "18", "Pixel\u0007"], "HD422:device_model"],
        [["1.4.0", "ios", "18", "Pixel‮8"], "HD422:device_model"],
      ];
      for (const [device, expected] of cases) {
        expect(await refusal(platform(player, { device })), JSON.stringify(device)).toBe(expected);
      }
      expect(await refusal(platform(player, { body: " " }))).toBe("SV422:empty");
      const spaced = await platform(player, {
        device: ["1.4.0", "ios", "18.1", "  iPhone 15 Pro "],
      });
      expect((await ticketRow(spaced.ticket_id))?.["device_model"]).toBe("iPhone 15 Pro");
      const idea = await platform(player, { kind: "suggestion" });
      expect(await ticketRow(idea.ticket_id)).toMatchObject({
        app_version: null,
        platform: null,
        os_version: null,
        device_model: null,
      });
    });

    it("holds 3 open and 5 a day; replays a key; refuses an account that is not active", async () => {
      const { id: player } = await newPlayer();
      const key = randomUUID();
      const first = await platform(player, { key });
      await platform(player, { kind: "suggestion" });
      await platform(player);
      expect(await platform(player, { key })).toMatchObject({
        ticket_id: first.ticket_id,
        replayed: true,
      });
      expect(await refusal(platform(player, { key, kind: "suggestion" }))).toBe("QK422");
      expect(await refusal(platform(player))).toBe("HT409:too_many_open");
      await owner(
        "UPDATE ticket SET status = 'closed', outcome = 'solved', answered_by_admin = $2, answer_key = 'x' || id, closed_at = now() WHERE player_id = $1",
        [player, admin],
      );
      await platform(player);
      await platform(player);
      const refused = await refusal(platform(player));
      expect(refused).toMatch(/^HT429:\d+$/);
      expect(Number(refused.split(":")[1])).toBeGreaterThan(23 * 3600);
      const event = await newEvent();
      const busy = await member(event);
      for (let made = 0; made < 3; made += 1) {
        await open(busy.player, event);
      }
      expect(await platform(busy.player)).toMatchObject({ status: "open" });
      for (const status of ["banned", "deleted"]) {
        const { id: closed } = await newPlayer();
        await owner(
          "UPDATE player SET status = $2, deleted_at = CASE WHEN $2 = 'deleted' THEN now() END, username = CASE WHEN $2 = 'deleted' THEN NULL ELSE username END WHERE id = $1",
          [closed, status],
        );
        expect(await refusal(platform(closed)), status).toBe("HT403:not_member");
      }
      expect(
        await refusal(
          query(
            {},
            "SELECT * FROM open_platform_ticket('suggestion', 'x', NULL, NULL, NULL, NULL, 'k')",
          ),
        ),
      ).toBe("42501");
    });
  });

  describe("escalation", () => {
    it("lets owners and editors in scope escalate with a note; the ticket leaves operators and answer doors", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const sender = await member(event);
      const op = await operator(event);
      const asked = await open(sender.player, event);
      const editor = await addMember(db.owner, ids.orgA, "editor", [event]);
      const outsider = await addMember(db.owner, ids.orgA, "editor", [other]);
      expect(await refusal(escalate(event, asked.ticket_id, "x", outsider))).toBe("AN404");
      expect(await refusal(escalate(event, asked.ticket_id, "   "))).toBe("SV422:empty");
      expect(
        await refusal(
          query({ playerId: op }, "SELECT * FROM staff_escalate_ticket($1, $2, 'x', NULL)", [
            event,
            asked.ticket_id,
          ]),
        ),
      ).toBe("AN404");
      expect(await seesOperator(op, event, asked.ticket_id)).toMatchObject({
        listed: true,
        count: 1,
      });
      const request = randomUUID();
      const [moved] = await query<Row>(
        team(editor),
        "SELECT * FROM staff_escalate_ticket($1, $2, $3, $4)",
        [event, asked.ticket_id, "  We tried a restart  ", request],
      );
      expect(moved).toEqual({ ticket_id: asked.ticket_id, queue: "questify", replayed: false });
      expect(await escalate(event, asked.ticket_id, "We tried a restart", editor)).toMatchObject({
        replayed: true,
      });
      expect(await refusal(escalate(event, asked.ticket_id, "Another note"))).toBe("HT409:moved");
      expect(await ticketRow(asked.ticket_id)).toMatchObject({
        queue: "questify",
        escalated_by_staff: editor,
        escalation_note: "We tried a restart",
        enrollment_id: sender.enrollment,
      });
      expect(await seesOperator(op, event, asked.ticket_id)).toEqual({
        listed: false,
        count: 0,
        one: "HT404",
      });
      expect(await refusal(opAnswer(op, event, asked.ticket_id))).toBe("HT404");
      // A stale dashboard Reply is told the ticket moved; an operator is told nothing (CTO code review 2).
      expect(await refusal(staffAnswer(event, asked.ticket_id))).toBe("HT409:moved");
      expect(idsOf(await teamTab(event, "open"))).toEqual([]);
      const [shown] = await teamTab(event, "with_questify");
      expect(shown).toMatchObject({
        id: asked.ticket_id,
        queue: "questify",
        escalation_note: "We tried a restart",
        escalated_by: expect.stringMatching(/@team\.test$/),
      });
      expect(
        await owner(
          "SELECT actor_type, action, organizer_id, event_id, after, request_id FROM audit_log WHERE target_type = 'ticket' AND target_id = $1",
          [asked.ticket_id],
        ),
      ).toEqual([
        {
          actor_type: "staff",
          action: "event.ticket_escalated",
          organizer_id: ids.orgA,
          event_id: event,
          after: { queue: "questify" },
          request_id: request,
        },
      ]);
      // It still counts as one of the sender's 3 open in the event.
      await open(sender.player, event);
      await open(sender.player, event);
      expect(await refusal(open(sender.player, event))).toBe("HT409:too_many_open");
    });

    it("refuses a closed ticket, another event's ticket and an archived event", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const closed = await open(sender.player, event);
      await staffAnswer(event, closed.ticket_id);
      expect(await refusal(escalate(event, closed.ticket_id))).toBe("HT409:not_open");
      const other = await newEvent();
      expect(await refusal(escalate(other, closed.ticket_id))).toBe("HT404");
      const waiting = await open(sender.player, event);
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      expect(await refusal(escalate(event, waiting.ticket_id))).toBe("HT409:event_closed");
    });
  });

  describe("the Questify queue", () => {
    it("lists and counts exactly queue = 'questify', audited per event shown with the ids, never text", async () => {
      const before = await query<Row>(adminSeat(), "SELECT * FROM console_ticket_counts()");
      const event = await newEvent();
      const sender = await member(event);
      const kept = await open(sender.player, event);
      const escalated = await open(sender.player, event, { kind: "problem" });
      await escalate(event, escalated.ticket_id);
      const direct = await platform(sender.player, { body: "y".repeat(300) });
      const idea = await platform(sender.player, { kind: "suggestion" });
      const request = randomUUID();
      const rows = await query<Row>(
        adminSeat(),
        "SELECT * FROM console_tickets('open', NULL, NULL, NULL, 100, $1)",
        [request],
      );
      const listed = idsOf(rows);
      expect(listed).toEqual(
        expect.arrayContaining([escalated.ticket_id, direct.ticket_id, idea.ticket_id]),
      );
      expect(listed).not.toContain(kept.ticket_id);
      const all = await owner<{ id: string }>(
        "SELECT id FROM ticket WHERE queue = 'questify' AND status = 'open' ORDER BY id",
      );
      expect(listed).toEqual(all.map((row) => row.id));
      const mine = rows.find((row) => row["id"] === direct.ticket_id);
      expect(mine).toMatchObject({
        preview: "y".repeat(120),
        username: sender.username,
        event_id: null,
        app_version: "1.4.0",
        device_model: "iPhone 15 Pro",
      });
      expect(Object.keys(mine ?? {})).not.toContain("avatar");
      expect(Object.keys(mine ?? {})).not.toContain("body");
      expect(rows.find((row) => row["id"] === escalated.ticket_id)).toMatchObject({
        organizer_name: "Najd Events",
        event_name_en: "Center Fest",
        escalated_by: expect.stringMatching(/@team\.test$/),
      });
      const audit = await owner<Row>(
        "SELECT actor_type, actor_id, organizer_id, event_id, after FROM audit_log WHERE action = 'console.tickets_read' AND request_id = $1 ORDER BY organizer_id NULLS FIRST",
        [request],
      );
      const byEvent = new Map<unknown, string[]>();
      for (const row of rows) {
        const list = byEvent.get(row["event_id"]) ?? [];
        list.push(String(row["id"]));
        byEvent.set(row["event_id"], list);
      }
      expect(audit).toHaveLength(byEvent.size);
      for (const row of audit) {
        expect(row).toMatchObject({ actor_type: "admin", actor_id: admin });
        expect(row["after"]).toEqual({
          status: "open",
          ids: [...(byEvent.get(row["event_id"]) ?? [])].toSorted((a, b) => Number(a) - Number(b)),
        });
      }
      expect(audit[0]).toMatchObject({ organizer_id: null, event_id: null });
      expect(JSON.stringify(audit)).not.toContain("Please look");
      expect(idsOf(await queue("open", null, "direct"))).not.toContain(escalated.ticket_id);
      expect(idsOf(await queue("open", null, "escalated"))).toEqual(
        expect.arrayContaining([escalated.ticket_id]),
      );
      expect(idsOf(await queue("open", "suggestion"))).toContain(idea.ticket_id);
      expect(idsOf(await queue("open", "suggestion"))).not.toContain(direct.ticket_id);
      expect(await queue("bogus")).toEqual([]);
      expect(await queue("open", null, "bogus")).toEqual([]);
      const [counts] = await query<Row>(adminSeat(), "SELECT * FROM console_ticket_counts()");
      expect(Number(counts?.["open"]) - Number(before[0]?.["open"])).toBe(3);
      expect(Number(counts?.["open_escalated"]) - Number(before[0]?.["open_escalated"])).toBe(1);
      const [detail] = await consoleOne(escalated.ticket_id);
      expect(detail).toMatchObject({ body: "Please look", escalation_note: "We tried a restart" });
      expect(
        await owner(
          "SELECT organizer_id, event_id FROM audit_log WHERE action = 'console.ticket_read' AND target_id = $1",
          [escalated.ticket_id],
        ),
      ).toEqual([{ organizer_id: ids.orgA, event_id: event }]);
      expect(await refusal(consoleOne(kept.ticket_id))).toBe("HT404");
      expect(await refusal(consoleOne("999999999"))).toBe("HT404");
    });

    it("pages keyset by id: open oldest first, closed newest first", async () => {
      const { id: player } = await newPlayer();
      const made = [await platform(player), await platform(player), await platform(player)];
      const first = idsOf(await consolePage("open", null));
      expect(first).toHaveLength(2);
      expect(Number(first[0])).toBeLessThan(Number(first[1]));
      const rest = idsOf(await consolePage("open", first[1] ?? null));
      expect(Number(rest[0])).toBeGreaterThan(Number(first[1]));
      for (const ticket of made) {
        await adminAnswer(ticket.ticket_id, null);
      }
      const closed = idsOf(await consolePage("closed", null));
      expect(Number(closed[0])).toBeGreaterThan(Number(closed[1]));
      const older = idsOf(await consolePage("closed", closed[1] ?? null));
      expect(Number(older[0])).toBeLessThan(Number(closed[1]));
    });

    it("answers and solves in its queue; the player and the team see the Questify team, never an admin", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const asked = await open(sender.player, event);
      await escalate(event, asked.ticket_id);
      const key = randomUUID();
      expect(await adminAnswer(asked.ticket_id, "  We fixed it  ", key)).toEqual({
        ticket_id: asked.ticket_id,
        outcome: "answered",
        replayed: false,
      });
      expect(await adminAnswer(asked.ticket_id, "We fixed it", key)).toMatchObject({
        replayed: true,
      });
      expect(await refusal(adminAnswer(asked.ticket_id, null, key))).toBe("QK422");
      expect(await refusal(adminAnswer(asked.ticket_id, "Again", randomUUID(), otherAdmin))).toBe(
        "HT409:already_closed",
      );
      const direct = await platform(sender.player);
      expect(await refusal(adminAnswer(direct.ticket_id, "x", key))).toBe("QK422");
      expect(await adminAnswer(direct.ticket_id, null)).toMatchObject({ outcome: "solved" });
      expect(await refusal(adminAnswer(direct.ticket_id, "   ", randomUUID()))).toBe(
        "HT409:already_closed",
      );
      const another = await platform(sender.player);
      expect(await refusal(adminAnswer(another.ticket_id, "  "))).toBe("SV422:empty");
      const own = await query<Row>({ playerId: sender.player }, "SELECT * FROM own_tickets(NULL)");
      expect(own.find((row) => row["id"] === asked.ticket_id)).toMatchObject({
        answered_by_team: "questify",
        with_questify: false,
        reply: "We fixed it",
      });
      expect(own.find((row) => row["id"] === direct.ticket_id)).toMatchObject({
        event_id: null,
        answered_by_team: "questify",
        outcome: "solved",
      });
      expect(JSON.stringify(own)).not.toMatch(/questify\.test|escalation|We tried/);
      const [closed] = await teamTab(event, "closed");
      expect(closed).toMatchObject({ answered_by: "admin", answerer: null, reply: "We fixed it" });
      expect(JSON.stringify(closed)).not.toContain("questify.test");
      expect(
        await owner(
          "SELECT actor_type, action, organizer_id, event_id, after FROM audit_log WHERE target_type = 'ticket' AND target_id = ANY ($1) AND action LIKE 'console.ticket_%' AND action <> 'console.ticket_read' ORDER BY id",
          [[asked.ticket_id, direct.ticket_id]],
        ),
      ).toEqual([
        {
          actor_type: "admin",
          action: "console.ticket_answered",
          organizer_id: ids.orgA,
          event_id: event,
          after: { outcome: "answered" },
        },
        {
          actor_type: "admin",
          action: "console.ticket_solved",
          organizer_id: null,
          event_id: null,
          after: { outcome: "solved" },
        },
      ]);
    });

    it("sends an escalated ticket back with a note; it leaves the console and rejoins operators", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const op = await operator(event);
      const asked = await open(sender.player, event);
      expect(await refusal(sendBack(asked.ticket_id))).toBe("HT404");
      expect(await refusal(adminAnswer(asked.ticket_id))).toBe("HT404");
      await escalate(event, asked.ticket_id);
      expect(await refusal(sendBack(asked.ticket_id, "  "))).toBe("SV422:empty");
      const direct = await platform(sender.player);
      expect(await refusal(sendBack(direct.ticket_id))).toBe("HT409:not_escalated");
      expect(await sendBack(asked.ticket_id, " Ask the venue ")).toEqual({
        ticket_id: asked.ticket_id,
        queue: "event",
        replayed: false,
      });
      expect(await sendBack(asked.ticket_id, "Ask the venue")).toMatchObject({ replayed: true });
      expect(await refusal(sendBack(asked.ticket_id, "Other"))).toBe("HT409:moved");
      expect(await refusal(adminAnswer(asked.ticket_id))).toBe("HT409:moved");
      expect(idsOf(await queue("open"))).not.toContain(asked.ticket_id);
      expect(await refusal(consoleOne(asked.ticket_id))).toBe("HT404");
      expect(await seesOperator(op, event, asked.ticket_id)).toEqual({
        listed: true,
        count: 1,
        one: "none",
      });
      const operatorRead = await query<Row>(
        { playerId: op },
        "SELECT * FROM operator_ticket($1, $2)",
        [event, asked.ticket_id],
      );
      const inboxRead = await query<Row>(
        { playerId: op },
        "SELECT * FROM operator_inbox($1, NULL, NULL, NULL, 100)",
        [event],
      );
      expect(JSON.stringify([operatorRead, inboxRead])).not.toMatch(/Ask the venue|We tried/);
      const [back] = await teamTab(event, "open");
      expect(back).toMatchObject({ id: asked.ticket_id, return_note: "Ask the venue" });
      await escalate(event, asked.ticket_id, "Second try");
      expect(await ticketRow(asked.ticket_id)).toMatchObject({
        queue: "questify",
        escalation_note: "Second try",
        return_note: "Ask the venue",
      });
      expect(await adminAnswer(asked.ticket_id)).toMatchObject({ outcome: "answered" });
      expect(
        (
          await owner<{ action: string }>(
            "SELECT action FROM audit_log WHERE target_type = 'ticket' AND target_id = $1 AND action <> 'console.ticket_read' ORDER BY id",
            [asked.ticket_id],
          )
        ).map((row) => row.action),
      ).toEqual([
        "event.ticket_escalated",
        "console.ticket_returned",
        "event.ticket_escalated",
        "console.ticket_answered",
      ]);
    });

    it("answers an archived event's escalated ticket but cannot send it back", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const one = await open(sender.player, event);
      const two = await open(sender.player, event);
      await escalate(event, one.ticket_id);
      await escalate(event, two.ticket_id);
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      expect(await refusal(sendBack(one.ticket_id))).toBe("HT409:event_closed");
      expect(await adminAnswer(two.ticket_id)).toMatchObject({ outcome: "answered" });
    });

    it("opens nothing on the request flag alone: no admin role, a disabled admin, or no flag", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const asked = await platform(sender.player);
      const [plain] = await owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash) VALUES ('plain@team.test', 'h') RETURNING id",
      );
      const [disabled] = await owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
      );
      const seats: RequestContext[] = [
        adminSeat(plain?.id),
        adminSeat(disabled?.id),
        { staffUserId: admin },
        { isAdmin: true },
        team(),
        { playerId: sender.player },
      ];
      for (const seat of seats) {
        for (const sql of [
          "SELECT * FROM console_tickets('open', NULL, NULL, NULL, 10, NULL)",
          "SELECT * FROM console_ticket_counts()",
          `SELECT * FROM console_ticket(${asked.ticket_id}, NULL)`,
          `SELECT * FROM admin_answer_ticket(${asked.ticket_id}, 'x', 'k', NULL)`,
          `SELECT * FROM admin_return_ticket(${asked.ticket_id}, 'x', NULL)`,
        ]) {
          expect(await refusal(query(seat, sql)), `${JSON.stringify(seat)} ${sql}`).toBe("42501");
        }
      }
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'console.ticket%' AND actor_id = ANY ($1)",
          [[plain?.id, disabled?.id]],
        ),
      ).toEqual([{ n: 0 }]);
    });

    it("keeps an escalated report hidden from operators after a send-back, notes included", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const op = await operator(event);
      const report = await open(sender.player, event, {
        kind: "report_player",
        username: target.username,
      });
      await escalate(event, report.ticket_id);
      const [seen] = await consoleOne(report.ticket_id);
      expect(seen).toMatchObject({ reported_username: target.username });
      await sendBack(report.ticket_id);
      expect(await seesOperator(op, event, report.ticket_id)).toEqual({
        listed: false,
        count: 0,
        one: "HT404",
      });
      expect(await refusal(opAnswer(op, event, report.ticket_id))).toBe("HT404");
    });
  });

  describe("cross-tenant and the platform admin", () => {
    it("gives an admin no event-queue ticket of any organizer, by list, count or id, and none after a send-back", async () => {
      const ownerB = await addMember(db.owner, ids.orgB, "owner");
      const teamB: RequestContext = { organizerId: ids.orgB, staffUserId: ownerB };
      const seedB = async (body: string) => {
        const [made] = await owner<{ id: string }>(
          `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
           SELECT n.player_id, n.organizer_id, n.event_id, n.id, 'question', $2, gen_random_uuid()::text
           FROM enrollment n WHERE n.event_id = $1 LIMIT 1 RETURNING id`,
          [ids.eventB, body],
        );
        return made?.id ?? "";
      };
      const openB = await seedB("B open");
      const closedB = await seedB("B closed");
      await query(teamB, "SELECT * FROM staff_answer_ticket($1, $2, 'ok', 'kb', NULL)", [
        ids.eventB,
        closedB,
      ]);
      const escalatedB = await seedB("B escalated");
      await query(teamB, "SELECT * FROM staff_escalate_ticket($1, $2, 'B tried', NULL)", [
        ids.eventB,
        escalatedB,
      ]);
      const returnedB = await seedB("B returned");
      await query(teamB, "SELECT * FROM staff_escalate_ticket($1, $2, 'B tried', NULL)", [
        ids.eventB,
        returnedB,
      ]);
      await sendBack(returnedB);
      const event = await newEvent();
      const sender = await member(event);
      const openA = await open(sender.player, event);
      const listed = [...idsOf(await queue("open")), ...idsOf(await queue("closed"))];
      expect(listed).toContain(escalatedB);
      for (const hidden of [openB, closedB, returnedB, openA.ticket_id]) {
        expect(listed, hidden).not.toContain(hidden);
        expect(await refusal(consoleOne(hidden)), hidden).toBe("HT404");
      }
      const [counts] = await query<Row>(adminSeat(), "SELECT * FROM console_ticket_counts()");
      const [real] = await owner<Row>(
        "SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'closed')::int AS closed FROM ticket WHERE queue = 'questify'",
      );
      expect({ open: counts?.["open"], closed: counts?.["closed"] }).toEqual(real);
      expect(JSON.stringify(await queue("open"))).not.toMatch(/B open|B closed|B returned/);
    });

    it("keeps an admin who is also a member of A to A's doors in the dashboard; B's team doors stay shut", async () => {
      const [both] = await owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('both@questify.test', 'h', 'admin') RETURNING id",
      );
      await owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [ids.orgA, both?.id],
      );
      const [escalatedB] = await owner<{ id: string }>(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key, queue,
                             escalated_at, escalated_by_staff, escalation_note)
         SELECT n.player_id, n.organizer_id, n.event_id, n.id, 'question', 'B help', gen_random_uuid()::text,
                'questify', now(), $2, 'n'
         FROM enrollment n WHERE n.event_id = $1 LIMIT 1 RETURNING id`,
        [ids.eventB, both?.id],
      );
      const asAdminInA: RequestContext = {
        organizerId: ids.orgA,
        staffUserId: both?.id ?? "",
        isAdmin: true,
      };
      for (const sql of [
        "SELECT * FROM event_tickets($1, 'with_questify', NULL, NULL, 50)",
        "SELECT * FROM event_ticket_counts($1)",
      ]) {
        expect(await refusal(query(asAdminInA, sql, [ids.eventB])), sql).toBe("AN404");
      }
      expect(
        await refusal(
          query(asAdminInA, "SELECT * FROM staff_escalate_ticket($1, $2, 'x', NULL)", [
            ids.eventB,
            escalatedB?.id,
          ]),
        ),
      ).toBe("AN404");
      expect(await consoleOne(escalatedB?.id ?? "", both?.id)).toHaveLength(1);
      const editorA = await addMember(db.owner, ids.orgA, "editor");
      expect(await refusal(escalate(ids.eventB, escalatedB?.id ?? "", "x", editorA))).toBe("AN404");
      expect(await query({ playerId: ids.playerA }, "SELECT * FROM own_tickets(NULL)")).toEqual([]);
    });
  });

  describe("the player's reads", () => {
    it("shows With the Questify team, the reported name and every queue's unread answers", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const report = await open(sender.player, event, {
        kind: "report_player",
        username: target.username,
      });
      await escalate(event, report.ticket_id);
      const direct = await platform(sender.player);
      const own = await query<Row>({ playerId: sender.player }, "SELECT * FROM own_tickets(NULL)");
      expect(own.find((row) => row["id"] === report.ticket_id)).toMatchObject({
        with_questify: true,
        reported_username: target.username,
        answered_by_team: null,
      });
      expect(own.find((row) => row["id"] === direct.ticket_id)).toMatchObject({
        event_id: null,
        event_name_en: null,
        with_questify: true,
      });
      expect(
        await query<Row>({ playerId: sender.player }, "SELECT * FROM own_tickets($1)", [event]),
      ).toHaveLength(1);
      const unread = async () =>
        (
          await query<{ n: number }>(
            { playerId: sender.player },
            "SELECT own_unread_tickets(NULL) AS n",
          )
        )[0]?.n;
      expect(await unread()).toBe(0);
      await adminAnswer(direct.ticket_id);
      await adminAnswer(report.ticket_id);
      expect(await unread()).toBe(2);
      await query({ playerId: sender.player }, "SELECT mark_tickets_seen(NULL, $1::bigint[])", [
        [direct.ticket_id],
      ]);
      expect(await unread()).toBe(1);
      const reported = await query<Row>(
        { playerId: target.player },
        "SELECT * FROM own_tickets(NULL)",
      );
      expect(reported).toEqual([]);
    });
  });

  describe("lifecycle", () => {
    it("erases event-less and escalated tickets; a report about an erased member keeps a deleted name", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const target = await member(event);
      const escalated = await open(sender.player, event);
      await escalate(event, escalated.ticket_id);
      await platform(sender.player);
      const watcher = await member(event);
      const report = await open(watcher.player, event, {
        kind: "report_player",
        username: sender.username,
      });
      await open(sender.player, event, { kind: "report_player", username: target.username });
      await owner("SELECT erase_rows($1, ARRAY[$2]::uuid[], NULL)", [
        sender.player,
        sender.enrollment,
      ]);
      expect(
        await owner("SELECT count(*)::int AS n FROM ticket WHERE player_id = $1", [sender.player]),
      ).toEqual([{ n: 0 }]);
      const [row] = (await teamTab(event, "open")).filter(
        (item) => item["id"] === report.ticket_id,
      );
      expect(row).toMatchObject({
        reported_enrollment_id: sender.enrollment,
        reported_username: null,
      });
      const own = await query<Row>({ playerId: watcher.player }, "SELECT * FROM own_tickets(NULL)");
      expect(own[0]).toMatchObject({ reported_username: null });
    });

    it("clears a report's link when the rehearsal wipe takes the reported account", async () => {
      const event = await newEvent({ status: "scheduled" });
      await owner("UPDATE event SET starts_at = now() + interval '1 hour' WHERE id = $1", [event]);
      await owner(
        "INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES ($1, $2, 'CNTR-WPEX')",
        [event, ids.orgA],
      );
      const tester = await newPlayer();
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, 'rehearsal')",
        [ids.orgA, event, tester.id],
      );
      const real = await member(event);
      const report = await open(real.player, event, {
        kind: "report_player",
        username: tester.username,
      });
      await platform(tester.id);
      await owner("SELECT wipe_rehearsal($1, 'go_live', $2)", [event, randomUUID()]);
      expect(await ticketRow(report.ticket_id)).toMatchObject({
        reported_enrollment_id: null,
        status: "open",
      });
      expect(
        await owner("SELECT count(*)::int AS n FROM ticket WHERE player_id = $1", [tester.id]),
      ).toEqual([{ n: 1 }]);
    });

    it("purges by the latest hop: never an open event-less ticket by age, not a day early", async () => {
      const { id: player } = await newPlayer();
      const openOld = await platform(player);
      const closedOld = await platform(player);
      const closedRecent = await platform(player, { kind: "suggestion" });
      await owner(
        "UPDATE ticket SET created_at = now() - interval '400 days' WHERE player_id = $1",
        [player],
      );
      await owner(
        "UPDATE ticket SET status = 'closed', outcome = 'solved', answered_by_admin = $3, answer_key = 'p' || id, closed_at = now() - $2 * interval '1 day' WHERE id = $1",
        [closedOld.ticket_id, 91, admin],
      );
      await owner(
        "UPDATE ticket SET status = 'closed', outcome = 'solved', answered_by_admin = $3, answer_key = 'p' || id, closed_at = now() - $2 * interval '1 day' WHERE id = $1",
        [closedRecent.ticket_id, 89, admin],
      );
      const ended = await newEvent({ endsIn: "-200 days" });
      const sender = await member(ended);
      const seed = async (extra: string) => {
        const [made] = await owner<{ id: string }>(
          `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key,
                               created_at, queue, escalated_at, escalated_by_staff, escalation_note, returned_at,
                               returned_by_admin, return_note)
           VALUES ($1, $2, $3, $4, 'question', 'old', gen_random_uuid()::text, now() - interval '199 days', ${extra})
           RETURNING id`,
          [sender.player, ids.orgA, ended, sender.enrollment],
        );
        return made?.id ?? "";
      };
      const lateEscalation = await seed(
        `'questify', now() - interval '89 days', '${ownerA}', 'n', NULL, NULL, NULL`,
      );
      const oldEscalation = await seed(
        `'questify', now() - interval '91 days', '${ownerA}', 'n', NULL, NULL, NULL`,
      );
      const lateReturn = await seed(
        `'event', now() - interval '120 days', '${ownerA}', 'n', now() - interval '89 days', '${admin}', 'r'`,
      );
      const oldReturn = await seed(
        `'event', now() - interval '120 days', '${ownerA}', 'n', now() - interval '91 days', '${admin}', 'r'`,
      );
      while (
        Number((await query<{ n: number }>({}, "SELECT purge_ended_tickets(1000) AS n"))[0]?.n) > 0
      ) {
        // The sweep runs until nothing is due.
      }
      for (const gone of [closedOld.ticket_id, oldEscalation, oldReturn]) {
        expect(await ticketRow(gone), gone).toBeUndefined();
      }
      for (const kept of [openOld.ticket_id, closedRecent.ticket_id, lateEscalation, lateReturn]) {
        expect(await ticketRow(kept), kept).toBeDefined();
      }
    });
  });

  describe("crossed locks", () => {
    it("gives the team's answer and the escalation one winner", async () => {
      const event = await newEvent();
      const sender = await member(event);
      const asked = await open(sender.player, event);
      const [first, second] = await crossed(
        [
          team(),
          "SELECT * FROM staff_escalate_ticket($1, $2, 'Help', NULL)",
          [event, asked.ticket_id],
        ],
        () => staffAnswer(event, asked.ticket_id),
      );
      expect(first.status).toBe("fulfilled");
      expect(codeOf(second)).toBe("HT409:moved");
      const other = await open(sender.player, event);
      const [answered, escalation] = await crossed(
        [
          team(),
          "SELECT * FROM staff_answer_ticket($1, $2, 'Hi', $3, NULL)",
          [event, other.ticket_id, randomUUID()],
        ],
        () => escalate(event, other.ticket_id),
      );
      expect(answered.status).toBe("fulfilled");
      expect(codeOf(escalation)).toBe("HT409:not_open");
    });

    it("gives two admins one answer, and an answer or a send-back one winner", async () => {
      const { id: player } = await newPlayer();
      const asked = await platform(player);
      const [first, second] = await crossed(
        [
          adminSeat(),
          "SELECT * FROM admin_answer_ticket($1, 'One', $2, NULL)",
          [asked.ticket_id, randomUUID()],
        ],
        () => adminAnswer(asked.ticket_id, "Two", randomUUID(), otherAdmin),
      );
      expect(first.status).toBe("fulfilled");
      expect(codeOf(second)).toBe("HT409:already_closed");
      const event = await newEvent();
      const sender = await member(event);
      const escalated = await open(sender.player, event);
      await escalate(event, escalated.ticket_id);
      const [answer, back] = await crossed(
        [
          adminSeat(),
          "SELECT * FROM admin_answer_ticket($1, 'Done', $2, NULL)",
          [escalated.ticket_id, randomUUID()],
        ],
        () => sendBack(escalated.ticket_id, "Yours", otherAdmin),
      );
      expect(answer.status).toBe("fulfilled");
      expect(codeOf(back)).toBe("HT409:already_closed");
    });

    it("makes one platform key sent twice at once one ticket, and lets one of the 3rd and 4th through", async () => {
      const { id: player } = await newPlayer();
      const key = randomUUID();
      const sql =
        "SELECT * FROM open_platform_ticket('suggestion', 'Idea', NULL, NULL, NULL, NULL, $1)";
      const [first, second] = await crossed([{ playerId: player }, sql, [key]], () =>
        platform(player, { kind: "suggestion", key }),
      );
      expect(first.status).toBe("fulfilled");
      expect(second).toMatchObject({ status: "fulfilled", value: { replayed: true } });
      await platform(player);
      const [third, fourth] = await crossed([{ playerId: player }, sql, [randomUUID()]], () =>
        platform(player),
      );
      expect(third.status).toBe("fulfilled");
      expect(codeOf(fourth)).toBe("HT409:too_many_open");
    });

    it("lets no ticket outlive an erasure: an answer waits and finds nothing; a send waits or is deleted", async () => {
      const erase = async (player: string, held: () => Promise<unknown>) => {
        await db.owner.query("BEGIN");
        await db.owner.query("SELECT 1 FROM player WHERE id = $1 FOR UPDATE", [player]);
        await db.owner.query("SELECT erase_rows($1, ARRAY[]::uuid[], NULL)", [player]);
        const waiting = refusal(held());
        await lockWait();
        await db.owner.query("COMMIT");
        return waiting;
      };
      const one = await newPlayer();
      const asked = await platform(one.id);
      expect(await erase(one.id, () => adminAnswer(asked.ticket_id))).toBe("HT404");
      const two = await newPlayer();
      expect(await erase(two.id, () => platform(two.id))).toBe("HT403:not_member");
      const three = await newPlayer();
      const client = await pool.connect();
      const gate = signal();
      const started = signal();
      const held = withRequestContext(client, { playerId: three.id }, async () => {
        await client.query(
          "SELECT * FROM open_platform_ticket('suggestion', 'Idea', NULL, NULL, NULL, NULL, $1)",
          [randomUUID()],
        );
        started.resolve();
        await gate.promise;
      }).finally(() => client.release());
      await started.promise;
      // The erasure needs its own owner connection: the lock check below runs on db.owner while it waits.
      const eraser = new Client({
        host: db.owner.host,
        port: db.owner.port,
        user: db.owner.user,
        password: String(db.owner.password),
        database: db.owner.database,
      });
      await eraser.connect();
      const erasure = (async () => {
        await eraser.query("BEGIN");
        await eraser.query("SELECT 1 FROM player WHERE id = $1 FOR UPDATE", [three.id]);
        await eraser.query("SELECT erase_rows($1, ARRAY[]::uuid[], NULL)", [three.id]);
        await eraser.query("COMMIT");
      })();
      try {
        await lockWait();
        gate.resolve();
        await held;
        await erasure;
      } finally {
        await eraser.end();
      }
      expect(
        await owner("SELECT count(*)::int AS n FROM ticket WHERE player_id = $1", [three.id]),
      ).toEqual([{ n: 0 }]);
    });
  });
});
