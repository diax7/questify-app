import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createActivation } from "#src/activation/service";

const ORGANIZER = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-000000000002";
const EVENT = "00000000-0000-4000-8000-000000000003";
const ACTOR = { organizerId: ORGANIZER, staffUserId: STAFF } as never;
const ADMIN = { id: STAFF } as never;
const CALLER = { requestId: "req-1" } as never;
const NO_ID = { requestId: undefined } as never;

type Statement = { sql: string; values: unknown[] };

/** A pool whose client logs every statement and answers the data ones through `answer`. */
function fakePool(answer: (sql: string, values: unknown[]) => unknown) {
  const statements: Statement[] = [];
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
  return { pool: { connect: async () => client } as unknown as Pool, statements, client };
}

const dataOf = (statements: Statement[]) =>
  statements.filter(
    (s) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(s.sql) && !s.sql.includes("set_config"),
  );

const make = (answer: (sql: string, values: unknown[]) => unknown) => {
  const fake = fakePool(answer);
  const onAddonsChanged = vi.fn();
  return {
    ...fake,
    onAddonsChanged,
    activation: createActivation({ pool: fake.pool, onAddonsChanged }),
  };
};

describe("the activation service", () => {
  it("reads the view in the team's seat", async () => {
    const { activation, statements } = make(() => [
      {
        status: "draft",
        player_limit_mode: "hard",
        player_limit: 50,
        request_state: "pending",
        requested_at: new Date("2026-03-04T05:06:07.000Z"),
        note: null,
        players: 3,
        alerts: [80],
        addons: ["bigScreen"],
      },
    ]);
    expect(await activation.view(ACTOR, EVENT)).toEqual({
      state: "requested",
      requestedAt: "2026-03-04T05:06:07.000Z",
      note: null,
      limit: { mode: "hard", value: 50 },
      players: 3,
      alerts: [80],
      addons: ["bigScreen"],
    });
    expect(dataOf(statements).map((s) => s.values)).toEqual([[EVENT]]);
    expect(statements[0]?.sql).toBe("BEGIN");
    expect(statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("answers undefined for an event the seat cannot see", async () => {
    const { activation } = make(() => []);
    expect(await activation.view(ACTOR, EVENT)).toBeUndefined();
  });

  it("requests with the request id and names the outcome", async () => {
    const { activation, statements } = make(() => [
      { outcome: "already", requested_at: new Date("2026-01-01T00:00:00.000Z") },
    ]);
    expect(await activation.request(ACTOR, EVENT, CALLER)).toEqual({
      kind: "already",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(dataOf(statements)).toEqual([
      {
        sql: "SELECT outcome, requested_at FROM request_event_activation($1, $2)",
        values: [EVENT, "req-1"],
      },
    ]);
  });

  it("sends null when the caller has no request id, and throws when the definer answers nothing", async () => {
    const { activation, statements } = make(() => []);
    await expect(activation.request(ACTOR, EVENT, NO_ID)).rejects.toThrow(
      "request_event_activation answered no row; check migration 0027",
    );
    expect(dataOf(statements)[0]?.values).toEqual([EVENT, null]);
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("withdraws, and reads anything but true as none", async () => {
    const yes = make(() => [{ withdrawn: true }]);
    expect(await yes.activation.withdraw(ACTOR, EVENT, CALLER)).toEqual({ kind: "withdrawn" });
    expect(dataOf(yes.statements)).toEqual([
      { sql: "SELECT withdraw_event_activation($1, $2) AS withdrawn", values: [EVENT, "req-1"] },
    ]);
    const no = make(() => [{ withdrawn: false }]);
    expect(await no.activation.withdraw(ACTOR, EVENT, NO_ID)).toEqual({ kind: "none" });
    expect(dataOf(no.statements)[0]?.values).toEqual([EVENT, null]);
    const empty = make(() => []);
    expect(await empty.activation.withdraw(ACTOR, EVENT, CALLER)).toEqual({ kind: "none" });
  });

  it("lists the queue in the admin's seat", async () => {
    const { activation, statements } = make(() => [
      {
        event_id: EVENT,
        name_ar: "اسم",
        name_en: null,
        organizer: "Acme",
        requested_at: new Date("2026-02-03T04:05:06.000Z"),
        starts_at: null,
        timezone: "Asia/Riyadh",
      },
    ]);
    expect(await activation.queue(ADMIN)).toEqual([
      {
        eventId: EVENT,
        name: { ar: "اسم", en: null },
        organizer: "Acme",
        requestedAt: "2026-02-03T04:05:06.000Z",
        startsAt: null,
        timezone: "Asia/Riyadh",
      },
    ]);
    const settings = statements.find((s) => s.sql.includes("set_config"));
    expect(settings?.values).toEqual([
      ["app.organizer_id", "app.player_id", "app.staff_user_id", "app.is_admin", "app.device_id"],
      ["", "", STAFF, "on", ""],
    ]);
    expect(dataOf(statements)[0]?.sql).toContain("WHERE r.state = 'pending'");
    expect(dataOf(statements)[0]?.sql).toContain("LIMIT 200");
  });

  it("finds an event by its code, case-insensitively", async () => {
    const found = make(() => [{ id: EVENT }]);
    expect(await found.activation.findByCode(ADMIN, "AbCd")).toBe(EVENT);
    expect(dataOf(found.statements)).toEqual([
      { sql: "SELECT id FROM event WHERE lower(join_code) = lower($1)", values: ["AbCd"] },
    ]);
    expect(await make(() => []).activation.findByCode(ADMIN, "zz")).toBeUndefined();
  });

  it("activates with the limit and add-ons, then tells the settings cache", async () => {
    const { activation, statements, onAddonsChanged } = make(() => []);
    expect(
      await activation.activate(
        ADMIN,
        EVENT,
        { limit: { mode: "soft", value: 200 }, addons: ["bigScreen", "kiosk"] },
        CALLER,
      ),
    ).toEqual({ kind: "done" });
    expect(dataOf(statements)).toEqual([
      {
        sql: "SELECT activate_event($1, $2, $3, $4, $5)",
        values: [EVENT, "soft", 200, ["bigScreen", "kiosk"], "req-1"],
      },
    ]);
    expect(onAddonsChanged).toHaveBeenCalledTimes(1);
  });

  it("does not tell the settings cache when the database fails", async () => {
    const { activation, onAddonsChanged } = make(() => new Error("down"));
    await expect(
      activation.activate(
        ADMIN,
        EVENT,
        { limit: { mode: "none", value: null }, addons: [] },
        NO_ID,
      ),
    ).rejects.toThrow("down");
    expect(onAddonsChanged).not.toHaveBeenCalled();
  });

  it("rejects with the note, and sets the limit", async () => {
    const reject = make(() => []);
    expect(await reject.activation.reject(ADMIN, EVENT, "Add the map.", CALLER)).toEqual({
      kind: "done",
    });
    expect(dataOf(reject.statements)).toEqual([
      {
        sql: "SELECT reject_event_activation($1, $2, $3)",
        values: [EVENT, "Add the map.", "req-1"],
      },
    ]);
    const limit = make(() => []);
    expect(
      await limit.activation.setLimit(ADMIN, EVENT, { mode: "hard", value: 10 }, NO_ID),
    ).toEqual({ kind: "done" });
    expect(dataOf(limit.statements)).toEqual([
      {
        sql: "SELECT set_event_player_limit($1, $2, $3, $4)",
        values: [EVENT, "hard", 10, null],
      },
    ]);
  });

  it("returns a definer's refusal as a value", async () => {
    const { activation, statements } = make(() => Object.assign(new Error("x"), { code: "QA404" }));
    expect(await activation.reject(ADMIN, EVENT, "x", CALLER)).toEqual({ kind: "not_found" });
    expect(statements.at(-1)?.sql).toBe("ROLLBACK");
    const invalid = make(() => Object.assign(new Error("x"), { code: "QA422", detail: "venue" }));
    expect(
      await invalid.activation.setLimit(ADMIN, EVENT, { mode: "none", value: null }, CALLER),
    ).toEqual({ kind: "invalid", field: "venue" });
  });
});
