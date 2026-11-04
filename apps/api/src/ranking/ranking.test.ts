import { EMPTY_EQUIPMENT, type Equipment } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createRanking,
  type CompletionEntries,
  type EntryRow,
  type RankingLog,
  type RankingView,
} from "#src/ranking/ranking";
import type { RankingStore } from "#src/ranking/store";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const EVENT = "11111111-1111-4111-8111-111111111111";
const PLAYER = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const ANN = "44444444-4444-4444-8444-444444444444";
const BEA = "55555555-5555-4555-8555-555555555555";
const CAL = "66666666-6666-4666-8666-666666666666";
const DAY = "2026-11-04";

type Queries = Record<string, (values: readonly unknown[]) => FakeAnswer>;
type Logged = [string, Record<string, string | number>];

const noRows = (): FakeAnswer => ({ rows: [] });
const rowsOf =
  (...rows: unknown[]) =>
  (): FakeAnswer => ({ rows });

/** Answers each statement by the first needle its SQL contains; a statement nobody expects fails the test. */
const answering =
  (given: Queries) =>
  (sql: string, values: readonly unknown[]): FakeAnswer => {
    const found = Object.entries(given).find(([needle]) => sql.includes(needle));
    if (found === undefined) {
      throw new Error(`unexpected statement: ${sql}`);
    }
    return found[1](values);
  };

const throwing = (code: string) => (): FakeAnswer => {
  throw pgError({ code });
};

const SHOWN: Equipment = {
  character: { id: "c1", kind: "character", name: { ar: "ص", en: "Scout" }, visualKey: null },
  frame: null,
  title: null,
};
const OWN = { id: ME, score: "10", username: "me", avatar: "falcon", equipment: EMPTY_EQUIPMENT };
const ANN_TOP = {
  enrollment_id: ANN,
  username: "ann",
  avatar: "fox",
  equipment: EMPTY_EQUIPMENT,
  score: "20",
};
const BLOCKED_TOP = {
  enrollment_id: BEA,
  username: null,
  avatar: null,
  equipment: null,
  score: "15",
};
const named = (id: string, over: Record<string, unknown> = {}) => ({
  enrollment_id: id,
  username: "ann",
  avatar: "fox",
  equipment: EMPTY_EQUIPMENT,
  ranked: true,
  ...over,
});

/** The statements of one `read`: the reader, the day, the name display, the top and place from PostgreSQL. */
const readWorld = (over: Queries = {}): Queries => ({
  "FROM enrollment e JOIN player p": rowsOf(OWN),
  ranking_today: rowsOf({ day: DAY, multi_day: false, live: true, my_score: null }),
  player_name_display: rowsOf({ display: "username" }),
  ranking_top: rowsOf(ANN_TOP),
  ranking_position: rowsOf({ place: "2", total: "2" }),
  ranking_rows: rowsOf(named(ANN)),
  ranking_names: noRows,
  mark_ranking_repair: noRows,
  ...over,
});

/** The statements of one `repairDue`: no claimed event, no live event, a live multi-day event's day. */
const repairWorld = (over: Queries = {}): Queries => ({
  claim_ranking_repairs: rowsOf({ claim_ranking_repairs: EVENT }),
  live_ranking_events: noRows,
  ranking_today: rowsOf({ day: DAY, multi_day: true, live: true, my_score: null }),
  mark_ranking_repair: noRows,
  ...over,
});

/** A store that records every call; `given` replaces what a call answers (no copy built, every rebuild done). */
const storeOf = (given: Partial<RankingStore> = {}) => ({
  upsert: vi.fn<RankingStore["upsert"]>(given.upsert ?? (() => Promise.resolve())),
  upsertRead: vi.fn<RankingStore["upsertRead"]>(
    given.upsertRead ?? (() => Promise.resolve(undefined)),
  ),
  remove: vi.fn<RankingStore["remove"]>(given.remove ?? (() => Promise.resolve())),
  read: vi.fn<RankingStore["read"]>(given.read ?? (() => Promise.resolve(undefined))),
  rebuild: vi.fn<RankingStore["rebuild"]>(given.rebuild ?? (() => Promise.resolve("rebuilt"))),
  builtAt: vi.fn<RankingStore["builtAt"]>(given.builtAt ?? (() => Promise.resolve(undefined))),
});

const harness = (world: Queries, store: RankingStore | undefined) => {
  const { pool, queries } = fakePool(answering(world));
  const logs: Logged[] = [];
  const log: RankingLog = (level, fields) => logs.push([level, fields]);
  return {
    ranking: createRanking({ pool, store, log }),
    logs,
    queries,
    asked: (needle: string) => queries.filter((sql) => sql.includes(needle)).length,
  };
};

