import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

// The foundation review (2026-10-19) proved each of these was possible before migration 0005. Each test is that probe.
describe.skipIf(TEST_DATABASE_URL === undefined)("core columns are closed to hand edits", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let owner: string;
  let editor: string;
  let stranger: string;
  let draftB: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    const staff = async (email: string): Promise<string> =>
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO staff_user (email, password_hash) VALUES ($1, 'h') RETURNING id",
          [email],
        )
      ).rows[0]?.id ?? "";
    owner = await staff("owner@najd.sa");
    editor = await staff("editor@najd.sa");
    stranger = await staff("stranger@najd.sa");
    await db.owner.query(
      `INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope)
       VALUES ($1, $2, 'owner', NULL), ($1, $3, 'editor', ARRAY[$4]::uuid[])`,
      [ids.orgA, owner, editor, ids.eventA],
    );
    draftB =
      (
        await db.owner.query<{ id: string }>(
          "INSERT INTO event (organizer_id, join_code, name_en, status, access) VALUES ($1, 'DRAFTB', 'Secret', 'draft', 'private') RETURNING id",
          [ids.orgB],
        )
      ).rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await db.close();
  });

  const as = (context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query(sql, values)).rows);

  const enrollmentOf = async (player: string) =>
    (
      await db.owner.query<{ score: string; balance: string; status: string }>(
        "SELECT score, balance, status FROM enrollment WHERE player_id = $1 ORDER BY joined_at LIMIT 1",
        [player],
      )
    ).rows[0];

  describe("points", () => {
    it("cannot be set by a player on their own enrollment", async () => {
      await expect(
        as({ playerId: ids.playerA }, "UPDATE enrollment SET score = 999999, balance = 999999"),
      ).rejects.toThrow(/permission denied/);
      expect(await enrollmentOf(ids.playerA)).toMatchObject({ score: "0", balance: "0" });
    });

    it("cannot be set by the organizer or an admin either: only the points ledger may move them", async () => {
      for (const context of [{ organizerId: ids.orgA }, { isAdmin: true }]) {
        await expect(as(context, "UPDATE enrollment SET balance = 5")).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it("cannot be given at enrollment", async () => {
      await expect(
        as(
          { playerId: ids.playerB },
          "INSERT INTO enrollment (organizer_id, event_id, player_id, score, balance) VALUES ($1, $2, $3, 500, 500)",
          [ids.orgA, ids.eventA, ids.playerB],
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("enrollment", () => {
    it("lets a player join a public live event they can see", async () => {
      await as(
        { playerId: ids.playerB },
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
        [ids.orgA, ids.eventA, ids.playerB],
      );
      expect(await enrollmentOf(ids.playerB)).toBeDefined();
    });

    it("refuses a player joining another organizer's private draft event", async () => {
      await expect(
        as(
          { playerId: ids.playerA },
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          [ids.orgB, draftB, ids.playerA],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("refuses a player joining as banned or removed", async () => {
      const event = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'OPEN2', 'Open', 'live') RETURNING id",
          [ids.orgA],
        )
      ).rows[0]?.id;
      await expect(
        as(
          { playerId: ids.playerA },
          "INSERT INTO enrollment (organizer_id, event_id, player_id, status) VALUES ($1, $2, $3, 'removed')",
          [ids.orgA, event, ids.playerA],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("lets a player leave, but not lift their own ban", async () => {
      await db.owner.query("UPDATE enrollment SET status = 'banned' WHERE player_id = $1", [
        ids.playerA,
      ]);
      await expect(
        as({ playerId: ids.playerA }, "UPDATE enrollment SET status = 'active'"),
      ).rejects.toThrow(/not allowed/);
      expect((await enrollmentOf(ids.playerA))?.status).toBe("banned");

      await as({ playerId: ids.playerB }, "UPDATE enrollment SET status = 'left'");
      expect((await enrollmentOf(ids.playerB))?.status).toBe("left");
    });

    it("lets the event's organizer change a status", async () => {
      await as(
        { organizerId: ids.orgA },
        "UPDATE enrollment SET status = 'active' WHERE player_id = $1",
        [ids.playerA],
      );
      expect((await enrollmentOf(ids.playerA))?.status).toBe("active");
    });
  });

  describe("player standing", () => {
    it("cannot be changed by the player: no lifting a platform ban", async () => {
      await db.owner.query("UPDATE player SET status = 'banned' WHERE id = $1", [ids.playerA]);
      await expect(
        as({ playerId: ids.playerA }, "UPDATE player SET status = 'active' WHERE id = $1", [
          ids.playerA,
        ]),
      ).rejects.toThrow(/Questify admin/);
      await as({ isAdmin: true }, "UPDATE player SET status = 'active' WHERE id = $1", [
        ids.playerA,
      ]);
    });

    it("lets a player change their own username and delete their own account", async () => {
      await as({ playerId: ids.playerA }, "UPDATE player SET username = 'sara_new' WHERE id = $1", [
        ids.playerA,
      ]);
      await as({ playerId: ids.playerA }, "UPDATE player SET status = 'deleted' WHERE id = $1", [
        ids.playerA,
      ]);
      const rows = (
        await db.owner.query("SELECT username, status FROM player WHERE id = $1", [ids.playerA])
      ).rows;
      expect(rows).toEqual([{ username: "sara_new", status: "deleted" }]);
      await db.owner.query("UPDATE player SET status = 'active' WHERE id = $1", [ids.playerA]);
    });

    it("cannot be set when a player is created", async () => {
      await expect(
        as({ isAdmin: true }, "INSERT INTO player (username, status) VALUES ('newbie', 'banned')"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("contact details", () => {
    it("are hidden from the organizer of a player's event", async () => {
      const players = await as({ organizerId: ids.orgA }, "SELECT username FROM player");
      expect(players.length).toBeGreaterThan(0);
      expect(await as({ organizerId: ids.orgA }, "SELECT * FROM player_contact")).toEqual([]);
    });

    it("are visible to the player and to Questify admins", async () => {
      expect(await as({ playerId: ids.playerA }, "SELECT email FROM player_contact")).toEqual([
        { email: "sara@example.com" },
      ]);
      expect(await as({ isAdmin: true }, "SELECT 1 FROM player_contact")).toHaveLength(2);
    });

    it("are no longer columns of the player table", async () => {
      const columns = (
        await db.owner.query<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'player'",
        )
      ).rows.map((row) => row.column_name);
      expect(columns).not.toContain("email");
      expect(columns).not.toContain("phone_e164");
    });
  });

  describe("organizer team", () => {
    it("cannot be changed by an editor: no widening their own scope, no making themselves owner", async () => {
      await as(
        { organizerId: ids.orgA, staffUserId: editor },
        "UPDATE organizer_member SET event_scope = NULL WHERE staff_user_id = $1",
        [editor],
      );
      await as(
        { organizerId: ids.orgA, staffUserId: editor },
        "UPDATE organizer_member SET role = 'owner' WHERE staff_user_id = $1",
        [editor],
      );
      const rows = (
        await db.owner.query<{ role: string; event_scope: string[] | null }>(
          "SELECT role, event_scope FROM organizer_member WHERE staff_user_id = $1",
          [editor],
        )
      ).rows;
      expect(rows).toEqual([{ role: "editor", event_scope: [ids.eventA] }]);
    });

    it("cannot gain members added by an editor", async () => {
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: editor },
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
          [ids.orgA, stranger],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("can be changed by the owner", async () => {
      await as(
        { organizerId: ids.orgA, staffUserId: owner },
        "UPDATE organizer_member SET event_scope = NULL WHERE staff_user_id = $1",
        [editor],
      );
      const rows = (
        await db.owner.query("SELECT event_scope FROM organizer_member WHERE staff_user_id = $1", [
          editor,
        ])
      ).rows;
      expect(rows).toEqual([{ event_scope: null }]);
    });

    it("cannot be claimed by a stranger, even for an organizer with no owner", async () => {
      const orphan = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Orphan', 'orphan') RETURNING id",
        )
      ).rows[0]?.id;
      for (const target of [orphan, ids.orgB]) {
        await expect(
          as(
            { staffUserId: stranger },
            "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
            [target, stranger],
          ),
        ).rejects.toThrow(/row-level security/);
      }
    });

    it("is created together with its first owner, by a signed-in staff user only", async () => {
      const [created] = await as(
        { staffUserId: stranger },
        "SELECT create_organizer('Fresh Co', 'fresh-co') AS id",
      );
      const id = (created as { id: string }).id;
      const rows = (
        await db.owner.query(
          "SELECT staff_user_id, role FROM organizer_member WHERE organizer_id = $1",
          [id],
        )
      ).rows;
      expect(rows).toEqual([{ staff_user_id: stranger, role: "owner" }]);
      await expect(as({}, "SELECT create_organizer('Nobody', 'nobody')")).rejects.toThrow(
        /signed-in staff/,
      );
    });

    it("refuses a bare organizer row from anyone but an admin", async () => {
      await expect(
        as({ staffUserId: stranger }, "INSERT INTO organizer (name, slug) VALUES ('Bare', 'bare')"),
      ).rejects.toThrow(/row-level security/);
    });

    it("never loses its owner: an owner cannot demote or remove themselves", async () => {
      const ownerContext = { organizerId: ids.orgA, staffUserId: owner };
      await as(
        ownerContext,
        "UPDATE organizer_member SET role = 'editor' WHERE staff_user_id = $1",
        [owner],
      );
      await as(ownerContext, "DELETE FROM organizer_member WHERE staff_user_id = $1", [owner]);
      const rows = (
        await db.owner.query("SELECT role FROM organizer_member WHERE staff_user_id = $1", [owner])
      ).rows;
      expect(rows).toEqual([{ role: "owner" }]);
    });

    it("cannot make a second owner by promoting an editor directly", async () => {
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: owner },
          "UPDATE organizer_member SET role = 'owner' WHERE staff_user_id = $1",
          [editor],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("changes owner only through a transfer by the owner, to an existing editor", async () => {
      await expect(
        as({ staffUserId: editor }, "SELECT transfer_ownership($1, $2)", [ids.orgA, editor]),
      ).rejects.toThrow(/only the owner/);
      await expect(
        as({ staffUserId: owner }, "SELECT transfer_ownership($1, $2)", [ids.orgA, stranger]),
      ).rejects.toThrow(/already be an editor/);
      await as({ staffUserId: owner }, "SELECT transfer_ownership($1, $2)", [ids.orgA, editor]);
      const rows = (
        await db.owner.query<{ staff_user_id: string; role: string }>(
          "SELECT staff_user_id, role FROM organizer_member WHERE organizer_id = $1 ORDER BY role",
          [ids.orgA],
        )
      ).rows;
      expect(rows).toEqual([
        { staff_user_id: owner, role: "editor" },
        { staff_user_id: editor, role: "owner" },
      ]);
      await as({ staffUserId: editor }, "SELECT transfer_ownership($1, $2)", [ids.orgA, owner]);
    });

    it("cannot be removed by an editor", async () => {
      await as(
        { organizerId: ids.orgA, staffUserId: editor },
        "DELETE FROM organizer_member WHERE staff_user_id = $1",
        [owner],
      );
      const rows = (
        await db.owner.query("SELECT 1 FROM organizer_member WHERE staff_user_id = $1", [owner])
      ).rows;
      expect(rows).toHaveLength(1);
    });
  });
});
