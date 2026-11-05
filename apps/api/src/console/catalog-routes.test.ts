import { DEFAULT_QUESTIFY_HOME } from "@questify/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { PublicAccount } from "#src/auth/staff-store";
import { registerConsoleCatalogRoutes } from "#src/console/catalog-routes";
import { registerConventions } from "#src/conventions";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { fakePool } from "#test/support/fake-pool";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const NAME = { ar: "اسم", en: "Name" };
const HEADERS = { "x-test-admin": "yes", "idempotency-key": "key-1" };
const TEMPLATE_DOC = {
  name: { ar: "مؤتمر", en: "Conference" },
  description: { ar: "يوم طويل.", en: "A long day." },
  body: {
    config: { features: {}, accent: "sky", layoutPreset: "classic" },
    categories: [
      {
        nameAr: "البداية",
        nameEn: "Start",
        orderMode: "any",
        completionBonus: 0,
        quests: [
          {
            type: "scan_qr",
            titleAr: "سجّل حضورك",
            titleEn: "Check in",
            descriptionAr: "امسح الرمز.",
            descriptionEn: "Scan the code.",
            points: 50,
            repeatCap: 1,
            typeConfig: {},
          },
        ],
      },
    ],
    rewards: [],
  },
  enabled: true,
};
const TEMPLATE_ROW = {
  key: "conference",
  position: 1,
  name: NAME,
  description: NAME,
  body: {},
  enabled: true,
  updatedAt: "2030-01-01T00:00:00Z",
};
const ACHIEVEMENT_ROW = {
  id: "quests-done",
  metric: "quests",
  bronze: 1,
  silver: 2,
  gold: 3,
  name: NAME,
  visualKey: "trophy",
  position: 1,
};
const SHOP_ROW = {
  itemId: "gold-frame",
  kind: "frame",
  name: NAME,
  visualKey: null,
  price: 5,
  status: "active",
  position: 1,
};
const ITEM_ROW = {
  id: "gold-frame",
  kind: "frame",
  name: NAME,
  visualKey: "frame-03",
  source: null,
  locked: { art: null },
};
const HOME_ROW = { order: [], hidden: [], banner: [] };

type Seen = { sql: string; values: readonly unknown[] };
let app: FastifyInstance;

/** The catalog routes at the admin prefix over a pool answering every door with `answer` as its `r` column. */
function build(answer: unknown = {}) {
  const seen: Seen[] = [];
  const forgotten: string[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return sql.endsWith(" AS r") ? { rows: [{ r: answer }] } : { rows: [] };
  });
  app = Fastify();
  registerConventions(app, {
    minAppVersion: "1.0.0",
    idempotencyStore: new MemoryIdempotencyStore(),
  });
  app.addHook("onRequest", async (request) => {
    request.staff = {
      account: { id: ADMIN } as PublicAccount,
      sessionId: "session-1",
      tokenHash: "",
      surface: "console",
    };
  });
  const deps = {
    pool,
    keys: { userKey: () => Buffer.alloc(32, 7) },
    forgetConfig: () => void forgotten.push("config"),
  };
  app.register(async (scope) => registerConsoleCatalogRoutes(scope, deps), {
    prefix: "/v1/admin",
  });
  const doors = () => seen.filter((query) => query.sql.endsWith(" AS r"));
  return { seen, doors, forgotten };
}

const send = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({
    method,
    url: `/v1/admin/catalog${url}`,
    headers: { ...HEADERS, "content-type": "application/json" },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });

afterEach(async () => {
  await app.close();
});

