import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { withPreIdentityContext } from "#src/db/pre-identity";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const tokenHash = (): string => createHash("sha256").update(randomBytes(32)).digest("hex");
/** The stored code HMAC of every seeded sign-up; the API computes this from the code typed. */
const CODE_HASH = createHash("sha256").update("the right code").digest();
const ARGON =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA";

/**
 * The organizer team in the database (T-101, migration 0008): editor event limits on every table that names an
 * event, the limit's own rules, leaving, and the definer functions for sign-up and invites.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("organizer team (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let owner: string;
  let limited: string;
  let unlimited: string;
  let eventA2: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    eventA2 = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en, status, access) VALUES ($1, 'NAJD2', 'Second', 'draft', 'private') RETURNING id",
        [ids.orgA],
      )
    ).rows[0]?.id as string;
    await db.owner.query(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
      [ids.orgA, eventA2, ids.playerB],
    );
    owner = await addMember(db.owner, ids.orgA, "owner");
    limited = await addMember(db.owner, ids.orgA, "editor", [ids.eventA]);
    unlimited = await addMember(db.owner, ids.orgA, "editor");
    await db.owner.query(
      `INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type)
       VALUES ('staff', $1, $2, $3, 'event.seed', 'event'), ('staff', $1, $2, $4, 'event.seed', 'event'),
              ('staff', $1, $2, NULL, 'organizer.member.invite', 'organizer_invite')`,
      [owner, ids.orgA, ids.eventA, eventA2],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  const as = async <T extends Record<string, unknown>>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const seat = (staffUserId: string): RequestContext => ({ organizerId: ids.orgA, staffUserId });

  const addInvite = async (
    email: string,
    expires = "now() + interval '7 days'",
  ): Promise<string> => {
    const hash = tokenHash();
    await db.owner.query(
      `INSERT INTO organizer_invite (organizer_id, email, role, event_scope, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'editor', ARRAY[$3]::uuid[], decode($4, 'hex'), $5, ${expires})`,
      [ids.orgA, email, ids.eventA, hash, owner],
    );
    return hash;
  };
  const acceptNew = (hash: string, passwordHash: string) =>
    withPreIdentityContext(
      db.app,
      { kind: "invite", tokenHash: hash },
      async () =>
        (
          await db.app.query<{ staff_user_id: string; organizer_id: string }>(
            "SELECT * FROM accept_invite_new($1, NULL)",
            [passwordHash],
          )
        ).rows[0],
    );

  const addSignup = async (fields: {
    email: string;
    passwordHash: string | null;
    expires?: string;
    attempts?: number;
  }): Promise<string> => {
    const hash = tokenHash();
    await db.owner.query(
      `INSERT INTO staff_signup (token_hash, code_hash, email, password_hash, organizer_name, accepted_terms,
                                 accepted_dpa, accepted_content, attempts, expires_at)
       VALUES (decode($1, 'hex'), decode($2, 'hex'), $3, $4, 'Riyadh Expo', '0.1', '0.1', '0.1', $5, ${fields.expires ?? "now() + interval '10 minutes'"})`,
      [hash, CODE_HASH.toString("hex"), fields.email, fields.passwordHash, fields.attempts ?? 0],
    );
    return hash;
  };
  const complete = (hash: string, slug: string, code: Buffer = CODE_HASH) =>
    withPreIdentityContext(
      db.app,
      { kind: "signup", tokenHash: hash },
      async () =>
        (
          await db.app.query<{ staff_user_id: string; organizer_id: string }>(
            "SELECT * FROM complete_signup($1, $2, NULL)",
            [slug, code],
          )
        ).rows[0],
    );

  describe("an editor limited to one event", () => {
    it("sees only that event, its enrollments and its players", async () => {
      const events = await as<{ id: string }>(
        seat(limited),
        "SELECT id FROM event WHERE organizer_id = $1",
        [ids.orgA],
      );
      expect(events.map((row) => row.id)).toEqual([ids.eventA]);
      const enrollments = await as<{ event_id: string }>(
        seat(limited),
        "SELECT event_id FROM enrollment",
      );
      expect(enrollments.map((row) => row.event_id)).toEqual([ids.eventA]);
      const players = await as<{ id: string }>(seat(limited), "SELECT id FROM player");
      expect(players.map((row) => row.id)).toEqual([ids.playerA]);
    });

    it("cannot change or delete the other event or its enrollments, even with a bare statement", async () => {
      await as(seat(limited), "UPDATE event SET name_en = 'changed' WHERE id = $1", [eventA2]);
      await as(seat(limited), "DELETE FROM event WHERE id = $1", [eventA2]);
      await as(seat(limited), "UPDATE enrollment SET status = 'banned' WHERE event_id = $1", [
        eventA2,
      ]);
      const event = await db.owner.query("SELECT name_en FROM event WHERE id = $1", [eventA2]);
      expect(event.rows).toEqual([{ name_en: "Second" }]);
      const enrollment = await db.owner.query("SELECT status FROM enrollment WHERE event_id = $1", [
        eventA2,
      ]);
      expect(enrollment.rows).toEqual([{ status: "active" }]);
    });

    it("reads the audit entries of their event and of the organizer, not of the other event", async () => {
      const rows = await as<{ event_id: string | null }>(
        seat(limited),
        "SELECT event_id FROM audit_log WHERE organizer_id = $1 ORDER BY event_id NULLS LAST",
        [ids.orgA],
      );
      expect(rows.map((row) => row.event_id)).toEqual([ids.eventA, null]);
    });

    it("cannot create an event, which would fall outside the limit", async () => {
      await expect(
        as(
          seat(limited),
          "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'LIMIT1', 'x')",
          [ids.orgA],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe("an unlimited editor and the owner", () => {
    it("see every event of the organizer and may create one", async () => {
      for (const who of [unlimited, owner]) {
        const events = await as<{ id: string }>(
          seat(who),
          "SELECT id FROM event WHERE organizer_id = $1",
          [ids.orgA],
        );
        expect(events.map((row) => row.id).toSorted()).toEqual([ids.eventA, eventA2].toSorted());
        expect(await as(seat(who), "SELECT 1 FROM enrollment")).toHaveLength(2);
      }
      await as(
        seat(unlimited),
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'FREE01', 'x')",
        [ids.orgA],
      );
    });
  });

  describe("the limit itself", () => {
    it("never empty: NULL means every event", async () => {
      await expect(
        db.owner.query("UPDATE organizer_member SET event_scope = '{}' WHERE staff_user_id = $1", [
          limited,
        ]),
      ).rejects.toThrow(/organizer_member_scope_not_empty/);
    });

    it("names only this organizer's events, whoever writes it", async () => {
      await expect(
        db.owner.query(
          "UPDATE organizer_member SET event_scope = ARRAY[$2]::uuid[] WHERE staff_user_id = $1",
          [limited, ids.eventB],
        ),
      ).rejects.toThrow(/only this organizer's events/);
    });

    it("is changed by the owner only, and roles by nobody through the API's role", async () => {
      await as(
        seat(limited),
        "UPDATE organizer_member SET event_scope = NULL WHERE staff_user_id = $1",
        [limited],
      );
      const still = await db.owner.query(
        "SELECT event_scope FROM organizer_member WHERE staff_user_id = $1",
        [limited],
      );
      expect(still.rows).toEqual([{ event_scope: [ids.eventA] }]);
      await as(
        seat(owner),
        "UPDATE organizer_member SET event_scope = ARRAY[$2]::uuid[] WHERE staff_user_id = $1",
        [unlimited, eventA2],
      );
      await as(
        seat(owner),
        "UPDATE organizer_member SET event_scope = NULL WHERE staff_user_id = $1",
        [unlimited],
      );
      await expect(
        as(seat(owner), "UPDATE organizer_member SET role = 'editor' WHERE staff_user_id = $1", [
          unlimited,
        ]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("leaving", () => {
    it("lets an editor leave, but never the owner", async () => {
      const leaver = await addMember(db.owner, ids.orgA, "editor");
      await as(
        seat(leaver),
        "DELETE FROM organizer_member WHERE staff_user_id = $1 AND organizer_id = $2",
        [leaver, ids.orgA],
      );
      await as(
        seat(owner),
        "DELETE FROM organizer_member WHERE staff_user_id = $1 AND organizer_id = $2",
        [owner, ids.orgA],
      );
      const left = await db.owner.query(
        "SELECT staff_user_id FROM organizer_member WHERE staff_user_id = ANY($1)",
        [[leaver, owner]],
      );
      expect(left.rows).toEqual([{ staff_user_id: owner }]);
    });

    it("does not let an editor remove someone else", async () => {
      await as(seat(unlimited), "DELETE FROM organizer_member WHERE staff_user_id = $1", [limited]);
      const rows = await db.owner.query("SELECT 1 FROM organizer_member WHERE staff_user_id = $1", [
        limited,
      ]);
      expect(rows.rows).toHaveLength(1);
    });
  });

  describe("completing a sign-up", () => {
    it("creates the account, the organizer with its owner and acceptances, and removes the pending row", async () => {
      const hash = await addSignup({ email: "fresh.owner@riyadh.test", passwordHash: ARGON });
      const done = await complete(hash, "riyadh-expo-a1b2c3");
      const member = await db.owner.query(
        "SELECT role FROM organizer_member WHERE staff_user_id = $1 AND organizer_id = $2",
        [done?.staff_user_id, done?.organizer_id],
      );
      expect(member.rows).toEqual([{ role: "owner" }]);
      const accepted = await db.owner.query(
        "SELECT count(*)::int AS n FROM organizer_acceptance WHERE organizer_id = $1",
        [done?.organizer_id],
      );
      expect(accepted.rows).toEqual([{ n: 3 }]);
      const audit = await db.owner.query<{ action: string }>(
        "SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY id",
        [done?.staff_user_id],
      );
      expect(audit.rows.map((row) => row.action)).toEqual(["staff.signup", "organizer.create"]);
      const pending = await db.owner.query(
        "SELECT 1 FROM staff_signup WHERE token_hash = decode($1, 'hex')",
        [hash],
      );
      expect(pending.rows).toEqual([]);
    });

    it.each([
      [
        "an email that already had an account (no password kept)",
        { email: "x1@riyadh.test", passwordHash: null },
      ],
      [
        "an expired sign-up",
        { email: "x2@riyadh.test", passwordHash: ARGON, expires: "now() - interval '1 second'" },
      ],
      [
        "a sign-up with no attempts left",
        { email: "x3@riyadh.test", passwordHash: ARGON, attempts: 5 },
      ],
    ])("refuses %s", async (_label, fields) => {
      const hash = await addSignup(fields);
      await expect(complete(hash, `slug-${randomBytes(3).toString("hex")}`)).rejects.toThrow(
        /cannot be completed/,
      );
    });

    it("refuses without a token: a bare call opens nothing", async () => {
      await expect(
        withRequestContext(db.app, {}, () =>
          db.app.query("SELECT * FROM complete_signup('nothing', $1, NULL)", [CODE_HASH]),
        ),
      ).rejects.toThrow(/cannot be completed/);
    });

    it("refuses a code that is not the emailed one, and leaves the sign-up waiting", async () => {
      const hash = await addSignup({ email: "wrong.code@riyadh.test", passwordHash: ARGON });
      const wrong = createHash("sha256").update("a guess").digest();
      await expect(complete(hash, "wrong-code-a1b2c3", wrong)).rejects.toThrow(
        /cannot be completed/,
      );
      const pending = await db.owner.query(
        "SELECT 1 FROM staff_signup WHERE token_hash = decode($1, 'hex')",
        [hash],
      );
      expect(pending.rows).toHaveLength(1);
    });
  });

  describe("accepting an invite with a new account", () => {
    it("creates the account with the invite's email and limit, and uses the invite up", async () => {
      const hash = await addInvite("new.editor@najd.test");
      const done = await acceptNew(hash, ARGON);
      const rows = await db.owner.query(
        `SELECT u.email, m.role, m.event_scope FROM staff_user u
         JOIN organizer_member m ON m.staff_user_id = u.id WHERE u.id = $1`,
        [done?.staff_user_id],
      );
      expect(rows.rows).toEqual([
        { email: "new.editor@najd.test", role: "editor", event_scope: [ids.eventA] },
      ]);
      await expect(acceptNew(hash, ARGON)).rejects.toThrow(/expired or was already used/);
    });

    it("drops events deleted since the invite was sent, and refuses when none is left", async () => {
      const gone = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'GONE01', 'Gone') RETURNING id",
          [ids.orgA],
        )
      ).rows[0]?.id as string;
      const both = tokenHash();
      const onlyGone = tokenHash();
      for (const [email, scope, hash] of [
        ["partly.gone@najd.test", [ids.eventA, gone], both],
        ["all.gone@najd.test", [gone], onlyGone],
      ] as const) {
        await db.owner.query(
          `INSERT INTO organizer_invite (organizer_id, email, role, event_scope, token_hash, invited_by, expires_at)
           VALUES ($1, $2, 'editor', $3::uuid[], decode($4, 'hex'), $5, now() + interval '7 days')`,
          [ids.orgA, email, scope, hash, owner],
        );
      }
      await db.owner.query("DELETE FROM event WHERE id = $1", [gone]);
      const done = await acceptNew(both, ARGON);
      const scope = await db.owner.query(
        "SELECT event_scope FROM organizer_member WHERE staff_user_id = $1",
        [done?.staff_user_id],
      );
      expect(scope.rows).toEqual([{ event_scope: [ids.eventA] }]);
      await expect(acceptNew(onlyGone, ARGON)).rejects.toThrow(/no longer exist/);
    });

    it("refuses an editor invite for someone who is already a member", async () => {
      const already = await db.owner.query<{ email: string }>(
        "SELECT email FROM staff_user WHERE id = $1",
        [unlimited],
      );
      const hash = await addInvite(already.rows[0]?.email as string);
      await expect(
        withPreIdentityContext(db.app, { kind: "invite", tokenHash: hash }, async ({ promote }) => {
          await promote(unlimited);
          await db.app.query("SELECT accept_invite(NULL)");
        }),
      ).rejects.toThrow(/already a member/);
    });

    it("refuses an expired invite, a hash that is not argon2id, and an email that already has an account", async () => {
      await expect(
        acceptNew(await addInvite("late@najd.test", "now() - interval '1 second'"), ARGON),
      ).rejects.toThrow(/expired/);
      await expect(acceptNew(await addInvite("plain@najd.test"), "plaintext")).rejects.toThrow(
        /argon2id/,
      );
      await db.owner.query(
        "INSERT INTO staff_user (email, password_hash) VALUES ('taken@najd.test', 'h')",
      );
      await expect(acceptNew(await addInvite("taken@najd.test"), ARGON)).rejects.toThrow(
        /duplicate key|unique/,
      );
    });
  });
});