const view = (seen: RankingView | "not_enrolled" | "today_off"): RankingView => {
  if (seen === "not_enrolled" || seen === "today_off") {
    throw new Error(`expected a view, got ${seen}`);
  }
  return seen;
};

const copyOf = (...top: [string, bigint, bigint][]) => ({
  top: top.map(([enrollmentId, version, score]) => ({ enrollmentId, version, score })),
  total: top.length,
  place: 2,
});

const entry = (over: Partial<EntryRow> = {}): EntryRow => ({
  event_id: EVENT,
  enrollment_id: ME,
  score: "10",
  score_version: "7",
  ranked: true,
  ...over,
});

const entriesOf = (over: Partial<CompletionEntries> = {}): CompletionEntries => ({
  eventId: EVENT,
  entry: entry(),
  day: undefined,
  failed: false,
  sqlstate: undefined,
  ...over,
});

/** The ranking's own reads, with the database and Redis replaced by what each statement and call answers. */
describe("the ranking read from PostgreSQL alone", () => {
  it("answers the board and the reader's place with no store, logging and marking nothing", async () => {
    const run = harness(readWorld(), undefined);
    const seen = view(await run.ranking.read(EVENT, PLAYER));
    expect(seen).toEqual({
      rows: [
        {
          rank: 1,
          username: "ann",
          fullName: null,
          avatar: "fox",
          equipment: EMPTY_EQUIPMENT,
          hidden: false,
          score: 20,
          isMe: false,
        },
      ],
      me: {
        rank: 2,
        username: "me",
        fullName: null,
        avatar: "falcon",
        equipment: EMPTY_EQUIPMENT,
        score: 10,
      },
      total: 2,
      today: false,
      names: "username",
    });
    expect(run.logs).toEqual([]);
    expect(run.asked("mark_ranking_repair")).toBe(0);
  });

  it("hides the player a blocked reader no longer sees, keeping the place and the score", async () => {
    const world = readWorld({ ranking_top: rowsOf(BLOCKED_TOP, ANN_TOP) });
    const seen = view(await harness(world, undefined).ranking.read(EVENT, PLAYER));
    expect(seen.rows.map((row) => [row.username, row.hidden, row.score])).toEqual([
      [null, true, 15],
      ["ann", false, 20],
    ]);
  });
});

describe("the ranking read from the Redis copy", () => {
  it("answers from PostgreSQL, with nothing logged or marked, when the copy cannot be built", async () => {
    const store = storeOf({ rebuild: () => Promise.resolve("busy") });
    const run = harness(readWorld(), store);
    const seen = view(await run.ranking.read(EVENT, PLAYER));
    expect(seen.rows.map((row) => row.username)).toEqual(["ann"]);
    expect(store.rebuild).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(run.logs).toEqual([]);
    expect(run.asked("mark_ranking_repair")).toBe(0);
    expect(run.asked("ranking_rows")).toBe(0);
  });

  it("takes out a player the database no longer ranks or no longer finds, and answers from PostgreSQL", async () => {
    const store = storeOf({
      read: () => Promise.resolve(copyOf([ANN, 1n, 30n], [BEA, 2n, 20n], [CAL, 3n, 10n])),
    });
    const world = readWorld({
      ranking_rows: rowsOf(named(ANN), named(CAL, { ranked: false })),
    });
    const run = harness(world, store);
    const seen = view(await run.ranking.read(EVENT, PLAYER));
    expect(store.remove.mock.calls).toEqual([
      [EVENT, BEA, 2n],
      [EVENT, CAL, 3n],
    ]);
    expect(run.asked("mark_ranking_repair")).toBe(1);
    expect(seen.total).toBe(2);
    expect(run.logs).toEqual([]);
  });

  it("answers not_enrolled, leaving the copy alone, when the reader lost their place", async () => {
    const store = storeOf({ read: () => Promise.resolve(copyOf([ANN, 1n, 30n])) });
    const run = harness(readWorld({ ranking_rows: throwing("QR403") }), store);
    expect(await run.ranking.read(EVENT, PLAYER)).toBe("not_enrolled");
    expect(store.remove).not.toHaveBeenCalled();
    expect(run.logs).toEqual([]);
    expect(run.asked("mark_ranking_repair")).toBe(0);
  });

  it("logs any other failure of the names read, marks the event and answers from PostgreSQL", async () => {
    const store = storeOf({ read: () => Promise.resolve(copyOf([ANN, 1n, 30n])) });
    const run = harness(readWorld({ ranking_rows: throwing("57P01") }), store);
    const seen = view(await run.ranking.read(EVENT, PLAYER));
    expect(seen.total).toBe(2);
    expect(run.logs).toEqual([["warn", { event: "ranking.read_failed", reason: "Error" }]]);
    expect(run.asked("mark_ranking_repair")).toBe(1);
  });

  it("shows a masked row with nothing of the player, and the equipment as the database gave it", async () => {
    const store = storeOf({
      read: () => Promise.resolve(copyOf([BEA, 1n, 30n], [ANN, 2n, 20n], [ME, 3n, 10n])),
    });
    const world = readWorld({
      ranking_rows: rowsOf(
        named(BEA, { username: null, avatar: null, equipment: null }),
        named(ANN, { equipment: SHOWN }),
        named(ME, { username: "me", equipment: null }),
      ),
    });
    const seen = view(await harness(world, store).ranking.read(EVENT, PLAYER));
    expect(seen.rows).toEqual([
      {
        rank: 1,
        username: null,
        fullName: null,
        avatar: null,
        equipment: null,
        hidden: true,
        score: 30,
        isMe: false,
      },
      {
        rank: 2,
        username: "ann",
        fullName: null,
        avatar: "fox",
        equipment: SHOWN,
        hidden: false,
        score: 20,
        isMe: false,
      },
      {
        rank: 3,
        username: "me",
        fullName: null,
        avatar: "fox",
        equipment: EMPTY_EQUIPMENT,
        hidden: false,
        score: 10,
        isMe: true,
      },
    ]);
  });
});

