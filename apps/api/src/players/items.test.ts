import { decodeCursor, encodeCursor, type ProfileItem } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { itemNotOwned, itemRefusal, readEquipment, readLocker } from "#src/players/items";
import { fakePool, pgError } from "#test/support/fake-pool";

const EVENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const frame = (id: string): ProfileItem => ({
  id,
  kind: "frame",
  name: { ar: "إطار", en: "Frame" },
  visualKey: "frame-01",
});
const levelRow = (n: number) => ({
  item: frame(`f${n}`),
  earned_at: `2030-01-0${n}T10:00:00.000000Z`,
  source_level: n,
  source_event: null,
  seen: n % 2 === 0,
});

/** Reads the locker from rows the database "returns", keeping the statement's values. */
async function lockerOf(rows: unknown[], cursor: string | undefined, limit: number) {
  const seen: (readonly unknown[])[] = [];
  const { pool } = fakePool((_sql, values) => {
    seen.push(values);
    return { rows };
  });
  const client = await pool.connect();
  try {
    return { page: await readLocker(client, cursor, limit), seen };
  } finally {
    client.release();
  }
}

/** The error a call refuses with, or a failing expectation when it does not refuse. */
async function refusalOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("The call did not refuse.");
}

describe("itemRefusal", () => {
  it("answers 401 for a session the database cannot read (PI401)", () => {
    try {
      itemRefusal(pgError({ code: "PI401" }));
      expect.unreachable("PI401 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 401, envelope: { code: "unauthenticated" } });
    }
  });

  it("answers 422 item_not_owned for an item that is not in the locker (PI422)", () => {
    try {
      itemRefusal(pgError({ code: "PI422" }));
      expect.unreachable("PI422 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 422, envelope: { code: "item_not_owned" } });
      expect((error as HttpError).envelope).toEqual(itemNotOwned().envelope);
    }
  });

  it("rethrows anything else untouched, so exception details never become an answer", () => {
    for (const original of [pgError({ code: "23505" }), new Error("no code"), pgError({})]) {
      try {
        itemRefusal(original);
        expect.unreachable("an unknown error must throw");
      } catch (error) {
        expect(error).toBe(original);
      }
    }
  });
});

describe("readEquipment", () => {
  it("returns the equipment and the next reward the database answers", async () => {
    const row = {
      equipment: { character: null, frame: frame("f1"), title: null },
      next_reward: frame("f2"),
    };
    const { pool, queries } = fakePool(() => ({ rows: [row] }));
    const client = await pool.connect();
    expect(await readEquipment(client)).toEqual(row);
    expect(queries).toEqual(["SELECT equipment,next_reward FROM own_equipment()"]);
  });

  it("answers 401 when the database returns no row for the caller", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const error = await refusalOf(async () => readEquipment(await pool.connect()));
    expect(error).toMatchObject({ status: 401, envelope: { code: "unauthenticated" } });
  });
});

describe("readLocker", () => {
  it("asks for one row more than the page, from the first page when there is no cursor", async () => {
    const { seen } = await lockerOf([], undefined, 30);
    expect(seen).toEqual([[null, null, 31]]);
  });

  it("returns an empty page with no next cursor", async () => {
    const { page } = await lockerOf([], undefined, 5);
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("keeps entries earned at a level as a level source", async () => {
    const { page } = await lockerOf([levelRow(1), levelRow(2)], undefined, 5);
    expect(page.items).toEqual([
      {
        item: frame("f1"),
        earnedAt: "2030-01-01T10:00:00.000000Z",
        source: { kind: "level", level: 1 },
        seen: false,
      },
      {
        item: frame("f2"),
        earnedAt: "2030-01-02T10:00:00.000000Z",
        source: { kind: "level", level: 2 },
        seen: true,
      },
    ]);
  });

  it("keeps entries earned at an event as an event source", async () => {
    const event = { id: EVENT_ID, name: { ar: "مهرجان", en: "Fest" } };
    const { page } = await lockerOf(
      [{ ...levelRow(3), source_level: 0, source_event: event }],
      undefined,
      5,
    );
    expect(page.items[0]?.source).toEqual({ kind: "event", event });
  });

  it("returns no next cursor when the rows fit the page exactly or fall short of it", async () => {
    const exact = await lockerOf([levelRow(1), levelRow(2)], undefined, 2);
    expect(exact.page.items).toHaveLength(2);
    expect(exact.page.nextCursor).toBeNull();
    const short = await lockerOf([levelRow(1)], undefined, 2);
    expect(short.page.nextCursor).toBeNull();
  });

  it("trims the extra row and points the next cursor at the last row of the page", async () => {
    const { page } = await lockerOf([levelRow(1), levelRow(2), levelRow(3)], undefined, 2);
    expect(page.items.map((entry) => entry.item.id)).toEqual(["f1", "f2"]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? "")).toEqual({
      at: "2030-01-02T10:00:00.000000Z",
      id: "f2",
    });
  });

  it("gives no next cursor for an empty page even when a row was fetched past it", async () => {
    const { page } = await lockerOf([levelRow(1)], undefined, 0);
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("continues after the position in a valid cursor", async () => {
    const cursor = encodeCursor({ at: "2030-01-02T10:00:00.000000Z", id: "f2" });
    const { seen } = await lockerOf([], cursor, 10);
    expect(seen).toEqual([["2030-01-02T10:00:00.000000Z", "f2", 11]]);
  });

  it.each([
    ["text that is not base64url", "not a cursor!"],
    ["JSON that is not an object", Buffer.from("null").toString("base64url")],
    ["a position with no id", encodeCursor({ at: "2030-01-02T10:00:00.000000Z" })],
    ["a position with no time", encodeCursor({ id: "f2" })],
    ["a time that is not a date", encodeCursor({ at: "yesterday", id: "f2" })],
    ["an empty id", encodeCursor({ at: "2030-01-02T10:00:00.000000Z", id: "" })],
    [
      "an id over 64 characters",
      encodeCursor({ at: "2030-01-02T10:00:00.000000Z", id: "x".repeat(65) }),
    ],
    [
      "a position with an extra field",
      encodeCursor({ at: "2030-01-02T10:00:00.000000Z", id: "f2", extra: 1 }),
    ],
  ])("refuses %s as an invalid request without querying", async (_name, cursor) => {
    const seen: unknown[] = [];
    const { pool } = fakePool((sql) => {
      seen.push(sql);
      return { rows: [] };
    });
    const client = await pool.connect();
    const error = await refusalOf(() => readLocker(client, cursor, 10));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, envelope: { code: "invalid_request" } });
    expect(seen).toEqual([]);
  });
});
