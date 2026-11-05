import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setLocalSettings } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  connectAsOwner,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Mode = "hard" | "soft" | "none";
type Accepted = { outcome: string; accepted: number; remaining: number };

/** How long a blocked call may take to show up waiting on a lock, and the pause between two looks. */
const LOCK_WAIT_MS = 20_000;
const POLL_MS = 10;

const sqlstate = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return "ok";
};

/** Opens a transaction on `client` with a request context, left open for the test to end. */
const begin = async (client: Client, context: RequestContext) => {
  await client.query("BEGIN");
  await setLocalSettings(client, [
    ["app.organizer_id", context.organizerId ?? ""],
    ["app.staff_user_id", context.staffUserId ?? ""],
    ["app.player_id", context.playerId ?? ""],
  ]);
};

const join = async (client: Client, player: string, code: string) =>
  (
    await withRequestContext(client, { playerId: player }, () =>
      client.query<{ outcome: string }>(
        "SELECT * FROM join_event($1, 'code', '0.2', '{}'::jsonb, false)",
        [code],
      ),
    )
  ).rows[0]?.outcome;

/**
 * Events have no welcome points unless a test asks: the welcome grant's ranking mark locks one row per event, which
 * would serialize racing writers before they reach the statement trigger and hide its lock order.
 *
 * The seat limit checked once per statement (T-221, migration 0146, ADR-630 to ADR-632): exactly the limit when
 * accept-all, joins and direct writes race, the statement guard on its own (inserts and updates, several events, a
 * lowered limit, rehearsal, READ COMMITTED only), the 80 and 100 marks at the crossing, and accept-all's 1,000 a call.
 * A blocked call is proven waiting through pg_stat_activity before the holder ends, never by a sleep.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "the seat limit once a statement (database)",
  () => {
    let db: TestDatabase;
    let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
    let staff: string;
    let counter = 0;
    const open: Client[] = [];
    /** Each test connection's backend pid, read when it connects: a busy client cannot answer a query. */
    const pids = new Map<Client, number>();

    beforeAll(async () => {
      db = await createTestDatabase();
      ids = await seedTwoTenants(db.owner);
      staff = await addMember(db.owner, ids.orgA);
    });
    afterAll(async () => {
      await Promise.all(open.map((client) => client.end()));
      await db.close();
    });

    const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;
    const team = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: staff });

    /** `n` new events in one statement (`join_code` numbered from the counter); answers their ids and codes. */
    const newEvents = async (
      n: number,
      spec: { mode?: Mode; limit?: number; access?: string; welcome?: number } = {},
    ) => {
      const first = counter + 1;
      counter += n;
      return owner<{ id: string; code: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at, welcome_points,
                          player_limit_mode, player_limit)
       SELECT $1, 'SL' || lpad(g::text, 4, '0'), 'Seat Fest', 'live', $3, now() - interval '2 hours',
              now() + interval '1 day', $6, $4, $5
       FROM generate_series($2::int, $7::int) g
       RETURNING id, join_code AS code`,
        [
          ids.orgA,
          first,
          spec.access ?? "public",
          spec.mode ?? "hard",
          spec.limit ?? null,
          spec.welcome ?? null,
          counter,
        ],
      );
    };
    const newEvent = async (spec: Parameters<typeof newEvents>[1] = {}) => {
      const [event] = await newEvents(1, spec);
      return { id: event?.id ?? "", code: event?.code ?? "" };
    };
    /**
     * Hundreds of events: the time zone guard looks each zone up in pg_timezone_names (about 50 ms a row, 14 s for
     * 300), which would bury the test under seeding, so it is off for this insert only and back on after it.
     */
    const newManyEvents = async (n: number, limit: number) => {
      await owner("ALTER TABLE event DISABLE TRIGGER event_timezone_guard");
      try {
        return await newEvents(n, { limit });
      } finally {
        await owner("ALTER TABLE event ENABLE TRIGGER event_timezone_guard");
      }
    };
    /** `n` new players enrolled with `status` in one statement; answers the enrollment ids, oldest first. */
    const enrol = async (event: string, n: number, status = "active", via: string | null = null) =>
      (
        await owner<{ id: string }>(
          `WITH p AS (INSERT INTO player (username) SELECT 'seat_' || $2 || '_' || g FROM generate_series(1, $3) g
                    RETURNING id)
         INSERT INTO enrollment (organizer_id, event_id, player_id, status, joined_via)
         SELECT e.organizer_id, e.id, p.id, $4, $5 FROM p CROSS JOIN event e WHERE e.id = $1 RETURNING id`,
          [event, randomUUID().slice(0, 8), n, status, via],
        )
      ).map((row) => row.id);
    const newPlayer = async () => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`seat_player_${counter}`],
      );
      await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
        player?.id,
        `seat${counter}@example.com`,
      ]);
      return player?.id ?? "";
    };
    const seats = async (event: string) =>
      (await owner<{ n: number }>("SELECT event_seats($1) AS n", [event]))[0]?.n;
    const statusOf = async (enrollments: string[]) =>
      (
        await owner<{ status: string }>(
          "SELECT status FROM enrollment WHERE id = ANY($1) ORDER BY id",
          [enrollments],
        )
      ).map((row) => row.status);

    const appClient = async () => {
      const client = new Client({ connectionString: db.appUrl });
      await client.connect();
      open.push(client);
      pids.set(client, Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid));
      return client;
    };
    const ownerClient = async () => {
      const client = await connectAsOwner(db);
      open.push(client);
      pids.set(client, Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid));
      return client;
    };
    /**
     * Waits until `client` is blocked on a lock (pg_stat_activity), polling the catalog against a deadline, never
     * sleeping blindly and never counting attempts: a loaded runner stretches each poll, not the time allowed.
     */
    const blockedOn = async (client: Client) => {
      const pid = pids.get(client);
      const deadline = Date.now() + LOCK_WAIT_MS;
      while (Date.now() < deadline) {
        const rows = await owner(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pid],
        );
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      throw new Error(`connection ${pid} never waited on a lock within ${LOCK_WAIT_MS} ms`);
    };
    const marks = (event: string) =>
      owner<{ level: number; players: number }>(
        "SELECT level, players FROM event_limit_alert WHERE event_id = $1 ORDER BY level",
        [event],
      );
    const insert = async (client: Client, events: string[]) => {
      const players = [await newPlayer(), await newPlayer()];
      return client.query(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, status)
         SELECT $1, e.event, e.player, 'active'
         FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS e(event, player, k) ORDER BY e.k`,
        [ids.orgA, events, players],
      );
    };
    const acceptAll = async (event: string, client: Client = db.app) =>
      (
        await withRequestContext(client, team(), () =>
          client.query<Accepted>("SELECT * FROM accept_all_join_requests($1, $2)", [
            event,
            randomUUID(),
          ]),
        )
      ).rows[0];

    describe("exactly the limit under concurrency", () => {
      it("accept-all first: a join and a second accept-all wait, then answer full and accept nothing", async () => {
        const event = await newEvent({ limit: 8 });
        await enrol(event.id, 5);
        await enrol(event.id, 10, "pending");
        const [a, b, c] = [await appClient(), await appClient(), await appClient()];
        await begin(a, team());
        const held = await a.query<Accepted>("SELECT * FROM accept_all_join_requests($1, $2)", [
          event.id,
          randomUUID(),
        ]);
        expect(held.rows[0]).toMatchObject({ accepted: 3, remaining: 7 });
        const joined = join(b, await newPlayer(), event.code);
        await blockedOn(b);
        const second = acceptAll(event.id, c);
        await blockedOn(c);
        await a.query("COMMIT");
        expect(await joined).toBe("full");
        expect(await second).toMatchObject({ accepted: 0, remaining: 7 });
        expect(await seats(event.id)).toBe(8);
      });

      it("a join first: two accept-alls wait, then take only the seats left between them", async () => {
        const event = await newEvent({ limit: 8 });
        await enrol(event.id, 5);
        await enrol(event.id, 10, "pending");
        const [a, b, c] = [await appClient(), await appClient(), await appClient()];
        await begin(b, { playerId: await newPlayer() });
        const held = await b.query<{ status: string }>(
          "SELECT * FROM join_event($1, 'code', '0.2', '{}'::jsonb, false)",
          [event.code],
        );
        expect(held.rows[0]?.status).toBe("active");
        const first = acceptAll(event.id, a);
        await blockedOn(a);
        const second = acceptAll(event.id, c);
        await blockedOn(c);
        await b.query("COMMIT");
        const answers = [await first, await second].map((answer) => answer?.accepted);
        expect(answers.toSorted()).toEqual([0, 2]);
        expect(await seats(event.id)).toBe(8);
      });

      it("two accept-alls: the second takes nothing after a commit, every free seat after a rollback", async () => {
        for (const end of ["COMMIT", "ROLLBACK"]) {
          const event = await newEvent({ limit: 8 });
          await enrol(event.id, 5);
          await enrol(event.id, 10, "pending");
          const [a, c] = [await appClient(), await appClient()];
          await begin(a, team());
          await a.query("SELECT * FROM accept_all_join_requests($1, $2)", [event.id, randomUUID()]);
          const second = acceptAll(event.id, c);
          await blockedOn(c);
          await a.query(end);
          expect((await second)?.accepted, end).toBe(end === "COMMIT" ? 0 : 3);
          expect(await seats(event.id)).toBe(8);
        }
      });

      it("two direct writes at the last seat: the first commits, the second raises QL409 and moves nothing", async () => {
        const event = await newEvent({ limit: 6 });
        await enrol(event.id, 5);
        const [first, second] = await enrol(event.id, 2, "pending");
        const [one, two] = [await ownerClient(), await ownerClient()];
        await one.query("BEGIN");
        await one.query("UPDATE enrollment SET status = 'active' WHERE id = $1", [first]);
        const late = sqlstate(
          two.query("UPDATE enrollment SET status = 'active' WHERE id = $1", [second]),
        );
        await blockedOn(two);
        await one.query("COMMIT");
        expect(await late).toBe("QL409");
        expect(await statusOf([second ?? ""])).toEqual(["pending"]);
        expect(await seats(event.id)).toBe(6);
      });

      it("two statements over the same two events in opposite row orders take the seat locks in id order", async () => {
        const [x, y] = [await newEvent({ limit: 50 }), await newEvent({ limit: 50 })];
        const [low, high] = [x.id, y.id].toSorted();
        const [blocker, one, two] = [await ownerClient(), await ownerClient(), await ownerClient()];
        await blocker.query("BEGIN");
        await blocker.query("SELECT lock_event_seats($1)", [high]);
        const reversed = sqlstate(insert(two, [high ?? "", low ?? ""]));
        await blockedOn(two);
        const ordered = sqlstate(insert(one, [low ?? "", high ?? ""]));
        await blockedOn(one);
        await blocker.query("COMMIT");
        expect([await reversed, await ordered]).toEqual(["ok", "ok"]);
        expect([await seats(low ?? ""), await seats(high ?? "")]).toEqual([2, 2]);
      });

      it("takes the seat locks of a 300-event statement in id order even when the planner hashes the groups", async () => {
        const events = (await newManyEvents(300, 50)).map((event) => event.id);
        const ordered = events.toSorted();
        const players = await owner<{ id: string }>(
          "INSERT INTO player (username) SELECT 'seat_many_' || $1 || '_' || g FROM generate_series(1, 300) g RETURNING id",
          [randomUUID().slice(0, 8)],
        );
        const [blocker, writer] = [await ownerClient(), await ownerClient()];
        await blocker.query("BEGIN");
        await blocker.query("SELECT lock_event_seats($1)", [ordered[150]]);
        // Without a sort the planner groups the statement's rows by hash, which is not the id order.
        await writer.query("SET enable_sort = off");
        const written = sqlstate(
          writer.query(
            `INSERT INTO enrollment (organizer_id, event_id, player_id, status)
             SELECT $1, e.event, e.player, 'active'
             FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS e(event, player, k) ORDER BY e.k`,
            [ids.orgA, ordered.toReversed(), players.map((player) => player.id)],
          ),
        );
        await blockedOn(writer);
        const held = await owner<{ id: string }>(
          `SELECT e.id FROM pg_locks l
           JOIN event e ON l.objid::bigint = (hashtext(e.id::text)::bigint & 4294967295)
           WHERE l.pid = $1 AND l.locktype = 'advisory' AND l.classid = 270027 AND l.granted
             AND e.id = ANY($2)
           ORDER BY e.id`,
          [pids.get(writer), events],
        );
        expect(held.map((row) => row.id)).toEqual(ordered.slice(0, 150));
        await blocker.query("COMMIT");
        expect(await written).toBe("ok");
      }, 120_000);
    });

    describe("the statement guard on its own", () => {
      it("refuses a statement that seats one too many and moves none; exactly to the limit passes", async () => {
        const event = await newEvent({ limit: 10 });
        await enrol(event.id, 7);
        const requests = await enrol(event.id, 4, "pending");
        expect(
          await sqlstate(
            owner("UPDATE enrollment SET status = 'active' WHERE id = ANY($1)", [requests]),
          ),
        ).toBe("QL409");
        expect(await statusOf(requests)).toEqual(["pending", "pending", "pending", "pending"]);
        await owner("UPDATE enrollment SET status = 'active' WHERE id = ANY($1)", [
          requests.slice(0, 3),
        ]);
        expect(await seats(event.id)).toBe(10);
      });

      it("answers QL409 with the limit as its detail", async () => {
        const event = await newEvent({ limit: 2 });
        await enrol(event.id, 2);
        await expect(enrol(event.id, 1)).rejects.toMatchObject({ code: "QL409", detail: "2" });
      });

      it("checks inserts: one row or several past the limit raise, exactly to it passes", async () => {
        const event = await newEvent({ limit: 5 });
        await enrol(event.id, 3);
        expect(await sqlstate(enrol(event.id, 3))).toBe("QL409");
        expect(await seats(event.id)).toBe(3);
        await enrol(event.id, 2);
        expect(await sqlstate(enrol(event.id, 1))).toBe("QL409");
        expect(await sqlstate(enrol(event.id, 1, "pending"))).toBe("ok");
        expect(await seats(event.id)).toBe(5);
      });

      it("lets an insert that conflicts with a seated player through at a full event (ON CONFLICT DO NOTHING)", async () => {
        const event = await newEvent({ limit: 1 });
        const [seated] = await enrol(event.id, 1);
        const [row] = await owner<{ player_id: string }>(
          "SELECT player_id FROM enrollment WHERE id = $1",
          [seated],
        );
        const inserted = await owner(
          `INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, 'active')
         ON CONFLICT DO NOTHING RETURNING id`,
          [ids.orgA, event.id, row?.player_id],
        );
        expect(inserted).toEqual([]);
        expect(await seats(event.id)).toBe(1);
      });

      it("refuses a two-event statement whole when one event is over its limit", async () => {
        const [open1, full] = [await newEvent({ limit: 10 }), await newEvent({ limit: 1 })];
        await enrol(full.id, 1);
        const requests = [
          ...(await enrol(open1.id, 1, "pending")),
          ...(await enrol(full.id, 1, "pending")),
        ];
        expect(
          await sqlstate(
            owner("UPDATE enrollment SET status = 'active' WHERE id = ANY($1)", [requests]),
          ),
        ).toBe("QL409");
        expect(await statusOf(requests)).toEqual(["pending", "pending"]);
      });

      it("under a lowered limit refuses one more seat but not a leave, a ban, a ban lift or an erasure's exit", async () => {
        const event = await newEvent({ limit: 10 });
        const [leaver, banned, erased, kept] = await enrol(event.id, 5);
        const [request] = await enrol(event.id, 1, "pending");
        await owner("UPDATE event SET player_limit = 2 WHERE id = $1", [event.id]);
        expect(
          await sqlstate(owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [request])),
        ).toBe("QL409");
        await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [leaver]);
        await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned]);
        await owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [banned]);
        await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [erased]);
        await owner("UPDATE enrollment SET score = score + 1 WHERE id = $1", [kept]);
        expect(await seats(event.id)).toBe(3);
      });

      it("never counts or refuses a rehearsal row", async () => {
        const event = await newEvent({ limit: 1 });
        await enrol(event.id, 1);
        expect(await sqlstate(enrol(event.id, 2, "active", "rehearsal"))).toBe("ok");
        expect(await seats(event.id)).toBe(1);
        const client = await ownerClient();
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        const rehearsing = await sqlstate(
          client.query(
            `INSERT INTO enrollment (organizer_id, event_id, player_id, status, joined_via)
             VALUES ($1, $2, $3, 'active', 'rehearsal')`,
            [ids.orgA, event.id, await newPlayer()],
          ),
        );
        await client.query("ROLLBACK");
        expect(rehearsing, "a rehearsal row takes no seat, so no READ COMMITTED check").toBe("ok");
      });

      it("records nothing and locks nothing without a limit, and only marks a soft one", async () => {
        const free = await newEvent({ mode: "none" });
        await enrol(free.id, 30);
        expect(await seats(free.id)).toBe(30);
        const soft = await newEvent({ mode: "soft", limit: 2 });
        await enrol(soft.id, 4);
        expect(await seats(soft.id)).toBe(4);
      });

      it("still answers ES423 on a suspended event", async () => {
        const event = await newEvent({ limit: 10 });
        const [request] = await enrol(event.id, 1, "pending");
        await owner(
          "UPDATE event SET suspended_at = now(), suspension_reason = 'checking a report' WHERE id = $1",
          [event.id],
        );
        expect(
          await sqlstate(owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [request])),
        ).toBe("ES423");
      });

      it("refuses to seat a player on a limited event under REPEATABLE READ, and lets other writes through", async () => {
        const limited = await newEvent({ limit: 10 });
        const free = await newEvent({ mode: "none" });
        const [seated] = await enrol(limited.id, 1);
        const [request] = await enrol(limited.id, 1, "pending");
        const [other] = await enrol(free.id, 1, "pending");
        const client = await ownerClient();
        const repeatable = async (sql: string, values: unknown[]) => {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
          const answer = await sqlstate(client.query(sql, values));
          await client.query(answer === "ok" ? "COMMIT" : "ROLLBACK");
          return answer;
        };
        expect(
          await repeatable("UPDATE enrollment SET status = 'active' WHERE id = $1", [request]),
        ).toBe("0A000");
        expect(
          await repeatable("UPDATE enrollment SET score = score + 1 WHERE id = $1", [seated]),
        ).toBe("ok");
        expect(
          await repeatable("UPDATE enrollment SET status = 'active' WHERE id = $1", [other]),
        ).toBe("ok");
      });
    });

    describe("the 80 and 100 marks", () => {
      it("records each mark once with the count at the crossing, soft and hard", async () => {
        for (const mode of ["soft", "hard"] as const) {
          const event = await newEvent({ mode, limit: 10, access: "private" });
          await enrol(event.id, 7);
          await enrol(event.id, 5, "pending");
          expect((await acceptAll(event.id))?.accepted, mode).toBe(mode === "soft" ? 5 : 3);
          expect(await marks(event.id), mode).toEqual([
            { level: 80, players: 8 },
            { level: 100, players: 10 },
          ]);
          await enrol(event.id, 1, "pending");
          await acceptAll(event.id);
          expect(await marks(event.id), mode).toHaveLength(2);
        }
      });

      it("records the 80 mark alone below the limit, at the first seat past it", async () => {
        const event = await newEvent({ limit: 20 });
        await enrol(event.id, 10);
        await enrol(event.id, 8);
        expect(await marks(event.id)).toEqual([{ level: 80, players: 16 }]);
      });
    });

    describe("accept-all, up to 1,000 a call", () => {
      it("takes 1,000 without a limit, then the rest; one welcome, audit row and notice per player", async () => {
        const event = await newEvent({ mode: "none", access: "private", welcome: 5 });
        await enrol(event.id, 1001, "pending");
        expect(await acceptAll(event.id)).toEqual({
          outcome: "done",
          accepted: 1000,
          remaining: 1,
        });
        expect(await acceptAll(event.id)).toEqual({ outcome: "done", accepted: 1, remaining: 0 });
        const [counts] = await owner<{ welcomes: number; audits: number; notices: number }>(
          `SELECT (SELECT count(*)::integer FROM ledger_entry WHERE event_id = $1 AND kind = 'welcome') AS welcomes,
                (SELECT count(*)::integer FROM audit_log WHERE event_id = $1 AND action = 'event.join_accept') AS audits,
                (SELECT count(*)::integer FROM notice WHERE event_id = $1 AND kind = 'join_accepted') AS notices`,
          [event.id],
        );
        expect(counts).toEqual({ welcomes: 1001, audits: 1001, notices: 1001 });
      });

      it("takes every free seat of a hard limit in one call", async () => {
        const event = await newEvent({ limit: 10, access: "private" });
        await enrol(event.id, 3);
        await enrol(event.id, 20, "pending");
        expect(await acceptAll(event.id)).toEqual({ outcome: "done", accepted: 7, remaining: 13 });
        expect(await seats(event.id)).toBe(10);
      });
    });

    describe("deny by default", () => {
      it("keeps the seat guard and the crossings internal, and the row guard gone", async () => {
        const rows = await owner<{
          proname: string;
          app: boolean;
          outsider: boolean;
          definer: boolean;
        }>(
          `SELECT proname, has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('questify_outsider', p.oid, 'EXECUTE') AS outsider, prosecdef AS definer
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND proname IN ('enrollment_seat_limit', 'record_limit_crossings', 'enrollment_player_limit')
         ORDER BY proname`,
        );
        expect(rows).toEqual([
          { proname: "enrollment_seat_limit", app: false, outsider: false, definer: true },
          { proname: "record_limit_crossings", app: false, outsider: false, definer: true },
        ]);
        const event = await newEvent({ limit: 5 });
        await expect(
          db.outsider.query("SELECT public.record_limit_crossings($1::uuid, $2::uuid, 5, 0, 5)", [
            event.id,
            ids.orgA,
          ]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          db.app.query("SELECT public.record_limit_crossings($1::uuid, $2::uuid, 5, 0, 5)", [
            event.id,
            ids.orgA,
          ]),
        ).rejects.toThrow(/permission denied/);
        const triggers = await owner<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger WHERE tgrelid = 'enrollment'::regclass
           AND tgname IN ('enrollment_player_limit', 'enrollment_seat_limit_insert', 'enrollment_seat_limit_update')
         ORDER BY tgname`,
        );
        expect(triggers.map((row) => row.tgname)).toEqual([
          "enrollment_seat_limit_insert",
          "enrollment_seat_limit_update",
        ]);
      });
    });
  },
);
