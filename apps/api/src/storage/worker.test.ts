import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorageError, type ObjectStore } from "#src/storage/client";
import { RECONCILE_AGE_MS } from "#src/storage/reconcile";
import { startMediaWorker, type MediaWorker } from "#src/storage/worker";
import { trackRun } from "#src/telemetry/runs";
import { fakePool, pgError } from "#test/support/fake-pool";

vi.mock("#src/telemetry/runs", () => ({
  trackRun: vi.fn((_tick: string, run: () => Promise<unknown>) => run()),
}));

const NOW = 1_800_000_000_000;
const INTERVAL = 1_000;

type Route =
  | "uploads"
  | "images"
  | "purge"
  | "claim"
  | "done"
  | "failed"
  | "reconcileClaim"
  | "keysKnown";
type Answers = Partial<Record<Route, (values: readonly unknown[]) => unknown[]>>;
type Logged = [level: string, fields: Record<string, unknown>];

const ROUTES: ReadonlyArray<readonly [Route, string]> = [
  ["uploads", "media_sweep_uploads"],
  ["images", "media_sweep_images"],
  ["purge", "media_purge_due"],
  ["claim", "media_delete_claim"],
  ["done", "media_delete_done"],
  ["failed", "media_delete_failed"],
  ["reconcileClaim", "media_reconcile_claim"],
  ["keysKnown", "media_keys_known"],
];

const rowsOf = (size: number) =>
  Array.from({ length: size }, (_, n) => ({ id: String(n + 1), key: `k${n + 1}`, claim: "tok" }));

/** A claim that hands out `size` rows for each of its first `times` calls and nothing after. */
const handing = (size: number, times = 1) => {
  let given = 0;
  return () => {
    given += 1;
    return given <= times ? rowsOf(size) : [];
  };
};

/** The main database's answer to each statement the worker sends, by the routine it names; the rest answer no rows. */
function harness(answers: Answers = {}, options: { store?: Partial<ObjectStore> } = {}) {
  const calls: Array<{ route: Route | undefined; sql: string; values: readonly unknown[] }> = [];
  const { pool } = fakePool((sql, values) => {
    const route = ROUTES.find(([, fragment]) => sql.includes(fragment))?.[0];
    calls.push({ route, sql, values });
    const answer = route === undefined ? undefined : answers[route];
    return { rows: answer?.(values) ?? [] };
  });
  const deleted: string[][] = [];
  const store = {
    deleteMany: async (keys: readonly string[]) => {
      deleted.push([...keys]);
      return keys.length;
    },
    keysPage: async () => [],
    ...options.store,
  } as unknown as ObjectStore;
  const lines: Logged[] = [];
  const log = (level: "info" | "error", fields: Record<string, unknown>) => {
    lines.push([level, fields]);
  };
  const count = (route: Route) => calls.filter((call) => call.route === route).length;
  return { pool, store, calls, deleted, lines, log, count };
}

const started: MediaWorker[] = [];
const start = (setup: ReturnType<typeof harness>, extra: { random?: () => number } = {}) => {
  const worker = startMediaWorker({
    pool: setup.pool,
    store: setup.store,
    intervalMs: INTERVAL,
    log: setup.log,
    now: () => NOW,
    random: () => 0.5,
    ...extra,
  });
  started.push(worker);
  return worker;
};

