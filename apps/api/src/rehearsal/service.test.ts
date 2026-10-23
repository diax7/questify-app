import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { JoinDeps } from "#src/join/join";
import { createRehearsal, wipeDueRehearsals } from "#src/rehearsal/service";

const ACTOR = {
  organizerId: "00000000-0000-4000-8000-000000000001",
  staffUserId: "00000000-0000-4000-8000-000000000002",
} as never;
const CALLER = { requestId: "r1" } as never;
const EVENT = "00000000-0000-4000-8000-000000000003";

const card = (code: string | null, statusNow = "draft") => ({
  code,
  status_now: statusNow,
  accounts: 0,
  completions: 0,
  points: "0",
  reservations: 0,
  flags: 0,
  first_play_at: null,
  erased_at: null,
  erase_counts: null,
  live_wiped_at: null,
});

/** A pool whose client answers each statement through `answer`; transaction statements answer nothing. */
function fakePool(answer: (sql: string, values: unknown[]) => unknown) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      const result = answer(sql, values);
      if (result instanceof Error) {
        throw result;
      }
      return { rows: result };
    }),
    release: vi.fn(),
  };
  const deps = {
    pool: { connect: async () => client } as unknown as Pool,
    keys: {},
  } as unknown as JoinDeps;
  return { deps, statements };
}

const pgError = (code: string) => Object.assign(new Error(code), { code });

/** Codes A-1, A-2, … so each try is told apart. */
const counter = () => {
  let n = 0;
  return () => {
    n += 1;
    return `CODE-${n}`;
  };
};

describe("the team's card", () => {
  it("shows a card that has its code without opening anything", async () => {
    const { deps, statements } = fakePool(() => [card("ABCD-2345")]);
    expect(await createRehearsal(deps, counter()).card(ACTOR, EVENT)).toMatchObject({
      code: "ABCD-2345",
      open: true,
    });
    expect(statements.some((s) => s.sql.includes("open_rehearsal"))).toBe(false);
  });

  it("never opens a rehearsal after go-live", async () => {
    const { deps, statements } = fakePool(() => [card(null, "live")]);
    expect(await createRehearsal(deps, counter()).card(ACTOR, EVENT)).toMatchObject({
      code: null,
      open: false,
    });
    expect(statements.some((s) => s.sql.includes("open_rehearsal"))).toBe(false);
  });

  it("opens with a fresh code, trying another when one is taken, up to five", async () => {
    let opened = 0;
    const { deps, statements } = fakePool((sql) => {
      if (sql.includes("open_rehearsal")) {
        opened += 1;
        return opened < 3 ? pgError("23505") : [];
      }
      return [card(opened >= 3 ? "CODE-3" : null)];
    });
    expect(await createRehearsal(deps, counter()).card(ACTOR, EVENT)).toMatchObject({
      code: "CODE-3",
    });
    expect(
      statements.filter((s) => s.sql.includes("open_rehearsal")).map((s) => s.values[1]),
    ).toEqual(["CODE-1", "CODE-2", "CODE-3"]);

    let tries = 0;
    const taken = fakePool((sql) => {
      if (sql.includes("open_rehearsal")) {
        tries += 1;
        return pgError("23505");
      }
      return [card(null)];
    });
    await expect(createRehearsal(taken.deps, counter()).card(ACTOR, EVENT)).rejects.toMatchObject({
      code: "23505",
    });
    expect(tries).toBe(5);
  });

  it("answers the definers' refusals, and throws anything else at once", async () => {
    const missing = fakePool(() => pgError("AN404"));
    expect(await createRehearsal(missing.deps).card(ACTOR, EVENT)).toEqual({
      kind: "refused",
      refusal: "not_found",
    });
    const over = fakePool((sql) =>
      sql.includes("open_rehearsal") ? pgError("RR409") : [card(null)],
    );
    expect(await createRehearsal(over.deps).card(ACTOR, EVENT)).toEqual({
      kind: "refused",
      refusal: "over",
    });
    let tries = 0;
    const broken = fakePool((sql) => {
      if (sql.includes("open_rehearsal")) {
        tries += 1;
        return pgError("57014");
      }
      return [card(null)];
    });
    await expect(createRehearsal(broken.deps).card(ACTOR, EVENT)).rejects.toMatchObject({
      code: "57014",
    });
    expect(tries).toBe(1);
    const empty = fakePool(() => []);
    await expect(createRehearsal(empty.deps).card(ACTOR, EVENT)).rejects.toThrow(/no row/);
  });
});

describe("rotate and erase", () => {
  it("rotates to the definer's code with the request id", async () => {
    const { deps, statements } = fakePool(() => [{ code: "NEWC-2345" }]);
    expect(await createRehearsal(deps, counter()).rotate(ACTOR, EVENT, CALLER)).toEqual({
      kind: "rotated",
      code: "NEWC-2345",
    });
    expect(statements.find((s) => s.sql.includes("rotate_rehearsal_code"))?.values).toEqual([
      EVENT,
      "CODE-1",
      "r1",
    ]);
    const silent = fakePool(() => []);
    expect(await createRehearsal(silent.deps, counter()).rotate(ACTOR, EVENT, CALLER)).toEqual({
      kind: "rotated",
      code: "CODE-1",
    });
  });

  it("erases and reads the counts", async () => {
    const { deps } = fakePool(() => [{ counts: { accounts: 2, completions: 5 } }]);
    expect(
      await createRehearsal(deps).erase(ACTOR, EVENT, { requestId: undefined } as never),
    ).toEqual({
      kind: "erased",
      counts: { accounts: 2, completions: 5, points: 0, reservations: 0, flags: 0 },
    });
    const none = fakePool(() => []);
    expect(await createRehearsal(none.deps).erase(ACTOR, EVENT, CALLER)).toMatchObject({
      counts: { accounts: 0 },
    });
  });
});

describe("wipeDueRehearsals", () => {
  it("wipes each due event in its own call and counts the ones it wiped", async () => {
    const { deps, statements } = fakePool((sql, values) =>
      sql.includes("due_rehearsal_wipes")
        ? [{ event_id: "a" }, { event_id: "b" }, { event_id: "c" }]
        : [{ wiped: values[0] !== "b" }],
    );
    expect(await wipeDueRehearsals(deps.pool)).toBe(2);
    expect(
      statements.filter((s) => s.sql.includes("ensure_rehearsal_wiped")).map((s) => s.values[0]),
    ).toEqual(["a", "b", "c"]);
    const quiet = fakePool((sql) =>
      sql.includes("due_rehearsal_wipes") ? [{ event_id: "a" }] : [],
    );
    expect(await wipeDueRehearsals(quiet.deps.pool)).toBe(0);
  });
});
