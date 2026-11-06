import { randomUUID } from "node:crypto";
import {
  REGISTRIES,
  USAGE_EVENTS_CAP,
  eventFeatureKeys,
  featureUsageRawSchema,
  type FeatureUsageRawOrganizer,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { sqlstate } from "#test/support/push";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

const KEYS = eventFeatureKeys(REGISTRIES);
/** The features whose content the door counts; ranking and today's ranking have none of their own. */
const MEASURED = [
  "agenda",
  "bigScreen",
  "boosts",
  "cheers",
  "community",
  "flashQuests",
  "helpDesk",
  "maps",
  "meetSomeone",
  "miniGames",
  "polls",
  "questRatings",
  "shareQuests",
  "shop",
];
const QUEST_BODY = `INSERT INTO quest (organizer_id, event_id, category_id, type, title_en, points, repeat_cap, visible,
                                      flash, verification, type_config)
   SELECT e.organizer_id, e.id, c.id, $2, 'Q', 5, 1, $3, $4,
          CASE WHEN $2 = 'scan_qr' THEN ARRAY['quest_qr'] ELSE ARRAY[]::text[] END, $5::jsonb
   FROM event e JOIN category c ON c.event_id = e.id WHERE e.id = $1 LIMIT 1`;

/**
 * The console's feature usage door (T-714, FR-1839, migration 0140): for a page of organizers, what their events switch on
 * and which of them have content in the feature. Counts only; for an active platform admin alone (QE403 to every other
 * seat); bounded to an organizer's 200 latest events and a page of 51 (the route shows 50, the 51st says there is more).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("feature usage door (database)", () => {
  let f: QuestifyFixture;
  let adminId = "";
  let admin: RequestContext = {};
  beforeAll(async () => {
    f = await questifyFixture();
    adminId = await newAdmin("usage-door@questify.test");
    admin = { isAdmin: true, staffUserId: adminId };
  });
  afterAll(async () => {
    await f.close();
  });

  async function newAdmin(email: string, status = "active"): Promise<string> {
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ($1, 'h', 'admin', $2) RETURNING id",
      [email, status],
    );
    return row?.id ?? "";
  }
  const newOrganizer = async (name: string, slug = `usage-${randomUUID().slice(0, 8)}`) =>
    (
      await f.owner<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ($1, $2) RETURNING id",
        [name, slug],
      )
    )[0]?.id ?? "";
  const door = async (
    search: string | null = null,
    after: string | null = null,
    size: number | null = 50,
    keys: readonly string[] = KEYS,
  ) =>
    featureUsageRawSchema.parse(
      (
        await f.run<{ r: unknown }>(admin, "SELECT console_feature_usage($1, $2, $3, $4) AS r", [
          search,
          after,
          size,
          keys,
        ])
      )[0]?.r,
    ).organizers;
  const only = async (organizer: string): Promise<FeatureUsageRawOrganizer> => {
    const name = (
      await f.owner<{ name: string }>("SELECT name FROM organizer WHERE id = $1", [organizer])
    )[0]?.name;
    const found = (await door(name ?? null)).find((row) => row.id === organizer);
    if (found === undefined) {
      throw new Error(`organizer ${organizer} is not in the answer`);
    }
    return found;
  };

  /** Gives one event content in one feature, through the cheapest rows its table accepts. */
  const content: Record<string, (event: string) => Promise<unknown>> = {
    agenda: (event) =>
      f.owner(
        `INSERT INTO event_session (organizer_id, event_id, kind, title_en, starts_at, ends_at, access, created_by)
         SELECT organizer_id, id, 'talk', 'Talk', now(), now() + interval '1 hour', 'open', $2
         FROM event WHERE id = $1`,
        [event, adminId],
      ),
    bigScreen: (event) =>
      f.owner(
        `INSERT INTO paired_device (organizer_id, event_id, kind, label, secret_hash, paired_by_staff)
         SELECT organizer_id, id, 'screen', 'Hall', sha256(gen_random_uuid()::text::bytea), $2
         FROM event WHERE id = $1`,
        [event, adminId],
      ),
    boosts: (event) =>
      f.owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         SELECT e.organizer_id, e.id, c.id, now(), now() + interval '1 hour'
         FROM event e JOIN category c ON c.event_id = e.id WHERE e.id = $1 LIMIT 1`,
        [event],
      ),
    cheers: (event) =>
      f.owner(
        `INSERT INTO cheers_moment (event_id, organizer_id, ends_at)
         SELECT id, organizer_id, now() + interval '1 minute' FROM event WHERE id = $1`,
        [event],
      ),
    community: (event) =>
      f.owner(
        `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
         SELECT organizer_id, id, 'Goal', 'players', 10, now(), now() + interval '1 day' FROM event WHERE id = $1`,
        [event],
      ),
    flashQuests: (event) => f.owner(QUEST_BODY, [event, "scan_qr", false, true, "{}"]),
    helpDesk: async (event) => {
      await f.join(event, await f.newPlayer());
      return f.owner(
        `INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
         SELECT n.player_id, n.organizer_id, n.event_id, n.id, 'question', 'Where?', gen_random_uuid()::text
         FROM enrollment n WHERE n.event_id = $1 LIMIT 1`,
        [event],
      );
    },
    maps: (event) =>
      f.owner(
        `INSERT INTO event_map (organizer_id, event_id, name_en, position, created_by)
         SELECT organizer_id, id, 'Map', 1, $2 FROM event WHERE id = $1`,
        [event, adminId],
      ),
    meetSomeone: (event) => f.owner(QUEST_BODY, [event, "meet", true, false, '{"dailyCap": 5}']),
    miniGames: (event) =>
      f.owner(QUEST_BODY, [
        event,
        "game",
        true,
        false,
        '{"game": "memory_match", "level": "easy", "attempts": 3}',
      ]),
    polls: (event) =>
      f.owner(QUEST_BODY, [
        event,
        "vote",
        true,
        false,
        '{"options": ["a", "b"], "live": {"choices": "one", "results": "never", "minutes": 10}}',
      ]),
    questRatings: async (event) => {
      await f.join(event, await f.newPlayer());
      await f.owner(QUEST_BODY, [event, "scan_qr", true, false, "{}"]);
      return f.owner(
        `INSERT INTO quest_rating (organizer_id, event_id, quest_id, enrollment_id, thumb)
         SELECT q.organizer_id, q.event_id, q.id, n.id, 'up'
         FROM quest q JOIN enrollment n ON n.event_id = q.event_id WHERE q.event_id = $1 LIMIT 1`,
        [event],
      );
    },
    shareQuests: (event) =>
      f.owner(QUEST_BODY, [event, "share", true, false, '{"message": {"ar": "س", "en": "x"}}']),
    shop: (event) =>
      f.owner(
        `INSERT INTO reward (organizer_id, event_id, kind, name_en, price, stock_total)
         SELECT organizer_id, id, 'item', 'Cap', 10, 5 FROM event WHERE id = $1`,
        [event],
      ),
  };

  /** Events in bulk, with the triggers off (they only keep derived rows this door never reads), so a busy organizer is cheap to build. */
  const manyEvents = async (organizer: string, total: number, prefix: string) => {
    await f.owner("SET session_replication_role = replica");
    try {
      await f.owner(
        `INSERT INTO event (organizer_id, join_code, name_en, status, access, kind, starts_at, ends_at, created_at)
         SELECT $1, $2 || i, 'E' || i, 'scheduled', 'public', 'physical', now() + interval '1 day',
                now() + interval '2 days', now() - make_interval(mins => i)
         FROM generate_series(1, $3::int) AS i`,
        [organizer, prefix, total],
      );
    } finally {
      await f.owner("SET session_replication_role = origin");
    }
  };

  const planOf = async (sql: string, values: unknown[]) => {
    await f.owner("BEGIN");
    try {
      await f.owner("SET LOCAL enable_seqscan = off");
      const plan = await f.owner<Record<string, unknown>>(`EXPLAIN ${sql}`, values);
      return plan.map((line) => String(line["QUERY PLAN"])).join(" ");
    } finally {
      await f.owner("ROLLBACK");
    }
  };

  describe("who may ask", () => {
    it("refuses every seat that is not an active platform admin with QE403", async () => {
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const disabled = await newAdmin("usage-off@questify.test", "disabled");
      const seats: RequestContext[] = [
        f.team(),
        f.team(editor),
        { playerId: await f.newPlayer() },
        { isAdmin: true },
        { isAdmin: true, staffUserId: editor },
        { isAdmin: true, staffUserId: disabled },
        { staffUserId: adminId },
        {},
      ];
      for (const seat of seats) {
        const call = f.run(seat, "SELECT console_feature_usage(NULL, NULL, 50, $1) AS r", [KEYS]);
        expect(await sqlstate(call), JSON.stringify(seat)).toBe("QE403");
      }
    });
  });

  describe("what each feature counts", () => {
    it("counts an event once per feature that has content, and no other event", async () => {
      const organizer = await newOrganizer("Counts Co");
      const rich = await f.newEvent({ organizer });
      const bare = await f.newEvent({ organizer });
      for (const key of MEASURED) {
        await content[key]?.(rich);
      }
      const row = await only(organizer);
      expect(row.events).toBe(2);
      expect(Object.keys(row.using).toSorted()).toEqual(MEASURED);
      for (const key of MEASURED) {
        expect([key, row.using[key]]).toEqual([key, 1]);
      }
      await content["shop"]?.(bare);
      expect((await only(organizer)).using["shop"]).toBe(2);
    });

    it("answers zero for a measured feature nobody used, and nothing for ranking", async () => {
      const organizer = await newOrganizer("Quiet Co");
      await f.newEvent({ organizer });
      const row = await only(organizer);
      expect(row.using["shop"]).toBe(0);
      expect(MEASURED.every((key) => row.using[key] === 0)).toBe(true);
      expect(Object.hasOwn(row.using, "ranking")).toBe(false);
      expect(Object.hasOwn(row.using, "rankingToday")).toBe(false);
    });

    it("answers zero for an organizer with no event at all", async () => {
      const organizer = await newOrganizer("Empty Co");
      const row = await only(organizer);
      expect(row).toMatchObject({
        events: 0,
        more: false,
        switches: {},
        unlocked: {},
        overrides: {},
      });
      expect(Object.keys(row.using).toSorted()).toEqual(MEASURED);
      expect(MEASURED.every((key) => row.using[key] === 0)).toBe(true);
    });

    it("does not count a removed reward, a revoked screen, a plain vote, a plain quest or a game of another type", async () => {
      const organizer = await newOrganizer("Edges Co");
      const event = await f.newEvent({ organizer });
      await content["shop"]?.(event);
      await f.owner("UPDATE reward SET status = 'removed' WHERE event_id = $1", [event]);
      await content["bigScreen"]?.(event);
      await f.owner(
        "UPDATE paired_device SET status = 'revoked', revoked_at = now() WHERE event_id = $1",
        [event],
      );
      await f.owner(QUEST_BODY, [event, "vote", true, false, '{"options": ["a", "b"]}']);
      await f.owner(QUEST_BODY, [event, "scan_qr", true, false, "{}"]);
      const row = await only(organizer);
      for (const key of ["shop", "bigScreen", "polls", "flashQuests", "shareQuests", "miniGames"]) {
        expect([key, row.using[key]]).toEqual([key, 0]);
      }
    });

    it("keeps each organizer's counts to its own events", async () => {
      const first = await newOrganizer("Own Co One");
      const second = await newOrganizer("Own Co Two");
      const mine = await f.newEvent({ organizer: first });
      await f.newEvent({ organizer: second });
      await content["maps"]?.(mine);
      expect((await only(first)).using["maps"]).toBe(1);
      expect((await only(second)).using["maps"]).toBe(0);
    });
  });

  describe("switches, unlocks and overrides", () => {
    it("counts the events that set their own switch on and off, for the listed features only", async () => {
      const organizer = await newOrganizer("Switch Co");
      await f.newEvent({ organizer });
      const off = await f.newEvent({ organizer });
      const on = await f.newEvent({ organizer });
      await f.owner(
        `UPDATE event SET config = jsonb_build_object('features',
           jsonb_build_object('cheers', false, 'questRatings', true, 'dailyStreak', false, 'teleporter', true))
         WHERE id = ANY ($1)`,
        [[off, on]],
      );
      const row = await only(organizer);
      expect(row.switches).toEqual({
        cheers: { on: 0, off: 2 },
        questRatings: { on: 2, off: 0 },
      });
    });

    it("ignores a config whose features are not an object", async () => {
      const organizer = await newOrganizer("Odd Co");
      const event = await f.newEvent({ organizer });
      await f.owner(`UPDATE event SET config = '{"features": [1, 2]}'::jsonb WHERE id = $1`, [
        event,
      ]);
      expect((await only(organizer)).switches).toEqual({});
    });

    it("counts the events an add-on is unlocked for", async () => {
      const organizer = await newOrganizer("Unlock Co");
      const one = await f.newEvent({ organizer });
      await f.newEvent({ organizer });
      await f.owner(
        `INSERT INTO event_entitlement (event_id, organizer_id, feature)
         SELECT id, organizer_id, 'bigScreen' FROM event WHERE id = $1`,
        [one],
      );
      expect((await only(organizer)).unlocked).toEqual({ bigScreen: 1 });
    });

    it("lists the organizer's overrides and none of another organizer's", async () => {
      const organizer = await newOrganizer("Override Co");
      const other = await newOrganizer("Override Other");
      await f.owner(
        `INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, 'cheers', false), ($1, 'shop', true), ($2, 'maps', false)`,
        [organizer, other],
      );
      expect((await only(organizer)).overrides).toEqual({ cheers: false, shop: true });
      expect((await only(other)).overrides).toEqual({ maps: false });
    });

    it("answers only the keys it was asked about", async () => {
      const organizer = await newOrganizer("Keys Co");
      const event = await f.newEvent({ organizer });
      await content["shop"]?.(event);
      await f.owner(
        `INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, 'cheers', false), ($1, 'shop', true)`,
        [organizer],
      );
      const [row] = (await door("Keys Co", null, 50, ["shop"])).filter((r) => r.id === organizer);
      expect(row?.overrides).toEqual({ shop: true });
      const [none] = (await door("Keys Co", null, 50, [])).filter((r) => r.id === organizer);
      expect(none?.overrides).toEqual({});
      expect(none?.switches).toEqual({});
    });
  });

  describe("the bound on an organizer's events", () => {
    it(
      "reads the 200 latest events of an organizer and says there are older ones",
      { timeout: 120_000 },
      async () => {
        const organizer = await newOrganizer("Busy Co");
        await manyEvents(organizer, USAGE_EVENTS_CAP + 5, "BUSY");
        const oldest = (
          await f.owner<{ id: string }>(
            "SELECT id FROM event WHERE organizer_id = $1 ORDER BY created_at, id LIMIT 1",
            [organizer],
          )
        )[0]?.id;
        await content["cheers"]?.(oldest ?? "");
        const row = await only(organizer);
        expect(row).toMatchObject({ events: USAGE_EVENTS_CAP, more: true });
        expect(row.using["cheers"]).toBe(0);
      },
    );

    it("counts the latest events and not the oldest ones", { timeout: 120_000 }, async () => {
      const organizer = await newOrganizer("Recent Co");
      await manyEvents(organizer, USAGE_EVENTS_CAP + 1, "RCNT");
      const newest = (
        await f.owner<{ id: string }>(
          "SELECT id FROM event WHERE organizer_id = $1 ORDER BY created_at DESC, id LIMIT 1",
          [organizer],
        )
      )[0]?.id;
      await content["cheers"]?.(newest ?? "");
      expect((await only(organizer)).using["cheers"]).toBe(1);
    });

    it("says there are no older events at exactly 200", { timeout: 120_000 }, async () => {
      const organizer = await newOrganizer("Exact Co");
      await manyEvents(organizer, USAGE_EVENTS_CAP, "EXCT");
      expect(await only(organizer)).toMatchObject({ events: USAGE_EVENTS_CAP, more: false });
    });
  });

  describe("pages and search", () => {
    it("finds an organizer by the start of its name or slug, in any case, and by nothing inside", async () => {
      const organizer = await newOrganizer("Zanzibar Festivals", "zz-fest-slug");
      expect((await door("zanz")).map((row) => row.id)).toEqual([organizer]);
      expect((await door("ZZ-FEST")).map((row) => row.id)).toEqual([organizer]);
      expect(await door("festivals")).toEqual([]);
      expect(await door("%")).toEqual([]);
    });

    it("pages by name and id without repeating or skipping an organizer, and holds the size to 1..51", async () => {
      for (const name of ["Pg Alpha", "Pg Beta", "Pg Gamma", "Pg Delta", "Pg Epsilon"]) {
        await newOrganizer(name);
      }
      const all = (await door("Pg ", null, 50)).map((row) => row.name);
      expect(all).toEqual(["Pg Alpha", "Pg Beta", "Pg Delta", "Pg Epsilon", "Pg Gamma"]);
      const seen: string[] = [];
      let after: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await door("Pg ", after, 2);
        expect(page.length).toBeLessThanOrEqual(2);
        seen.push(...page.map((row) => row.name));
        if (page.length < 2) {
          break;
        }
        after = page.at(-1)?.id ?? null;
      }
      expect(seen).toEqual(all);
      expect(await door("Pg ", null, 0)).toHaveLength(1);
      expect(await door("Pg ", null, -4)).toHaveLength(1);
      expect(await door(null, null, 1000)).not.toHaveLength(0);
      await f.owner(
        "INSERT INTO organizer (name, slug) SELECT 'Fill ' || g, 'fill-' || g FROM generate_series(1, 52) g",
      );
      expect(await door(null, null, 1000)).toHaveLength(51);
      expect(await door("Pg ", null, null)).toHaveLength(5);
    });

    it("answers an empty page for a cursor that is no organizer", async () => {
      expect(await door("Pg ", randomUUID(), 5)).toEqual([]);
    });
  });

  describe("closed to the public", () => {
    it("is not executable by PUBLIC or the outsider role, and runs with a pinned search path", async () => {
      const [fn] = await f.owner<{
        app: boolean;
        outsider: boolean;
        definer: boolean;
        settings: string[];
      }>(
        `SELECT has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app,
                has_function_privilege('questify_outsider', p.oid, 'EXECUTE') AS outsider,
                prosecdef AS definer, proconfig AS settings
         FROM pg_proc p WHERE p.proname = 'console_feature_usage'`,
      );
      expect(fn).toEqual({
        app: true,
        outsider: false,
        definer: true,
        settings: ["search_path=public, pg_temp"],
      });
      const held = await f.owner<{ grantee: string }>(
        `SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'public' ELSE a.grantee::regrole::text END AS grantee
         FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.proname = 'console_feature_usage' AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner`,
      );
      expect(held).toEqual([{ grantee: "questify_app" }]);
    });
  });

  describe("the indexes the probes use", () => {
    it("reads a quest type, a flash quest, a live poll, a rating and a reward through an index", async () => {
      const event = randomUUID();
      const cases: [string, RegExp][] = [
        ["SELECT 1 FROM quest WHERE event_id = $1 AND type = 'meet'", /quest_event_type_idx/],
        ["SELECT 1 FROM quest WHERE event_id = $1 AND type = 'share'", /quest_event_type_idx/],
        ["SELECT 1 FROM quest WHERE event_id = $1 AND type = 'game'", /quest_event_type_idx/],
        ["SELECT 1 FROM quest WHERE event_id = $1 AND flash", /quest_flash_idx/],
        [
          "SELECT 1 FROM quest WHERE event_id = $1 AND type = 'vote' AND type_config ? 'live'",
          /quest_live_idx/,
        ],
        ["SELECT 1 FROM quest_rating WHERE event_id = $1", /quest_rating_event_idx/],
        ["SELECT 1 FROM reward WHERE event_id = $1 AND status = 'active'", /reward_event_order/],
        ["SELECT 1 FROM ticket WHERE event_id = $1", /ticket_(event|open)_idx/],
        ["SELECT 1 FROM event_session WHERE event_id = $1", /event_session_event/],
        ["SELECT 1 FROM event_map WHERE event_id = $1", /event_map_event/],
        ["SELECT 1 FROM boost WHERE event_id = $1", /boost_event_idx/],
        ["SELECT 1 FROM community_goal WHERE event_id = $1", /community_goal_event_idx/],
        [
          "SELECT 1 FROM paired_device WHERE event_id = $1 AND kind = 'screen' AND status = 'active'",
          /paired_device_event_idx/,
        ],
        ["SELECT 1 FROM cheers_moment WHERE event_id = $1", /cheers_moment_pkey/],
      ];
      for (const [sql, index] of cases) {
        expect(await planOf(sql, [event]), sql).toMatch(index);
      }
    });

    it(
      "reads a busy organizer's latest events in index order, without sorting all of them",
      { timeout: 120_000 },
      async () => {
        const organizer = await newOrganizer("Thousands Co");
        await manyEvents(organizer, 3000, "THSD");
        await f.owner("ANALYZE event");
        const plan = await planOf(
          `SELECT x.id FROM event x WHERE x.organizer_id = $1
           ORDER BY x.created_at DESC, x.id LIMIT ${USAGE_EVENTS_CAP + 1}`,
          [organizer],
        );
        expect(plan).toMatch(/event_organizer_created_idx/);
        expect(plan).not.toMatch(/Sort/);
      },
    );
  });
});
