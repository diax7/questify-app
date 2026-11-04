import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createRankingStore,
  type RankingRedis,
  type RankingStore,
  type RebuildEntry,
} from "#src/ranking/store";
import { TEST_REDIS_URL, createTestRedis } from "#test/support/test-redis";

const entry = (score: number, version: number, ranked = true): RebuildEntry => ({
  enrollmentId: randomUUID(),
  score: BigInt(score),
  version: BigInt(version),
  ranked,
});

/**
 * The Redis copy of a ranking (T-106, ADR-118): the order, versioned writes, tombstones, and rebuilds that lose nothing
 * written while they run.
 */
describe.skipIf(TEST_REDIS_URL === undefined)("the ranking store (Redis)", () => {
  let client: RankingRedis;
  let store: RankingStore;

  beforeAll(async () => {
    client = await createTestRedis();
    store = createRankingStore(client);
  });
  afterAll(async () => {
    await client.close();
  });

  /** A built, empty ranking for a new event. */
  const newEvent = async (): Promise<string> => {
    const event = randomUUID();
    expect(await store.rebuild(event, async () => [])).toBe("rebuilt");
    return event;
  };
  const order = async (event: string) =>
    (await store.read(event, 100, undefined))?.top.map((row) => row.enrollmentId);

  it("reads nothing until the copy is built", async () => {
    expect(await store.read(randomUUID(), 10, undefined)).toBeUndefined();
    expect(await store.builtAt(randomUUID())).toBeUndefined();
  });

  it("orders by points, then by who reached them first, and says each one's place", async () => {
    const event = await newEvent();
    const [a, b, c] = [entry(10, 7), entry(10, 5), entry(30, 9)];
    for (const one of [a, b, c]) {
      await store.upsert(event, one);
    }
    expect(await order(event)).toEqual([c.enrollmentId, b.enrollmentId, a.enrollmentId]);
    const read = await store.read(event, 2, a.enrollmentId);
    expect(read).toEqual({
      top: [
        { enrollmentId: c.enrollmentId, version: 9n, score: 30n },
        { enrollmentId: b.enrollmentId, version: 5n, score: 10n },
      ],
      total: 3,
      place: 3,
    });
    expect((await store.read(event, 1, randomUUID()))?.place).toBeNull();
  });

  it("moves a player with each newer write and ignores an older or repeated one", async () => {
    const event = await newEvent();
    const a = entry(10, 5);
    await store.upsert(event, a);
    await store.upsert(event, { ...a, score: 20n, version: 8n });
    await store.upsert(event, { ...a, score: 15n, version: 6n });
    await store.upsert(event, { ...a, score: 99n, version: 8n });
    expect((await store.read(event, 10, a.enrollmentId))?.top).toEqual([
      { enrollmentId: a.enrollmentId, version: 8n, score: 20n },
    ]);
  });

  it("keeps a removed player out: a late write from before the removal is refused", async () => {
    const event = await newEvent();
    const a = entry(10, 5);
    await store.upsert(event, a);
    await store.remove(event, a.enrollmentId, 5n);
    await store.upsert(event, a);
    expect(await store.read(event, 10, a.enrollmentId)).toEqual({ top: [], total: 0, place: null });
    await store.upsert(event, { ...a, version: 6n });
    expect((await store.read(event, 10, a.enrollmentId))?.place).toBe(1);
  });

  it("rebuilds to exactly the given entries, leaving out the ones not ranked", async () => {
    const event = await newEvent();
    const stale = entry(50, 1);
    await store.upsert(event, stale);
    const entries = [entry(5, 3), entry(40, 2), entry(5, 1), entry(70, 4, false)];
    expect(await store.rebuild(event, async () => entries)).toBe("rebuilt");
    expect(await order(event)).toEqual([
      entries[1]?.enrollmentId,
      entries[2]?.enrollmentId,
      entries[0]?.enrollmentId,
    ]);
    expect(await store.builtAt(event)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("rebuilds an event with no one ranked to an empty, built copy", async () => {
    const event = await newEvent();
    await store.upsert(event, entry(5, 1));
    await store.rebuild(event, async () => [entry(9, 2, false)]);
    expect(await store.read(event, 10, undefined)).toEqual({ top: [], total: 0, place: null });
  });

  it("loses nothing written while a rebuild runs, and a late write cannot undo a removal in it", async () => {
    const event = await newEvent();
    const moved = entry(10, 5);
    const banned = entry(30, 6);
    const joined = entry(20, 7);
    await store.rebuild(event, async () => {
      // Writes that commit after the rebuild read PostgreSQL arrive while it runs.
      await store.upsert(event, { ...moved, score: 60n, version: 8n });
      await store.upsert(event, joined);
      await store.upsert(event, banned);
      return [moved, { ...banned, ranked: false }];
    });
    expect(await order(event)).toEqual([moved.enrollmentId, joined.enrollmentId]);
    expect((await store.read(event, 1, moved.enrollmentId))?.top[0]?.score).toBe(60n);
  });

  it("keeps the copy being built and its flag under the event's own keys, the flag expiring with the lock", async () => {
    const event = await newEvent();
    const seen: { present: number; flagTtl: number } = { present: 0, flagTtl: 0 };
    await store.rebuild(event, async () => {
      await store.upsert(event, entry(5, 1));
      seen.present = await client.exists([
        `rank:{${event}}:next`,
        `rank:{${event}}:next:member`,
        `rank:{${event}}:building`,
      ]);
      seen.flagTtl = await client.pTTL(`rank:{${event}}:building`);
      return [];
    });
    expect(seen.present).toBe(3);
    expect(seen.flagTtl).toBeGreaterThan(0);
    expect(seen.flagTtl).toBeLessThanOrEqual(30_000);
  });

  it("sends a large rebuild to Redis in chunks of at most 500 entries", async () => {
    const event = randomUUID();
    const entries = Array.from({ length: 1000 }, (_, index) => entry(1000 - index, index + 1));
    const fill = vi.spyOn(client, "rankingFill");
    try {
      expect(await store.rebuild(event, async () => entries)).toBe("rebuilt");
      // The script takes the lifetime, then five arguments per entry.
      expect(fill.mock.calls.map(([, args]) => args.length)).toEqual([1 + 5 * 500, 1 + 5 * 500]);
    } finally {
      fill.mockRestore();
    }
    expect((await store.read(event, 1, undefined))?.total).toBe(1000);
  });

  it("leaves out a member of the set that stands for no enrollment", async () => {
    const event = await newEvent();
    const a = entry(10, 5);
    await store.upsert(event, a);
    await client.zAdd(`rank:{${event}}`, { score: 99, value: "not-a-member" });
    expect((await store.read(event, 10, undefined))?.top).toEqual([
      { enrollmentId: a.enrollmentId, version: 5n, score: 10n },
    ]);
  });

  it("lets one rebuild of an event run at a time", async () => {
    const event = await newEvent();
    let second: string | undefined;
    await store.rebuild(event, async () => {
      second = await store.rebuild(event, async () => []);
      return [];
    });
    expect(second).toBe("busy");
    expect(await store.rebuild(event, async () => [])).toBe("rebuilt");
  });

  it("releases the lock and leaves no half-built copy when a rebuild fails", async () => {
    const event = await newEvent();
    await expect(
      store.rebuild(event, async () => {
        await store.upsert(event, entry(3, 4));
        throw new Error("database down");
      }),
    ).rejects.toThrow("database down");
    for (const key of [
      `rank:{${event}}:next`,
      `rank:{${event}}:next:member`,
      `rank:{${event}}:building`,
    ]) {
      expect(await client.exists(key)).toBe(0);
    }
    expect(await store.rebuild(event, async () => [])).toBe("rebuilt");
  });

  it("reads only the place when asked for no rows, however large the ranking", async () => {
    const event = await newEvent();
    const entries = Array.from({ length: 25 }, (_, index) => entry(100 - index, index + 1));
    for (const one of entries) {
      await store.upsert(event, one);
    }
    expect(await store.read(event, 0, entries[17]?.enrollmentId)).toEqual({
      top: [],
      total: 25,
      place: 18,
    });
  });

  it("keeps every key of an event for 30 days after a write", async () => {
    const event = await newEvent();
    await store.upsert(event, entry(1, 1));
    for (const key of [`rank:{${event}}`, `rank:{${event}}:member`, `rank:{${event}}:built`]) {
      const ttl = await client.pTTL(key);
      expect(ttl).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    }
  });

  it("refuses a version outside a ledger id's range", async () => {
    await expect(store.upsert(randomUUID(), entry(1, -1))).rejects.toThrow(RangeError);
  });

  describe("one write and its place in one call (upsertRead, ADR-673)", () => {
    it("writes and answers the place and total with no top, under the same version rule", async () => {
      const event = await newEvent();
      const [a, b] = [entry(10, 5), entry(30, 6)];
      expect(await store.upsertRead(event, a)).toEqual({ top: [], total: 1, place: 1 });
      expect(await store.upsertRead(event, b)).toEqual({ top: [], total: 2, place: 1 });
      expect(await store.upsertRead(event, { ...a, score: 40n, version: 7n })).toEqual({
        top: [],
        total: 2,
        place: 1,
      });
      expect(await store.upsertRead(event, { ...a, score: 1n, version: 7n })).toEqual({
        top: [],
        total: 2,
        place: 1,
      });
      expect(await order(event)).toEqual([a.enrollmentId, b.enrollmentId]);
    });

    it("answers undefined for a copy not built, the write applied as upsert applies it", async () => {
      const event = randomUUID();
      const a = entry(10, 5);
      expect(await store.upsertRead(event, a)).toBeUndefined();
      expect(await client.hGet(`rank:{${event}}:member`, a.enrollmentId)).toMatch(/^v/);
    });

    it("keeps a removal: a write older than the tombstone answers no place", async () => {
      const event = await newEvent();
      const a = entry(10, 5);
      await store.remove(event, a.enrollmentId, 6n);
      expect(await store.upsertRead(event, a)).toEqual({ top: [], total: 0, place: null });
    });

    it("writes the copy being rebuilt as well, so a rebuild loses nothing", async () => {
      const event = await newEvent();
      const a = entry(10, 5);
      await store.rebuild(event, async () => {
        await store.upsertRead(event, a);
        return [];
      });
      expect(await order(event)).toEqual([a.enrollmentId]);
    });

    it("runs by its SHA1 and loads the body again after Redis forgot its scripts", async () => {
      const event = await newEvent();
      const sent: string[] = [];
      const send = client.sendCommand.bind(client);
      const spy = vi.spyOn(client, "sendCommand").mockImplementation((args, options) => {
        sent.push(String(args[0]));
        return send(args, options);
      });
      try {
        await store.upsertRead(event, entry(10, 5));
        await client.scriptFlush();
        sent.length = 0;
        expect(await store.upsertRead(event, entry(20, 6))).toMatchObject({ total: 2, place: 1 });
        expect(sent).toEqual(["EVALSHA", "EVAL"]);
        sent.length = 0;
        await store.upsertRead(event, entry(5, 7));
        expect(sent).toEqual(["EVALSHA"]);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
