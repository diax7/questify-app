import { describe, expect, it } from "vitest";
import type { ObjectStore } from "#src/storage/client";
import {
  RECONCILE_AGE_MS,
  ReconcileAborted,
  reconcileCap,
  reconcileMedia,
} from "#src/storage/reconcile";
import { fakePool, pgError } from "#test/support/fake-pool";

const NOW = 1_800_000_000_000;
const key = (n: number) => `k${String(n).padStart(5, "0")}`;

/** A media store holding `keys` (all older than an hour): pages them in key order and records every delete. */
function mediaOf(keys: readonly string[]) {
  const deleted: string[][] = [];
  const pages: Array<{ after: string | null; olderThan: Date }> = [];
  const store = {
    keysPage: async (after: string | null, olderThan: Date, n: number) => {
      pages.push({ after, olderThan });
      return keys.filter((one) => after === null || one > after).slice(0, n);
    },
    deleteMany: async (gone: readonly string[]) => {
      deleted.push([...gone]);
      return gone.length;
    },
  } as unknown as ObjectStore;
  return { store, deleted, pages };
}

/** The main database's answer: every key asked, known unless `unknown` names it. */
const mainKnowing = (unknown: ReadonlySet<string>) =>
  fakePool((_sql, values) => ({
    rows: (values[0] as string[]).map((one) => ({ key: one, known: !unknown.has(one) })),
  }));

/** The orphan sweep (review 86 MAJOR 1): fail closed, a cap for the daily run, `all` past it. */
describe("the media reconcile", () => {
  it("deletes the keys the main database says it does not know, and keeps the rest", async () => {
    const keys = Array.from({ length: 1200 }, (_, n) => key(n));
    const media = mediaOf(keys);
    const unknown = new Set([key(3), key(700)]);
    const result = await reconcileMedia({
      pool: mainKnowing(unknown).pool,
      store: media.store,
      now: () => NOW,
    });
    expect(result).toEqual({ outcome: "done", scanned: 1200, unknown: 2, deleted: 2 });
    expect(media.deleted).toEqual([[key(3), key(700)]]);
    expect(media.pages.map((page) => page.after)).toEqual([null, key(499), key(999)]);
    expect(media.pages[0]?.olderThan.getTime()).toBe(NOW - RECONCILE_AGE_MS);
  });

  it("deletes nothing when the main database fails, answers short, names a key not asked, or one twice", async () => {
    const keys = [key(1), key(2), key(3)];
    const answers = [
      () => {
        throw pgError({ code: "57P01" });
      },
      (asked: string[]) => ({ rows: asked.slice(1).map((one) => ({ key: one, known: false })) }),
      (asked: string[]) => ({
        rows: [...asked.slice(1), "k99999"].map((one) => ({ key: one, known: false })),
      }),
      (asked: string[]) => ({
        rows: [asked[0], asked[0], asked[1]].map((one) => ({ key: one, known: false })),
      }),
      (asked: string[]) => ({ rows: asked.map((one) => ({ key: one, known: null })) }),
      () => ({ rows: [] }),
    ];
    for (const [n, answer] of answers.entries()) {
      const media = mediaOf(keys);
      const { pool } = fakePool((_sql, values) => answer(values[0] as string[]));
      const failed = await reconcileMedia({ pool, store: media.store, now: () => NOW }).catch(
        (error: unknown) => error,
      );
      expect(failed, String(n)).toBeInstanceOf(ReconcileAborted);
      expect((failed as ReconcileAborted).code, String(n)).toBe(
        n === 0 ? "keys_known_failed" : "odd_answer",
      );
      expect(media.deleted, String(n)).toEqual([]);
    }
  });

  it("blocks the daily run past min(1,000, max(10, 5 % of the rows)), and an operator's `all` run goes past it", async () => {
    expect([reconcileCap(0), reconcileCap(10), reconcileCap(400), reconcileCap(40_000)]).toEqual([
      10, 10, 20, 1000,
    ]);
    const keys = Array.from({ length: 400 }, (_, n) => key(n));
    const over = new Set(keys.slice(0, 21));
    const daily = mediaOf(keys);
    expect(
      await reconcileMedia({ pool: mainKnowing(over).pool, store: daily.store, now: () => NOW }),
    ).toEqual({ outcome: "blocked", scanned: 400, unknown: 21, deleted: 0 });
    expect(daily.deleted).toEqual([]);
    const atCap = mediaOf(keys);
    expect(
      (
        await reconcileMedia({
          pool: mainKnowing(new Set(keys.slice(0, 20))).pool,
          store: atCap.store,
          now: () => NOW,
        })
      ).deleted,
    ).toBe(20);
    const all = mediaOf(keys);
    expect(
      await reconcileMedia(
        { pool: mainKnowing(over).pool, store: all.store, now: () => NOW },
        { all: true },
      ),
    ).toEqual({ outcome: "done", scanned: 400, unknown: 21, deleted: 21 });
  });

  it("deletes a few orphans on a small database instead of blocking every day", async () => {
    const keys = Array.from({ length: 12 }, (_, n) => key(n));
    const small = mediaOf(keys);
    expect(
      await reconcileMedia({
        pool: mainKnowing(new Set(keys.slice(0, 3))).pool,
        store: small.store,
        now: () => NOW,
      }),
    ).toEqual({ outcome: "done", scanned: 12, unknown: 3, deleted: 3 });
  });

  it("stops paging once a stale main restore has made more than 1,000 keys unknown", async () => {
    const keys = Array.from({ length: 5000 }, (_, n) => key(n));
    const media = mediaOf(keys);
    const result = await reconcileMedia({
      pool: mainKnowing(new Set(keys)).pool,
      store: media.store,
      now: () => NOW,
    });
    expect(result).toEqual({ outcome: "blocked", scanned: 1500, unknown: 1500, deleted: 0 });
    expect(media.deleted).toEqual([]);
  });
});
