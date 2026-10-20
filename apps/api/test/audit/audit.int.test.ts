import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordAudit } from "#src/audit/record";
import { createAuthKeys } from "#src/auth/keys";
import { clearThrottleFor, createStaffAccount } from "#src/auth/staff-admin";
import type { PublicAccount } from "#src/auth/staff-store";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import { createTranslationService } from "#src/translations/service";
import {
  createStaff,
  signInFully,
  startApp,
  testConfig,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Entry = {
  actor_type: string;
  actor_id: string | null;
  organizer_id: string | null;
  event_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  request_id: string | null;
};

describe.skipIf(TEST_DATABASE_URL === undefined)("audit log", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let settings: SettingsService;
  let admin: PublicAccount;
  let memberA = "";
  let memberB = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    settings = createSettingsService({ pool });
    const adminId = await createStaff(db.owner, { email: "root@questify.test", admin: true });
    admin = { id: adminId, email: "root@questify.test", status: "active", platformRole: "admin" };
    memberA = await createStaff(db.owner, { email: "a@najd.test" });
    memberB = await createStaff(db.owner, { email: "b@tabuk.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner')",
      [ids.orgA, memberA, ids.orgB, memberB],
    );
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const entries = async (action?: string): Promise<Entry[]> =>
    (
      await db.owner.query<Entry>(
        `SELECT actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after, request_id
         FROM audit_log ${action === undefined ? "" : "WHERE action = $1"} ORDER BY id`,
        action === undefined ? [] : [action],
      )
    ).rows;

  const as = (context: RequestContext, sql: string, values: unknown[] = []) =>
    withRequestContext(db.app, context, async () => (await db.app.query(sql, values)).rows);

  const insertAs = (context: RequestContext, columns: string, values: unknown[]) =>
    as(
      context,
      `INSERT INTO audit_log (${columns}) VALUES (${values.map((_, index) => `$${index + 1}`).join(", ")})`,
      values,
    );

  describe("can never be changed or removed (FR-1030)", () => {
    beforeAll(async () => {
      await db.owner.query(
        "INSERT INTO audit_log (actor_type, action, target_type) VALUES ('system', 'test.seed', 'nothing')",
      );
    });

    it("refuses the API role any update or delete, even as an admin", async () => {
      for (const sql of [
        "UPDATE audit_log SET action = 'x.y'",
        "DELETE FROM audit_log",
        "TRUNCATE audit_log",
      ]) {
        await expect(as({ isAdmin: true }, sql)).rejects.toThrow(/permission denied/);
      }
    });

    it("refuses the owner connection too", async () => {
      for (const sql of [
        "UPDATE audit_log SET action = 'x.y'",
        "DELETE FROM audit_log",
        "TRUNCATE audit_log",
      ]) {
        await expect(db.owner.query(sql)).rejects.toThrow(/can never be changed or removed/);
      }
      expect((await entries("test.seed")).length).toBe(1);
    });

    it("keeps its guards firing even when a session turns ordinary triggers off", async () => {
      const { rows } = await db.owner.query<{ tgname: string; tgenabled: string }>(
        "SELECT tgname, tgenabled FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal ORDER BY tgname",
      );
      expect(rows).toEqual([
        { tgname: "audit_log_no_truncate", tgenabled: "A" },
        { tgname: "audit_log_no_update_or_delete", tgenabled: "A" },
      ]);
    });

    it("refuses the outsider anything", async () => {
      await expect(db.outsider.query("SELECT * FROM public.audit_log")).rejects.toThrow(
        /permission denied/,
      );
      await expect(
        db.outsider.query(
          "INSERT INTO public.audit_log (actor_type, action, target_type) VALUES ('system', 'a.b', 'c')",
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("can only be written in your own name", () => {
    it("lets a staff member write their own entry for their organizer and its event", async () => {
      await insertAs(
        { organizerId: ids.orgA, staffUserId: memberA },
        "actor_type, actor_id, organizer_id, event_id, action, target_type",
        ["staff", memberA, ids.orgA, ids.eventA, "event.test", "event"],
      );
    });

    it.each([
      ["another person's id", "staff", "memberB", "orgA", null],
      ["the admin type without being an admin", "admin", "memberA", null, null],
      ["the system type", "system", null, null, null],
      ["another organizer", "staff", "memberA", "orgB", null],
      ["an event of another organizer", "staff", "memberA", "orgA", "eventB"],
    ] as const)("refuses an entry claiming %s", async (_label, type, actor, organizer, event) => {
      const pick = (name: string | null) =>
        name === null
          ? null
          : (
              { memberA, memberB, orgA: ids.orgA, orgB: ids.orgB, eventB: ids.eventB } as Record<
                string,
                string
              >
            )[name];
      await expect(
        insertAs(
          { organizerId: ids.orgA, staffUserId: memberA },
          "actor_type, actor_id, organizer_id, event_id, action, target_type",
          [type, pick(actor), pick(organizer), pick(event), "event.test", "event"],
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it("refuses an entry about an event without its organizer, from any connection", async () => {
      await expect(
        insertAs(
          { isAdmin: true, staffUserId: admin.id },
          "actor_type, actor_id, event_id, action, target_type",
          ["admin", admin.id, ids.eventA, "event.test", "event"],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        db.owner.query(
          "INSERT INTO audit_log (actor_type, actor_id, event_id, action, target_type) VALUES ('admin', $1, $2, 'event.test', 'event')",
          [admin.id, ids.eventA],
        ),
      ).rejects.toThrow(/check constraint/);
    });

    it("does not let the API choose the time or the number of an entry", async () => {
      await expect(
        insertAs({ staffUserId: memberA }, "actor_type, actor_id, action, target_type, at", [
          "staff",
          memberA,
          "event.test",
          "event",
          "2020-01-01T00:00:00Z",
        ]),
      ).rejects.toThrow(/permission denied/);
      await expect(
        insertAs({ staffUserId: memberA }, "id, actor_type, actor_id, action, target_type", [
          1,
          "staff",
          memberA,
          "event.test",
          "event",
        ]),
      ).rejects.toThrow(/permission denied|cannot insert/);
    });
  });

  describe("who can read it", () => {
    it("shows an organizer its own entries, including a Questify admin's support work in its events", async () => {
      await insertAs(
        { isAdmin: true, staffUserId: admin.id },
        "actor_type, actor_id, organizer_id, event_id, action, target_type",
        ["admin", admin.id, ids.orgA, ids.eventA, "event.support", "event"],
      );
      const seen = (await as(
        { organizerId: ids.orgA, staffUserId: memberA },
        "SELECT organizer_id, action FROM audit_log",
      )) as {
        organizer_id: string;
        action: string;
      }[];
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((row) => row.organizer_id === ids.orgA)).toBe(true);
      expect(seen.map((row) => row.action)).toContain("event.support");
    });

    it("shows another organizer none of them, and a staff member outside an organizer nothing", async () => {
      expect(
        await as(
          { organizerId: ids.orgB, staffUserId: memberB },
          "SELECT 1 FROM audit_log WHERE organizer_id = $1",
          [ids.orgA],
        ),
      ).toEqual([]);
      expect(await as({ staffUserId: memberA }, "SELECT 1 FROM audit_log")).toEqual([]);
    });

    it("shows a Questify admin everything", async () => {
      const all = await entries();
      expect(await as({ isAdmin: true }, "SELECT 1 FROM audit_log")).toHaveLength(all.length);
    });
  });

  describe("outlives what it describes", () => {
    it("keeps an event's entries after the event is deleted (FR-1003)", async () => {
      const temp = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'TEMP1', 'Temp') RETURNING id",
          [ids.orgA],
        )
      ).rows[0]?.id;
      await insertAs(
        { organizerId: ids.orgA, staffUserId: memberA },
        "actor_type, actor_id, organizer_id, event_id, action, target_type",
        ["staff", memberA, ids.orgA, temp, "event.test", "event"],
      );
      await as({ organizerId: ids.orgA }, "DELETE FROM event WHERE id = $1", [temp]);
      const left = (await db.owner.query("SELECT 1 FROM audit_log WHERE event_id = $1", [temp]))
        .rows;
      expect(left).toHaveLength(1);
    });
  });

  describe("goes with its change, or neither is kept", () => {
    it("rolls back the change when the entry would hold a secret", async () => {
      await expect(
        withRequestContext(db.app, { isAdmin: true, staffUserId: admin.id }, async () => {
          await db.app.query("INSERT INTO translation (key, en) VALUES ('nav.home', 'Start')");
          await recordAudit(db.app, {
            actor: { type: "admin", id: admin.id },
            action: "translation.update",
            target: { type: "translation", id: "nav.home" },
            after: { en: "Start", session_token: "abc" },
          });
        }),
      ).rejects.toThrow(/must not hold "session_token"/);
      expect((await db.owner.query("SELECT 1 FROM translation")).rows).toEqual([]);
    });

    it("refuses an action name that is not dotted words", async () => {
      await expect(
        recordAudit(db.app, {
          actor: { type: "system" },
          action: "Bad Action",
          target: { type: "x" },
        }),
      ).rejects.toThrow(/dotted lower-case/);
    });
  });

  describe("every change writes exactly one entry", () => {
    let mark = 0;
    beforeEach(async () => {
      mark =
        (await db.owner.query<{ max: number | null }>("SELECT max(id)::int AS max FROM audit_log"))
          .rows[0]?.max ?? 0;
    });
    const newEntries = async (): Promise<Entry[]> =>
      (
        await db.owner.query<Entry>(
          `SELECT actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after, request_id
           FROM audit_log WHERE id > $1 ORDER BY id`,
          [mark],
        )
      ).rows;

    it("platform settings: what changed, by which admin, and nothing for a save that changes nothing", async () => {
      const requestId = "11111111-2222-4333-8444-555555555555";
      await settings.savePlatformSettings(
        admin,
        { tuning: { myQrGraceSeconds: 9 } },
        { requestId },
      );
      await settings.savePlatformSettings(admin, { tuning: { myQrGraceSeconds: 9 } });
      await settings.savePlatformSettings(admin, { features: { teleporter: { enabled: true } } });
      expect(await newEntries()).toEqual([
        {
          actor_type: "admin",
          actor_id: admin.id,
          organizer_id: null,
          event_id: null,
          action: "platform_settings.update",
          target_type: "platform_setting",
          target_id: "tuning",
          before: { tuning: null },
          after: { tuning: { myQrGraceSeconds: 9 } },
          request_id: requestId,
        },
      ]);
    });

    it("platform settings: only the block that changed", async () => {
      await settings.savePlatformSettings(admin, {
        tuning: { myQrGraceSeconds: 9 },
        features: { shop: { enabled: false } },
      });
      const [entry] = await newEntries();
      expect(entry).toMatchObject({
        target_id: "features",
        before: { features: null },
        after: { features: { shop: { enabled: false } } },
      });
    });

    it("event switches: the member, the organizer and the event, before and after", async () => {
      const actor = { staffUserId: memberA, organizerId: ids.orgA };
      await settings.saveEventSwitches(actor, ids.eventA, { features: { cheers: false } });
      await settings.saveEventSwitches(actor, ids.eventA, { features: { cheers: false } });
      await settings.saveEventSwitches(actor, ids.eventB, { features: { cheers: false } });
      expect(await newEntries()).toEqual([
        expect.objectContaining({
          actor_type: "staff",
          actor_id: memberA,
          organizer_id: ids.orgA,
          event_id: ids.eventA,
          action: "event.features.update",
          before: { features: {} },
          after: { features: { cheers: false } },
        }),
      ]);
    });

    it("add-ons: unlock and lock once each, nothing for a repeat or a miss", async () => {
      await settings.unlockFeature(admin, ids.eventA, "bigScreen");
      await settings.unlockFeature(admin, ids.eventA, "bigScreen");
      await settings.lockFeature(admin, ids.eventA, "bigScreen");
      await settings.lockFeature(admin, ids.eventA, "bigScreen");
      expect(
        (await newEntries()).map((entry) => [entry.action, entry.organizer_id, entry.event_id]),
      ).toEqual([
        ["event.addon.unlock", ids.orgA, ids.eventA],
        ["event.addon.lock", ids.orgA, ids.eventA],
      ]);
    });

    it("translations: the languages that changed, nothing for a repeat", async () => {
      const translations = createTranslationService({ pool });
      await translations.save(admin, "nav.shop", { en: "Market" });
      await translations.save(admin, "nav.shop", { en: "Market" });
      await translations.save(admin, "nav.shop", { en: "" });
      expect((await newEntries()).map((entry) => [entry.before, entry.after])).toEqual([
        [{ en: null }, { en: "Market" }],
        [{ en: "Market" }, { en: null }],
      ]);
    });

    it("staff CLI: a system entry for each command, without the email", async () => {
      const id = await createStaffAccount(
        db.owner,
        { email: "cli@najd.test", password: "a long enough password", admin: false },
        async () => false,
      );
      await clearThrottleFor(db.owner, createAuthKeys(testConfig().auth.secret), "cli@najd.test");
      await clearThrottleFor(db.owner, createAuthKeys(testConfig().auth.secret), "ghost@najd.test");
      const made = await newEntries();
      expect(
        made.map((entry) => [
          entry.actor_type,
          entry.actor_id,
          entry.action,
          entry.target_id,
          entry.after,
        ]),
      ).toEqual([
        ["system", null, "staff.create", id, { platformRole: "none" }],
        ["system", null, "staff.throttle.clear", id, { found: true }],
        ["system", null, "staff.throttle.clear", null, { found: false }],
      ]);
      expect(JSON.stringify(made)).not.toContain("cli@najd.test");
    });
  });

  describe("sessions", () => {
    let test: TestApp;
    beforeAll(async () => {
      test = await startApp(db);
    });
    afterAll(async () => {
      await test.close();
    });

    it("records opening a session with its request id, and ending it", async () => {
      const email = "session@najd.test";
      const user = await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const opened = (await entries("staff.session.open")).filter(
        (entry) => entry.actor_id === user,
      );
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        actor_type: "staff",
        target_type: "staff_session",
        after: { endedOlderSessions: 0 },
      });
      expect(opened[0]?.request_id).toMatch(/^[0-9a-f-]{36}$/);

      const signOut = await test.app.inject({
        method: "POST",
        url: "/v1/staff/auth/sign-out",
        headers: withSession(cookie),
      });
      expect(signOut.statusCode).toBe(204);
      const ended = (await entries("staff.session.end")).filter((entry) => entry.actor_id === user);
      expect(ended).toHaveLength(1);
      expect(ended[0]?.target_id).toBe(opened[0]?.target_id);
      expect(ended[0]?.request_id).toBe(String(signOut.headers["x-request-id"]));
    });

    it("writes nothing for ending a session that does not exist", async () => {
      const email = "nobody-ends@najd.test";
      const user = await createStaff(db.owner, { email });
      const cookie = await signInFully(test, email);
      const response = await test.app.inject({
        method: "DELETE",
        url: "/v1/staff/sessions/00000000-0000-4000-8000-000000000000",
        headers: withSession(cookie),
      });
      expect(response.statusCode).toBe(404);
      expect(
        (await entries("staff.session.end")).filter((entry) => entry.actor_id === user),
      ).toEqual([]);
    });
  });
});
