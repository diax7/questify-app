import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  event: undefined as { id: string; timezone: string; statusNow: string } | undefined,
  audits: [] as unknown[],
}));

vi.mock("#src/quests/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/quests/store")>()),
  lockBuilderEvent: async () => mocked.event,
}));
vi.mock("#src/quests/builder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/quests/builder")>()),
  audit: async (_client: unknown, _actor: unknown, _caller: unknown, entry: unknown) => {
    mocked.audits.push(entry);
  },
}));

const { createReward } = await import("#src/rewards/builder");
const { updateItem } = await import("#src/rewards/quest-items");

const ORGANIZER = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-000000000002";
const EVENT = "00000000-0000-4000-8000-000000000003";
const ID = "00000000-0000-4000-8000-000000000004";
const ACTOR = { organizerId: ORGANIZER, staffUserId: STAFF } as never;
const CALLER = { requestId: "r1" } as never;

type Statement = { sql: string; values: unknown[] };

function fakePool(answer: (sql: string, values: unknown[]) => unknown[]) {
  const statements: Statement[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      const rows = answer(sql, values);
      return { rows, rowCount: rows.length };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

const dataSql = (statements: Statement[]) =>
  statements
    .filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(s.sql) && !s.sql.includes("set_config"))
    .map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "));

beforeEach(() => {
  mocked.event = { id: EVENT, timezone: "Asia/Riyadh", statusNow: "draft" };
  mocked.audits = [];
});

describe("createReward", () => {
  const rewardRow = {
    id: ID,
    kind: "item",
    name_ar: null,
    name_en: "Cap",
    description_ar: null,
    description_en: null,
    price: 5,
    stock_total: 7,
    units_out: 0,
    per_player_limit: null,
    opens_at: null,
    closes_at: null,
    section: null,
    tag_new: false,
    tag_limited: false,
    position: 2,
  };

  function run(
    input: Parameters<typeof createReward>[3],
    options: Readonly<{ count?: number; desk?: boolean }> = {},
  ) {
    const fake = fakePool((sql) => {
      if (sql.includes("count(*)")) {
        return [{ n: options.count ?? 0 }];
      }
      if (sql.includes("desk_location_ar")) {
        return options.desk === false ? [] : [{ "?column?": 1 }];
      }
      return [{ ...rewardRow, kind: input.kind }];
    });
    const deps = { pool: fake.pool, codeKey: {} as never };
    return { ...fake, result: createReward(deps, ACTOR, EVENT, input, CALLER) };
  }

  it("refuses stock on a digital reward, and a missing stock on any other", async () => {
    expect(await run({ kind: "digital", name: { en: "Code" }, price: 1, stock: 5 }).result).toEqual(
      { kind: "stock_from_codes" },
    );
    expect(await run({ kind: "item", name: { en: "Cap" }, price: 1 }).result).toEqual({
      kind: "invalid",
      field: "stock",
    });
    expect(await run({ kind: "experience", name: { en: "Cap" }, price: 1 }).result).toEqual({
      kind: "invalid",
      field: "stock",
    });
  });

  it("lets a digital reward through with stock 0 or none", async () => {
    for (const stock of [0, undefined]) {
      const { result, statements } = run({
        kind: "digital",
        name: { en: "Code" },
        price: 1,
        stock,
      });
      expect((await result).kind).toBe("done");
      expect(dataSql(statements)).toEqual(["SELECT count(*)::int AS", "INSERT INTO reward"]);
    }
  });

  it("refuses a reward the merge refuses, before touching the database", async () => {
    const { result, statements } = run({ kind: "experience", price: 1, stock: 1 });
    expect(await result).toEqual({ kind: "invalid", field: "name" });
    expect(dataSql(statements)).toEqual([]);
  });

  it("refuses the hundred-and-first reward", async () => {
    const { result, statements } = run(
      { kind: "experience", name: { en: "Cap" }, price: 1, stock: 1 },
      { count: 100 },
    );
    expect(await result).toEqual({ kind: "limit_reached", limit: 100 });
    expect(dataSql(statements)).toEqual(["SELECT count(*)::int AS"]);
  });

  it("needs a desk place for an item only", async () => {
    const item = run({ kind: "item", name: { en: "Cap" }, price: 1, stock: 1 }, { desk: false });
    expect(await item.result).toEqual({ kind: "desk_needed" });
    expect(dataSql(item.statements)).toEqual(["SELECT count(*)::int AS", "SELECT 1 FROM"]);
    const experience = run(
      { kind: "experience", name: { en: "Cap" }, price: 1, stock: 1 },
      { desk: false },
    );
    expect((await experience.result).kind).toBe("done");
    expect(dataSql(experience.statements)).not.toContain("SELECT 1 FROM");
  });

  it("inserts at the end with the merged fields, and audits the create", async () => {
    const { result, statements } = run(
      {
        kind: "item",
        name: { ar: "قبعة", en: "Cap" },
        description: { en: "Blue" },
        price: 5,
        stock: 7,
        perPlayerLimit: 2,
        section: "merch",
        tags: { new: true },
      },
      { count: 2 },
    );
    expect(await result).toEqual({
      kind: "done",
      value: {
        id: ID,
        kind: "item",
        name: { ar: null, en: "Cap" },
        description: { ar: null, en: null },
        price: 5,
        stock: 7,
        unitsOut: 0,
        perPlayerLimit: null,
        opensAt: null,
        closesAt: null,
        section: null,
        tags: { new: false, limited: false },
        position: 2,
      },
    });
    const insert = statements.find((s) => s.sql.includes("INSERT INTO reward"));
    expect(insert?.values).toEqual([
      EVENT,
      "item",
      "قبعة",
      "Cap",
      null,
      "Blue",
      5,
      7,
      2,
      null,
      null,
      "merch",
      true,
      false,
      2,
    ]);
    expect(mocked.audits).toEqual([
      {
        action: "reward.create",
        eventId: EVENT,
        target: { type: "reward", id: ID },
        after: {
          kind: "item",
          name: { ar: null, en: "Cap" },
          description: { ar: null, en: null },
          price: 5,
          stock: 7,
          perPlayerLimit: null,
          opensAt: null,
          closesAt: null,
          section: null,
          tags: { new: false, limited: false },
        },
      },
    ]);
  });
});

const itemRow = (over: Record<string, unknown> = {}) => ({
  id: ID,
  name_ar: "قديم",
  name_en: "Old",
  description_ar: null,
  description_en: "Desc",
  stock_total: 10,
  units_out: 4,
  stock_left: 6,
  missed: 0,
  quests: [],
  categories: [],
  ...over,
});

function runUpdate(
  input: Parameters<typeof updateItem>[3],
  options: Readonly<{ active?: boolean; after?: Record<string, unknown> }> = {},
) {
  let reads = 0;
  const fake = fakePool((sql) => {
    if (sql.includes("FOR UPDATE")) {
      return options.active === false ? [] : [{ "?column?": 1 }];
    }
    if (sql.includes("quest_items(")) {
      reads += 1;
      return [reads === 1 ? itemRow() : itemRow(options.after)];
    }
    return [];
  });
  return {
    ...fake,
    result: updateItem({ pool: fake.pool }, ACTOR, { eventId: EVENT, id: ID }, input, CALLER),
  };
}

describe("updateItem", () => {
  it("is not found for a stranger's event, and refused once archived", async () => {
    mocked.event = undefined;
    expect(await runUpdate({}).result).toEqual({ kind: "not_found" });
    mocked.event = { id: EVENT, timezone: "UTC", statusNow: "archived" };
    expect(await runUpdate({}).result).toEqual({ kind: "event_archived" });
  });

  it("is not found for a removed or unknown item", async () => {
    const { result, statements } = runUpdate({}, { active: false });
    expect(await result).toEqual({ kind: "not_found" });
    expect(dataSql(statements)).toEqual(["SELECT 1 FROM"]);
  });

  it("refuses a name cleared in both languages", async () => {
    expect(await runUpdate({ name: { ar: " ", en: null } }).result).toEqual({
      kind: "invalid",
      field: "name",
    });
  });

  it("refuses a stock below the units already out", async () => {
    expect(await runUpdate({ stockTotal: 3 }).result).toEqual({
      kind: "stock_below_reserved",
      unitsOut: 4,
    });
    const equal = await runUpdate({ stockTotal: 4 }, { after: { stock_total: 4, stock_left: 0 } })
      .result;
    expect(equal.kind).toBe("done");
  });

  it("updates with the merged text and stock, and audits only what changed", async () => {
    const { result, statements } = runUpdate(
      { name: { en: "  New  " }, description: { en: "" }, stockTotal: 12 },
      {
        after: {
          name_en: "New",
          description_en: null,
          stock_total: 12,
          stock_left: 8,
        },
      },
    );
    const outcome = await result;
    expect(outcome).toMatchObject({
      kind: "done",
      value: { id: ID, name: { ar: "قديم", en: "New" }, stockTotal: 12, stockLeft: 8 },
    });
    expect(statements.find((s) => s.sql.includes("UPDATE quest_item"))?.values).toEqual([
      ID,
      "قديم",
      "New",
      null,
      null,
      12,
    ]);
    expect(mocked.audits).toEqual([
      {
        action: "quest_item.update",
        eventId: EVENT,
        target: { type: "quest_item", id: ID },
        before: { nameEn: "Old", descriptionEn: "Desc", stockTotal: 10 },
        after: { nameEn: "New", descriptionEn: null, stockTotal: 12 },
      },
    ]);
  });

  it("keeps the stock when none is sent, and writes no audit when nothing changed", async () => {
    const { result, statements } = runUpdate({});
    expect((await result).kind).toBe("done");
    expect(statements.find((s) => s.sql.includes("UPDATE quest_item"))?.values).toEqual([
      ID,
      "قديم",
      "Old",
      null,
      "Desc",
      10,
    ]);
    expect(mocked.audits).toEqual([]);
  });
});
