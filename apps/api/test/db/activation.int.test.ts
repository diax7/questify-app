import { randomUUID } from "node:crypto";
import { Client } from "pg";
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

/** A promise opened from outside, to hold a transaction open at a chosen moment. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let open: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    open = done;
  });
  return { promise, resolve: () => open?.() };
}

/**
 * Activation and limits in the database (T-210, migration 0027): the owner requests, a Questify admin activates,
 * rejects or changes the limit, each audited; the hard limit is a wall at the enrollment itself.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("event activation (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let editorA: string;
  let ownerB: string;
  let admin: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
    const [row] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('admin@questify.test', 'h', 'admin') RETURNING id",
      )
    ).rows;
    admin = row?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) => withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);
  const seatA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const editorSeat = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: editorA });
  const seatB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });
  const adminSeat = (): RequestContext => ({ isAdmin: true, staffUserId: admin });

  const newDraft = async (fields: { venue?: string | null; starts?: string } = {}) => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, venue_en, starts_at, ends_at)
       VALUES ($1, $2, 'Spring Fest', $3, now() + ($4)::interval, now() + interval '3 days') RETURNING id`,
      [
        ids.orgA,
        `ACT${counter}`,
        fields.venue === undefined ? "Riyadh Front" : fields.venue,
        fields.starts ?? "1 day",
      ],
    );
    return event?.id ?? "";
  };
  const activate = (
    event: string,
    mode = "none",
    cap: number | null = null,
    addons: string[] = [],
  ) =>
    as(adminSeat(), "SELECT activate_event($1, $2, $3, $4, $5)", [
      event,
      mode,
      cap,
      addons,
      randomUUID(),
    ]);
  const newPlayer = async () => {
    counter += 1;
    const mine = counter;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`seat_${mine}`],
    );
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      player?.id,
      `seat${mine}@najd.sa`,
    ]);
    return player?.id ?? "";
  };
  const enroll = async (event: string, player?: string, client: Client = db.app) =>
    as<{ id: string }>(
      adminSeat(),
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, event, player ?? (await newPlayer())],
      client,
    );
  const audit = (event: string) =>
    owner<{ action: string; actor_type: string; after: Row | null }>(
      "SELECT action, actor_type, after FROM audit_log WHERE event_id = $1 ORDER BY id",
      [event],
    );
  const alerts = (event: string) =>
    owner<{ level: number; players: number }>(
      "SELECT level, players FROM event_limit_alert WHERE event_id = $1 ORDER BY level",
      [event],
    );

  describe("the owner's request", () => {
    it("records one pending request and one audit entry, however often it is sent", async () => {
      const event = await newDraft();
      const first = await as<{ outcome: string }>(
        seatA(),
        "SELECT * FROM request_event_activation($1, $2)",
        [event, randomUUID()],
      );
      const second = await as<{ outcome: string }>(
        seatA(),
        "SELECT * FROM request_event_activation($1, $2)",
        [event, randomUUID()],
      );
      expect(first[0]?.outcome).toBe("requested");
      expect(second[0]?.outcome).toBe("already");
      expect(await as(seatA(), "SELECT state FROM event_activation_request")).toEqual([
        { state: "pending" },
      ]);
      expect((await audit(event)).map((row) => row.action)).toEqual(["event.activation.request"]);
    });

    it("refuses an editor, another organizer, and an event that is not a draft", async () => {
      const event = await newDraft();
      for (const seat of [editorSeat(), seatB()]) {
        await expect(
          as(seat, "SELECT * FROM request_event_activation($1, $2)", [event, randomUUID()]),
        ).rejects.toMatchObject({ code: "QE403" });
      }
      await expect(
        as(seatA(), "SELECT * FROM request_event_activation($1, $2)", [ids.eventA, randomUUID()]),
      ).rejects.toMatchObject({ code: "QE409" });
    });

    it("is withdrawn by the owner only, once", async () => {
      const event = await newDraft();
      await as(seatA(), "SELECT * FROM request_event_activation($1, $2)", [event, randomUUID()]);
      await expect(
        as(editorSeat(), "SELECT withdraw_event_activation($1, $2)", [event, randomUUID()]),
      ).rejects.toMatchObject({ code: "QE403" });
      const withdrawn = await as<{ w: boolean }>(
        seatA(),
        "SELECT withdraw_event_activation($1, $2) AS w",
        [event, randomUUID()],
      );
      const again = await as<{ w: boolean }>(
        seatA(),
        "SELECT withdraw_event_activation($1, $2) AS w",
        [event, randomUUID()],
      );
      expect([withdrawn[0]?.w, again[0]?.w]).toEqual([true, false]);
      expect((await audit(event)).map((row) => row.action)).toEqual([
        "event.activation.request",
        "event.activation.withdraw",
      ]);
    });

    it("is open to the team and admins only; nobody writes it directly", async () => {
      const event = await newDraft();
      await as(seatA(), "SELECT * FROM request_event_activation($1, $2)", [event, randomUUID()]);
      const mine = "SELECT event_id FROM event_activation_request WHERE event_id = $1";
      expect(await as(editorSeat(), mine, [event])).toHaveLength(1);
      expect(await as(seatB(), "SELECT event_id FROM event_activation_request")).toEqual([]);
      expect(await as(adminSeat(), mine, [event])).toHaveLength(1);
      await expect(
        as(adminSeat(), "UPDATE event_activation_request SET state = 'rejected'"),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(seatA(), "UPDATE event SET player_limit_mode = 'none' WHERE id = $1", [event]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("activation by a Questify admin", () => {
    it("schedules the draft, sets the limit and exactly the add-ons, and clears the request", async () => {
      const event = await newDraft();
      await as(seatA(), "SELECT * FROM request_event_activation($1, $2)", [event, randomUUID()]);
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'oldThing')",
        [event, ids.orgA],
      );
      await activate(event, "soft", 300, ["bigScreen", "bigScreen"]);
      expect(
        await owner(
          "SELECT status, player_limit_mode, player_limit, activated_by FROM event WHERE id = $1",
          [event],
        ),
      ).toEqual([
        { status: "scheduled", player_limit_mode: "soft", player_limit: 300, activated_by: admin },
      ]);
      expect(
        await owner("SELECT feature FROM event_entitlement WHERE event_id = $1", [event]),
      ).toEqual([{ feature: "bigScreen" }]);
      expect(
        await owner("SELECT 1 FROM event_activation_request WHERE event_id = $1", [event]),
      ).toEqual([]);
      const entries = await audit(event);
      expect(entries.at(-1)).toMatchObject({
        action: "event.activate",
        actor_type: "admin",
        after: { status: "scheduled", limitMode: "soft", limit: 300, addons: ["bigScreen"] },
      });
    });

    it("makes an event whose start has passed live at once", async () => {
      const event = await newDraft({ starts: "-1 hour" });
      await activate(event);
      expect(
        await owner(
          "SELECT event_status_now(status, starts_at, ends_at) AS now FROM event WHERE id = $1",
          [event],
        ),
      ).toEqual([{ now: "live" }]);
    });

    it("refuses anyone but an active platform admin", async () => {
      const event = await newDraft();
      const call = (context: RequestContext) =>
        as(context, "SELECT activate_event($1, 'none', NULL, '{}', NULL)", [event]);
      await expect(call(seatA())).rejects.toMatchObject({ code: "QE403" });
      // The flag alone is not enough: the account must be an admin.
      await expect(call({ isAdmin: true, staffUserId: ownerA })).rejects.toMatchObject({
        code: "QE403",
      });
      await expect(call({ isAdmin: true })).rejects.toMatchObject({ code: "QE403" });
      await owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [admin]);
      try {
        await expect(call(adminSeat())).rejects.toMatchObject({ code: "QE403" });
      } finally {
        await owner("UPDATE staff_user SET status = 'active' WHERE id = $1", [admin]);
      }
    });

    it("refuses an unknown event, a non-draft, missing times and a physical event with no venue", async () => {
      await expect(activate(randomUUID())).rejects.toMatchObject({ code: "QA404" });
      await expect(activate(ids.eventA)).rejects.toMatchObject({ code: "QA409" });
      const noVenue = await newDraft({ venue: null });
      await expect(activate(noVenue)).rejects.toMatchObject({ code: "QA422", detail: "venue" });
      await owner("UPDATE event SET kind = 'virtual' WHERE id = $1", [noVenue]);
      await activate(noVenue);
      const past = await newDraft();
      await owner(
        "UPDATE event SET starts_at = now() - interval '2 days', ends_at = now() - interval '1 day' WHERE id = $1",
        [past],
      );
      await expect(activate(past)).rejects.toMatchObject({ code: "QA422", detail: "times" });
      const noTimes = await newDraft();
      await owner("UPDATE event SET starts_at = NULL WHERE id = $1", [noTimes]);
      await expect(activate(noTimes)).rejects.toMatchObject({ code: "QA422", detail: "times" });
    });

    it("rejects a pending request with a note the owner reads; the event stays a draft", async () => {
      const event = await newDraft();
      const reject = () =>
        as(adminSeat(), "SELECT reject_event_activation($1, $2, $3)", [
          event,
          "Please add the venue map.",
          randomUUID(),
        ]);
      await expect(reject()).rejects.toMatchObject({ code: "QA409" });
      await as(seatA(), "SELECT * FROM request_event_activation($1, $2)", [event, randomUUID()]);
      await reject();
      expect(
        await as(seatA(), "SELECT state, note FROM event_activation_request WHERE event_id = $1", [
          event,
        ]),
      ).toEqual([{ state: "rejected", note: "Please add the venue map." }]);
      expect(await owner("SELECT status FROM event WHERE id = $1", [event])).toEqual([
        { status: "draft" },
      ]);
      // Asking again clears the note.
      await as(seatA(), "SELECT * FROM request_event_activation($1, $2)", [event, randomUUID()]);
      expect(
        await as(seatA(), "SELECT state, note FROM event_activation_request WHERE event_id = $1", [
          event,
        ]),
      ).toEqual([{ state: "pending", note: null }]);
    });
  });

  describe("the player limit", () => {
    it("closes joining at a hard limit, and a seat freed by leaving opens it again", async () => {
      const event = await newDraft();
      await activate(event, "hard", 2);
      await enroll(event);
      await enroll(event);
      await expect(enroll(event)).rejects.toMatchObject({ code: "QL409", detail: "2" });
      const [first] = await owner<{ id: string }>(
        "SELECT id FROM enrollment WHERE event_id = $1 ORDER BY joined_at LIMIT 1",
        [event],
      );
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [first?.id]);
      await enroll(event);
      // A player who left cannot come back while the event is full.
      await expect(
        owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [first?.id]),
      ).rejects.toMatchObject({ code: "QL409" });
    });

    it("never refuses a ban at a full event, and a ban keeps the seat", async () => {
      const event = await newDraft();
      await activate(event, "hard", 2);
      const [left] = await enroll(event);
      await owner("UPDATE enrollment SET status = 'left' WHERE id = $1", [left?.id]);
      await enroll(event);
      await enroll(event);
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [left?.id]);
      expect(await as(seatA(), "SELECT event_seat_count($1) AS n", [event])).toEqual([{ n: 3 }]);
      // Lifting the ban takes no new seat.
      await owner("UPDATE enrollment SET status = 'active' WHERE id = $1", [left?.id]);
    });

    it("lets an insert for a player already in the event reach its conflict", async () => {
      const event = await newDraft();
      await activate(event, "hard", 1);
      const player = await newPlayer();
      await enroll(event, player);
      const again = await as(
        adminSeat(),
        `INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)
         ON CONFLICT (event_id, player_id) DO NOTHING RETURNING id`,
        [ids.orgA, event, player],
      );
      expect(again).toEqual([]);
    });

    it("lets exactly the limit in when the last seats are taken at once", async () => {
      const event = await newDraft();
      await activate(event, "hard", 3);
      const clients = await Promise.all(
        Array.from({ length: 6 }, async () => {
          const client = new Client({ connectionString: db.appUrl });
          await client.connect();
          return client;
        }),
      );
      try {
        const players = await Promise.all(clients.map(() => newPlayer()));
        const results = await Promise.allSettled(
          clients.map((client, index) => enroll(event, players[index], client)),
        );
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
        for (const result of results.filter((r) => r.status === "rejected")) {
          expect((result as PromiseRejectedResult).reason).toMatchObject({ code: "QL409" });
        }
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      expect(await owner("SELECT event_seats($1) AS n", [event])).toEqual([{ n: 3 }]);
    });

    it("never blocks at a soft limit, and records each mark once (80% rounds up)", async () => {
      const event = await newDraft();
      await activate(event, "soft", 5);
      for (let index = 0; index < 3; index += 1) {
        await enroll(event);
      }
      expect(await alerts(event)).toEqual([]);
      await enroll(event);
      expect(await alerts(event)).toEqual([{ level: 80, players: 4 }]);
      await enroll(event);
      await enroll(event);
      expect(await alerts(event)).toEqual([
        { level: 80, players: 4 },
        { level: 100, players: 5 },
      ]);
    });

    it("lets an admin change the limit, keeps everyone, and recomputes the marks", async () => {
      const event = await newDraft();
      await activate(event, "none");
      await enroll(event);
      await enroll(event);
      await expect(
        as(seatA(), "SELECT set_event_player_limit($1, 'hard', 1, NULL)", [event]),
      ).rejects.toMatchObject({ code: "QE403" });
      await as(adminSeat(), "SELECT set_event_player_limit($1, 'hard', 1, $2)", [
        event,
        randomUUID(),
      ]);
      expect(await alerts(event)).toEqual([
        { level: 80, players: 2 },
        { level: 100, players: 2 },
      ]);
      await expect(enroll(event)).rejects.toMatchObject({ code: "QL409" });
      await as(adminSeat(), "SELECT set_event_player_limit($1, 'none', NULL, NULL)", [event]);
      expect(await alerts(event)).toEqual([]);
      await enroll(event);
      expect((await audit(event)).map((row) => row.action)).toContain("event.limit");
      const draft = await newDraft();
      await expect(
        as(adminSeat(), "SELECT set_event_player_limit($1, 'none', NULL, NULL)", [draft]),
      ).rejects.toMatchObject({ code: "QA409" });
    });

    it("makes a join wait for an admin who is setting a hard limit, then applies it", async () => {
      const event = await newDraft();
      await activate(event, "none");
      await enroll(event);
      const adminClient = new Client({ connectionString: db.appUrl });
      const joinClient = new Client({ connectionString: db.appUrl });
      await Promise.all([adminClient.connect(), joinClient.connect()]);
      try {
        const held = gate();
        const locked = gate();
        const change = withRequestContext(adminClient, adminSeat(), async () => {
          await adminClient.query("SELECT set_event_player_limit($1, 'hard', 1, NULL)", [event]);
          locked.resolve();
          await held.promise;
        });
        await locked.promise;
        let settled = false;
        const join = enroll(event, await newPlayer(), joinClient).finally(() => {
          settled = true;
        });
        join.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toBe(false);
        held.resolve();
        await change;
        await expect(join).rejects.toMatchObject({ code: "QL409" });
      } finally {
        await Promise.all([adminClient.end(), joinClient.end()]);
      }
    });

    it("shows the seat count to the event's team and admins only, and the marks to the team", async () => {
      const event = await newDraft();
      await activate(event, "soft", 1);
      await enroll(event);
      expect(await as(seatA(), "SELECT event_seat_count($1) AS n", [event])).toEqual([{ n: 1 }]);
      expect(await as(adminSeat(), "SELECT event_seat_count($1) AS n", [event])).toEqual([
        { n: 1 },
      ]);
      expect(await as(seatB(), "SELECT event_seat_count($1) AS n", [event])).toEqual([{ n: null }]);
      expect(
        await as(seatA(), "SELECT level FROM event_limit_alert WHERE event_id = $1", [event]),
      ).toHaveLength(2);
      expect(await as(seatB(), "SELECT level FROM event_limit_alert")).toEqual([]);
      await expect(as(seatA(), "SELECT event_seats($1)", [event])).rejects.toThrow(
        /permission denied/,
      );
    });
  });
});