describe("each catalog's address and answer names", () => {
  it.each([
    ["/templates", "SELECT admin_templates() AS r", "templates"],
    ["/achievements", "SELECT admin_achievements() AS r", "achievements"],
    ["/gem-shop", "SELECT admin_shop_items() AS r", "items"],
    ["/items", "SELECT admin_items() AS r", "items"],
  ])("lists %s through its door as { %s }", async (path, sql, list) => {
    const { doors } = build([]);
    const response = await send("GET", path);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ [list]: [] });
    expect(doors()[0]?.sql).toBe(sql);
  });

  it.each([
    ["/level-titles", "SELECT admin_level_titles() AS r", { titles: [] }],
    ["/amounts", "SELECT admin_amounts() AS r", undefined],
    ["/xp-table", "SELECT admin_xp_table() AS r", { levels: [] }],
    ["/home-layout", "SELECT admin_home_layout() AS r", HOME_ROW],
  ])("answers %s as the document itself", async (path, sql, row) => {
    const amounts = {
      xp: { questXp: 100, dailyFinishXp: 20, dailyRightXp: 10, dailyWordXp: 50 },
      gems: { levelUp: 20, bronze: 10, silver: 25, gold: 50 },
      stored: { xp: true, gems: true },
    };
    const document = row ?? amounts;
    const { doors } = build(document);
    const response = await send("GET", path);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ...document, revertible: false });
    expect(doors()[0]?.sql).toBe(sql);
  });

  it.each([
    ["/templates/conference", TEMPLATE_DOC, TEMPLATE_ROW, "template"],
    [
      "/achievements/quests-done",
      { name: NAME, bronze: 1, silver: 2, gold: 3 },
      ACHIEVEMENT_ROW,
      "achievement",
    ],
    ["/gem-shop/gold-frame", { price: 5, status: "active", position: 1 }, SHOP_ROW, "item"],
    ["/items/gold-frame", { name: NAME, visualKey: "frame-03" }, ITEM_ROW, "item"],
  ])("saves %s and answers it as { %s }", async (path, doc, row, one) => {
    build(row);
    const response = await send("PUT", path, doc);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ [one]: { ...row, revertible: false } });
  });
});

describe("a save's confirmation", () => {
  it("is an unknown field of an editor that pays no gems, refused before the door", async () => {
    const { doors } = build(TEMPLATE_ROW);
    const response = await send("PUT", "/templates/conference", {
      ...TEMPLATE_DOC,
      confirmed: true,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "invalid_catalog",
      details: { issues: [{ path: "" }] },
    });
    expect(doors()).toEqual([]);
  });

  it("is taken apart from an achievement's document and sent to its door", async () => {
    const { doors } = build(ACHIEVEMENT_ROW);
    const doc = { name: NAME, bronze: 1, silver: 2, gold: 3 };
    const response = await send("PUT", "/achievements/quests-done", { ...doc, confirmed: true });
    expect(response.statusCode).toBe(200);
    expect(doors()[0]?.values).toEqual(["quests-done", doc, null, true, expect.any(String)]);
  });

  it.each([
    ["null", null],
    ["a string", "bronze"],
    ["a list", [1]],
  ])(
    "leaves %s sent to an achievement whole, refused as one issue on the body",
    async (_label, body) => {
      const { doors } = build(ACHIEVEMENT_ROW);
      const response = await send("PUT", "/achievements/quests-done", body);
      expect(response.statusCode).toBe(422);
      const problem = response.json() as { code: string; details: { issues: { path: string }[] } };
      expect(problem.code).toBe("invalid_catalog");
      expect(problem.details.issues).toEqual([{ path: "", message: expect.any(String) }]);
      expect(doors()).toEqual([]);
    },
  );
});

describe("the settings cache", () => {
  it("is cleared by a change to Questify home, and by nothing else", async () => {
    const template = build(TEMPLATE_ROW);
    expect((await send("PUT", "/templates/conference", TEMPLATE_DOC)).statusCode).toBe(200);
    expect(template.forgotten).toEqual([]);
    await app.close();
    const home = build(HOME_ROW);
    const response = await send("PUT", "/home-layout", DEFAULT_QUESTIFY_HOME);
    expect(response.statusCode, response.body).toBe(200);
    expect(home.forgotten).toEqual(["config"]);
  });
});

describe("the XP table's preview and a new item", () => {
  it("refuses a table that fails the shared schema with its issues, before the limits and the door", async () => {
    const { seen } = build({ up: 0, down: 0, levels: 0, gems: 0, levelUp: 1 });
    const levels = [
      { level: 1, xpFrom: 5, itemId: null },
      { level: 2, xpFrom: 10, itemId: "a" },
    ];
    const response = await send("POST", "/xp-table/preview", { levels });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "invalid_catalog",
      details: { issues: [{ path: "levels.0.xpFrom", message: "level 1 starts at 0" }] },
    });
    expect(seen).toEqual([]);
  });

  it("refuses an item that fails the shared schema with its issues, before the limits and the door", async () => {
    const { seen } = build(ITEM_ROW);
    const response = await send("POST", "/items", {
      id: "gold-frame",
      kind: "frame",
      name: NAME,
      visualKey: "chest",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "invalid_catalog",
      details: { issues: [{ path: "visualKey", message: "pick the art shipped for this kind" }] },
    });
    expect(seen).toEqual([]);
  });
});
