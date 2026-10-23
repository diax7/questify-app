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
type Joined = {
  outcome: string;
  enrollment_id: string | null;
  status: string | null;
  welcome: number;
  waitlisted: boolean;
};

/**
 * Join requests and the waiting list in the database (T-218, migration 0036, ADR-167 to ADR-169): accepting and
 * declining, seats counted for accepted players only, 'full' and the waiting list, the lock order under races, and
 * who may decide.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("join requests (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let editorA: string;
  let ownerB: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA);
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB);
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
  const teamA = (staff = ownerA): RequestContext => ({ organizerId: ids.orgA, staffUserId: staff });

  type Spec = { access?: string; limit?: number; welcome?: number; endsIn?: string };
  const newEvent = async (spec: Spec = {}): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `JR${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at, welcome_points,
                          player_limit_mode, player_limit)
       VALUES ($1, $2, 'Gate Fest', 'live', $3, now() - interval '2 hours', now() + $4::interval, $5, $6, $7)
       RETURNING id`,
      [
        ids.orgA,
        code,
        spec.access ?? "private",
        spec.endsIn ?? "1 day",
        spec.welcome ?? null,
        spec.limit === undefined ? "none" : "hard",
        spec.limit ?? null,
      ],
    );
    return { id: event?.id ?? "", code };
  };
  const newPlayer = async (email?: string): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`asker_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
      id,
      email ?? `asker${counter}@example.com`,
    ]);
    return id;
  };
  const join = async (player: string, code: string, waitlist = false, client: Client = db.app) =>
    (
      await as<Joined>(
        { playerId: player },
        "SELECT * FROM join_event($1, 'code', '0.2', '{}'::jsonb, $2)",
        [code, waitlist],
        client,
      )
    )[0];
  const decide = async (
    event: string,
    enrollment: string,
    accept: boolean,
    context: RequestContext = teamA(),
    client: Client = db.app,
  ) =>
    (
      await as<{ outcome: string }>(
        context,
        "SELECT decide_join_request($1, $2, $3, $4) AS outcome",
        [event, enrollment, accept, randomUUID()],
        client,
      )
    )[0]?.outcome;
  const stateOf = async (enrollment: string) =>
    (
      await owner<{ status: string; waitlisted: boolean }>(
        "SELECT status, waitlisted FROM enrollment WHERE id = $1",
        [enrollment],
      )
    )[0];
  const seats = async (event: string) =>
    (await owner<{ n: number }>("SELECT event_seats($1) AS n", [event]))[0]?.n;
  const asked = async (event: { code: string }) => {
    const player = await newPlayer();
    const answer = await join(player, event.code);
    return { player, enrollment: answer?.enrollment_id ?? "" };
  };
  const filled = async (event: { code: string }, count: number) => {
    for (let index = 0; index < count; index += 1) {
      expect(await join(await newPlayer(), event.code)).toMatchObject({ status: "active" });
    }
  };
  const clients = async (count: number) =>
    Promise.all(
      Array.from({ length: count }, async () => {
        const client = new Client({ connectionString: db.appUrl });
        await client.connect();
        return client;
      }),
    );

  describe("accepting and declining (FR-1819)", () => {
    it("lets an accepted request in with the welcome reward once, audited without personal data", async () => {
      const event = await newEvent({ welcome: 30 });
      const { enrollment } = await asked(event);
      expect(await stateOf(enrollment)).toEqual({ status: "pending", waitlisted: false });
      expect(await decide(event.id, enrollment, true, teamA(editorA))).toBe("accepted");
      expect(await decide(event.id, enrollment, true)).toBe("unchanged");
      expect(await stateOf(enrollment)).toMatchObject({ status: "active" });
      expect(
        await owner("SELECT score_delta FROM ledger_entry WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([{ score_delta: "30" }]);
      expect(
        await owner(
          "SELECT action, actor_id, before, after FROM audit_log WHERE target_id = $1::text",
          [enrollment],
        ),
      ).toEqual([
        {
          action: "event.join_accept",
          actor_id: editorA,
          before: { status: "pending", waitlisted: false },
          after: { status: "active" },
        },
      ]);
    });

    it("bars a declined player from asking again, and cannot be left; the guest list or an acceptance lets them in", async () => {
      const event = await newEvent();
      const { player, enrollment } = await asked(event);
      expect(await decide(event.id, enrollment, false)).toBe("declined");
      expect(await decide(event.id, enrollment, false)).toBe("unchanged");
      expect(await join(player, event.code)).toMatchObject({
        outcome: "declined",
        enrollment_id: null,
      });
      await expect(
        as({ playerId: player }, "UPDATE enrollment SET status = 'left' WHERE id = $1", [
          enrollment,
        ]),
      ).rejects.toThrow(/not allowed/);
      expect(await decide(event.id, enrollment, true)).toBe("accepted");

      const again = await asked(event);
      const email = (
        await owner<{ email: string }>("SELECT email FROM player_contact WHERE player_id = $1", [
          again.player,
        ])
      )[0]?.email;
      await decide(event.id, again.enrollment, false);
      await as(
        teamA(),
        "INSERT INTO event_guest (event_id, kind, value) VALUES ($1, 'email', $2)",
        [event.id, email],
      );
      expect(
        (await as<{ id: string }>({ playerId: again.player }, "SELECT id FROM my_invitations()"))
          .length,
      ).toBe(1);
      expect(await join(again.player, event.code)).toMatchObject({
        outcome: "joined",
        status: "active",
      });
    });

    it("bars a player declined from a Public event's waiting list (the organizer's power, ADR-167)", async () => {
      const event = await newEvent({ access: "public", limit: 1 });
      await filled(event, 1);
      const player = await newPlayer();
      const listed = await join(player, event.code, true);
      expect(listed).toMatchObject({ status: "pending", waitlisted: true });
      expect(await decide(event.id, listed?.enrollment_id ?? "", false)).toBe("declined");
      await owner(
        "UPDATE event SET player_limit_mode = 'none', player_limit = NULL WHERE id = $1",
        [event.id],
      );
      expect(await join(player, event.code)).toMatchObject({ outcome: "declined" });
    });

    it("refuses what is not a request, and answers ended once the event is over, with no welcome", async () => {
      const event = await newEvent({ welcome: 10 });
      const { enrollment } = await asked(event);
      const member = await newPlayer();
      await owner("UPDATE event SET access = 'public' WHERE id = $1", [event.id]);
      const active = (await join(member, event.code))?.enrollment_id ?? "";
      expect(await decide(event.id, active, true)).toBe("unchanged");
      expect(await decide(event.id, active, false)).toBe("not_allowed");
      expect(await decide(event.id, randomUUID(), true)).toBe("not_found");
      await owner("UPDATE event SET ends_at = now() - interval '1 minute' WHERE id = $1", [
        event.id,
      ]);
      expect(await decide(event.id, enrollment, true)).toBe("ended");
      expect(await decide(event.id, enrollment, false)).toBe("ended");
      expect(
        await as(teamA(), "SELECT * FROM accept_all_join_requests($1, $2)", [
          event.id,
          randomUUID(),
        ]),
      ).toEqual([{ outcome: "ended", accepted: 0, remaining: 0 }]);
      expect(await stateOf(enrollment)).toMatchObject({ status: "pending" });
      expect(
        await owner("SELECT 1 FROM ledger_entry WHERE enrollment_id = $1", [enrollment]),
      ).toEqual([]);
    });

    it("keeps pending requests after a switch to Public, still for the team to decide (ADR-169)", async () => {
      const event = await newEvent();
      const { player, enrollment } = await asked(event);
      await owner("UPDATE event SET access = 'public' WHERE id = $1", [event.id]);
      expect(await join(player, event.code)).toMatchObject({
        outcome: "already",
        status: "pending",
      });
      expect(await decide(event.id, enrollment, true)).toBe("accepted");
    });

    it("lets only the event's own team decide: another organizer, an editor out of scope and a player get nothing", async () => {
      const event = await newEvent();
      const { player, enrollment } = await asked(event);
      const outOfScope = await addMember(db.owner, ids.orgA, "editor", [ids.eventA]);
      expect(
        await decide(event.id, enrollment, true, { organizerId: ids.orgB, staffUserId: ownerB }),
      ).toBe("not_found");
      expect(await decide(event.id, enrollment, true, teamA(outOfScope))).toBe("not_found");
      await expect(decide(event.id, enrollment, true, { playerId: player })).resolves.toBe(
        "not_found",
      );
      expect(
        await as(
          { organizerId: ids.orgB, staffUserId: ownerB },
          "SELECT * FROM join_requests($1, NULL, 50)",
          [event.id],
        ),
      ).toEqual([]);
      expect(
        await as(
          { organizerId: ids.orgB, staffUserId: ownerB },
          "SELECT * FROM accept_all_join_requests($1, $2)",
          [event.id, randomUUID()],
        ),
      ).toEqual([{ outcome: "not_found", accepted: 0, remaining: 0 }]);
      expect(await stateOf(enrollment)).toMatchObject({ status: "pending" });
    });

    it("lists pending and declined requests oldest first, by a cursor, public profile only", async () => {
      const event = await newEvent();
      const first = await asked(event);
      const second = await asked(event);
      const third = await asked(event);
      await decide(event.id, second.enrollment, false);
      await decide(event.id, third.enrollment, true);
      const page = await as<{ enrollment_id: string; status: string }>(
        teamA(editorA),
        "SELECT * FROM join_requests($1, NULL, 1)",
        [event.id],
      );
      expect(page.map((row) => [row.enrollment_id, row.status])).toEqual([
        [first.enrollment, "pending"],
      ]);
      expect(Object.keys(page[0] ?? {}).toSorted()).toEqual(
        ["avatar", "enrollment_id", "requested_at", "status", "username", "waitlisted"].toSorted(),
      );
      const next = await as<{ enrollment_id: string; status: string }>(
        teamA(),
        "SELECT * FROM join_requests($1, $2, 50)",
        [event.id, first.enrollment],
      );
      expect(next.map((row) => [row.enrollment_id, row.status])).toEqual([
        [second.enrollment, "declined"],
      ]);
    });
  });

  describe("bans of requests", () => {
    it("answers not_allowed for a pending or declined row, and the seats stay within the limit", async () => {
      const event = await newEvent({ limit: 1 });
      const pending = await asked(event);
      const declined = await asked(event);
      await decide(event.id, declined.enrollment, false);
      await decide(event.id, (await asked(event)).enrollment, true);
      for (const target of [pending.enrollment, declined.enrollment]) {
        for (const banned of [true, false]) {
          expect(
            (
              await as<{ outcome: string }>(
                teamA(),
                "SELECT set_enrollment_ban($1, $2, $3, $4) AS outcome",
                [event.id, target, banned, randomUUID()],
              )
            )[0]?.outcome,
          ).toBe("not_allowed");
        }
      }
      expect(await seats(event.id)).toBe(1);
    });
  });

  describe("seats count accepted players (ADR-168)", () => {
    it("never counts a request, and refuses an acceptance at the limit until it is raised", async () => {
      const event = await newEvent({ limit: 1 });
      const first = await asked(event);
      const second = await asked(event);
      expect(await seats(event.id)).toBe(0);
      expect(await decide(event.id, first.enrollment, true)).toBe("accepted");
      expect(await decide(event.id, second.enrollment, true)).toBe("full");
      expect(await stateOf(second.enrollment)).toEqual({ status: "pending", waitlisted: false });
      await owner("UPDATE event SET player_limit = 2 WHERE id = $1", [event.id]);
      expect(await decide(event.id, second.enrollment, true)).toBe("accepted");
      expect(await seats(event.id)).toBe(2);
    });

    it("answers full at a hard limit, puts a waitlist join on the list, and lets one in while a seat is free", async () => {
      const event = await newEvent({ access: "public", limit: 2 });
      expect(await join(await newPlayer(), event.code, true)).toMatchObject({
        outcome: "joined",
        status: "active",
        waitlisted: false,
      });
      await filled(event, 1);
      const late = await newPlayer();
      expect(await join(late, event.code)).toMatchObject({ outcome: "full", enrollment_id: null });
      const listed = await join(late, event.code, true);
      expect(listed).toMatchObject({ outcome: "joined", status: "pending", waitlisted: true });
      expect(await join(late, event.code, true)).toMatchObject({
        outcome: "already",
        waitlisted: true,
      });
      expect(await seats(event.id)).toBe(2);
      await owner("UPDATE event SET player_limit = 3 WHERE id = $1", [event.id]);
      expect(await decide(event.id, listed?.enrollment_id ?? "", true)).toBe("accepted");
      expect(await stateOf(listed?.enrollment_id ?? "")).toEqual({
        status: "active",
        waitlisted: false,
      });
    });

    it("answers already to an invited, waitlisted player rejoining a full event", async () => {
      const event = await newEvent({ access: "public", limit: 1 });
      await filled(event, 1);
      const email = `guest${randomUUID().slice(0, 6)}@example.com`;
      const guest = await newPlayer(email);
      expect(await join(guest, event.code, true)).toMatchObject({ waitlisted: true });
      await as(
        teamA(),
        "INSERT INTO event_guest (event_id, kind, value) VALUES ($1, 'email', $2)",
        [event.id, email],
      );
      expect(
        (
          await as<Joined>({ playerId: guest }, "SELECT * FROM join_invited($1, '0.2')", [event.id])
        )[0],
      ).toMatchObject({ outcome: "already", status: "pending", waitlisted: true });
    });

    it("clears the waiting list flag when the player leaves", async () => {
      const event = await newEvent({ access: "public", limit: 1 });
      await filled(event, 1);
      const player = await newPlayer();
      const listed = await join(player, event.code, true);
      await as({ playerId: player }, "UPDATE enrollment SET status = 'left' WHERE id = $1", [
        listed?.enrollment_id,
      ]);
      expect(await stateOf(listed?.enrollment_id ?? "")).toEqual({
        status: "left",
        waitlisted: false,
      });
    });

    it("lets one of two waitlist joins at the last seat in and lists the other", async () => {
      const event = await newEvent({ access: "public", limit: 1 });
      const pair = await clients(2);
      try {
        const players = [await newPlayer(), await newPlayer()];
        const answers = await Promise.all(
          pair.map((client, index) => join(players[index] ?? "", event.code, true, client)),
        );
        expect(answers.map((answer) => [answer?.status, answer?.waitlisted]).toSorted()).toEqual([
          ["active", false],
          ["pending", true],
        ]);
      } finally {
        await Promise.all(pair.map((client) => client.end()));
      }
      expect(await seats(event.id)).toBe(1);
    });

    it("accepts one of two requests at the last seat and answers full to the other", async () => {
      const event = await newEvent({ limit: 1 });
      const requests = [await asked(event), await asked(event)];
      const pair = await clients(2);
      try {
        const outcomes = await Promise.all(
          pair.map((client, index) =>
            decide(event.id, requests[index]?.enrollment ?? "", true, teamA(), client),
          ),
        );
        expect(outcomes.toSorted()).toEqual(["accepted", "full"]);
      } finally {
        await Promise.all(pair.map((client) => client.end()));
      }
      expect(await seats(event.id)).toBe(1);
    });
  });

  describe("accept all (FR-1825)", () => {
    it("accepts the oldest pending requests while seats are free, never a declined one, one audit row each", async () => {
      const event = await newEvent({ limit: 2 });
      const rows = [await asked(event), await asked(event), await asked(event), await asked(event)];
      await decide(event.id, rows[0]?.enrollment ?? "", false);
      const request = randomUUID();
      expect(
        await as(teamA(editorA), "SELECT * FROM accept_all_join_requests($1, $2)", [
          event.id,
          request,
        ]),
      ).toEqual([{ outcome: "done", accepted: 2, remaining: 1 }]);
      const states = await Promise.all(rows.map((row) => stateOf(row.enrollment)));
      expect(states.map((state) => state?.status)).toEqual([
        "declined",
        "active",
        "active",
        "pending",
      ]);
      expect(
        await owner(
          "SELECT count(*)::int AS n FROM audit_log WHERE request_id = $1 AND action = 'event.join_accept'",
          [request],
        ),
      ).toEqual([{ n: 2 }]);
      expect(
        await as(teamA(), "SELECT * FROM accept_all_join_requests($1, $2)", [
          event.id,
          randomUUID(),
        ]),
      ).toEqual([{ outcome: "done", accepted: 0, remaining: 1 }]);
    });

    it("accepts every pending request on an event without a hard limit", async () => {
      const event = await newEvent();
      await asked(event);
      await asked(event);
      expect(
        await as(teamA(), "SELECT * FROM accept_all_join_requests($1, $2)", [
          event.id,
          randomUUID(),
        ]),
      ).toEqual([{ outcome: "done", accepted: 2, remaining: 0 }]);
    });
  });

  describe("an operator who plays", () => {
    it("joins from a declined row, and answers full at a hard limit instead of raising", async () => {
      const event = await newEvent({ limit: 1 });
      const declined = await asked(event);
      await decide(event.id, declined.enrollment, false);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, true)",
        [ids.orgA, event.id, declined.player],
      );
      const play = (player: string) =>
        as<{ outcome: string }>(
          { playerId: player },
          "SELECT outcome FROM enroll_operator($1, '0.2')",
          [event.id],
        );
      expect(await play(declined.player)).toEqual([{ outcome: "joined" }]);
      const late = await newPlayer();
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, can_play) VALUES ($1, $2, $3, true)",
        [ids.orgA, event.id, late],
      );
      expect(await play(late)).toEqual([{ outcome: "full" }]);
    });
  });

  describe("the API role's reach", () => {
    it("cannot write the waiting list flag, on insert or update", async () => {
      const event = await newEvent({ access: "public", limit: 1 });
      await filled(event, 1);
      const player = await newPlayer();
      const listed = await join(player, event.code, true);
      await expect(
        as({ playerId: player }, "UPDATE enrollment SET waitlisted = false WHERE id = $1", [
          listed?.enrollment_id,
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(
          teamA(),
          "INSERT INTO enrollment (organizer_id, event_id, player_id, waitlisted) VALUES ($1, $2, $3, true)",
          [ids.orgA, event.id, await newPlayer()],
        ),
      ).rejects.toThrow(/permission denied/);
      expect(
        await owner<{ privilege_type: string; column_name: string }>(
          `SELECT privilege_type, column_name FROM information_schema.column_privileges
           WHERE table_name = 'enrollment' AND grantee = 'questify_app' AND privilege_type = 'UPDATE'`,
        ),
      ).toEqual([{ privilege_type: "UPDATE", column_name: "status" }]);
    });
  });
});
