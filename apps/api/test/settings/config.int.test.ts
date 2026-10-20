import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseComposedConfig, type ComposedConfig } from "@questify/shared";
import { withRequestContext } from "#src/db/context";
import type { PublicAccount } from "#src/auth/staff-store";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import { createStaff, startApp, type TestApp } from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const OFF = { ar: "الميزة متوقفة مؤقتا.", en: "This feature is paused." };

describe.skipIf(TEST_DATABASE_URL === undefined)("configuration", () => {
  let db: TestDatabase;
  let test: TestApp;
  let pool: Pool;
  let settings: SettingsService;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let admin: PublicAccount;
  let regular: PublicAccount;
  let staffA = "";
  const memberA = () => ({ staffUserId: staffA, organizerId: ids.orgA });
  const clock = { now: 1_000_000 };

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    const adminId = await createStaff(db.owner, { email: "root@questify.test", admin: true });
    const regularId = await createStaff(db.owner, { email: "editor@najd.test" });
    admin = { id: adminId, email: "root@questify.test", status: "active", platformRole: "admin" };
    regular = { id: regularId, email: "editor@najd.test", status: "active", platformRole: "none" };
    staffA = await createStaff(db.owner, { email: "member@najd.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [ids.orgA, staffA],
    );
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    settings = createSettingsService({ pool, ttlMs: 15_000, now: () => clock.now });
    test = await startApp(db, false, {}, settings);
  });
  afterAll(async () => {
    await test.close();
    await pool.end();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  const getConfig = (query = "", headers: Record<string, string> = {}) =>
    test.app.inject({ method: "GET", url: `/v1/config${query}`, headers });

  const configOf = async (query = ""): Promise<ComposedConfig> =>
    (await getConfig(query)).json<ComposedConfig>();

  describe("what an app receives", () => {
    it("is the defaults when nothing was changed: ungated features on, add-ons off, tuning at its start values", async () => {
      const response = await getConfig();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        features: {
          bigScreen: { enabled: false, minAppVersion: null, message: null },
          cheers: { enabled: true, minAppVersion: null, message: null },
          polls: { enabled: true, minAppVersion: null, message: null },
          shop: { enabled: true, minAppVersion: null, message: null },
        },
        tuning: { myQrGraceSeconds: 5, screenQrRotationSeconds: 45 },
      });
    });

    it("can be read by anyone and checks out against the schema the app uses", async () => {
      const response = await getConfig();
      expect(parseComposedConfig(response.json()).ok).toBe(true);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it("still answers an app that sends its version, and refuses one that is too old", async () => {
      expect((await getConfig("", { "x-app-version": "1.0.0" })).statusCode).toBe(200);
      expect((await getConfig("", { "x-app-version": "0.5.0" })).statusCode).toBe(426);
    });
  });

  describe("ETag", () => {
    it("answers 304 with no body when the app already has this configuration", async () => {
      const first = await getConfig();
      const etag = String(first.headers["etag"]);
      for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
        const again = await getConfig("", { "if-none-match": header });
        expect(again.statusCode, header).toBe(304);
        expect(again.body).toBe("");
        expect(again.headers["etag"]).toBe(etag);
      }
    });

    it("answers 200 with the new configuration when the tag is stale or unrelated", async () => {
      const response = await getConfig("", { "if-none-match": '"0000000000000000"' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveProperty("schemaVersion", 1);
    });

    it("changes the tag when a setting changes, and not when it does not", async () => {
      const before = String((await getConfig()).headers["etag"]);
      expect(String((await getConfig()).headers["etag"])).toBe(before);
      await settings.savePlatformSettings(admin, { tuning: { screenQrRotationSeconds: 50 } });
      const after = String((await getConfig()).headers["etag"]);
      expect(after).not.toBe(before);
      await settings.savePlatformSettings(admin, { tuning: { screenQrRotationSeconds: 45 } });
      expect(String((await getConfig()).headers["etag"])).toBe(before);
    });
  });

  describe("platform settings", () => {
    it("switch a feature off for everyone with a message, and back on", async () => {
      const saved = await settings.savePlatformSettings(admin, {
        features: { shop: { enabled: false, message: OFF } },
      });
      expect(saved).toEqual({ ok: true });
      expect((await configOf()).features["shop"]).toEqual({
        enabled: false,
        minAppVersion: null,
        message: OFF,
      });
      expect((await configOf(`?event=${ids.eventA}`)).features["shop"]?.enabled).toBe(false);

      await settings.savePlatformSettings(admin, { features: {} });
      expect((await configOf()).features["shop"]?.enabled).toBe(true);
    });

    it("carry a minimum app version for a feature", async () => {
      await settings.savePlatformSettings(admin, {
        features: { cheers: { minAppVersion: "1.4.0" } },
      });
      expect((await configOf()).features["cheers"]).toEqual({
        enabled: true,
        minAppVersion: "1.4.0",
        message: null,
      });
      await settings.savePlatformSettings(admin, { features: {} });
    });

    it("refuse a feature the app does not have, and write nothing", async () => {
      const before = await owner("SELECT * FROM platform_setting ORDER BY key");
      const result = await settings.savePlatformSettings(admin, {
        features: { teleporter: { enabled: true }, shop: { enabled: false } },
        tuning: { screenQrRotationSeconds: 99 },
      });
      expect(result).toEqual({
        ok: false,
        reason: "invalid",
        issues: [
          { path: "features.teleporter", message: "is not a feature of the app" },
          { path: "tuning.screenQrRotationSeconds", message: "must be a number from 30 to 60" },
        ],
      });
      expect(await owner("SELECT * FROM platform_setting ORDER BY key")).toEqual(before);
    });

    it("can only be saved by an active Questify admin", async () => {
      for (const who of [regular, { ...admin, status: "disabled" as const }]) {
        expect(await settings.savePlatformSettings(who, { features: {} })).toEqual({
          ok: false,
          reason: "forbidden",
        });
      }
    });

    it("record who changed them", async () => {
      await settings.savePlatformSettings(admin, { tuning: { myQrGraceSeconds: 8 } });
      const rows = await owner<{ updated_by: string }>(
        "SELECT updated_by FROM platform_setting WHERE key = 'tuning'",
      );
      expect(rows[0]?.updated_by).toBe(admin.id);
      await settings.savePlatformSettings(admin, { tuning: { myQrGraceSeconds: 5 } });
    });
  });

  describe("how fast a change reaches an app", () => {
    it("reaches another running copy of the server within the cache time, and not before", async () => {
      const other = createSettingsService({ pool, ttlMs: 15_000, now: () => clock.now });
      expect((await other.forEvent(undefined)).kind).toBe("ok");
      await settings.savePlatformSettings(admin, { tuning: { screenQrRotationSeconds: 55 } });
      const read = async () => {
        const result = await other.forEvent(undefined);
        return result.kind === "ok" ? result.config.tuning["screenQrRotationSeconds"] : undefined;
      };
      expect(await read()).toBe(45);
      clock.now += 14_999;
      expect(await read()).toBe(45);
      clock.now += 1;
      expect(await read()).toBe(55);
      await settings.savePlatformSettings(admin, { tuning: { screenQrRotationSeconds: 45 } });
    });

    it("reaches this copy of the server at once when it was saved here", async () => {
      await getConfig();
      await settings.savePlatformSettings(admin, { tuning: { screenQrRotationSeconds: 40 } });
      expect((await configOf()).tuning["screenQrRotationSeconds"]).toBe(40);
      await settings.savePlatformSettings(admin, { tuning: { screenQrRotationSeconds: 45 } });
    });
  });

  describe("an event", () => {
    it("can switch a feature off for itself only", async () => {
      expect(
        await settings.saveEventSwitches(memberA(), ids.eventA, { features: { cheers: false } }),
      ).toEqual({
        ok: true,
      });
      expect((await configOf(`?event=${ids.eventA}`)).features["cheers"]?.enabled).toBe(false);
      expect((await configOf()).features["cheers"]?.enabled).toBe(true);
      await settings.saveEventSwitches(memberA(), ids.eventA, { features: {} });
      expect((await configOf(`?event=${ids.eventA}`)).features["cheers"]?.enabled).toBe(true);
    });

    it("never switches on what the platform switched off", async () => {
      await settings.savePlatformSettings(admin, { features: { polls: { enabled: false } } });
      await settings.saveEventSwitches(memberA(), ids.eventA, { features: { polls: true } });
      expect((await configOf(`?event=${ids.eventA}`)).features["polls"]?.enabled).toBe(false);
      await settings.savePlatformSettings(admin, { features: {} });
      await settings.saveEventSwitches(memberA(), ids.eventA, { features: {} });
    });

    it("keeps the rest of the event's config when switches are saved and bumps its version", async () => {
      await owner('UPDATE event SET config = \'{"branding": {"accent": "gold"}}\' WHERE id = $1', [
        ids.eventA,
      ]);
      const before = await owner<{ config_version: number }>(
        "SELECT config_version FROM event WHERE id = $1",
        [ids.eventA],
      );
      await settings.saveEventSwitches(memberA(), ids.eventA, { features: { shop: false } });
      const rows = await owner<{ config: unknown; config_version: number }>(
        "SELECT config, config_version FROM event WHERE id = $1",
        [ids.eventA],
      );
      expect(rows[0]?.config).toEqual({ branding: { accent: "gold" }, features: { shop: false } });
      expect(rows[0]?.config_version).toBe((before[0]?.config_version ?? 0) + 1);
      await owner("UPDATE event SET config = '{}' WHERE id = $1", [ids.eventA]);
      await settings.saveEventSwitches(memberA(), ids.eventA, { features: {} });
    });

    it("refuses a switch for a feature the app does not have, and refuses an owner writing an unlock", async () => {
      expect(
        await settings.saveEventSwitches(memberA(), ids.eventA, {
          features: { teleporter: false },
        }),
      ).toMatchObject({ ok: false, reason: "invalid" });
      expect(
        await settings.saveEventSwitches(memberA(), ids.eventA, { unlocked: ["bigScreen"] }),
      ).toMatchObject({ ok: false, reason: "invalid" });
      expect((await configOf(`?event=${ids.eventA}`)).features["bigScreen"]?.enabled).toBe(false);
    });

    it("cannot be edited by another organizer", async () => {
      expect(
        await settings.saveEventSwitches(memberA(), ids.eventB, { features: { shop: false } }),
      ).toEqual({ ok: false, reason: "not_found" });
      const rows = await owner<{ config: unknown }>("SELECT config FROM event WHERE id = $1", [
        ids.eventB,
      ]);
      expect(rows[0]?.config).toEqual({});
    });
  });

  describe("add-ons (FR-1729)", () => {
    it("stay hidden until a Questify admin unlocks them, and hide again when locked", async () => {
      const feature = () =>
        configOf(`?event=${ids.eventA}`).then((c) => c.features["bigScreen"]?.enabled);
      expect(await feature()).toBe(false);
      expect(await settings.unlockFeature(admin, ids.eventA, "bigScreen")).toEqual({ ok: true });
      expect(await settings.unlockFeature(admin, ids.eventA, "bigScreen")).toEqual({ ok: true });
      expect(await feature()).toBe(true);
      expect((await configOf()).features["bigScreen"]?.enabled).toBe(false);
      expect(await settings.lockFeature(admin, ids.eventA, "bigScreen")).toEqual({ ok: true });
      expect(await feature()).toBe(false);
    });

    it("can be unlocked only by an admin, only for features that are add-ons, and only for events that exist", async () => {
      expect(await settings.unlockFeature(regular, ids.eventA, "bigScreen")).toEqual({
        ok: false,
        reason: "forbidden",
      });
      expect(await settings.unlockFeature(admin, ids.eventA, "shop")).toEqual({
        ok: false,
        reason: "invalid",
        issues: [{ path: "feature", message: "is not a gated feature of the app" }],
      });
      expect(
        await settings.unlockFeature(admin, "00000000-0000-4000-8000-000000000000", "bigScreen"),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(await settings.lockFeature(admin, ids.eventA, "bigScreen")).toEqual({
        ok: false,
        reason: "not_found",
      });
      expect(await owner("SELECT 1 FROM event_entitlement")).toEqual([]);
    });

    it("cannot be unlocked by the organizer, even by going to the database with their own rights", async () => {
      await expect(
        withRequestContext(db.app, memberA(), () =>
          db.app.query(
            "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
            [ids.eventA, ids.orgA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      expect(await owner("SELECT 1 FROM event_entitlement")).toEqual([]);
    });
  });

  describe("who can see an event's configuration", () => {
    it("answers 404 for a private event and for one that does not exist, exactly alike", async () => {
      const priv = await getConfig(`?event=${ids.eventB}`);
      const missing = await getConfig("?event=00000000-0000-4000-8000-000000000000");
      expect(priv.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(priv.json()).toEqual(missing.json());
    });

    it("rejects an event that is not an id and any query it does not know", async () => {
      expect((await getConfig("?event=nope")).statusCode).toBe(400);
      expect((await getConfig("?evnt=x")).statusCode).toBe(400);
    });

    it("keeps a private event's add-ons private", async () => {
      await owner(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen'), ($3, $4, 'bigScreen')",
        [ids.eventA, ids.orgA, ids.eventB, ids.orgB],
      );
      const anonymous = await withRequestContext(
        db.app,
        {},
        async () =>
          (await db.app.query<{ event_id: string }>("SELECT event_id FROM event_entitlement")).rows,
      );
      expect(anonymous.map((row) => row.event_id)).toEqual([ids.eventA]);
      const asAdmin = await withRequestContext(
        db.app,
        { isAdmin: true },
        async () => (await db.app.query("SELECT event_id FROM event_entitlement")).rows,
      );
      expect(asAdmin).toHaveLength(2);
      await owner("DELETE FROM event_entitlement");
    });
  });

  describe("what the server remembers", () => {
    it("reads the database once for the same request within the cache time", async () => {
      const spy = vi.spyOn(pool, "connect");
      try {
        await getConfig();
        await getConfig();
        await getConfig(`?event=${ids.eventA}`);
        await getConfig(`?event=${ids.eventA}`);
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    it("reads the platform settings once for several events", async () => {
      const second = (
        await owner<{ id: string }>(
          "INSERT INTO event (organizer_id, join_code, name_en, status) VALUES ($1, 'NAJD2', 'Second Fest', 'live') RETURNING id",
          [ids.orgA],
        )
      )[0]?.id;
      expireCaches();
      await getConfig(`?event=${ids.eventA}`);
      await owner(
        `INSERT INTO platform_setting (key, value) VALUES ('tuning', '{"myQrGraceSeconds": 9}')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      expect((await configOf(`?event=${second}`)).tuning["myQrGraceSeconds"]).toBe(5);
      expireCaches();
      expect((await configOf(`?event=${second}`)).tuning["myQrGraceSeconds"]).toBe(9);
      await owner("DELETE FROM platform_setting");
      await owner("DELETE FROM event WHERE id = $1", [second]);
      expireCaches();
    });
  });

  describe("damaged or old stored data", () => {
    it("never stops an app getting a configuration", async () => {
      await owner(
        `INSERT INTO platform_setting (key, value) VALUES
           ('features', '{"shop": 5, "teleporter": {"enabled": true}, "cheers": {"enabled": "no", "minAppVersion": "soon"}}'),
           ('tuning', '{"screenQrRotationSeconds": "fast", "warp": 9}')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      );
      expireCaches();
      const response = await getConfig();
      expect(response.statusCode).toBe(200);
      expect(parseComposedConfig(response.json()).ok).toBe(true);
      const config = response.json<ComposedConfig>();
      expect(config.features["shop"]?.enabled).toBe(true);
      expect(config.features["cheers"]).toEqual({
        enabled: true,
        minAppVersion: null,
        message: null,
      });
      expect(config.features).not.toHaveProperty("teleporter");
      expect(config.tuning).toEqual({ myQrGraceSeconds: 5, screenQrRotationSeconds: 45 });
      await owner("DELETE FROM platform_setting");
      expireCaches();
    });
  });

  describe("the database rules", () => {
    it("lets only an admin write platform settings, and nobody delete them", async () => {
      await expect(
        withRequestContext(db.app, { staffUserId: regular.id }, () =>
          db.app.query("INSERT INTO platform_setting (key, value) VALUES ('features', '{}')"),
        ),
      ).rejects.toThrow(/row-level security/);
      await withRequestContext(db.app, { isAdmin: true, staffUserId: admin.id }, () =>
        db.app.query("INSERT INTO platform_setting (key, value) VALUES ('features', '{}')"),
      );
      await expect(
        withRequestContext(db.app, { isAdmin: true }, () =>
          db.app.query("DELETE FROM platform_setting"),
        ),
      ).rejects.toThrow(/permission denied/);
      await owner("DELETE FROM platform_setting");
    });

    it("refuses a platform setting whose value is not an object", async () => {
      await expect(
        owner("INSERT INTO platform_setting (key, value) VALUES ('features', '[1]')"),
      ).rejects.toThrow(/check/);
    });

    it("lets the API change only the value of a setting, not its key", async () => {
      await owner("INSERT INTO platform_setting (key, value) VALUES ('features', '{}')");
      await expect(
        withRequestContext(db.app, { isAdmin: true }, () =>
          db.app.query("UPDATE platform_setting SET key = 'tuning'"),
        ),
      ).rejects.toThrow(/permission denied/);
      await owner("DELETE FROM platform_setting");
    });
  });

  /** Forget everything the running service has cached, as a restart would. */
  function expireCaches(): void {
    clock.now += 1_000_000;
  }
});
