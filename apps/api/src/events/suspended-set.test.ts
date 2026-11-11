import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { SUSPENDED_REFRESH_MS, createSuspendedSet } from "#src/events/suspended-set";

function fakePool(answers: string[][]) {
  let reads = 0;
  const pool = {
    query: async () => {
      const ids = answers[Math.min(reads, answers.length - 1)] ?? [];
      reads += 1;
      return { rows: [{ ids }] };
    },
  } as unknown as Pool;
  return { pool, reads: () => reads };
}

describe("the suspended set", () => {
  it("reads once per window and answers from that read", async () => {
    let now = 0;
    const fake = fakePool([["a"], ["b"]]);
    const set = createSuspendedSet(fake.pool, { now: () => now });
    expect(await set.has("a")).toBe(true);
    expect(await set.has("b")).toBe(false);
    now = SUSPENDED_REFRESH_MS - 1;
    expect(await set.has("a")).toBe(true);
    expect(fake.reads()).toBe(1);
    now = SUSPENDED_REFRESH_MS;
    expect(await set.has("b")).toBe(true);
    expect(fake.reads()).toBe(2);
  });

  it("reads again at once after an invalidation", async () => {
    const fake = fakePool([[], ["a"]]);
    const set = createSuspendedSet(fake.pool, { now: () => 0 });
    expect(await set.has("a")).toBe(false);
    set.invalidate();
    expect(await set.has("a")).toBe(true);
  });

  it("shares one read between questions asked at the same time", async () => {
    const fake = fakePool([["a"]]);
    const set = createSuspendedSet(fake.pool, { now: () => 0 });
    expect(await Promise.all([set.has("a"), set.has("a"), set.has("b")])).toEqual([
      true,
      true,
      false,
    ]);
    expect(fake.reads()).toBe(1);
  });

  it("does not keep a failed read", async () => {
    let fail = true;
    const pool = {
      query: async () => {
        if (fail) {
          throw new Error("down");
        }
        return { rows: [{ ids: ["a"] }] };
      },
    } as unknown as Pool;
    const set = createSuspendedSet(pool, { now: () => 0 });
    await expect(set.has("a")).rejects.toThrow("down");
    fail = false;
    expect(await set.has("a")).toBe(true);
  });

  it("answers whether any event is suspended, from the same read", async () => {
    let now = 0;
    const fake = fakePool([[], ["a"]]);
    const set = createSuspendedSet(fake.pool, { now: () => now });
    expect(await set.any()).toBe(false);
    expect(await set.has("a")).toBe(false);
    expect(fake.reads()).toBe(1);
    now = SUSPENDED_REFRESH_MS;
    expect(await set.any()).toBe(true);
    expect(await set.has("a")).toBe(true);
    expect(fake.reads()).toBe(2);
  });

  it("follows an invalidation in any()", async () => {
    const fake = fakePool([["a"], []]);
    const set = createSuspendedSet(fake.pool, { now: () => 0 });
    expect(await set.any()).toBe(true);
    set.invalidate();
    expect(await set.any()).toBe(false);
    expect(fake.reads()).toBe(2);
  });
});
