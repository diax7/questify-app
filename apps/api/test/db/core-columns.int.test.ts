import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";
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
      for (const context of [{ organizerId: ids.orgA, staffUserId: owner }, { isAdmin: true }]) {
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
    it("lets a player join a public live event by its code, through join_event only (T-111)", async () => {
      await as({ playerId: ids.playerB }, "SELECT join_event('NAJD1', 'code', '0.1')");
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
          "INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at) VALUES ($1, 'OPEN2', 'Open', 'live', now() - interval '1 hour', now() + interval '30 days') RETURNING id",
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
        { organizerId: ids.orgA, staffUserId: owner },
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

    it("lets a player change their own avatar and delete their own account, but never rename directly", async () => {
      for (const column of ["username = 'sara_new'", "birth_year = 1990"]) {
        await expect(
          as({ playerId: ids.playerA }, `UPDATE player SET ${column} WHERE id = $1`, [ids.playerA]),
        ).rejects.toThrow(/permission denied/);
      }
      await as({ playerId: ids.playerA }, "UPDATE player SET avatar = 'owl' WHERE id = $1", [
        ids.playerA,
      ]);
      await as({ playerId: ids.playerA }, "UPDATE player SET status = 'deleted' WHERE id = $1", [
        ids.playerA,
      ]);
      const rows = (
        await db.owner.query("SELECT username, avatar, status FROM player WHERE id = $1", [
          ids.playerA,
        ])
      ).rows;
      expect(rows).toEqual([{ username: "sara_k", avatar: "owl", status: "deleted" }]);
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
      const players = await as(
        { organizerId: ids.orgA, staffUserId: owner },
        "SELECT username FROM player",
      );
      expect(players.length).toBeGreaterThan(0);
      expect(
        await as({ organizerId: ids.orgA, staffUserId: owner }, "SELECT * FROM player_contact"),
      ).toEqual([]);
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
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: editor },
          "UPDATE organizer_member SET role = 'owner' WHERE staff_user_id = $1",
          [editor],
        ),
      ).rejects.toThrow(/permission denied/);
      const rows = (
        await db.owner.query<{ role: string; event_scope: string[] | null }>(
          "SELECT role, event_scope FROM organizer_member WHERE staff_user_id = $1",
          [editor],
        )
      ).rows;
      expect(rows).toEqual([{ role: "editor", event_scope: [ids.eventA] }]);
    });

    it("cannot gain members by a bare insert, from an editor or even the owner: only invites add members", async () => {
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: editor },
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
          [ids.orgA, stranger],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: owner },
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
          [ids.orgA, stranger],
        ),
      ).rejects.toThrow(/permission denied/);
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
        ).rejects.toThrow(/permission denied/);
      }
    });

    it("is created together with its first owner, acceptances and audit entry, by an active staff user only", async () => {
      const [created] = await as(
        { staffUserId: stranger },
        "SELECT create_organizer('Fresh Co', 'fresh-co', '0.1', '0.1', '0.1', NULL) AS id",
      );
      const id = (created as { id: string }).id;
      const members = (
        await db.owner.query(
          "SELECT staff_user_id, role FROM organizer_member WHERE organizer_id = $1",
          [id],
        )
      ).rows;
      expect(members).toEqual([{ staff_user_id: stranger, role: "owner" }]);
      const accepted = (
        await db.owner.query(
          "SELECT document, version, accepted_by FROM organizer_acceptance WHERE organizer_id = $1 ORDER BY document",
          [id],
        )
      ).rows;
      expect(accepted).toEqual(
        ["organizer_content_rules", "organizer_dpa", "organizer_terms"].map((document) => ({
          document,
          version: "0.1",
          accepted_by: stranger,
        })),
      );
      const audit = (
        await db.owner.query("SELECT actor_id, action FROM audit_log WHERE organizer_id = $1", [id])
      ).rows;
      expect(audit).toEqual([{ actor_id: stranger, action: "organizer.create" }]);
      await expect(
        as({}, "SELECT create_organizer('Nobody', 'nobody', '0.1', '0.1', '0.1', NULL)"),
      ).rejects.toThrow(/signed-in staff/);
      const disabled = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO staff_user (email, password_hash, status) VALUES ('off@najd.sa', 'h', 'disabled') RETURNING id",
        )
      ).rows[0]?.id as string;
      await expect(
        as(
          { staffUserId: disabled },
          "SELECT create_organizer('Off Co', 'off-co', '0.1', '0.1', '0.1', NULL)",
        ),
      ).rejects.toThrow(/signed-in staff/);
    });

    it("keeps acceptances append-only for the API", async () => {
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: owner },
          "INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by) VALUES ($1, 'organizer_terms', '9.9', $2)",
          [ids.orgA, owner],
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as({ organizerId: ids.orgA, staffUserId: owner }, "DELETE FROM organizer_acceptance"),
      ).rejects.toThrow(/permission denied/);
    });

    it("refuses a bare organizer row from anyone but an admin", async () => {
      await expect(
        as({ staffUserId: stranger }, "INSERT INTO organizer (name, slug) VALUES ('Bare', 'bare')"),
      ).rejects.toThrow(/row-level security/);
    });

    it("never loses its owner: an owner cannot demote or remove themselves", async () => {
      const ownerContext = { organizerId: ids.orgA, staffUserId: owner };
      await expect(
        as(ownerContext, "UPDATE organizer_member SET role = 'editor' WHERE staff_user_id = $1", [
          owner,
        ]),
      ).rejects.toThrow(/permission denied/);
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
      ).rejects.toThrow(/permission denied/);
    });

    it("changes owner only through an owner invite accepted by its addressee", async () => {
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await db.owner.query(
        `INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, 'editor@najd.sa', 'owner', decode($2, 'hex'), $3, now() + interval '7 days')`,
        [ids.orgA, tokenHash, owner],
      );
      const accept = (who: string) =>
        withPreIdentityContext(db.app, { kind: "invite", tokenHash }, async ({ promote }) => {
          await promote(who);
          return (await db.app.query("SELECT accept_invite(NULL) AS organizer")).rows;
        });
      await expect(accept(stranger)).rejects.toThrow(/another email address/);
      expect(await accept(editor)).toEqual([{ organizer: ids.orgA }]);
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
      await expect(accept(editor)).rejects.toThrow(/expired or was already used/);
      // Hand the organizer back for the other tests, the same way.
      const back = randomBytes(32).toString("hex");
      const backHash = createHash("sha256").update(back).digest("hex");
      await db.owner.query(
        `INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, 'owner@najd.sa', 'owner', decode($2, 'hex'), $3, now() + interval '7 days')`,
        [ids.orgA, backHash, editor],
      );
      await withPreIdentityContext(
        db.app,
        { kind: "invite", tokenHash: backHash },
        async ({ promote }) => {
          await promote(owner);
          await db.app.query("SELECT accept_invite(NULL)");
        },
      );
      await db.owner.query(
        "UPDATE organizer_member SET event_scope = ARRAY[$2]::uuid[] WHERE staff_user_id = $1",
        [editor, ids.eventA],
      );
    });

    it("refuses an owner invite whose sender no longer owns the organizer", async () => {
      const tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
      await db.owner.query(
        `INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, 'stranger@najd.sa', 'owner', decode($2, 'hex'), $3, now() + interval '7 days')`,
        [ids.orgA, tokenHash, editor],
      );
      await expect(
        withPreIdentityContext(db.app, { kind: "invite", tokenHash }, async ({ promote }) => {
          await promote(stranger);
          await db.app.query("SELECT accept_invite(NULL)");
        }),
      ).rejects.toThrow(/no longer owns/);
      await db.owner.query("DELETE FROM organizer_invite WHERE token_hash = decode($1, 'hex')", [
        tokenHash,
      ]);
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