describe("the reader's own state in a read", () => {
  it("answers not_enrolled for a reader the database does not find", async () => {
    const run = harness(readWorld({ "FROM enrollment e JOIN player p": noRows }), undefined);
    expect(await run.ranking.read(EVENT, PLAYER)).toBe("not_enrolled");
    expect(run.asked("ranking_today")).toBe(0);
  });

  it("answers not_enrolled for a reader whose event day the database no longer answers", async () => {
    const store = storeOf();
    const run = harness(readWorld({ ranking_today: noRows }), store);
    expect(await run.ranking.read(EVENT, PLAYER)).toBe("not_enrolled");
    expect(store.read).not.toHaveBeenCalled();
    expect(run.asked("ranking_top")).toBe(0);
  });

  it("names players by username, asking nothing, when the name display is not answered", async () => {
    for (const answer of [noRows, rowsOf({ display: null }), rowsOf({ display: "nickname" })]) {
      const run = harness(readWorld({ player_name_display: answer }), undefined);
      expect(view(await run.ranking.read(EVENT, PLAYER)).names).toBe("username");
      expect(run.asked("ranking_names")).toBe(0);
    }
  });

  it("asks for full names only where the event shows them, with the reader's own among the ids", async () => {
    const world = readWorld({
      player_name_display: rowsOf({ display: "both" }),
      ranking_names: rowsOf({ enrollment_id: ANN, full_name: "Ann Ali" }),
    });
    const run = harness(world, undefined);
    const seen = view(await run.ranking.read(EVENT, PLAYER));
    expect(seen.names).toBe("both");
    expect(seen.rows[0]?.fullName).toBe("Ann Ali");
    expect(seen.me?.fullName).toBeNull();
    expect(run.asked("ranking_names")).toBe(1);
  });
});

/** Runs one repair; `statuses` names the copies whose rebuild finds another rebuild already running. */
const rebuilt = async (
  world: Queries,
  statuses: Record<string, "rebuilt" | "busy"> = {},
  store = storeOf({ rebuild: (key) => Promise.resolve(statuses[key] ?? "rebuilt") }),
) => {
  const run = harness(world, store);
  await run.ranking.repairDue();
  return { ...run, store, keys: store.rebuild.mock.calls.map(([key]) => key) };
};

