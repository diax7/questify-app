import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("database isolation", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let memberA: string;
  /** A member of organizer A acting in its name. */
  const seatA = () => ({ organizerId: ids.orgA, staffUserId: memberA });

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    memberA = await addMember(db.owner, ids.orgA, "editor");
  });
  afterAll(async () => {
    await db.close();
  });

  const as = <T>(
    context: Parameters<typeof withRequestContext>[1],
    sql: string,
    values: unknown[] = [],
  ) =>
    withRequestContext(
      db.app,
      context,
      async () => (await db.app.query<T & Record<string, unknown>>(sql, values)).rows,
    );

  describe("tenant isolation (the API's role)", () => {
    it("shows an unidentified caller no private data, only public live events", async () => {
      expect(await as({}, "SELECT id FROM enrollment")).toEqual([]);
      expect(await as({}, "SELECT id FROM player")).toEqual([]);
      expect(await as({}, "SELECT id FROM staff_user")).toEqual([]);
      expect(await as({}, "SELECT staff_user_id FROM organizer_member")).toEqual([]);
      expect((await as<{ id: string }>({}, "SELECT id FROM event")).map((r) => r.id)).toEqual([
        ids.eventA,
      ]);
    });

    it("lets organizer A read only its own enrollments and players", async () => {
      const enrollments = await as<{ organizer_id: string }>(
        seatA(),
        "SELECT organizer_id FROM enrollment",
      );
      expect(enrollments.map((r) => r.organizer_id)).toEqual([ids.orgA]);
      const players = await as<{ username: string }>(seatA(), "SELECT username FROM player");
      expect(players.map((r) => r.username)).toEqual(["sara_k"]);
    });

    it("hides organizer B's private event from organizer A", async () => {
      const events = await as<{ id: string }>(seatA(), "SELECT id FROM event");
      expect(events.map((r) => r.id)).toEqual([ids.eventA]);
    });

    it("refuses organizer A creating an event under organizer B", async () => {
      await expect(
        as(
          seatA(),
          "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'EVIL1', 'x')",
          [ids.orgB],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("changes nothing when organizer A updates or deletes organizer B's event", async () => {
      await as(seatA(), "UPDATE event SET name_en = 'hacked' WHERE id = $1", [ids.eventB]);
      await as(seatA(), "DELETE FROM event WHERE id = $1", [ids.eventB]);
      const { rows } = await db.owner.query("SELECT name_en FROM event WHERE id = $1", [
        ids.eventB,
      ]);
      expect(rows).toEqual([{ name_en: "Winter Fest" }]);
    });

    it("refuses moving an own event to another organizer: the column is not writable at all", async () => {
      await expect(
        as(seatA(), "UPDATE event SET organizer_id = $1 WHERE id = $2", [ids.orgB, ids.eventA]),
      ).rejects.toThrow(/permission denied/);
    });

    it("lets a player see only their own enrollments and themselves", async () => {
      const enrollments = await as<{ player_id: string }>(
        { playerId: ids.playerA },
        "SELECT player_id FROM enrollment",
      );
      expect(enrollments.map((r) => r.player_id)).toEqual([ids.playerA]);
      const players = await as<{ id: string }>({ playerId: ids.playerA }, "SELECT id FROM player");
      expect(players.map((r) => r.id)).toEqual([ids.playerA]);
    });

    it("refuses a player enrolling someone else", async () => {
      await expect(
        as(
          { playerId: ids.playerA },
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          [ids.orgA, ids.eventA, ids.playerB],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("lets a Questify admin see everything", async () => {
      expect(await as({ isAdmin: true }, "SELECT id FROM organizer")).toHaveLength(2);
      expect(await as({ isAdmin: true }, "SELECT id FROM enrollment")).toHaveLength(2);
    });

    it("opens nothing for an organizer context without a member (no staff member, no tenant)", async () => {
      const outsider = await addMember(db.owner, ids.orgB, "editor");
      for (const context of [
        { organizerId: ids.orgA },
        { organizerId: ids.orgA, staffUserId: outsider },
      ]) {
        expect(await as(context, "SELECT 1 FROM enrollment")).toEqual([]);
        expect(await as(context, "SELECT 1 FROM player")).toEqual([]);
        expect(await as(context, "SELECT 1 FROM audit_log")).toEqual([]);
        const events = await as<{ id: string }>(context, "SELECT id FROM event");
        expect(events.map((row) => row.id)).toEqual([ids.eventA]);
        await expect(
          as(
            context,
            "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'FORGED', 'x')",
            [ids.orgA],
          ),
        ).rejects.toThrow(/row-level security/);
      }
    });

    it("forgets the context when the transaction ends", async () => {
      await as(seatA(), "SELECT 1");
      expect(await as({}, "SELECT id FROM enrollment")).toEqual([]);
    });

    it("rejects a context id that is not a UUID before talking to the database", async () => {
      await expect(as({ organizerId: "1' OR '1'='1" }, "SELECT 1")).rejects.toThrow(RangeError);
    });
  });

  describe("data rules", () => {
    it("keeps an enrollment's organizer equal to its event's organizer", async () => {
      await expect(
        db.owner.query(
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          [ids.orgB, ids.eventA, ids.playerB],
        ),
      ).rejects.toThrow(/foreign key/);
    });
    it("treats usernames as unique ignoring case", async () => {
      await expect(
        db.owner.query("INSERT INTO player (username) VALUES ('SARA_K')"),
      ).rejects.toThrow(/duplicate key/);
    });
    it("allows only Saudi (+966) phone numbers", async () => {
      await expect(
        db.owner.query(
          "INSERT INTO player_contact (player_id, phone_e164) VALUES ($1, '+971501234567')",
          [ids.playerA],
        ),
      ).rejects.toThrow(/check/);
    });
    it("allows only one owner per organizer", async () => {
      const { rows } = await db.owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash) VALUES ('a@x.sa', 'x'), ('b@x.sa', 'x') RETURNING id",
      );
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [ids.orgA, rows[0]?.id],
      );
      await expect(
        db.owner.query(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
          [ids.orgA, rows[1]?.id],
        ),
      ).rejects.toThrow(/duplicate key/);
    });
  });
});
