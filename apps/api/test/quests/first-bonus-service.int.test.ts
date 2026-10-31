import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import { createQuest, updateQuest } from "#src/quests/quests";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("first-N bonus builder service boundaries", () => {
  let db: TestDatabase;
  let pool: Pool;
  let actor: Actor;
  let eventId: string;
  let categoryId: string;
  const log = vi.fn<Caller["log"]>();
  const caller = (): Caller => ({
    address: "127.0.0.1",
    userAgent: null,
    log,
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 2 });
    const ids = await seedTwoTenants(db.owner);
    const staffUserId = await addMember(db.owner, ids.orgA);
    actor = {
      staffUserId,
      organizerId: ids.orgA,
      organizer: { id: ids.orgA, role: "owner", eventScope: null },
    };
    eventId = ids.eventA;
    const { rows } = await db.owner.query<{ id: string }>(
      "SELECT id FROM category WHERE event_id = $1 ORDER BY position LIMIT 1",
      [eventId],
    );
    categoryId = rows[0]?.id ?? "";
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const create = (firstBonus: { points: number; slots: number }) =>
    createQuest(
      { pool },
      actor,
      eventId,
      { categoryId, type: "scan_qr", title: { en: "Service quest" }, points: 10, firstBonus },
      caller(),
    );
  const snapshot = async () =>
    (
      await db.owner.query(
        `SELECT q.id, q.title_en, q.points, b.points AS bonus_points, b.slots
         FROM quest q LEFT JOIN quest_first_bonus b ON b.quest_id = q.id
         WHERE q.event_id = $1 ORDER BY q.id`,
        [eventId],
      )
    ).rows;

  it.each([
    [{ points: 0, slots: 3 }, "points"],
    [{ points: 100_001, slots: 3 }, "points"],
    [{ points: 7, slots: 0 }, "slots"],
    [{ points: 7, slots: 1001 }, "slots"],
  ] as const)(
    "refuses invalid create and update inputs before writing: %j",
    async (firstBonus, field) => {
      const made = await create({ points: 7, slots: 3 });
      expect(made.kind).toBe("done");
      if (made.kind !== "done") {
        throw new Error("Expected a valid quest fixture");
      }
      const before = await snapshot();
      const auditBefore = await db.owner.query("SELECT id FROM audit_log ORDER BY id");
      log.mockClear();
      expect(await create(firstBonus)).toEqual({ kind: "invalid_first_bonus", field });
      expect(
        await updateQuest(
          { pool },
          actor,
          { eventId, id: made.value.id },
          { title: { en: "Must not persist" }, points: 99, firstBonus, confirm: true },
          caller(),
        ),
      ).toEqual({ kind: "invalid_first_bonus", field });
      expect(await snapshot()).toEqual(before);
      expect((await db.owner.query("SELECT id FROM audit_log ORDER BY id")).rows).toEqual(
        auditBefore.rows,
      );
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("logs the saved quest and setter outcome, and keeps a bonus on an ordinary quest edit", async () => {
    log.mockClear();
    const made = await create({ points: 17, slots: 4 });
    expect(made.kind).toBe("done");
    if (made.kind !== "done") {
      throw new Error("Expected a valid quest fixture");
    }
    expect(log).toHaveBeenCalledExactlyOnceWith("quest.first_bonus_set", {
      questId: made.value.id,
      outcome: "set",
    });
    log.mockClear();
    const edited = await updateQuest(
      { pool },
      actor,
      { eventId, id: made.value.id },
      { title: { en: "Renamed" }, confirm: true },
      caller(),
    );
    expect(edited).toMatchObject({
      kind: "done",
      value: { quest: { title: { en: "Renamed" }, firstBonus: made.value.firstBonus }, change: null },
    });
    expect(log).not.toHaveBeenCalled();
  });
});
