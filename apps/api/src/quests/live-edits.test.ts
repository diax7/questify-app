import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { OrganizerContext } from "#src/organizers/store";
import {
  LiveEditError,
  PAST_POINTS_TYPES,
  applyPast,
  deletePlayed,
  liveEditRefusal,
  readImpact,
} from "#src/quests/live-edits";

type Answer = (sql: string, values: unknown[]) => Promise<{ rows: unknown[] }>;

const clientOf = (answer: Answer): PoolClient =>
  ({ query: vi.fn(async (sql: string, values: unknown[] = []) => answer(sql, values)) }) as never;

const pastRow = (over: Record<string, unknown>) => ({
  quest_id: "q",
  to_points: 0,
  completions: 0,
  players: 0,
  raised: 0,
  lowered: 0,
  clamped: 0,
  replayed: false,
  more: false,
  ...over,
});

const pgError = (code: string, hint?: string) =>
  Object.assign(new Error(`pg ${code}`), { code, ...(hint === undefined ? {} : { hint }) });

describe("liveEditRefusal (T-604)", () => {
  it("maps each refusal of the past, delete and impact doors to its answer", () => {
    expect(liveEditRefusal({ code: "AQ404" })).toEqual({ kind: "not_found" });
    expect(liveEditRefusal({ code: "AS409" })).toEqual({ kind: "event_not_live" });
    expect(liveEditRefusal({ code: "RF409" })).toEqual({ kind: "results_final" });
    expect(liveEditRefusal({ code: "AK422" })).toEqual({ kind: "key_reused" });
    expect(liveEditRefusal({ code: "AC409", hint: "20,400" })).toEqual({
      kind: "over_cap",
      limit: 20,
    });
    expect(liveEditRefusal({ code: "AC409" })).toEqual({ kind: "over_cap", limit: 0 });
    expect(liveEditRefusal({ code: "PX422" })).toEqual({ kind: "invalid", field: "apply" });
  });

  it("leaves anything else to be thrown", () => {
    expect(liveEditRefusal({ code: "40P01" })).toBeUndefined();
    expect(liveEditRefusal({})).toBeUndefined();
  });

  it("reaches only the types paid the quest's points per completion (Q-354)", () => {
    expect(PAST_POINTS_TYPES).toEqual(
      expect.arrayContaining([
        "scan_qr",
        "enter_code",
        "location",
        "vote",
        "survey",
        "share",
        "challenge",
        "passport",
        "meet",
      ]),
    );
    for (const type of ["submission", "quiz", "game"]) {
      expect(PAST_POINTS_TYPES).not.toContain(type);
    }
  });
});

describe("LiveEditError (T-604)", () => {
  it("carries the door's refusal and its cause", () => {
    const cause = { code: "AQ404" };
    const error = new LiveEditError({ kind: "not_found" }, cause);
    expect(error).toBeInstanceOf(Error);
    expect(error.refusal).toEqual({ kind: "not_found" });
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("LiveEditError");
    expect(error.message).toBe("live edit refused: not_found");
  });
});

describe("applyPast (T-604)", () => {
  const target = { eventId: "e", questId: "q", fromPoints: 100, key: "k", requestId: "r" };

  it("asks for each next part while the door has more, and adds the parts up", async () => {
    const parts = [
      pastRow({
        completions: 2000,
        players: 5,
        raised: 1500,
        lowered: 400,
        clamped: 3,
        more: true,
      }),
      pastRow({ completions: 10, raised: 4, lowered: 6, replayed: true }),
    ];
    const asked: unknown[][] = [];
    const client = clientOf(async (_sql, values) => {
      asked.push(values);
      return { rows: [parts[asked.length - 1]] };
    });
    expect(await applyPast(client, target)).toEqual({
      completions: 2010,
      players: 5,
      raised: 1504,
      lowered: 406,
      clamped: 3,
      replayed: true,
    });
    expect(asked.map((values) => values[6])).toEqual([1, 2]);
    expect(asked[0]).toEqual(["e", "q", 100, "k", "r", 2000, 1]);
  });

  it("throws the door's refusal as a LiveEditError that keeps the cause", async () => {
    const cause = pgError("AS409");
    const client = clientOf(async () => Promise.reject(cause));
    const thrown: unknown = await applyPast(client, target).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(LiveEditError);
    expect(thrown).toMatchObject({ refusal: { kind: "event_not_live" }, cause });
  });

  it("throws any other error as it is", async () => {
    const deadlock = pgError("40P01");
    const client = clientOf(async () => Promise.reject(deadlock));
    await expect(applyPast(client, target)).rejects.toBe(deadlock);
  });
});

