import { QUEST_TYPE_NAMES } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * Categories and quests in the database (T-103, migration 0010): every event has a General category, a quest sits in a
 * category of its own event, the organizer comes from the event, an editor's limit applies, an ended event's quests
 * are history, and the type is one the app ships.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("categories and quests (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let owner: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    owner = await addMember(db.owner, ids.orgA, "owner");
  });
  afterAll(async () => {
    await db.close();
  });

  const as = async <T extends Record<string, unknown>>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> =>
    withRequestContext(db.app, context, async () => (await db.app.query<T>(sql, values)).rows);
  const seatA = (staffUserId = owner): RequestContext => ({ organizerId: ids.orgA, staffUserId });

  /** An event of organizer A in a given state, made with the owner connection (as activation would). */
  const eventIn = async (status: "draft" | "live" | "ended" = "draft"): Promise<string> => {
    counter += 1;
    const times =
      status === "draft"
        ? ["1 day", "2 days"]
        : status === "live"
          ? ["-1 hour", "1 day"]
          : ["-2 days", "-1 day"];
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Quests', $3, now() + $4::interval, now() + $5::interval) RETURNING id`,
      [ids.orgA, `QBLD${counter}`, status, times[0], times[1]],
    );
    return rows[0]?.id ?? "";
  };
  const generalOf = async (event: string): Promise<string> =>
    (await db.owner.query<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [event]))
      .rows[0]?.id ?? "";
  const addQuest = (context: RequestContext, event: string, category: string, extra = "") =>
    as<{ id: string; organizer_id: string }>(
      context,
      `INSERT INTO quest (event_id, category_id, type, title_en, points${extra === "" ? "" : ", type_config"})
       VALUES ($1, $2, 'scan_qr', 'Find the stage', 10${extra === "" ? "" : `, ${extra}`})
       RETURNING id, organizer_id`,
      [event, category],
    );

  describe("the General category (FR-228)", () => {
    it("comes with every new event, in both languages, first", async () => {
      const event = await eventIn();
      const { rows } = await db.owner.query(
        "SELECT name_ar, name_en, position, organizer_id FROM category WHERE event_id = $1",
        [event],
      );
      expect(rows).toEqual([
        { name_ar: "عام", name_en: "General", position: 0, organizer_id: ids.orgA },
      ]);
    });

    it("was added to the events made before this migration", async () => {
      const { rows } = await db.owner.query(
        "SELECT count(*)::int AS missing FROM event e WHERE NOT EXISTS (SELECT 1 FROM category c WHERE c.event_id = e.id)",
      );
      expect(rows).toEqual([{ missing: 0 }]);
    });
  });

  describe("where a quest may sit", () => {
    it("takes its organizer from the event, never from the request", async () => {
      const event = await eventIn();
      const [quest] = await addQuest(seatA(), event, await generalOf(event));
      expect(quest?.organizer_id).toBe(ids.orgA);
      await expect(
        as(seatA(), "INSERT INTO category (organizer_id, event_id, name_en) VALUES ($1, $2, 'x')", [
          ids.orgB,
          event,
        ]),
      ).rejects.toThrow(/permission denied/);
    });

    it("refuses another organizer's event, even with a category id that exists there", async () => {
      await expect(addQuest(seatA(), ids.eventB, await generalOf(ids.eventB))).rejects.toThrow(
        /row-level security/,
      );
    });

    it("refuses a category of another event of the same organizer", async () => {
      const one = await eventIn();
      const two = await eventIn();
      await expect(addQuest(seatA(), one, await generalOf(two))).rejects.toMatchObject({
        code: "23503",
      });
    });

    it("never moves a quest to another event", async () => {
      const event = await eventIn();
      const [quest] = await addQuest(seatA(), event, await generalOf(event));
      await expect(
        as(seatA(), "UPDATE quest SET event_id = $2 WHERE id = $1", [quest?.id, await eventIn()]),
      ).rejects.toThrow(/permission denied/);
    });

    it("keeps a category that still holds quests until they are moved or deleted", async () => {
      const event = await eventIn();
      const general = await generalOf(event);
      await addQuest(seatA(), event, general);
      await expect(
        as(seatA(), "DELETE FROM category WHERE id = $1", [general]),
      ).rejects.toMatchObject({
        code: "23503",
      });
    });

    it("goes with its draft event when the event is deleted", async () => {
      const event = await eventIn();
      await addQuest(seatA(), event, await generalOf(event));
      await as(seatA(), "DELETE FROM event WHERE id = $1", [event]);
      const { rows } = await db.owner.query(
        "SELECT (SELECT count(*) FROM quest WHERE event_id = $1)::int AS quests, (SELECT count(*) FROM category WHERE event_id = $1)::int AS categories",
        [event],
      );
      expect(rows).toEqual([{ quests: 0, categories: 0 }]);
    });
  });

  describe("what a quest holds", () => {
    it.each([
      [
        "a type the app does not ship",
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'submission', 'x', 1)",
      ],
      [
        "no title",
        "INSERT INTO quest (event_id, category_id, type, points) VALUES ($1, $2, 'scan_qr', 1)",
      ],
      [
        "negative points",
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'x', -1)",
      ],
      [
        "a cap above 100",
        "INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap) VALUES ($1, $2, 'scan_qr', 'x', 1, 101)",
      ],
      [
        "a window that closes before it opens",
        "INSERT INTO quest (event_id, category_id, type, title_en, points, opens_at, closes_at) VALUES ($1, $2, 'scan_qr', 'x', 1, now(), now() - interval '1 minute')",
      ],
      [
        "a config that is not an object",
        "INSERT INTO quest (event_id, category_id, type, title_en, points, type_config) VALUES ($1, $2, 'scan_qr', 'x', 1, '[]')",
      ],
      [
        "a title over 120 characters",
        "INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', repeat('x', 121), 1)",
      ],
    ])("refuses %s", async (_name, sql) => {
      const event = await eventIn();
      await expect(as(seatA(), sql, [event, await generalOf(event)])).rejects.toMatchObject({
        code: "23514",
      });
    });

    it("accepts exactly the types the shared registry ships", async () => {
      const { rows } = await db.owner.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'quest_type_known'",
      );
      const listed = [...(rows[0]?.definition ?? "").matchAll(/'([a-z_]+)'/g)].map(
        (match) => match[1],
      );
      expect(listed.toSorted()).toEqual([...QUEST_TYPE_NAMES].toSorted());
    });

    it("keeps its type once created", async () => {
      const event = await eventIn();
      const [quest] = await addQuest(seatA(), event, await generalOf(event));
      await expect(
        as(seatA(), "UPDATE quest SET type = 'enter_code' WHERE id = $1", [quest?.id]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("an editor limited to chosen events", () => {
    it("sees and builds only those events' categories and quests", async () => {
      const mine = await eventIn();
      const other = await eventIn();
      const editor = await addMember(db.owner, ids.orgA, "editor", [mine]);
      const seat = seatA(editor);
      await addQuest(seat, mine, await generalOf(mine));
      await expect(addQuest(seat, other, await generalOf(other))).rejects.toThrow(
        /row-level security/,
      );
      const seen = await as<{ event_id: string }>(
        seat,
        "SELECT DISTINCT event_id FROM category WHERE event_id = ANY($1)",
        [[mine, other]],
      );
      expect(seen).toEqual([{ event_id: mine }]);
    });
  });

  describe("an ended event", () => {
    it("keeps its categories and quests as they were", async () => {
      const event = await eventIn("live");
      const general = await generalOf(event);
      const [quest] = await addQuest(seatA(), event, general);
      await db.owner.query("UPDATE event SET status = 'ended' WHERE id = $1", [event]);
      for (const sql of [
        "UPDATE quest SET points = 99 WHERE id = $1",
        "DELETE FROM quest WHERE id = $1",
      ]) {
        await expect(as(seatA(), sql, [quest?.id])).rejects.toMatchObject({ code: "QE409" });
      }
      await expect(
        as(seatA(), "INSERT INTO category (event_id, name_en) VALUES ($1, 'Late')", [event]),
      ).rejects.toMatchObject({ code: "QE409" });
      await expect(
        as(seatA(), "UPDATE category SET name_en = 'Renamed' WHERE id = $1", [general]),
      ).rejects.toMatchObject({ code: "QE409" });
    });

    it("counts as ended from its end time, before the tick catches up", async () => {
      const event = await eventIn("live");
      await db.owner.query("UPDATE event SET ends_at = now() - interval '1 second' WHERE id = $1", [
        event,
      ]);
      await expect(
        as(seatA(), "INSERT INTO category (event_id, name_en) VALUES ($1, 'Late')", [event]),
      ).rejects.toMatchObject({ code: "QE409" });
    });

    it("lets a live event's quests change", async () => {
      const event = await eventIn("live");
      const [quest] = await addQuest(seatA(), event, await generalOf(event));
      await as(seatA(), "UPDATE quest SET points = 20 WHERE id = $1", [quest?.id]);
      const { rows } = await db.owner.query("SELECT points FROM quest WHERE id = $1", [quest?.id]);
      expect(rows).toEqual([{ points: 20 }]);
    });
  });

  describe("outsiders", () => {
    it("can do nothing with categories and quests", async () => {
      for (const sql of [
        "SELECT * FROM public.category",
        "SELECT * FROM public.quest",
        "INSERT INTO public.category (event_id, name_en) VALUES (gen_random_uuid(), 'x')",
        "DELETE FROM public.quest",
      ]) {
        await expect(db.outsider.query(sql)).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot call the new functions", async () => {
      for (const fn of [
        "set_organizer_from_event()",
        "quest_closed_guard()",
        "add_general_category()",
        "quest_touch()",
      ]) {
        const { rows } = await db.owner.query<{ allowed: boolean }>(
          `SELECT has_function_privilege('questify_outsider', '${fn}', 'EXECUTE') AS allowed`,
        );
        expect(rows, fn).toEqual([{ allowed: false }]);
      }
    });
  });
});
