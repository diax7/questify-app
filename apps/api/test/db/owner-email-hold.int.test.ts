import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, addMember, connectAsOwner } from "#test/support/test-db";

const hash = (value: string): Buffer => createHash("sha256").update(value).digest();
const fresh = () => `held.${randomBytes(4).toString("hex")}@owner.test`;

type Held = Readonly<{
  id: string;
  staff: string;
  token: Buffer;
  stop: Buffer;
  code: Buffer;
  oldEmail: string;
}>;

/**
 * The held change's notice (ADR-815, migration 0169): `owner_email_hold_notice`, and `owner_email_apply` refusing a waited
 * change with no recorded notice. The password path never needs it.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("held email change notice (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let orgCount = 0;

  beforeAll(async () => {
    f = await pushFixture();
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('hold.admin@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: made?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const pending = async (): Promise<Held> => {
    orgCount += 1;
    const [org] = await f.owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ($1, $2) RETURNING id",
      [`Hold ${orgCount}`, `org-hold-${orgCount}-${randomBytes(3).toString("hex")}`],
    );
    const staff = await addMember(f.db.owner, org?.id ?? "", "owner");
    const id = randomUUID();
    const token = randomBytes(32);
    const stop = randomBytes(32);
    const code = hash(`code-${id}`);
    const started = await f.one<{ oldEmail: string }>(
      admin,
      "SELECT admin_owner_email_start($1, $2, $3, $4, $5, $6, $7, $8, $9) AS r",
      [
        id,
        org?.id,
        fresh(),
        "known_phone",
        "Owner called from the number on file.",
        token,
        stop,
        code,
        randomUUID(),
      ],
    );
    return { id, staff, token, stop, code, oldEmail: started.oldEmail };
  };
  const confirm = (c: Held, passwordOk: boolean | null) =>
    f.one<{ outcome: string }>({}, "SELECT owner_email_confirm($1, $2, $3, $4) AS r", [
      c.token,
      c.code,
      passwordOk,
      randomUUID(),
    ]);
  const held = async (): Promise<Held> => {
    const c = await pending();
    expect(await confirm(c, null)).toMatchObject({ outcome: "held" });
    return c;
  };
  const door = (token: Buffer, sent: boolean) =>
    f.one<string>({}, "SELECT owner_email_hold_notice($1, $2, $3) AS r", [
      token,
      sent,
      randomUUID(),
    ]);
  const stopIt = (c: Held) =>
    f.one<string>({}, "SELECT owner_email_stop($1, $2) AS r", [c.stop, randomUUID()]);
  const row = async (id: string) =>
    (
      await f.owner<{ state: string; hold_notice_at: Date | null; closed_at: Date | null }>(
        "SELECT state, hold_notice_at, closed_at FROM staff_email_change WHERE id = $1",
        [id],
      )
    )[0];
  const makeDue = (id: string) =>
    f.owner(
      "UPDATE staff_email_change SET applies_at = now() - interval '1 second' WHERE id = $1",
      [id],
    );
  const applyDue = () =>
    f.run<{ r: { outcome: string; changeId?: string } }>(
      {},
      "SELECT owner_email_apply_due(50) AS r",
    );
  const audits = (staff: string) =>
    f.owner<{ action: string; after: Record<string, unknown> }>(
      "SELECT action, after FROM audit_log WHERE target_id = $1 AND action LIKE 'owner_email.%' ORDER BY at, id",
      [staff],
    );
  const emailOf = async (staff: string) =>
    (await f.owner<{ email: string }>("SELECT email FROM staff_user WHERE id = $1", [staff]))[0]
      ?.email;

  describe("the door", () => {
    it("records a sent notice once, then answers noticed whatever `sent` says", async () => {
      const c = await held();
      expect(await door(c.token, true)).toBe("noticed");
      const first = (await row(c.id))?.hold_notice_at;
      expect(first).not.toBeNull();
      expect(await door(c.token, true)).toBe("noticed");
      expect(await door(c.token, false)).toBe("noticed");
      expect(await row(c.id)).toMatchObject({ state: "held", hold_notice_at: first });
      const notes = (await audits(c.staff)).filter((a) => a.action === "owner_email.hold_notice");
      expect(notes).toEqual([{ action: "owner_email.hold_notice", after: { changeId: c.id } }]);
    });

    it("closes the change on a failed send, with no address in the audit row", async () => {
      const c = await held();
      expect(await door(c.token, false)).toBe("closed");
      expect((await row(c.id))?.state).toBe("send_failed");
      expect((await row(c.id))?.closed_at).not.toBeNull();
      expect((await audits(c.staff)).at(-1)).toEqual({
        action: "owner_email.send_failed",
        after: { changeId: c.id, step: "hold_notice", why: "send" },
      });
      expect(await door(c.token, true)).toBe("gone");
    });

    it("answers gone for an unknown token, a pending change and a closed one", async () => {
      expect(await door(randomBytes(32), true)).toBe("gone");
      const open = await pending();
      expect(await door(open.token, true)).toBe("gone");
      expect(await door(open.token, false)).toBe("gone");
      expect(await row(open.id)).toMatchObject({ state: "pending", hold_notice_at: null });
      const stopped = await held();
      await stopIt(stopped);
      expect(await door(stopped.token, true)).toBe("gone");
      expect((await row(stopped.id))?.state).toBe("stopped");
    });

    it("treats a NULL `sent` as a failed send", async () => {
      const c = await held();
      expect(
        await f.one<string>({}, "SELECT owner_email_hold_notice($1, NULL, NULL) AS r", [c.token]),
      ).toBe("closed");
    });
  });

  describe("apply", () => {
    it("closes a waited change with no notice and touches nothing else", async () => {
      const c = await held();
      await f.owner(
        `INSERT INTO staff_password_reset (staff_user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + interval '1 hour')`,
        [c.staff, randomBytes(32)],
      );
      await f.owner("INSERT INTO staff_session (staff_user_id, token_hash) VALUES ($1, $2)", [
        c.staff,
        randomBytes(32),
      ]);
      await makeDue(c.id);
      expect((await applyDue()).map((one) => one.r)).toContainEqual({
        outcome: "send_failed",
        changeId: c.id,
      });
      expect((await row(c.id))?.state).toBe("send_failed");
      expect(await emailOf(c.staff)).toBe(c.oldEmail);
      expect(
        await f.owner(
          "SELECT 1 FROM staff_session WHERE staff_user_id = $1 AND revoked_at IS NULL",
          [c.staff],
        ),
      ).toHaveLength(1);
      expect(
        await f.owner("SELECT 1 FROM staff_password_reset WHERE staff_user_id = $1", [c.staff]),
      ).toHaveLength(1);
      expect((await audits(c.staff)).at(-1)).toEqual({
        action: "owner_email.send_failed",
        after: { changeId: c.id, step: "hold_notice", why: "unrecorded" },
      });
    });

    it("applies a waited change whose notice is on record", async () => {
      const c = await held();
      await door(c.token, true);
      await makeDue(c.id);
      expect((await applyDue()).map((one) => one.r)).toContainEqual(
        expect.objectContaining({ outcome: "confirmed", changeId: c.id }),
      );
    });

    it("never needs the notice on the password path", async () => {
      const c = await pending();
      expect(await confirm(c, true)).toMatchObject({ outcome: "confirmed" });
      expect(await row(c.id)).toMatchObject({ state: "confirmed", hold_notice_at: null });
    });
  });

  describe("races", () => {
    it("ends in Stop's state when the door runs against it", async () => {
      const c = await held();
      const [noted, stopped] = await Promise.all([door(c.token, true), stopIt(c)]);
      expect(["noticed", "gone"]).toContain(noted);
      expect(stopped).toBe("stopped");
      expect((await row(c.id))?.state).toBe("stopped");
    });

    it("ends in one state when a failed send runs against Stop", async () => {
      const c = await held();
      const [noted, stopped] = await Promise.all([door(c.token, false), stopIt(c)]);
      expect([noted, stopped].toSorted()).toSatisfy(
        (pair: string[]) =>
          JSON.stringify(pair) === JSON.stringify(["closed", "none"]) ||
          JSON.stringify(pair) === JSON.stringify(["gone", "stopped"]),
      );
      expect(["send_failed", "stopped"]).toContain((await row(c.id))?.state);
    });

    it("ends in the cancel's state when the door runs against an admin cancel", async () => {
      const c = await held();
      await Promise.all([
        door(c.token, true),
        f.run(admin, "SELECT admin_owner_email_cancel($1, $2)", [c.id, randomUUID()]),
      ]);
      expect((await row(c.id))?.state).toBe("cancelled");
    });

    it("waits for an apply holding the row, and finds it closed", async () => {
      const c = await held();
      await makeDue(c.id);
      const other = await connectAsOwner(f.db);
      try {
        await other.query("BEGIN");
        await other.query("SELECT owner_email_apply_due(50)");
        const late = door(c.token, true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await other.query("COMMIT");
        expect(await late).toBe("gone");
      } finally {
        await other.end();
      }
      expect(await row(c.id)).toMatchObject({ state: "send_failed", hold_notice_at: null });
      expect(await emailOf(c.staff)).toBe(c.oldEmail);
    });

    it("applies once from two due runs at once", async () => {
      const c = await held();
      await door(c.token, true);
      await makeDue(c.id);
      const runs = await Promise.all([applyDue(), applyDue()]);
      const mine = runs.flat().filter((one) => one.r.changeId === c.id);
      expect(mine.map((one) => one.r.outcome)).toEqual(["confirmed"]);
    });
  });

  describe("outsiders", () => {
    it("keeps the door from PUBLIC and the apply from the API role", async () => {
      const c = await held();
      const [grants] = await f.owner<{ outsider: boolean; app: boolean }>(
        `SELECT has_function_privilege('questify_outsider', p, 'EXECUTE') AS outsider,
                has_function_privilege('questify_app', p, 'EXECUTE') AS app
         FROM (SELECT 'owner_email_hold_notice(bytea, boolean, uuid)'::regprocedure AS p) x`,
      );
      expect(grants).toEqual({ outsider: false, app: true });
      expect(
        await sqlstate(
          f.db.app.query("SELECT owner_email_apply($1::uuid, 'waited', NULL::uuid)", [c.id]),
        ),
      ).toBe("42501");
      expect(await row(c.id)).toMatchObject({ state: "held", hold_notice_at: null });
    });

    it("keeps the table closed to the API role, so it cannot mark a change by id", async () => {
      const c = await held();
      expect(await sqlstate(f.db.app.query("SELECT hold_notice_at FROM staff_email_change"))).toBe(
        "42501",
      );
      expect(
        await sqlstate(
          f.db.app.query("UPDATE staff_email_change SET hold_notice_at = now() WHERE id = $1", [
            c.id,
          ]),
        ),
      ).toBe("42501");
    });

    it("changes nothing for a wrong token", async () => {
      const c = await held();
      expect(await door(randomBytes(32), true)).toBe("gone");
      expect(await door(c.stop, false)).toBe("gone");
      expect(await row(c.id)).toMatchObject({ state: "held", hold_notice_at: null });
    });
  });
});