describe("deletePlayed (T-604)", () => {
  const target = { eventId: "e", questId: "q", remove: true, requestId: "r" };

  it("sends the choice and answers what was taken back", async () => {
    const asked: unknown[][] = [];
    const client = clientOf(async (_sql, values) => {
      asked.push(values);
      return { rows: [{ removed: 3, total: "250" }] };
    });
    expect(await deletePlayed(client, target)).toEqual({ removed: 3, total: 250 });
    expect(await deletePlayed(client, { ...target, remove: false })).toEqual({
      removed: 3,
      total: 250,
    });
    expect(asked).toEqual([
      ["e", "q", true, "r"],
      ["e", "q", false, "r"],
    ]);
  });

  it("answers zero when the door returns no row", async () => {
    const client = clientOf(async () => ({ rows: [] }));
    expect(await deletePlayed(client, target)).toEqual({ removed: 0, total: 0 });
  });

  it("throws the door's refusal as a LiveEditError, and any other error as it is", async () => {
    const refused = clientOf(async () => Promise.reject(pgError("RF409")));
    await expect(deletePlayed(refused, target)).rejects.toMatchObject({
      name: "LiveEditError",
      refusal: { kind: "results_final" },
    });
    const broken = pgError("57014");
    await expect(
      deletePlayed(
        clientOf(async () => Promise.reject(broken)),
        target,
      ),
    ).rejects.toBe(broken);
  });
});

const poolOf = (impact: () => Promise<{ rows: unknown[] }>): Pool => {
  const client = {
    query: async (sql: string) => (sql.includes("quest_points_impact") ? impact() : { rows: [] }),
    release: () => undefined,
  };
  return { connect: async () => client } as never;
};

describe("readImpact (T-604)", () => {
  const context = { organizerId: randomUUID(), staffUserId: randomUUID() } as OrganizerContext;
  const target = { eventId: randomUUID(), questId: randomUUID(), points: 60 };

  const refusedWith = (code: string) =>
    readImpact({ pool: poolOf(async () => Promise.reject(pgError(code))) }, context, target);

  it("reads every number of the screen from its own column", async () => {
    const row = {
      eligible: true,
      completions: 1,
      players: 2,
      raise: 3,
      lower: 4,
      clamped: 5,
      prizes_handed: 6,
    };
    const pool = poolOf(async () => ({ rows: [row] }));
    expect(await readImpact({ pool }, context, target)).toEqual({
      kind: "done",
      value: {
        eligible: true,
        completions: 1,
        players: 2,
        raise: 3,
        lower: 4,
        clamped: 5,
        prizesHanded: 6,
      },
    });
    const none = poolOf(async () => ({ rows: [{ ...row, eligible: "yes" }] }));
    expect(await readImpact({ pool: none }, context, target)).toMatchObject({
      value: { eligible: false },
    });
  });

  it("answers zeros and not eligible when the door returns no row", async () => {
    const pool = poolOf(async () => ({ rows: [] }));
    expect(await readImpact({ pool }, context, target)).toEqual({
      kind: "done",
      value: {
        eligible: false,
        completions: 0,
        players: 0,
        raise: 0,
        lower: 0,
        clamped: 0,
        prizesHanded: 0,
      },
    });
  });

  it("answers each refusal of the door, and throws any other error", async () => {
    expect(await refusedWith("AN404")).toEqual({ kind: "not_found" });
    expect(await refusedWith("AQ404")).toEqual({ kind: "not_found" });
    expect(await refusedWith("AS409")).toEqual({ kind: "event_not_live" });
    await expect(refusedWith("40P01")).rejects.toMatchObject({ code: "40P01" });
  });
});
