import { decodeCursor, encodeCursor } from "@questify/shared";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import {
  readAchievements,
  readCities,
  readEvents,
  readQuestifyQuests,
  syncQuestify,
} from "#src/questify/questify";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const EVENT = "11111111-1111-4111-8111-111111111111";
const OTHER_EVENT = "22222222-2222-4222-8222-222222222222";
const THIRD_EVENT = "33333333-3333-4333-8333-333333333333";
const AT = "2030-01-01T10:00:00.123456Z";

type Seen = { sql: string; values: readonly unknown[] };

/** A client over a fake pool answering from `answer`, with every query it saw. */
async function clientAnswering(answer: (sql: string, values: readonly unknown[]) => FakeAnswer) {
  const seen: Seen[] = [];
  const { pool } = fakePool((sql, values) => {
    seen.push({ sql, values });
    return answer(sql, values);
  });
  return { client: (await pool.connect()) as PoolClient, seen };
}

const failure = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("the call did not fail");
};

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  event_id: EVENT,
  name: { ar: "ملتقى", en: "Meetup" },
  local_date: "2030-01-01",
  starts_at: new Date("2030-01-01T10:00:00.000Z"),
  ends_at: new Date("2030-01-01T12:00:00.000Z"),
  timezone: "Asia/Riyadh",
  city: { ar: "الرياض", en: "Riyadh" },
  event_status: "ended",
  member_status: "active",
  score: "120",
  played: true,
  rank: 3,
  rank_state: "final",
  is_public: true,
  sort_at: AT,
  ...overrides,
});

describe("syncQuestify", () => {
  it("answers what the evaluator wrote", async () => {
    const result = { achievements: [{ id: "regular", tier: "bronze" }], quests: [], levelUp: null };
    const { client, seen } = await clientAnswering(() => ({ rows: [{ result }] }));
    await expect(syncQuestify(client)).resolves.toEqual(result);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("questify_sync()");
  });

  it("answers 401 when the database says the caller is not an active player (PI401)", async () => {
    const { client } = await clientAnswering(() => {
      throw pgError({ code: "PI401" });
    });
    const error = await failure(syncQuestify(client));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401, envelope: { code: "unauthenticated" } });
  });

  it.each([{ code: "40P01" }, { code: "PI402" }, { code: "" }, {}])(
    "rethrows the database fault %o unchanged",
    async (fields) => {
      const fault = pgError(fields);
      const { client } = await clientAnswering(() => {
        throw fault;
      });
      expect(await failure(syncQuestify(client))).toBe(fault);
    },
  );
});

describe.each([
  ["readAchievements", readAchievements, "own_achievements", [{ id: "regular", tier: null }]],
  ["readQuestifyQuests", readQuestifyQuests, "own_questify_quests", { alwaysOn: [], seasonal: [] }],
])("%s", (_name, read, door, list) => {
  it("answers the list the database built for the caller", async () => {
    const { client, seen } = await clientAnswering(() => ({ rows: [{ list }] }));
    await expect(read(client)).resolves.toEqual(list);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain(door);
  });

  it("answers an empty list as it is, not as a signed-out caller", async () => {
    const empty = Array.isArray(list) ? [] : { alwaysOn: [], seasonal: [] };
    const { client } = await clientAnswering(() => ({ rows: [{ list: empty }] }));
    await expect(read(client)).resolves.toEqual(empty);
  });

  it.each([
    ["a null list", [{ list: null }]],
    ["a row without a list", [{}]],
    ["no row", []],
  ])("answers 401 for %s, an inactive caller", async (_label, rows) => {
    const { client } = await clientAnswering(() => ({ rows }));
    const error = await failure(read(client));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 401, envelope: { code: "unauthenticated" } });
  });
});

describe("readCities", () => {
  it("answers the seeded cities in the database's order", async () => {
    const list = [
      { id: "riyadh", name: { ar: "الرياض", en: "Riyadh" } },
      { id: "jeddah", name: { ar: "جدة", en: "Jeddah" } },
    ];
    const { client } = await clientAnswering(() => ({ rows: [{ list }] }));
    await expect(readCities(client)).resolves.toEqual(list);
  });
});

