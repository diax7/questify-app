import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
  logStreakBonus,
  readOwnDailyStreak,
  readOwnEventStreak,
  readStreakSettings,
  saveStreakSettings,
  streakBonusPaid,
  streakRefusalOf,
} from "#src/streaks/streaks";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const CONTEXT = {
  organizerId: "11111111-1111-4111-8111-111111111111",
  staffUserId: "22222222-2222-4222-8222-222222222222",
} as const;
const EVENT = "33333333-3333-4333-8333-333333333333";
const SETTINGS = {
  enabled: true,
  bonusPoints: 25,
  closedWeekdays: [5],
  closedDays: ["2030-11-02"],
  multiDay: true,
  today: "2030-11-01",
};
const BODY = { enabled: true, bonusPoints: 25, closedWeekdays: [5], closedDays: ["2030-11-02"] };
const clientOf = (answer: (sql: string, values: readonly unknown[]) => FakeAnswer) =>
  fakePool(answer).pool.connect() as unknown as Promise<PoolClient>;

describe("the streak refusals (migration 0068)", () => {
  it.each([
    [{ code: "AN404" }, { kind: "not_found" }],
    [
      { code: "RF409", detail: "results_final" },
      { kind: "conflict", reason: "results_final", day: null },
    ],
    [
      { code: "ST409", detail: "single_day" },
      { kind: "conflict", reason: "single_day", day: null },
    ],
    [
      { code: "ST409", detail: "archived" },
      { kind: "conflict", reason: "archived", day: null },
    ],
    [
      { code: "ST409", detail: "day_started", hint: "2030-11-01" },
      { kind: "conflict", reason: "day_started", day: "2030-11-01" },
    ],
    [
      { code: "ST409", detail: "day_started" },
      { kind: "conflict", reason: "day_started", day: null },
    ],
    [
      { code: "ST409", detail: "archived", hint: "2030-11-01" },
      { kind: "conflict", reason: "archived", day: null },
    ],
    [
      { code: "ST422", detail: "enabled" },
      { kind: "invalid", field: "enabled" },
    ],
    [
      { code: "ST422", detail: "bonusPoints" },
      { kind: "invalid", field: "bonusPoints" },
    ],
    [
      { code: "ST422", detail: "closedWeekdays" },
      { kind: "invalid", field: "closedWeekdays" },
    ],
    [
      { code: "ST422", detail: "closedDays" },
      { kind: "invalid", field: "closedDays" },
    ],
  ])("maps %o", (pg, refusal) => {
    expect(streakRefusalOf(pg)).toEqual(refusal);
  });

  it.each([
    [{ code: "ST409", detail: "frozen" }],
    [{ code: "ST409" }],
    [{ code: "ST422", detail: "streak" }],
    [{ code: "ST422" }],
    [{ code: "QB409", detail: "single_day" }],
    [{ code: "23505" }],
    [{}],
  ])("leaves %o to the caller", (pg) => {
    expect(streakRefusalOf(pg)).toBeUndefined();
  });
});

describe("the settings door", () => {
  it("reads the settings in the team member's seat", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ s: SETTINGS }] }));
    expect(await readStreakSettings({ pool }, CONTEXT, EVENT)).toEqual({
      kind: "done",
      value: SETTINGS,
    });
    expect(queries).toEqual(["SELECT event_streak_settings($1) AS s"]);
  });

  it("throws when the read answers no row, and answers a refusal the database raised", async () => {
    const none = fakePool(() => ({ rows: [] }));
    await expect(readStreakSettings({ pool: none.pool }, CONTEXT, EVENT)).rejects.toThrow(
      "event_streak_settings answered no row",
    );
    const refused = fakePool(() => {
      throw pgError({ code: "AN404" });
    });
    expect(await readStreakSettings({ pool: refused.pool }, CONTEXT, EVENT)).toEqual({
      kind: "not_found",
    });
    const broken = fakePool(() => {
      throw pgError({ code: "XX000" });
    });
    await expect(readStreakSettings({ pool: broken.pool }, CONTEXT, EVENT)).rejects.toThrow(
      "database error XX000",
    );
  });

  it("saves every field in order, then reads the stored settings; unchanged is a replay", async () => {
    for (const [outcome, replayed] of [
      ["set", false],
      ["unchanged", true],
    ] as const) {
      const sent: unknown[][] = [];
      const { pool } = fakePool((sql, values) => {
        if (sql.startsWith("SELECT set_event_streak")) {
          sent.push([...values]);
          return { rows: [{ outcome }] };
        }
        return { rows: [{ s: SETTINGS }] };
      });
      expect(
        await saveStreakSettings({ pool }, CONTEXT, {
          eventId: EVENT,
          body: BODY,
          requestId: "r1",
        }),
      ).toEqual({ kind: "done", value: { settings: SETTINGS, replayed } });
      expect(sent).toEqual([[EVENT, true, 25, [5], ["2030-11-02"], "r1"]]);
    }
  });

  it("answers the door's refusal", async () => {
    const { pool } = fakePool(() => {
      throw pgError({ code: "ST409", detail: "day_started", hint: "2030-11-01" });
    });
    expect(
      await saveStreakSettings({ pool }, CONTEXT, { eventId: EVENT, body: BODY, requestId: "r1" }),
    ).toEqual({ kind: "conflict", reason: "day_started", day: "2030-11-01" });
  });
});

describe("the player's reads", () => {
  it("answers the event streak while it is on, and null while off or for a non-member", async () => {
    const row = { is_on: true, days: 3, played_today: true, closed_today: false, bonus_points: 5 };
    expect(await readOwnEventStreak(await clientOf(() => ({ rows: [row] })), EVENT)).toEqual({
      days: 3,
      playedToday: true,
      closedToday: false,
      bonusPoints: 5,
    });
    expect(
      await readOwnEventStreak(await clientOf(() => ({ rows: [{ ...row, is_on: false }] })), EVENT),
    ).toBeNull();
    expect(await readOwnEventStreak(await clientOf(() => ({ rows: [] })), EVENT)).toBeNull();
  });

  it("answers a completion's streak bonus, or null", async () => {
    expect(
      await streakBonusPaid(await clientOf(() => ({ rows: [{ points: 5, days: 2 }] })), "9"),
    ).toEqual({ points: 5, days: 2 });
    expect(await streakBonusPaid(await clientOf(() => ({ rows: [] })), "9")).toBeNull();
  });

  it("answers the daily streak, or null while the switch is off", async () => {
    const daily = { days: 4, today: false, next: { days: 7, xp: 100 } };
    expect(await readOwnDailyStreak(await clientOf(() => ({ rows: [{ s: daily }] })))).toEqual(
      daily,
    );
    expect(await readOwnDailyStreak(await clientOf(() => ({ rows: [{ s: null }] })))).toBeNull();
    expect(await readOwnDailyStreak(await clientOf(() => ({ rows: [] })))).toBeNull();
  });
});

describe("the streak bonus log", () => {
  it("logs the streak day of a fresh payment only, never the player", () => {
    const lines: Record<string, unknown>[] = [];
    const log = { info: (fields: Record<string, unknown>) => lines.push(fields) };
    logStreakBonus(log, { replayed: false, streakBonus: { points: 5, days: 3 } });
    logStreakBonus(log, { replayed: true, streakBonus: { points: 5, days: 3 } });
    logStreakBonus(log, { replayed: false, streakBonus: null });
    logStreakBonus(log, null);
    expect(lines).toEqual([{ event: "completion.streak_bonus", days: 3 }]);
  });
});