describe("the ranking's repair run", () => {
  it("rebuilds the event and, while it is multi-day and live, today's copy with it", async () => {
    const run = await rebuilt(repairWorld());
    expect(run.keys).toEqual([EVENT, `${EVENT}/${DAY}`]);
    expect(run.asked("mark_ranking_repair")).toBe(0);
    expect(run.logs).toEqual([]);
  });

  it("rebuilds only the event's copy for a single-day event and for one that is not live", async () => {
    for (const shape of [
      { multi_day: false, live: true },
      { multi_day: true, live: false },
    ]) {
      const world = repairWorld({
        ranking_today: rowsOf({ day: DAY, my_score: null, ...shape }),
      });
      const run = await rebuilt(world);
      expect(run.keys).toEqual([EVENT]);
      expect(run.asked("mark_ranking_repair")).toBe(0);
    }
  });

  it("rebuilds only the event's copy when the database has no day for it, with nothing logged", async () => {
    const run = await rebuilt(repairWorld({ ranking_today: noRows }));
    expect(run.keys).toEqual([EVENT]);
    expect(run.logs).toEqual([]);
    expect(run.asked("mark_ranking_repair")).toBe(0);
  });

  it("marks the event again when either copy's rebuild was busy, and not otherwise", async () => {
    const cases: [Record<string, "busy">, number][] = [
      [{ [EVENT]: "busy" }, 1],
      [{ [`${EVENT}/${DAY}`]: "busy" }, 1],
      [{ [EVENT]: "busy", [`${EVENT}/${DAY}`]: "busy" }, 1],
      [{}, 0],
    ];
    for (const [statuses, marked] of cases) {
      const run = await rebuilt(repairWorld(), statuses);
      expect(run.keys, JSON.stringify(statuses)).toEqual([EVENT, `${EVENT}/${DAY}`]);
      expect(run.asked("mark_ranking_repair"), JSON.stringify(statuses)).toBe(marked);
    }
  });

  it("rebuilds a live event whose copy is missing or older than the backstop, and only those", async () => {
    const [fresh, missing, old] = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    ];
    const builtAt = new Map<string, number | undefined>([
      [fresh, Date.now() - 1000],
      [missing, undefined],
      [old, Date.now() - 6 * 60 * 1000],
    ]);
    const world = repairWorld({
      claim_ranking_repairs: noRows,
      live_ranking_events: rowsOf(
        { live_ranking_events: fresh },
        { live_ranking_events: missing },
        { live_ranking_events: old },
      ),
      ranking_today: rowsOf({ day: DAY, multi_day: false, live: true, my_score: null }),
    });
    const run = await rebuilt(
      world,
      {},
      storeOf({ builtAt: (key) => Promise.resolve(builtAt.get(key)) }),
    );
    expect(run.keys).toEqual([missing, old]);
    expect(run.logs).toEqual([]);
  });
});

describe("the ranking after a completion", () => {
  const ranked = {
    event_id: EVENT,
    enrollment_id: ME,
    score: "10",
    score_version: "7",
    ranked: true,
  };

  it("answers no place and logs nothing for a completion that left no entry", async () => {
    const store = storeOf();
    const world = {
      "ranking_entry_of(": noRows,
      "ranking_day_entry_of(": noRows,
    };
    const run = harness(world, store);
    expect(await run.ranking.afterCompletion(PLAYER, "9")).toBeNull();
    expect(run.logs).toEqual([]);
    expect(run.asked("ranking_day_entry_of")).toBe(1);
    expect(store.upsertRead).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it("logs a failed entry read, answers no place and never fails the completion", async () => {
    const world = { "ranking_entry_of(": throwing("57P01") };
    const run = harness(world, storeOf());
    await expect(run.ranking.afterCompletion(PLAYER, "9")).resolves.toBeNull();
    expect(run.logs).toEqual([["warn", { event: "ranking.write_failed", reason: "Error" }]]);
    expect(run.asked("mark_ranking_repair")).toBe(0);
  });

  it("keeps the overall place when only the event day's entry cannot be read", async () => {
    const store = storeOf({
      upsertRead: () => Promise.resolve({ top: [], total: 3, place: 3 }),
    });
    const world = {
      "ranking_entry_of(": rowsOf(ranked),
      "ranking_day_entry_of(": throwing("57P01"),
    };
    const run = harness(world, store);
    expect(await run.ranking.afterCompletion(PLAYER, "9")).toBe(3);
    expect(run.logs).toEqual([["warn", { event: "ranking.day_write_failed", reason: "Error" }]]);
  });

  it("answers no place for an entry with no points yet, touching nothing", async () => {
    const store = storeOf();
    const run = harness({}, store);
    const answer = await run.ranking.afterAnswer(
      entriesOf({ entry: entry({ score_version: null }) }),
    );
    expect(answer).toBeNull();
    expect(store.upsertRead).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(store.rebuild).not.toHaveBeenCalled();
    expect(run.logs).toEqual([]);
  });

  it("takes a player who is not ranked out of the copy instead of placing them", async () => {
    const store = storeOf({
      upsertRead: () => Promise.resolve({ top: [], total: 3, place: 3 }),
    });
    const run = harness({}, store);
    expect(
      await run.ranking.afterAnswer(entriesOf({ entry: entry({ ranked: false }) })),
    ).toBeNull();
    expect(store.remove.mock.calls).toEqual([[EVENT, ME, 7n]]);
    expect(store.upsertRead).not.toHaveBeenCalled();
    expect(run.logs).toEqual([]);
  });
});