describe("readEvents", () => {
  const query = { played: true, limit: 20 };

  it("maps a row to the event the app reads", async () => {
    const { client } = await clientAnswering(() => ({ rows: [eventRow()] }));
    await expect(readEvents(client, query)).resolves.toEqual({
      events: [
        {
          eventId: EVENT,
          name: { ar: "ملتقى", en: "Meetup" },
          date: "2030-01-01",
          startsAt: "2030-01-01T10:00:00.000Z",
          endsAt: "2030-01-01T12:00:00.000Z",
          timezone: "Asia/Riyadh",
          city: { ar: "الرياض", en: "Riyadh" },
          eventStatus: "ended",
          memberStatus: "active",
          score: 120,
          played: true,
          rank: 3,
          rankState: "final",
          isPublic: true,
        },
      ],
      nextCursor: null,
    });
  });

  it("answers null times and a null city and rank for an event with none", async () => {
    const row = eventRow({ starts_at: null, ends_at: null, city: null, rank: null });
    const { client } = await clientAnswering(() => ({ rows: [row] }));
    const { events } = await readEvents(client, query);
    expect(events[0]).toMatchObject({ startsAt: null, endsAt: null, city: null, rank: null });
  });

  it("asks for the played flag, the first page and one row more than the limit", async () => {
    const { client, seen } = await clientAnswering(() => ({ rows: [] }));
    await readEvents(client, { played: false, limit: 7 });
    expect(seen[0]?.sql).toContain("own_events($1, $2, $3, $4)");
    expect(seen[0]?.values).toEqual([false, null, null, 8]);
  });

  it("hands the cursor's position to the database", async () => {
    const { client, seen } = await clientAnswering(() => ({ rows: [] }));
    const cursor = encodeCursor({ at: AT, id: EVENT });
    await readEvents(client, { ...query, cursor });
    expect(seen[0]?.values).toEqual([true, AT, EVENT, 21]);
  });

  it("answers the page and a cursor at its last row when more rows follow", async () => {
    const rows = [
      eventRow({ event_id: EVENT, sort_at: "2030-03-01T10:00:00.000001Z" }),
      eventRow({ event_id: OTHER_EVENT, sort_at: "2030-02-01T10:00:00.000002Z" }),
      eventRow({ event_id: THIRD_EVENT, sort_at: "2030-01-01T10:00:00.000003Z" }),
    ];
    const { client } = await clientAnswering(() => ({ rows }));
    const page = await readEvents(client, { played: true, limit: 2 });
    expect(page.events.map((event) => event.eventId)).toEqual([EVENT, OTHER_EVENT]);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? "")).toEqual({
      at: "2030-02-01T10:00:00.000002Z",
      id: OTHER_EVENT,
    });
  });

  it("answers no cursor when the rows fill the page exactly", async () => {
    const rows = [eventRow({ event_id: EVENT }), eventRow({ event_id: OTHER_EVENT })];
    const { client } = await clientAnswering(() => ({ rows }));
    const page = await readEvents(client, { played: true, limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("answers an empty page without a cursor for a limit of 0", async () => {
    const { client } = await clientAnswering(() => ({ rows: [eventRow()] }));
    await expect(readEvents(client, { played: true, limit: 0 })).resolves.toEqual({
      events: [],
      nextCursor: null,
    });
  });

  it.each([
    ["text that is not a cursor", "not a cursor!"],
    ["a cursor that is not JSON", Buffer.from("plain text").toString("base64url")],
    ["a cursor that is not an object", Buffer.from("[1]").toString("base64url")],
    ["a position without an id", encodeCursor({ at: AT })],
    ["a position without a time", encodeCursor({ id: EVENT })],
    ["a time without an offset", encodeCursor({ at: "2030-01-01T10:00:00", id: EVENT })],
    ["an id that is not a UUID", encodeCursor({ at: AT, id: "7" })],
    ["a position with a field more", encodeCursor({ at: AT, id: EVENT, extra: 1 })],
  ])("answers 400 for %s and asks the database nothing", async (_label, cursor) => {
    const { client, seen } = await clientAnswering(() => ({ rows: [] }));
    const error = await failure(readEvents(client, { ...query, cursor }));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, envelope: { code: "invalid_request" } });
    expect(seen).toEqual([]);
  });
});
