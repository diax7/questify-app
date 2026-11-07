import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

const REASON = "Owner called from the number on file.";
const hash = (value: string): Buffer => createHash("sha256").update(value).digest();
type Started = Readonly<{
  id: string;
  staff: string;
  org: string;
  token: Buffer;
  stop: Buffer;
  code: Buffer;
  oldEmail: string;
  newEmail: string;
}>;
const fresh = () => `new.${randomBytes(4).toString("hex")}@owner.test`;
type Outcome = Readonly<{ outcome: string; attemptsLeft?: number }>;

/**
 * The owner email change in the database (T-701b, migration 0130, ADR-490..492): who may start one, the code and
 * password tries counted together, the 24-hour hold without the password, the old address's Stop, completion ending
 * every session, and the 180-day erasure. Audit rows never hold an address.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("owner email change (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let adminId = "";
  let orgCount = 0;
  beforeAll(async () => {
    f = await pushFixture();
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('support@questify.test', 'h', 'admin') RETURNING id",
    );
    adminId = made?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
  });
  afterAll(async () => {
    await f.close();
  });

  const newOrganizer = async (): Promise<{ org: string; owner: string; email: string }> => {
    orgCount += 1;
    const [org] = await f.owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ($1, $2) RETURNING id",
      [`Org ${orgCount}`, `org-email-${orgCount}-${randomBytes(3).toString("hex")}`],
    );
    const owner = await addMember(f.db.owner, org?.id ?? "", "owner");
    const [row] = await f.owner<{ email: string }>("SELECT email FROM staff_user WHERE id = $1", [
      owner,
    ]);
    return { org: org?.id ?? "", owner, email: row?.email ?? "" };
  };
  const start = (
    org: string,
    newEmail: string,
    options: Readonly<{ seat?: RequestContext; identity?: string; reason?: string }> = {},
  ) => {
    const id = randomUUID();
    const token = randomBytes(32);
    const stop = randomBytes(32);
    const code = hash(`code-${id}`);
    return f
      .one<{ oldEmail: string; newEmail: string }>(
        options.seat ?? admin,
        "SELECT admin_owner_email_start($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r",
        [
          id,
          org,
          newEmail,
          options.identity ?? "known_phone",
          options.reason ?? REASON,
          token,
          stop,
          code,
          randomUUID(),
        ],
      )
      .then(async (r) => {
        const [row] = await f.owner<{ staff_user_id: string }>(
          "SELECT staff_user_id FROM staff_email_change WHERE id = $1",
          [id],
        );
        return {
          id,
          staff: row?.staff_user_id ?? "",
          org,
          token,
          stop,
          code,
          oldEmail: r.oldEmail,
          newEmail: r.newEmail,
        } satisfies Started;
      });
  };
  const confirm = (c: Started, code: Buffer | null, passwordOk: boolean | null) =>
    f.one<Outcome>({}, "SELECT owner_email_confirm($1, $2, $3, $4) AS r", [
      c.token,
      code,
      passwordOk,
      randomUUID(),
    ]);
  const stopIt = (c: Started) =>
    f.one<string>({}, "SELECT owner_email_stop($1, $2) AS r", [c.stop, randomUUID()]);
  const stateOf = async (id: string) =>
    (
      await f.owner<{ state: string; attempts: number; completed_how: string | null }>(
        "SELECT state, attempts, completed_how FROM staff_email_change WHERE id = $1",
        [id],
      )
    )[0];
  const emailOf = async (staff: string) =>
    (await f.owner<{ email: string }>("SELECT email FROM staff_user WHERE id = $1", [staff]))[0]
      ?.email;
  const startState = async (org: string, address: string, seat = admin) =>
    sqlstate(start(org, address, { seat }));

  describe("start", () => {
    it("is refused to anyone but an active platform admin", async () => {
      const { org } = await newOrganizer();
      const [disabled] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ($1, 'h', 'admin', 'disabled') RETURNING id",
        [fresh()],
      );
      for (const seat of [
        {},
        { isAdmin: true },
        { playerId: await f.newPlayer() },
        f.team(),
        { isAdmin: true, staffUserId: disabled?.id ?? "" },
        { staffUserId: adminId },
      ] satisfies RequestContext[]) {
        expect(await startState(org, fresh(), seat)).toBe("QE403");
      }
    });

    it("refuses an organizer without an owner, the admin's own account and another admin", async () => {
      expect(await startState(randomUUID(), fresh())).toBe("EC404");
      const { org, owner } = await newOrganizer();
      await f.owner("UPDATE staff_user SET platform_role = 'admin' WHERE id = $1", [owner]);
      expect(await startState(org, fresh())).toBe("EC403");
      const own = await newOrganizer();
      await f.owner("UPDATE organizer_member SET staff_user_id = $1 WHERE organizer_id = $2", [
        adminId,
        own.org,
      ]);
      expect(await startState(own.org, fresh())).toBe("EC403");
    });

    it("refuses a disabled owner, the same address, another account's address, a bad reason or check", async () => {
      const { org, owner, email } = await newOrganizer();
      expect(await startState(org, email.toUpperCase())).toBe("EC409");
      expect(await startState(org, "SUPPORT@questify.test")).toBe("EC409");
      expect(await startState(org, "not-an-address")).toBe("EC422");
      expect(await sqlstate(start(org, fresh(), { reason: "short" }))).toBe("EC422");
      expect(await sqlstate(start(org, fresh(), { identity: "a_guess" }))).toBe("EC422");
      await f.owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [owner]);
      expect(await startState(org, fresh())).toBe("EC422");
    });

    it("keeps one open change per account and three starts a day", async () => {
      const { org } = await newOrganizer();
      const first = await start(org, fresh());
      expect(await startState(org, fresh())).toBe("EC409");
      await f.run(admin, "SELECT admin_owner_email_cancel($1, $2)", [first.id, randomUUID()]);
      const second = await start(org, fresh());
      await f.run(admin, "SELECT admin_owner_email_cancel($1, $2)", [second.id, randomUUID()]);
      const third = await start(org, fresh());
      await f.run(admin, "SELECT admin_owner_email_cancel($1, $2)", [third.id, randomUUID()]);
      expect(await startState(org, fresh())).toBe("EC429");
    });

    it("lets one of two concurrent starts win", async () => {
      const { org } = await newOrganizer();
      const results = await Promise.all([startState(org, fresh()), startState(org, fresh())]);
      expect(results.toSorted()).toEqual(["EC409", "none"]);
    });

    it("writes ids, the check and the reason to the audit log, never an address", async () => {
      const { org } = await newOrganizer();
      const c = await start(org, fresh());
      await confirm(c, c.code, true);
      const rows = await f.owner<{ action: string; text: string }>(
        "SELECT action, row_to_json(a)::text AS text FROM audit_log a WHERE after ->> 'changeId' = $1 ORDER BY id",
        [c.id],
      );
      expect(rows.map((row) => row.action)).toEqual(["owner_email.start", "owner_email.confirm"]);
      for (const row of rows) {
        expect(row.text).not.toContain(c.oldEmail);
        expect(row.text).not.toContain(c.newEmail);
      }
    });
  });

  describe("confirm", () => {
    it("counts wrong codes and wrong passwords in the same five tries, then refuses the right ones", async () => {
      const { org, owner, email } = await newOrganizer();
      const c = await start(org, fresh());
      expect(await confirm(c, hash("wrong"), true)).toEqual({ outcome: "wrong", attemptsLeft: 4 });
      expect(await confirm(c, c.code, false)).toEqual({ outcome: "wrong", attemptsLeft: 3 });
      expect(await confirm(c, null, true)).toEqual({ outcome: "wrong", attemptsLeft: 2 });
      await confirm(c, hash("wrong"), true);
      expect(await confirm(c, hash("wrong"), null)).toEqual({ outcome: "wrong", attemptsLeft: 0 });
      expect(await confirm(c, c.code, true)).toEqual({ outcome: "locked" });
      expect(await emailOf(owner)).toBe(email);
    });

    it("keeps the tries when the admin resends a code, at most three resends a minute apart", async () => {
      const { org } = await newOrganizer();
      const c = await start(org, fresh());
      await confirm(c, hash("wrong"), true);
      const resend = (code: Buffer) =>
        sqlstate(
          f.run(admin, "SELECT admin_owner_email_resend($1, $2, $3)", [c.id, code, randomUUID()]),
        );
      expect(await resend(hash("too soon"))).toBe("EC409");
      for (const round of [1, 2, 3]) {
        await f.owner(
          "UPDATE staff_email_change SET last_sent_at = now() - interval '61 seconds' WHERE id = $1",
          [c.id],
        );
        expect(await resend(hash(`second ${round}`))).toBe("none");
      }
      await f.owner(
        "UPDATE staff_email_change SET last_sent_at = now() - interval '61 seconds' WHERE id = $1",
        [c.id],
      );
      expect(await resend(hash("fourth"))).toBe("EC429");
      expect(await confirm(c, c.code, true)).toEqual({ outcome: "wrong", attemptsLeft: 3 });
      expect((await stateOf(c.id))?.attempts).toBe(2);
      expect(await confirm(c, hash("second 3"), true)).toMatchObject({ outcome: "confirmed" });
    });

    it("answers an unknown, expired or closed link alike", async () => {
      const { org } = await newOrganizer();
      const c = await start(org, fresh());
      expect(await confirm({ ...c, token: randomBytes(32) }, c.code, true)).toEqual({
        outcome: "invalid",
      });
      await f.owner(
        `UPDATE staff_email_change SET created_at = now() - interval '61 minutes',
           expires_at = now() - interval '1 minute' WHERE id = $1`,
        [c.id],
      );
      expect(await confirm(c, c.code, true)).toEqual({ outcome: "invalid" });
      const view = await f.one<object | null>({}, "SELECT owner_email_view($1) AS r", [c.token]);
      expect(view).toBeNull();
      const other = await newOrganizer();
      const d = await start(other.org, fresh());
      await f.run(admin, "SELECT admin_owner_email_cancel($1, $2)", [d.id, randomUUID()]);
      expect(await confirm(d, d.code, true)).toEqual({ outcome: "invalid" });
    });

    it("applies at once with the password: the email, every session, challenge, reset link and old invite", async () => {
      const { org, owner } = await newOrganizer();
      const other = await addMember(f.db.owner, org, "editor");
      for (const staff of [owner, other]) {
        await f.owner("INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)", [
          staff,
          randomBytes(32),
        ]);
        await f.owner(
          "INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
          [staff, randomBytes(32)],
        );
      }
      const c = await start(org, fresh());
      const elsewhere = (await newOrganizer()).org;
      await f.owner(
        `INSERT INTO organizer_invite (organizer_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'editor', $3, $4, now() + interval '1 day')`,
        [elsewhere, c.oldEmail, randomBytes(32), adminId],
      );
      expect(await confirm(c, c.code, true)).toEqual({
        outcome: "confirmed",
        changeId: c.id,
        oldEmail: c.oldEmail,
        newEmail: c.newEmail,
      });
      expect(await emailOf(owner)).toBe(c.newEmail);
      expect(await stateOf(c.id)).toMatchObject({ state: "confirmed", completed_how: "password" });
      const live = await f.owner<{ staff_user_id: string }>(
        "SELECT staff_user_id FROM staff_session WHERE revoked_at IS NULL AND staff_user_id = ANY($1)",
        [[owner, other]],
      );
      expect(live.map((row) => row.staff_user_id)).toEqual([other]);
      expect(await f.count("staff_password_reset WHERE staff_user_id = $1", [owner])).toBe(0);
      expect(await f.count("staff_password_reset WHERE staff_user_id = $1", [other])).toBe(1);
      expect(await f.count("organizer_invite WHERE email = $1", [c.oldEmail])).toBe(0);
      expect(await f.count("staff_user WHERE email = $1", [c.oldEmail])).toBe(0);
    });

    it("closes as email_taken when another account took the address meanwhile, and commits that", async () => {
      const { org, owner, email } = await newOrganizer();
      const c = await start(org, fresh());
      await f.owner("INSERT INTO staff_user (email, password_hash) VALUES ($1, 'h')", [c.newEmail]);
      expect(await confirm(c, c.code, true)).toEqual({ outcome: "email_taken" });
      expect((await stateOf(c.id))?.state).toBe("email_taken");
      expect(await emailOf(owner)).toBe(email);
    });

    it("lets one of two concurrent confirms win", async () => {
      const { org } = await newOrganizer();
      const c = await start(org, fresh());
      const results = await Promise.all([confirm(c, c.code, true), confirm(c, c.code, true)]);
      expect(results.map((r) => r.outcome).toSorted()).toEqual(["confirmed", "invalid"]);
    });
  });

  describe("hold and stop", () => {
    it("holds 24 hours without the password; Stop cancels it during the hold", async () => {
      const { org, owner, email } = await newOrganizer();
      const c = await start(org, fresh());
      expect(await confirm(c, c.code, null)).toMatchObject({ outcome: "held" });
      expect((await stateOf(c.id))?.state).toBe("held");
      expect(await stopIt(c)).toBe("stopped");
      await f.owner("UPDATE staff_email_change SET applies_at = now() WHERE id = $1", [c.id]);
      const applied = await f.run<{ r: { changeId?: string } }>(
        {},
        "SELECT owner_email_apply_due(50) AS r",
      );
      expect(applied.map((row) => row.r.changeId)).not.toContain(c.id);
      expect(await emailOf(owner)).toBe(email);
    });

    it("applies a hold whose day passed", async () => {
      const { org, owner } = await newOrganizer();
      const c = await start(org, fresh());
      await confirm(c, c.code, null);
      await f.one({}, "SELECT owner_email_hold_notice($1, true, NULL) AS r", [c.token]);
      await f.owner(
        "UPDATE staff_email_change SET applies_at = now() - interval '1 second' WHERE id = $1",
        [c.id],
      );
      const applied = await f.run<{ r: { outcome: string } }>(
        {},
        "SELECT owner_email_apply_due(50) AS r",
      );
      expect(applied.map((row) => row.r)).toContainEqual(
        expect.objectContaining({ outcome: "confirmed", changeId: c.id }),
      );
      expect(await emailOf(owner)).toBe(c.newEmail);
      expect((await stateOf(c.id))?.completed_how).toBe("waited");
    });

    it("stops a pending change, and after the password path only reports it to the team once", async () => {
      const { org } = await newOrganizer();
      const pending = await start(org, fresh());
      expect(await stopIt(pending)).toBe("stopped");
      expect(await confirm(pending, pending.code, true)).toEqual({ outcome: "invalid" });
      const c = await start(org, fresh());
      await confirm(c, c.code, true);
      expect(await stopIt(c)).toBe("reported");
      expect(await stopIt(c)).toBe("reported");
      expect(await f.count("team_alert WHERE change_id = $1", [c.id])).toBe(1);
      expect((await stateOf(c.id))?.state).toBe("confirmed");
      expect(await stopIt({ ...c, stop: randomBytes(32) })).toBe("none");
      await f.owner(
        "UPDATE staff_email_change SET closed_at = now() - interval '8 days' WHERE id = $1",
        [c.id],
      );
      expect(await stopIt(c)).toBe("none");
    });
  });

  describe("lifecycle and grants", () => {
    it("expires a pending change past its hour and erases addresses 180 days after closing", async () => {
      const { org } = await newOrganizer();
      const c = await start(org, fresh());
      await f.owner(
        `UPDATE staff_email_change SET created_at = now() - interval '61 minutes',
           expires_at = now() - interval '1 minute' WHERE id = $1`,
        [c.id],
      );
      expect(await f.one<number>({}, "SELECT owner_email_purge(1000) AS r")).toBeGreaterThan(0);
      expect((await stateOf(c.id))?.state).toBe("expired");
      await f.owner(
        "UPDATE staff_email_change SET closed_at = now() - interval '181 days' WHERE id = $1",
        [c.id],
      );
      await f.one<number>({}, "SELECT owner_email_purge(1000) AS r");
      const [row] = await f.owner<{ old_email: string | null; new_email: string | null }>(
        "SELECT old_email, new_email FROM staff_email_change WHERE id = $1",
        [c.id],
      );
      expect(row).toEqual({ old_email: null, new_email: null });
    });

    it("takes its rows with a deleted account", async () => {
      const { org, owner } = await newOrganizer();
      const c = await start(org, fresh());
      await f.owner("DELETE FROM organizer_member WHERE staff_user_id = $1", [owner]);
      await f.owner("DELETE FROM staff_user WHERE id = $1", [owner]);
      expect(await f.count("staff_email_change WHERE id = $1", [c.id])).toBe(0);
    });

    it("leaves the API's role only SELECT and UPDATE (password_hash) on staff_user, and nothing on the change", async () => {
      const grants = await f.owner<{ privilege_type: string; column_name: string | null }>(
        `SELECT privilege_type, NULL AS column_name FROM information_schema.role_table_grants
         WHERE grantee = 'questify_app' AND table_name = 'staff_user'
         UNION ALL
         SELECT privilege_type, column_name FROM information_schema.role_column_grants
         WHERE grantee = 'questify_app' AND table_name = 'staff_user' AND privilege_type <> 'SELECT'`,
      );
      expect(grants).toEqual(
        expect.arrayContaining([
          { privilege_type: "SELECT", column_name: null },
          { privilege_type: "UPDATE", column_name: "password_hash" },
        ]),
      );
      expect(grants).toHaveLength(2);
      for (const sql of [
        "SELECT * FROM staff_email_change",
        "SELECT * FROM team_alert",
        "SELECT owner_email_apply(gen_random_uuid(), 'password', NULL)",
      ]) {
        expect(await sqlstate(f.run(admin, sql)), sql).toBe("42501");
      }
    });
  });
});
