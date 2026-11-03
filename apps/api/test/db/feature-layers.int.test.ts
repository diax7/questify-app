import { randomUUID } from "node:crypto";
import { FEATURES, isOrganizerOverridable } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { eventFeatureOn } from "#src/settings/feature-guard";
import { createSettingsService } from "#src/settings/service";
import { pushFixture, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/** A call's SQLSTATE and detail ("RS403:feature_off"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

/**
 * Feature layers in the database (T-711, migration 0136, FR-1826): an organizer override lies over the platform's switch
 * in the four SQL rules that read it, nobody but an active admin writes it, an organizer's rows are read only by whoever
 * can see one of its events, and with no override every rule answers as it did before.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("feature layers (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let disabledAdmin: RequestContext = {};

  beforeAll(async () => {
    f = await pushFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('layers@questify.test', 'h', 'admin') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
    const [gone] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('gone@questify.test', 'h', 'admin', 'disabled') RETURNING id",
    );
    disabledAdmin = { isAdmin: true, staffUserId: gone?.id ?? "" };
  });
  afterAll(async () => {
    await f.close();
  });

  const setOverride = (organizer: string, feature: string, enabled: boolean | null) =>
    enabled === null
      ? f.owner("DELETE FROM organizer_feature_override WHERE organizer_id = $1 AND feature = $2", [
          organizer,
          feature,
        ])
      : f.owner(
          `INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, $2, $3)
           ON CONFLICT (organizer_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`,
          [organizer, feature, enabled],
        );
  const setPlatform = (key: string, on: boolean | null) =>
    on === null
      ? f.owner("DELETE FROM platform_setting WHERE key = 'features'")
      : f.owner(
          `INSERT INTO platform_setting (key, value) VALUES ('features', jsonb_build_object($1::text,
             jsonb_build_object('enabled', $2::boolean)))
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, on],
        );
  const setSwitch = (event: string, key: string, on: boolean) =>
    f.owner(
      `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}')
         || jsonb_build_object($2::text, $3::boolean)) WHERE id = $1`,
      [event, key, on],
    );
  const reset = async () => {
    await f.owner("DELETE FROM organizer_feature_override");
    await f.owner("DELETE FROM platform_setting WHERE key = 'features'");
  };

  const funded = async (event: string) => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player, "code");
    await f.owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                 staff_user_id)
       SELECT organizer_id, event_id, id, 'award', 500, 500, 'staff', $2 FROM enrollment WHERE id = $1`,
      [enrollment, f.ownerA],
    );
    return player;
  };
  const reward = async (event: string) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO reward (event_id, kind, name_en, price, stock_total)
         VALUES ($1, 'item', 'Mug', 100, 5) RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";
  const reserve = (player: string, rewardId: string) =>
    refusal(
      f.run({ playerId: player }, "SELECT status FROM reserve_reward($1, $2)", [
        rewardId,
        randomUUID(),
      ]),
    );

  describe("the table", () => {
    it("is written by an active admin only, and read by whoever sees one of the organizer's events", async () => {
      await reset();
      const insert = (context: RequestContext, organizer: string) =>
        refusal(
          f.run(
            context,
            "INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, 'shop', false)",
            [organizer],
          ),
        );
      const owner = f.team();
      expect(await insert({}, f.ids.orgA)).toBe("42501");
      expect(await insert({ playerId: f.ids.playerA }, f.ids.orgA)).toBe("42501");
      expect(await insert(owner, f.ids.orgA)).toBe("42501");
      expect(await insert({ isAdmin: true }, f.ids.orgA)).toBe("42501");
      expect(await insert(disabledAdmin, f.ids.orgA)).toBe("42501");
      expect(await insert(admin, f.ids.orgA)).toBe("none");
      expect(await insert(admin, f.ids.orgB)).toBe("none");

      const rows = (context: RequestContext) =>
        f.run<{ organizer_id: string }>(
          context,
          "SELECT organizer_id FROM organizer_feature_override",
        );
      // Organizer A's event is public, B's is private: a player and organizer B's stranger see A's row only.
      expect((await rows({ playerId: f.ids.playerA })).map((row) => row.organizer_id)).toEqual([
        f.ids.orgA,
      ]);
      expect((await rows(owner)).map((row) => row.organizer_id)).toEqual([f.ids.orgA]);
      expect(await rows({})).toEqual([
        // no identity: the public event is still visible, so is its organizer's row
        { organizer_id: f.ids.orgA },
      ]);
      expect((await rows(admin)).length).toBe(2);
      await reset();
    });

    it("lets an admin change and remove a row, and nobody else", async () => {
      await reset();
      await setOverride(f.ids.orgA, "shop", false);
      const change = (context: RequestContext, sql: string) => f.run(context, sql, [f.ids.orgA]);
      for (const context of [{}, f.team(), { playerId: f.ids.playerA }, disabledAdmin]) {
        const update = await change(
          context,
          "UPDATE organizer_feature_override SET enabled = true WHERE organizer_id = $1 RETURNING 1",
        );
        const remove = await change(
          context,
          "DELETE FROM organizer_feature_override WHERE organizer_id = $1 RETURNING 1",
        );
        expect(update).toEqual([]);
        expect(remove).toEqual([]);
      }
      expect((await f.owner("SELECT enabled FROM organizer_feature_override"))[0]).toEqual({
        enabled: false,
      });
      expect(
        await change(
          admin,
          "UPDATE organizer_feature_override SET enabled = true WHERE organizer_id = $1 RETURNING 1",
        ),
      ).toHaveLength(1);
      expect(
        await change(
          admin,
          "DELETE FROM organizer_feature_override WHERE organizer_id = $1 RETURNING 1",
        ),
      ).toHaveLength(1);
    });

    it("refuses a feature that cannot be overridden, and lists exactly the registry's overridable features", async () => {
      expect(
        await refusal(
          f.owner(
            "INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, 'nfcTags', true)",
            [f.ids.orgA],
          ),
        ),
      ).toMatch(/^23514/);
      expect(
        await refusal(
          f.owner(
            "INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, 'dailyStreak', true)",
            [f.ids.orgA],
          ),
        ),
      ).toMatch(/^23514/);
      const [check] = await f.owner<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'organizer_feature_override'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%shop%'`,
      );
      const listed = [...(check?.def.matchAll(/'([a-zA-Z]+)'::text/g) ?? [])]
        .map((m) => m[1])
        .toSorted();
      const overridable = Object.entries(FEATURES)
        .filter(([, definition]) => isOrganizerOverridable(definition))
        .map(([key]) => key)
        .toSorted();
      expect(listed).toEqual(overridable);
    });

    it("holds nothing for PUBLIC and keeps the platform rule internal", async () => {
      const [rights] = await f.owner<{
        table_public: boolean;
        function_app: boolean;
        function_public: boolean;
      }>(
        `SELECT has_table_privilege('public', 'organizer_feature_override', 'SELECT') AS table_public,
                has_function_privilege('questify_app', 'platform_feature_on(uuid, text)', 'EXECUTE') AS function_app,
                has_function_privilege('public', 'platform_feature_on(uuid, text)', 'EXECUTE') AS function_public`,
      );
      expect(rights).toEqual({ table_public: false, function_app: false, function_public: false });
    });
  });

  describe("the rules that read the platform switch", () => {
    const rules = [
      ["shop", "SELECT shop_on(e) AS on FROM event e WHERE e.id = $1"],
      ["flashQuests", "SELECT flash_on(e) AS on FROM event e WHERE e.id = $1"],
      ["ranking", "SELECT ranking_on(e) AS on FROM event e WHERE e.id = $1"],
      ["polls", "SELECT feature_enabled(e, 'polls') AS on FROM event e WHERE e.id = $1"],
      [
        "cheers",
        "SELECT (cheers_json(e) ->> 'platformOn')::boolean AS on FROM event e WHERE e.id = $1",
      ],
    ] as const;

    it("answer as before with no override, for every platform and event switch", async () => {
      await reset();
      const event = await f.newEvent({ phase: "live" });
      for (const [key, sql] of rules) {
        for (const platformOn of [true, false, null]) {
          await setPlatform(key, platformOn);
          const [row] = await f.owner<{ on: boolean }>(sql, [event]);
          expect({ key, platformOn, on: row?.on }).toEqual({
            key,
            platformOn,
            on: platformOn !== false,
          });
        }
      }
      await reset();
    });

    it("let an override win over the platform, only for that organizer's events", async () => {
      await reset();
      const mine = await f.newEvent({ phase: "live" });
      const theirs = await f.newEvent({ phase: "live", organizer: f.ids.orgB });
      for (const [key, sql] of rules) {
        const read = async (event: string) => (await f.owner<{ on: boolean }>(sql, [event]))[0]?.on;
        await setPlatform(key, false);
        await setOverride(f.ids.orgA, key, true);
        expect({ key, mine: await read(mine), theirs: await read(theirs) }).toEqual({
          key,
          mine: true,
          theirs: false,
        });
        await setPlatform(key, true);
        await setOverride(f.ids.orgA, key, false);
        expect({ key, mine: await read(mine), theirs: await read(theirs) }).toEqual({
          key,
          mine: false,
          theirs: true,
        });
        await setOverride(f.ids.orgA, key, null);
      }
      await reset();
    });

    it("agree with the API's composed configuration in every state of platform, override and event switch", async () => {
      await reset();
      const settings = createSettingsService({ pool: f.pool, ttlMs: 0 });
      const event = await f.newEvent({ phase: "live" });
      const player = await f.newPlayer();
      await f.join(event, player);
      for (const key of ["shop", "polls"]) {
        for (const platformOn of [true, false]) {
          for (const override of [null, true, false]) {
            for (const eventOn of [true, false]) {
              await setPlatform(key, platformOn);
              await setOverride(f.ids.orgA, key, override);
              await setSwitch(event, key, eventOn);
              const [row] = await f.owner<{ on: boolean }>(
                "SELECT feature_enabled(e, $2) AS on FROM event e WHERE e.id = $1",
                [event, key],
              );
              const api = await eventFeatureOn(settings, event, player, key);
              const state = { key, platformOn, override, eventOn };
              expect({ ...state, db: row?.on }).toEqual({ ...state, db: api });
              expect(api, JSON.stringify(state)).toBe((override ?? platformOn) && eventOn);
            }
          }
        }
      }
      await reset();
    });
  });

  describe("the shop's reservation door", () => {
    it("is refused by an override Off and opened by an override On, for that organizer alone", async () => {
      await reset();
      const mine = await f.newEvent({ phase: "live" });
      const theirs = await f.newEvent({ phase: "live", organizer: f.ids.orgB });
      const mineReward = await reward(mine);
      const theirReward = await reward(theirs);
      const mineWho = await funded(mine);
      const theirWho = await funded(theirs);

      await setOverride(f.ids.orgA, "shop", false);
      expect(await reserve(mineWho, mineReward)).toBe("RS403:feature_off");
      expect(await reserve(theirWho, theirReward)).toBe("none");

      await setOverride(f.ids.orgA, "shop", null);
      await setPlatform("shop", false);
      expect(await reserve(mineWho, mineReward)).toBe("RS403:feature_off");
      await setOverride(f.ids.orgA, "shop", true);
      expect(await reserve(mineWho, mineReward)).toBe("none");
      expect(await reserve(theirWho, theirReward)).toBe("RS403:feature_off");
      await reset();
    });
  });
});