afterEach(async () => {
  await Promise.all(started.splice(0).map((worker) => worker.stop()));
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** The media worker's loop (T-301b, T-814) with its databases faked: what each run asks, deletes, counts and logs. */
describe("the media worker's run", () => {
  it("sweeps uploads and images, purges what is due, deletes one round of claimed keys and counts them all", async () => {
    const setup = harness({
      uploads: () => [{ n: 5 }],
      images: () => [{ n: 2 }],
      purge: () => [{ n: 3 }],
      claim: handing(3),
      done: () => [{ n: 3 }],
    });
    expect(await start(setup).runOnce()).toEqual({ swept: 7, purged: 3, deleted: 3, failed: 0 });
    expect(setup.calls.map(({ sql, values }) => [sql, values])).toEqual([
      ["SELECT media_sweep_uploads() AS n", []],
      ["SELECT media_sweep_images($1) AS n", [500]],
      ["SELECT media_purge_due($1) AS n", [500]],
      ["SELECT * FROM media_delete_claim($1)", [50]],
      ["SELECT media_delete_done($1::bigint[], $2) AS n", [["1", "2", "3"], "tok"]],
      ["SELECT media_reconcile_claim()::int AS n", []],
    ]);
    expect(setup.deleted).toEqual([["k1", "k2", "k3"]]);
    expect(setup.lines).toEqual([]);
  });

  it("counts a sweep that answers no row as none", async () => {
    const setup = harness();
    expect(await start(setup).runOnce()).toEqual({ swept: 0, purged: 0, deleted: 0, failed: 0 });
    expect(setup.count("claim")).toBe(1);
    expect(setup.deleted).toEqual([]);
    expect(setup.count("done")).toBe(0);
    expect(setup.lines).toEqual([]);
  });

  it("claims again only after a full round, and stops at a round that is not full", async () => {
    const full = harness({ claim: handing(50, 1) });
    expect(await start(full).runOnce()).toMatchObject({ deleted: 50 });
    expect(full.count("claim")).toBe(2);

    const partial = harness({ claim: handing(49, 30) });
    expect(await start(partial).runOnce()).toMatchObject({ deleted: 49 });
    expect(partial.count("claim")).toBe(1);

    const more = harness({
      claim: (() => {
        const sizes = [50, 3];
        return () => rowsOf(sizes.shift() ?? 0);
      })(),
    });
    expect(await start(more).runOnce()).toMatchObject({ deleted: 53, failed: 0 });
    expect(more.count("claim")).toBe(2);
    expect(more.count("done")).toBe(2);
  });

  it("runs at most 10 rounds, 500 deletes, and leaves the rest for the next run", async () => {
    const setup = harness({ claim: handing(50, 30) });
    expect(await start(setup).runOnce()).toMatchObject({ deleted: 500, failed: 0 });
    expect(setup.count("claim")).toBe(10);
    expect(setup.deleted).toHaveLength(10);
  });

  it("backs a failed round off under its media code, per row and its claim, and does not claim again", async () => {
    const cases: Array<[Error, string]> = [
      [new StorageError("delete", "unavailable"), "media_unavailable"],
      [new StorageError("delete", "timeout"), "media_timeout"],
      [new StorageError("delete", "conflict"), "media_conflict"],
      [new Error("boom"), "error"],
    ];
    for (const [thrown, code] of cases) {
      const setup = harness(
        { claim: handing(50, 30) },
        {
          store: {
            deleteMany: async () => {
              throw thrown;
            },
          },
        },
      );
      expect(await start(setup).runOnce(), code).toMatchObject({ deleted: 0, failed: 50 });
      expect(setup.count("claim"), code).toBe(1);
      expect(setup.count("done"), code).toBe(0);
      const failed = setup.calls.filter((call) => call.route === "failed");
      expect(failed, code).toHaveLength(50);
      expect(failed[0]?.sql).toBe("SELECT media_delete_failed($1, $2, $3)");
      expect(
        failed.map((call) => call.values.slice(1)),
        code,
      ).toEqual(Array.from({ length: 50 }, () => [code, "tok"]));
      expect(
        failed.map((call) => call.values[0]),
        code,
      ).toEqual(rowsOf(50).map((row) => row.id));
    }
  });

  it("stops claiming and skips the reconcile once it is stopped mid-run", async () => {
    let worker: MediaWorker | undefined;
    const setup = harness(
      { claim: handing(50, 30), reconcileClaim: () => [{ n: 1 }] },
      {
        store: {
          deleteMany: async (keys: readonly string[]) => {
            await worker?.stop();
            return keys.length;
          },
        },
      },
    );
    worker = start(setup);
    expect(await worker.runOnce()).toMatchObject({ deleted: 50 });
    expect(setup.count("claim")).toBe(1);
    expect(setup.count("reconcileClaim")).toBe(0);
  });
});

const known = (unknown: ReadonlySet<string>) => (values: readonly unknown[]) =>
  (values[0] as string[]).map((key) => ({ key, known: !unknown.has(key) }));
const keysOf = (n: number) => Array.from({ length: n }, (_, i) => `r${String(i).padStart(4, "0")}`);
const storeOf = (keys: readonly string[]) => {
  const pages: Array<{ after: string | null; olderThan: Date }> = [];
  const store: Partial<ObjectStore> = {
    keysPage: async (after, olderThan, n) => {
      pages.push({ after, olderThan });
      return keys.filter((key) => after === null || key > after).slice(0, n);
    },
  };
  return { store, pages };
};

const sweeps = (setup: ReturnType<typeof harness>) => setup.count("uploads");

const pass = async (answers: Answers, store: Partial<ObjectStore> = {}) => {
  const setup = harness(answers, { store });
  start(setup);
  await vi.advanceTimersByTimeAsync(INTERVAL);
  return setup.lines;
};

/** The daily reconcile (T-814, ADR-839): one replica a day, its outcome logged by event, which the alerts count. */
describe("the media worker's daily reconcile", () => {
  it("does nothing on a replica that did not win the day's claim", async () => {
    for (const won of [0, 2]) {
      const media = storeOf(keysOf(3));
      const setup = harness({ reconcileClaim: () => [{ n: won }] }, { store: media.store });
      await start(setup).runOnce();
      expect(setup.count("keysKnown"), String(won)).toBe(0);
      expect(media.pages, String(won)).toEqual([]);
      expect(setup.lines, String(won)).toEqual([]);
    }
  });

  it("logs a finished reconcile as media.reconcile with its counts, reading rows from an hour before now", async () => {
    const media = storeOf(keysOf(12));
    const orphans = new Set(keysOf(3));
    const setup = harness(
      { reconcileClaim: () => [{ n: 1 }], keysKnown: known(orphans) },
      { store: { ...media.store, deleteMany: async (keys) => keys.length } },
    );
    await start(setup).runOnce();
    expect(setup.lines).toEqual([
      ["info", { event: "media.reconcile", scanned: 12, unknown: 3, deleted: 3 }],
    ]);
    expect(media.pages[0]?.olderThan.getTime()).toBe(NOW - RECONCILE_AGE_MS);
  });

  it("logs a blocked reconcile as the error media.reconcile_blocked, with its counts, and deletes nothing", async () => {
    const media = storeOf(keysOf(100));
    const orphans = new Set(keysOf(30));
    const setup = harness(
      { reconcileClaim: () => [{ n: 1 }], keysKnown: known(orphans) },
      { store: media.store },
    );
    await start(setup).runOnce();
    expect(setup.lines).toEqual([
      ["error", { event: "media.reconcile_blocked", scanned: 100, unknown: 30, deleted: 0 }],
    ]);
    expect(setup.deleted).toEqual([]);
  });

  it("logs a reconcile that could not trust its answers as media.reconcile_failed with the reason, never a key", async () => {
    const media = storeOf(keysOf(3));
    const failures: Array<[Answers["keysKnown"], Partial<ObjectStore> | undefined, string]> = [
      [
        () => {
          throw pgError({ code: "57P01" });
        },
        media.store,
        "keys_known_failed",
      ],
      [() => [], media.store, "odd_answer"],
      [
        undefined,
        {
          keysPage: async () => {
            throw new StorageError("keys", "timeout");
          },
        },
        "media_timeout",
      ],
      [
        undefined,
        {
          keysPage: async () => {
            throw new Error("boom");
          },
        },
        "error",
      ],
    ];
    for (const [keysKnown, store, code] of failures) {
      const setup = harness(
        { reconcileClaim: () => [{ n: 1 }], ...(keysKnown ? { keysKnown } : {}) },
        store ? { store } : {},
      );
      expect(await start(setup).runOnce(), code).toEqual({
        swept: 0,
        purged: 0,
        deleted: 0,
        failed: 0,
      });
      expect(setup.lines, code).toEqual([["error", { event: "media.reconcile_failed", code }]]);
    }
  });
});

const atWait = async (random: number, wait: number) => {
  const setup = harness();
  start(setup, { random: () => random });
  await vi.advanceTimersByTimeAsync(wait - 1);
  expect(sweeps(setup), `random ${random}`).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(sweeps(setup), `random ${random}`).toBe(1);
};

/** The loop's timer: when it fires, what a pass logs, and that a stopped worker stays stopped. */
describe("the media worker's schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("first runs after the interval, spread 20 % either way by the random draw, as the media tick", async () => {
    await atWait(0, 800);
    await atWait(0.5, 1000);
    await atWait(1, 1200);
    await atWait(0.25, 900);
    const ticks = vi.mocked(trackRun).mock.calls.map(([tick]) => tick);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(new Set(ticks)).toEqual(new Set(["media"]));
  });

  it("runs again an interval after each pass, and its timer does not keep the process alive", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setup = harness();
    start(setup);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweeps(setup)).toBe(1);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(sweeps(setup)).toBe(2);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(sweeps(setup)).toBe(5);
    const timers = setTimeoutSpy.mock.results.map((result) => result.value as NodeJS.Timeout);
    expect(timers.length).toBeGreaterThanOrEqual(2);
    for (const timer of timers) expect(timer.hasRef()).toBe(false);
  });

  it("logs nothing for a pass that did nothing", async () => {
    expect(await pass({})).toEqual([]);
  });

  it("logs a pass that swept, purged or deleted as the info media.run with its totals", async () => {
    const zero = { swept: 0, purged: 0, deleted: 0, failed: 0 };
    expect(await pass({ uploads: () => [{ n: 1 }] })).toEqual([
      ["info", { event: "media.run", ...zero, swept: 1 }],
    ]);
    expect(await pass({ images: () => [{ n: 4 }] })).toEqual([
      ["info", { event: "media.run", ...zero, swept: 4 }],
    ]);
    expect(await pass({ purge: () => [{ n: 2 }] })).toEqual([
      ["info", { event: "media.run", ...zero, purged: 2 }],
    ]);
    expect(await pass({ claim: handing(3) })).toEqual([
      ["info", { event: "media.run", ...zero, deleted: 3 }],
    ]);
  });

  it("logs a pass with a failed round as the error media.run, even when it deleted too", async () => {
    const failing = {
      deleteMany: async () => {
        throw new StorageError("delete", "unavailable");
      },
    };
    expect(await pass({ claim: handing(2) }, failing)).toEqual([
      ["error", { event: "media.run", swept: 0, purged: 0, deleted: 0, failed: 2 }],
    ]);
    expect(await pass({ claim: handing(2), purge: () => [{ n: 6 }] }, failing)).toEqual([
      ["error", { event: "media.run", swept: 0, purged: 6, deleted: 0, failed: 2 }],
    ]);
  });

  it("logs a pass that threw as media.run_failed with the database's code, or null", async () => {
    expect(
      await pass({
        uploads: () => {
          throw pgError({ code: "57P01" });
        },
      }),
    ).toEqual([["error", { event: "media.run_failed", code: "57P01" }]]);
    const withoutCode = await pass({
      purge: () => {
        throw new Error("boom");
      },
    });
    expect(withoutCode).toStrictEqual([["error", { event: "media.run_failed", code: null }]]);
  });

  it("does not run, or schedule again, once stopped before the timer fires", async () => {
    const setup = harness();
    const worker = start(setup);
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    await worker.stop();
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(setup.calls).toEqual([]);
  });

  it("finishes the pass in flight when stopped, skips its reconcile, and schedules no more", async () => {
    const opened: Array<() => void> = [];
    const gate = new Promise<void>((resolve) => opened.push(resolve));
    const setup = harness({ reconcileClaim: () => [{ n: 1 }] }, {});
    const held = setup.pool.connect.bind(setup.pool);
    let blocked = false;
    setup.pool.connect = (async () => {
      if (!blocked) {
        blocked = true;
        await gate;
      }
      return held();
    }) as typeof setup.pool.connect;
    const worker = start(setup);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(blocked).toBe(true);
    const stopping = worker.stop();
    opened[0]?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(sweeps(setup)).toBe(1);
    expect(setup.count("reconcileClaim")).toBe(0);
  });
});
