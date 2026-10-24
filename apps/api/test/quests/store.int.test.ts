import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { withRequestContext } from "#src/db/context";
import { createStaff } from "#test/support/auth-app";
import {
  activeItem,
  holdsPlayedOnce,
  listQuests,
  moveQuests,
  readCategory,
  readQuest,
} from "#src/quests/store";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** The builder's store read straight against the database: what the builder's HTTP tests cannot tell apart. */
describe.skipIf(TEST_DATABASE_URL === undefined)("the builder's store", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let app: PoolClient;
  let staff = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    app = db.app as unknown as PoolClient;
    staff = await createStaff(db.owner, { email: "editor@store.test" });
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [ids.orgA, staff],
    );
  });
  afterAll(async () => {
    await db.close();
  });

  const one = async (sql: string, values: unknown[] = []) =>
    (await db.owner.query<{ id: string }>(sql, values)).rows[0]?.id ?? "";
  const newCategory = () =>
    one("INSERT INTO category (event_id, name_en, position) VALUES ($1, 'Extra', 9) RETURNING id", [
      ids.eventA,
    ]);
  const newQuest = (category: string, type = "enter_code", config: object = { code: "NAJD" }) =>
    one(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
       VALUES ($1, $2, $3, 'A quest', 5, $4) RETURNING id`,
      [ids.eventA, category, type, JSON.stringify(config)],
    );
  const asOrganizer = <T>(work: () => Promise<T>) =>
    withRequestContext(db.app, { organizerId: ids.orgA, staffUserId: staff }, work);
  /** Whether another transaction could lock the row now, or must wait for this one. */
  const lockedElsewhere = async (table: "quest" | "category", id: string) =>
    db.owner
      .query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])
      .then(() => false)
      .catch((error: { code?: string }) => {
        if (error.code === "55P03") {
          return true;
        }
        throw error;
      });

  it("locks a quest or category it reads for a write until the transaction ends, and only then", async () => {
    const category = await newCategory();
    const quest = await newQuest(category);
    await asOrganizer(async () => {
      await readQuest(app, ids.eventA, quest);
      await readCategory(app, ids.eventA, category);
      expect(await lockedElsewhere("quest", quest)).toBe(false);
      expect(await lockedElsewhere("category", category)).toBe(false);
    });
    await asOrganizer(async () => {
      await readQuest(app, ids.eventA, quest, true);
      await readCategory(app, ids.eventA, category, true);
      expect(await lockedElsewhere("quest", quest)).toBe(true);
      expect(await lockedElsewhere("category", category)).toBe(true);
    });
    expect(await lockedElsewhere("quest", quest)).toBe(false);
  });

  it("reads a quest that is not a passport with no steps", async () => {
    const category = await newCategory();
    const quest = await newQuest(category);
    const listed = await asOrganizer(() => listQuests(app, ids.eventA));
    expect(listed.find((row) => row.id === quest)).toMatchObject({ steps: [], place: null });
  });

  it("says whether a category holds a quest played once", async () => {
    const category = await newCategory();
    await newQuest(category);
    expect(await asOrganizer(() => holdsPlayedOnce(app, category))).toBe(false);
    await newQuest(category, "share", {
      message: { en: "At the fest" },
      link: "https://example.com/fest",
    });
    expect(await asOrganizer(() => holdsPlayedOnce(app, category))).toBe(true);
  });

  it("moves every quest of a category and says how many", async () => {
    const from = await newCategory();
    const to = await newCategory();
    await newQuest(from);
    await newQuest(from);
    expect(await asOrganizer(() => moveQuests(app, from, to))).toBe(2);
    expect(await asOrganizer(() => moveQuests(app, from, to))).toBe(0);
  });

  it("takes an active quest item of the event only", async () => {
    const item = async (status: string, event = ids.eventA, organizer = ids.orgA) =>
      one(
        `INSERT INTO quest_item (organizer_id, event_id, name_en, stock_total, status)
         VALUES ($1, $2, 'Badge', 5, $3) RETURNING id`,
        [organizer, event, status],
      );
    const active = await item("active");
    const removed = await item("removed");
    const theirs = await item("active", ids.eventB, ids.orgB);
    expect(await asOrganizer(() => activeItem(app, ids.eventA, active))).toBe(true);
    expect(await asOrganizer(() => activeItem(app, ids.eventA, removed))).toBe(false);
    expect(await asOrganizer(() => activeItem(app, ids.eventA, theirs))).toBe(false);
  });
});
