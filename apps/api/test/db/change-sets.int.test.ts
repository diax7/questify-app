import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** A call's SQLSTATE, or "none" when it succeeds. */
const sqlState = async (work: Promise<unknown>) =>
  work.then(
    () => "none",
    (error: { code?: string }) => error.code,
  );

/**
 * The change set tables (T-604b, migration 0099): visible and writable only to an owner or an editor of the organizer
 * inside the event limit, never to a player, a stranger or the public role; a set and its items never change their
 * content; an item is decided once and only in an open set; an event holds 20 open sets.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("change set tables", () => {
  let db: TestDatabase;
  let orgA = "";
  let orgB = "";
  let eventA = "";
  let eventB = "";
  let staffA = "";
  let staffB = "";
  let playerA = "";

  const as = <T>(context: RequestContext, work: () => Promise<T>) =>
    withRequestContext(db.app, context, work);
  const seatA = (): RequestContext => ({ organizerId: orgA, staffUserId: staffA });
  const insert = (organizer: string, event: string, by: string, context: RequestContext) =>
    as(context, () =>
      sqlState(
        db.app.query(
          "INSERT INTO change_set (organizer_id, event_id, created_by) VALUES ($1, $2, $3)",
          [organizer, event, by],
        ),
      ),
    );
  const newSet = async (event = eventA, organizer = orgA, by = staffA) => {
    const { rows } = await db.owner.query<{ id: string }>(
      "INSERT INTO change_set (organizer_id, event_id, created_by) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, by],
    );
    return rows[0]?.id ?? "";
  };
  const newItem = async (set: string, position = 0, event = eventA, organizer = orgA) => {
    const { rows } = await db.owner.query<{ id: string }>(
      `INSERT INTO change_set_item (change_set_id, organizer_id, event_id, position, op, target, body)
       VALUES ($1, $2, $3, $4, 'add', 'quest', '{}') RETURNING id`,
      [set, organizer, event, position],
    );
    return rows[0]?.id ?? "";
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    ({ orgA, orgB, eventA, eventB, playerA } = await seedTwoTenants(db.owner));
    const staff = async (email: string, organizer: string) => {
      const { rows } = await db.owner.query<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash) VALUES ($1, 'x') RETURNING id",
        [email],
      );
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [organizer, rows[0]?.id],
      );
      return rows[0]?.id ?? "";
    };
    staffA = await staff("a@sets.test", orgA);
    staffB = await staff("b@sets.test", orgB);
  });
  afterAll(async () => {
    await db.close();
  });

  it("shows a set to its organizer's staff only, and to no player, stranger or public role", async () => {
    const set = await newSet();
    await newItem(set);
    const seen = async (context: RequestContext) =>
      as(context, async () => ({
        sets: (await db.app.query("SELECT 1 FROM change_set WHERE id = $1", [set])).rowCount,
        items: (await db.app.query("SELECT 1 FROM change_set_item WHERE change_set_id = $1", [set]))
          .rowCount,
      }));
    expect(await seen(seatA())).toEqual({ sets: 1, items: 1 });
    expect(await seen({ organizerId: orgB, staffUserId: staffB })).toEqual({ sets: 0, items: 0 });
    expect(await seen({ organizerId: orgA, playerId: playerA })).toEqual({ sets: 0, items: 0 });
    expect(await seen({ playerId: playerA })).toEqual({ sets: 0, items: 0 });
    await expect(db.outsider.query("SELECT 1 FROM public.change_set")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.outsider.query("SELECT 1 FROM public.change_set_item")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("keeps an editor to the events in their limit", async () => {
    const set = await newSet();
    const other = await db.owner.query<{ id: string }>(
      "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'SETS2', 'Second') RETURNING id",
      [orgA],
    );
    const editor = await db.owner.query<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash) VALUES ('editor@sets.test', 'x') RETURNING id",
    );
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role, event_scope) VALUES ($1, $2, 'editor', $3)",
      [orgA, editor.rows[0]?.id, [other.rows[0]?.id]],
    );
    const limited: RequestContext = {
      organizerId: orgA,
      staffUserId: editor.rows[0]?.id as string,
    };
    const found = await as(
      limited,
      async () => (await db.app.query("SELECT 1 FROM change_set WHERE id = $1", [set])).rowCount,
    );
    expect(found).toBe(0);
    const forged = await as(limited, async () =>
      sqlState(
        db.app.query(
          "INSERT INTO change_set (organizer_id, event_id, created_by) VALUES ($1, $2, $3)",
          [orgA, eventA, editor.rows[0]?.id],
        ),
      ),
    );
    expect(forged).toBe("42501");
  });

  it("refuses a set made for another organizer's event, in another's name, or by a stranger", async () => {
    expect(await insert(orgB, eventB, staffA, seatA())).toBe("42501");
    expect(await insert(orgA, eventA, staffB, seatA())).toBe("42501");
    expect(await insert(orgA, eventB, staffA, seatA())).toBe("23503");
    expect(await insert(orgA, eventA, staffA, { organizerId: orgA, playerId: playerA })).toBe(
      "42501",
    );
    expect(await insert(orgA, eventA, staffA, seatA())).toBe("none");
  });

  it("never deletes through the API's role, and never changes what a set or an item holds", async () => {
    const set = await newSet();
    const item = await newItem(set);
    const attempt = (sql: string, values: unknown[]) =>
      as(seatA(), () => sqlState(db.app.query(sql, values)));
    expect(await attempt("DELETE FROM change_set WHERE id = $1", [set])).toBe("42501");
    expect(await attempt("DELETE FROM change_set_item WHERE id = $1", [item])).toBe("42501");
    expect(
      await attempt("UPDATE change_set_item SET body = '{\"a\":1}' WHERE id = $1", [item]),
    ).toBe("42501");
    expect(
      await sqlState(
        db.owner.query("UPDATE change_set_item SET body = '{\"a\":1}' WHERE id = $1", [item]),
      ),
    ).toBe("CS409");
    expect(
      await sqlState(
        db.owner.query("UPDATE change_set SET created_by = $2 WHERE id = $1", [set, staffB]),
      ),
    ).toBe("CS409");
  });

  it("decides an item once, and only while its set is open", async () => {
    const set = await newSet();
    const first = await newItem(set, 0);
    const second = await newItem(set, 1);
    const decide = (item: string, status: string, error: string | null = null) =>
      as(seatA(), () =>
        sqlState(
          db.app.query(
            "UPDATE change_set_item SET status = $2, error = $3, decided_at = now() WHERE id = $1",
            [item, status, error],
          ),
        ),
      );
    expect(await decide(first, "applied")).toBe("none");
    expect(await decide(first, "stale")).toBe("CS409");
    expect(await decide(second, "failed")).toBe("23514");
    await as(seatA(), () =>
      db.app.query("UPDATE change_set SET status = 'closed', finished_at = now() WHERE id = $1", [
        set,
      ]),
    );
    expect(await decide(second, "stale")).toBe("CS409");
    expect(
      await sqlState(
        db.owner.query("UPDATE change_set SET status = 'open', finished_at = NULL WHERE id = $1", [
          set,
        ]),
      ),
    ).toBe("CS409");
    expect(
      await sqlState(
        db.owner.query(
          `INSERT INTO change_set_item (change_set_id, organizer_id, event_id, position, op, target, body)
       VALUES ($1, $2, $3, 5, 'add', 'quest', '{}')`,
          [set, orgA, eventA],
        ),
      ),
    ).toBe("CS409");
  });

  it("holds the shape of an item and 100 items to a set", async () => {
    const set = await newSet();
    const bad = (columns: string, values: string) =>
      sqlState(
        db.owner.query(
          `INSERT INTO change_set_item (change_set_id, organizer_id, event_id, position, ${columns}) VALUES ($1, $2, $3, 0, ${values})`,
          [set, orgA, eventA],
        ),
      );
    expect(await bad("op, target, body", "'add', 'quest', '[]'")).toBe("23514");
    expect(await bad("op, target, body", "'edit', 'quest', '{}'")).toBe("23514");
    expect(
      await bad("op, target, target_id, body", `'add', 'quest', '${randomUUID()}', '{}'`),
    ).toBe("23514");
    expect(await bad("op, target, body", "'add', 'event', '{}'")).toBe("23514");
    expect(await bad("op, target, body, before", "'add', 'quest', '{}', '{}'")).toBe("23514");
    expect(
      await sqlState(
        db.owner.query(
          `INSERT INTO change_set_item (change_set_id, organizer_id, event_id, position, op, target, body)
       VALUES ($1, $2, $3, 100, 'add', 'quest', '{}')`,
          [set, orgA, eventA],
        ),
      ),
    ).toBe("23514");
    expect(
      await sqlState(
        db.owner.query(
          `INSERT INTO change_set_item (change_set_id, organizer_id, event_id, position, op, target, body)
       VALUES ($1, $2, $3, 0, 'add', 'quest', $4)`,
          [set, orgA, eventB, "{}"],
        ),
      ),
    ).toBe("23503");
  });

  it("holds an event to 20 open sets, and counts a finished one no more", async () => {
    const crowded = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'SETS3', 'Crowded') RETURNING id",
        [orgA],
      )
    ).rows[0]?.id as string;
    const sets: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      sets.push(await newSet(crowded));
    }
    expect(await sqlState(newSet(crowded))).toBe("CS429");
    await db.owner.query(
      "UPDATE change_set SET status = 'closed', finished_at = now() WHERE id = $1",
      [sets[0]],
    );
    expect(await sqlState(newSet(crowded))).toBe("none");
  });

  it("follows the event when a draft event is deleted", async () => {
    const draft = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'SETS4', 'Gone') RETURNING id",
        [orgA],
      )
    ).rows[0]?.id as string;
    const set = await newSet(draft);
    await newItem(set, 0, draft);
    await db.owner.query("DELETE FROM event WHERE id = $1", [draft]);
    const left = await db.owner.query("SELECT 1 FROM change_set WHERE id = $1", [set]);
    expect(left.rowCount).toBe(0);
  });
});
