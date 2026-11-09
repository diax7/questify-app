import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Budget, JoinDeps } from "#src/join/join";

const miss = vi.hoisted(() => ({
  seen: [] as (readonly Budget[])[],
  throttle: false,
  forceNull: false,
}));

vi.mock("#src/join/join", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/join/join")>();
  return {
    ...original,
    withMissBudget: async (
      _deps: unknown,
      budgets: readonly Budget[],
      lookup: () => Promise<unknown>,
    ) => {
      miss.seen.push(budgets);
      if (miss.throttle) {
        return { kind: "throttled", retryAfterSeconds: 42 };
      }
      return miss.forceNull ? null : lookup();
    },
  };
});

const { createRehearsal } = await import("#src/rehearsal/service");

const PLAYER = "00000000-0000-4000-8000-000000000009";

function fakeDeps(answer: (sql: string, values: unknown[]) => unknown[]) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      return { rows: answer(sql, values) };
    }),
    release: vi.fn(),
  };
  const deps = {
    pool: { connect: async () => client } as unknown as Pool,
    keys: {
      playerKey: (id: string) => Buffer.from(`player:${id}`),
      addressKey: (bucket: string) => Buffer.from(`address:${bucket}`),
    },
  } as unknown as JoinDeps;
  return { deps, statements };
}

beforeEach(() => {
  miss.seen = [];
  miss.throttle = false;
  miss.forceNull = false;
});

describe("the player's rehearsal event by code", () => {
  const row = {
    id: "ev-1",
    name_ar: "اسم",
    name_en: "Name",
    venue_ar: null,
    venue_en: "Hall",
    kind: "conference",
    timezone: "Asia/Riyadh",
    starts_at: new Date("2026-01-02T03:04:05.000Z"),
    ends_at: null,
    status_now: "scheduled",
  };

  it("maps the row and charges the address and player budgets", async () => {
    const { deps, statements } = fakeDeps(() => [row]);
    const found = await createRehearsal(deps).eventByCode(PLAYER, "203.0.113.7", "ABCD-2345");
    expect(found).toEqual({
      id: "ev-1",
      name: { ar: "اسم", en: "Name" },
      venue: { ar: null, en: "Hall" },
      kind: "conference",
      timezone: "Asia/Riyadh",
      startsAt: new Date("2026-01-02T03:04:05.000Z"),
      endsAt: null,
      statusNow: "scheduled",
    });
    const lookup = statements.find((s) => s.sql.includes("rehearsal_event"));
    expect(lookup?.values).toEqual(["ABCD-2345"]);
    expect(miss.seen).toHaveLength(1);
    expect(miss.seen[0]).toHaveLength(2);
    expect(miss.seen[0]?.[0]?.max).toBe(60);
    expect(miss.seen[0]?.[1]).toEqual({ key: Buffer.from(`player:${PLAYER}`), max: 20 });
  });

  it("answers null for a code that opens nothing, and passes a throttle through", async () => {
    const none = fakeDeps(() => []);
    expect(await createRehearsal(none.deps).eventByCode(PLAYER, "203.0.113.7", "X")).toBeNull();
    miss.throttle = true;
    expect(await createRehearsal(none.deps).eventByCode(PLAYER, "203.0.113.7", "X")).toEqual({
      kind: "throttled",
      retryAfterSeconds: 42,
    });
  });
});

const joinRow = (outcome: string) => [{ outcome, enrollment_id: "en-1", event_id: "ev-1" }];

describe("the player's rehearsal join", () => {
  it.each(["joined", "already"] as const)("names both ids on %s", async (outcome) => {
    const { deps, statements } = fakeDeps(() => joinRow(outcome));
    expect(await createRehearsal(deps).join(PLAYER, "203.0.113.7", "CODE", "v3")).toEqual({
      kind: outcome,
      enrollmentId: "en-1",
      eventId: "ev-1",
    });
    expect(statements.find((s) => s.sql.includes("join_rehearsal"))?.values).toEqual([
      "CODE",
      "v3",
    ]);
    expect(miss.seen[0]).toHaveLength(2);
  });

  it.each(["already_player", "not_allowed", "full"] as const)(
    "answers %s alone",
    async (outcome) => {
      const { deps } = fakeDeps(() => joinRow(outcome));
      expect(await createRehearsal(deps).join(PLAYER, "a", "CODE", "v3")).toEqual({
        kind: outcome,
      });
    },
  );

  it("reads closed, no row and a missed lookup as closed", async () => {
    expect(
      await createRehearsal(fakeDeps(() => joinRow("closed")).deps).join(PLAYER, "a", "C", "v"),
    ).toEqual({ kind: "closed" });
    expect(await createRehearsal(fakeDeps(() => []).deps).join(PLAYER, "a", "C", "v")).toEqual({
      kind: "closed",
    });
    miss.forceNull = true;
    expect(
      await createRehearsal(fakeDeps(() => joinRow("joined")).deps).join(PLAYER, "a", "C", "v"),
    ).toEqual({ kind: "closed" });
  });

  it("passes a throttle through", async () => {
    miss.throttle = true;
    expect(await createRehearsal(fakeDeps(() => []).deps).join(PLAYER, "a", "C", "v")).toEqual({
      kind: "throttled",
      retryAfterSeconds: 42,
    });
  });
});
