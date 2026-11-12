import { ENGINE_VERSIONS, LEVELS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { closeDueRounds, readGame, sendResult, startRound } from "#src/plays/games";
import { issueMeetPass, meetPassState, meetPlayer } from "#src/plays/meet";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const QUEST = "22222222-2222-4222-8222-222222222222";
const CODE = "questify/meet/v1/AbCdEfGhIjKlMnOpQr_-12";

const keys = { playerKey: () => Buffer.alloc(32) } as unknown as AuthKeys;
const caller: Caller = { address: "127.0.0.1", userAgent: null, log: () => undefined };

/**
 * A database where the player is under every limit and `answer` answers the play's own query. `answer` sees only the
 * play's SQL and values: the limit's lock, count and record answer as an unlimited player's.
 */
function playDeps(answer: (sql: string, values: readonly unknown[]) => FakeAnswer) {
  const { pool, queries } = fakePool((sql, values) => {
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (sql.includes("FROM auth_throttle")) {
      return { rows: [{ count: 0, retry_after: null }] };
    }
    if (sql.startsWith("INSERT INTO auth_throttle")) {
      return { rows: [{ at: "now" }] };
    }
    return answer(sql, values);
  });
  return { deps: { pool, keys }, queries };
}

const nothingAsked = (sql: string): FakeAnswer => {
  throw new Error(`unexpected query: ${sql}`);
};

describe("meet-someone and mini-games switched off (the database's doors, T-711b)", () => {
  const switchedOff = pgError({ code: "QF403" });
  const offDoors = (sql: string): FakeAnswer => {
    if (/issue_meet_pass|meet_player|start_game_round/.test(sql)) {
      throw switchedOff;
    }
    return sql.includes("member_game") ? { rows: [{ game: "memory_match" }] } : nothingAsked(sql);
  };

  it("answers feature_off for a meet code, a meeting and a round when the door refuses QF403", async () => {
    const { deps, queries } = playDeps(offDoors);
    const device = { deviceId: undefined };
    expect(await issueMeetPass(deps, { playerId: PLAYER, questId: QUEST, ...device })).toEqual({
      kind: "feature_off",
    });
    const scan = { code: CODE, idempotencyKey: "k", position: null, ...device };
    expect(await meetPlayer(deps, { playerId: PLAYER, ...scan }, caller)).toEqual({
      kind: "feature_off",
    });
    const round = { idempotencyKey: "k", engineVersions: { memory_match: 99 }, ...device };
    expect(await startRound(deps, { playerId: PLAYER, questId: QUEST, ...round })).toEqual({
      kind: "feature_off",
    });
    expect(queries.some((sql) => sql.includes("issue_meet_pass"))).toBe(true);
    expect(queries.some((sql) => sql.includes("meet_player"))).toBe(true);
    expect(queries.some((sql) => sql.includes("start_game_round"))).toBe(true);
  });

  it("does not count a switched-off meeting toward the refused-scan limit", async () => {
    const recorded: unknown[][] = [];
    const { pool } = fakePool((sql, values) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM auth_throttle")) {
        return { rows: [{ count: 0, retry_after: null }] };
      }
      if (sql.startsWith("INSERT INTO auth_throttle")) {
        recorded.push([...values]);
        return { rows: [{ at: "now" }] };
      }
      return offDoors(sql);
    });
    const scan = { code: CODE, idempotencyKey: "k", position: null, deviceId: undefined };
    expect(await meetPlayer({ pool, keys }, { playerId: PLAYER, ...scan }, caller)).toEqual({
      kind: "feature_off",
    });
    expect(recorded).toEqual([]);
    const bad = { ...scan, code: "not a meet code" };
    expect(await meetPlayer({ pool, keys }, { playerId: PLAYER, ...bad }, caller)).toMatchObject({
      kind: "meet_refused",
      reason: "bad_code",
    });
    expect(recorded).toHaveLength(1);
  });
});

/** A scan of a well-formed code that `meet_player` refuses with this error. */
function scanRefused(error: Error) {
  const { deps } = playDeps((sql) => {
    if (sql.includes("meet_player")) {
      throw error;
    }
    return nothingAsked(sql);
  });
  const scan = { code: CODE, idempotencyKey: "k", deviceId: undefined, position: null };
  return meetPlayer(deps, { playerId: PLAYER, ...scan }, caller);
}

const refused = (reason: string, name: string | null, cap: number | null) => ({
  kind: "meet_refused",
  reason,
  name,
  cap,
});
const qm = (detail: string, hint: string) => pgError({ code: "QM409", detail, hint });

describe("a meeting the database refuses", () => {
  it("names the other player for already_met only, and the cap for daily_cap only", async () => {
    expect(await scanRefused(qm("already_met", "sara_k"))).toEqual(
      refused("already_met", "sara_k", null),
    );
    expect(await scanRefused(qm("already_met", "2030"))).toEqual(
      refused("already_met", "2030", null),
    );
    expect(await scanRefused(qm("daily_cap", "5"))).toEqual(refused("daily_cap", null, 5));
    expect(await scanRefused(qm("daily_cap", ""))).toEqual(refused("daily_cap", null, null));
    expect(await scanRefused(qm("done", "5"))).toEqual(refused("done", null, null));
    expect(await scanRefused(pgError({ code: "QM422", detail: "self" }))).toEqual(
      refused("self", null, null),
    );
  });

  it("lets any other error through: another code, or a QM code with a reason it does not know", async () => {
    for (const error of [
      pgError({ code: "XX000", detail: "self" }),
      pgError({ code: "QM409", detail: "tired" }),
      new Error("connection lost"),
    ]) {
      await expect(scanRefused(error)).rejects.toBe(error);
    }
  });
});

const stateOf = (answer: (sql: string) => FakeAnswer) =>
  meetPassState(playDeps(answer).deps, { playerId: PLAYER, passId: "7" });
/** meet_pass_state's row for a used code, changed by `fields`. */
const row = (fields: Record<string, unknown>) => (sql: string) =>
  sql.includes("meet_pass_state")
    ? { rows: [{ state: "used", username: "sara_k", avatar: "owl", points: "50", ...fields }] }
    : nothingAsked(sql);

describe("a meet code's state", () => {
  it("names who scanned a used code, with their avatar or the falcon", async () => {
    expect(await stateOf(row({}))).toEqual({
      kind: "done",
      value: { state: "used", met: { username: "sara_k", avatar: "owl", points: 50 } },
    });
    expect(await stateOf(row({ avatar: null }))).toMatchObject({
      value: { met: { avatar: "falcon" } },
    });
  });

  it("names no one for a used code whose scanner is gone", async () => {
    expect(await stateOf(row({ username: null, avatar: null, points: null }))).toEqual({
      kind: "done",
      value: { state: "used", met: null },
    });
  });

  it("answers the refusal of a player who may not play", async () => {
    const inactive = await stateOf(() => {
      throw pgError({ code: "QC403", detail: "removed" });
    });
    expect(inactive).toEqual({ kind: "enrollment_inactive", reason: "removed" });
  });
});

/** member_game's row for an easy memory-match quest, changed by `fields`. */
const view = (fields: Record<string, unknown> = {}) => ({
  game: "memory_match",
  level: "easy",
  params: LEVELS.memory_match.easy,
  attempts: 2,
  cooldown_minutes: null,
  used: 1,
  attempts_left: 1,
  passed: false,
  done: false,
  retry_at: null,
  open_round: null,
  open_deadline: null,
  last_verdict: null,
  last_result: null,
  server_now: new Date("2026-11-01T12:00:00Z"),
  ...fields,
});
const sheet = (viewRow: Record<string, unknown>) =>
  readGame(
    playDeps((sql) => {
      if (sql.includes("member_quest_images")) return { rows: [{ images: null }] };
      return sql.includes("member_game") ? { rows: [viewRow] } : nothingAsked(sql);
    }).deps,
    PLAYER,
    QUEST,
  );

describe("a game the database cannot name or refuses", () => {
  it("shows the sheet's open round, last result and retry time when the database has them", async () => {
    const open = view({
      retry_at: new Date("2026-11-01T12:10:00Z"),
      open_round: "42",
      open_deadline: new Date("2026-11-01T12:05:00Z"),
      last_verdict: "short",
      last_result: { pairs: 2 },
    });
    expect(await sheet(open)).toMatchObject({
      kind: "done",
      value: {
        retryAt: "2026-11-01T12:10:00.000Z",
        open: { roundId: "42", deadlineAt: "2026-11-01T12:05:00.000Z" },
        last: { verdict: "short", result: { pairs: 2 } },
      },
    });
    expect(await sheet(view())).toMatchObject({
      value: { retryAt: null, open: null, last: null },
    });
  });

  it("fails loudly on a game this build cannot play", async () => {
    await expect(sheet(view({ game: "chess" }))).rejects.toThrow(
      "The database named a game this build cannot play: chess",
    );
    const { deps } = playDeps((sql) =>
      sql.includes("member_game") ? { rows: [] } : nothingAsked(sql),
    );
    const round = { idempotencyKey: "k", deviceId: undefined, engineVersions: {} };
    await expect(startRound(deps, { playerId: PLAYER, questId: QUEST, ...round })).rejects.toThrow(
      /^The database named a game this build cannot play: $/,
    );
  });

  it("answers the refusal of a player who may not send a result", async () => {
    const { deps } = playDeps(() => {
      throw pgError({ code: "QC403", detail: "banned" });
    });
    const result = { roundId: "42", idempotencyKey: "k", inputs: [], claimed: null };
    expect(await sendResult(deps, { playerId: PLAYER, ...result }, caller)).toEqual({
      kind: "enrollment_inactive",
      reason: "banned",
    });
  });
});

describe("a game sheet's open round", () => {
  it("shows no open round while the database has only half of one", async () => {
    const deadline = new Date("2026-11-01T12:05:00Z");
    expect(await sheet(view({ open_round: "42", open_deadline: null }))).toMatchObject({
      value: { open: null },
    });
    expect(await sheet(view({ open_round: null, open_deadline: deadline }))).toMatchObject({
      value: { open: null },
    });
  });
});

describe("a round the database refuses before it starts", () => {
  it("answers the engine read's refusal without counting an attempt or issuing a round", async () => {
    const { deps, queries } = playDeps((sql) => {
      if (sql.includes("member_game")) {
        throw pgError({ code: "QC404" });
      }
      return sql.includes("start_game_round") ? { rows: [{}] } : nothingAsked(sql);
    });
    const round = { idempotencyKey: "k", deviceId: undefined, engineVersions: {} };
    expect(await startRound(deps, { playerId: PLAYER, questId: QUEST, ...round })).toEqual({
      kind: "not_found",
    });
    expect(queries.some((sql) => sql.includes("auth_throttle"))).toBe(false);
    expect(queries.some((sql) => sql.includes("start_game_round"))).toBe(false);
  });
});

/** What each reward read answers: a level, a category bonus, an item, a boost, a first-N place and a streak day. */
function rewardRow(sql: string): FakeAnswer | undefined {
  const rewards: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["own_level_items(", { items: [] }],
    ["FROM own_level(", { level_up: 3, up_title_ar: "مستكشف", up_title_en: "Explorer" }],
    ["own_bonus(", { category_id: "c1", points: "20", name_ar: null, name_en: "Food" }],
    ["own_quest_item(", { name_ar: null, name_en: "Mug", outcome: "pending", until: null }],
    ["completion_boost(", { multiplier: 2 }],
    ["own_first_bonus(", { points: 10, place: 1, slots: 3 }],
    ["own_streak_bonus(", { points: 15, days: 3 }],
  ];
  const found = rewards.find(([marker]) => sql.includes(marker));
  return found === undefined ? undefined : { rows: [found[1]] };
}

/** A memory-match round whose inputs the replay refuses, finished by the database with `finish`'s row. */
async function finishWith(finish: Record<string, unknown>) {
  const sent: unknown[][] = [];
  const { deps } = playDeps((sql, values) => {
    if (sql.includes("game_round_for_replay")) {
      const params = LEVELS.memory_match.easy;
      const engine = ENGINE_VERSIONS.memory_match;
      return { rows: [{ game: "memory_match", seed: 7, params, engine_version: engine }] };
    }
    if (sql.includes("finish_game_round")) {
      sent.push([...values]);
      return { rows: [finish] };
    }
    return rewardRow(sql) ?? nothingAsked(sql);
  });
  const result = { roundId: "42", idempotencyKey: "k", inputs: "garbage", claimed: null };
  const answer = await sendResult(deps, { playerId: PLAYER, ...result }, caller);
  return { answer, sent };
}

const finishRow = (fields: Record<string, unknown>) => ({
  verdict: "passed",
  completion_id: "77",
  points: "50",
  score: "120",
  balance: "80",
  attempts_left: 1,
  replayed: false,
  result: { pairs: 6 },
  reason: null,
  ...fields,
});

describe("a round's result", () => {
  it("tells the database a refused replay is never an unlikely pass", async () => {
    const { sent } = await finishWith(finishRow({ verdict: "refused", completion_id: null }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.[2]).toBe("refused");
    expect(sent[0]?.[5]).toBe(false);
  });

  it("answers every reward a paying round earned", async () => {
    const { answer } = await finishWith(finishRow({}));
    expect(answer).toMatchObject({
      kind: "done",
      value: {
        completionId: "77",
        levelUp: { level: 3 },
        bonus: { categoryId: "c1", points: 20 },
        item: { outcome: "pending" },
        boost: { multiplier: 2 },
        firstBonus: { points: 10, place: 1, slots: 3 },
        streakBonus: { points: 15, days: 3 },
      },
    });
  });

  it("answers no reward for a round that paid nothing", async () => {
    const { answer } = await finishWith(finishRow({ verdict: "short", completion_id: null }));
    expect(answer).toMatchObject({
      kind: "done",
      value: {
        completionId: null,
        points: 50,
        levelUp: null,
        bonus: null,
        item: null,
        boost: null,
        firstBonus: null,
        streakBonus: null,
      },
    });
  });
});

/** The sweep over a database whose close_one_due_round answers `outcomes` in turn (an error is raised), then null. */
function sweep(outcomes: ReadonlyArray<string | null | Error>) {
  let next = 0;
  const { pool } = fakePool((sql) => {
    if (!sql.includes("close_one_due_round")) {
      return nothingAsked(sql);
    }
    const outcome = outcomes[next] ?? null;
    next += 1;
    if (outcome instanceof Error) {
      throw outcome;
    }
    return { rows: [{ outcome }] };
  });
  return closeDueRounds({ pool });
}

describe("the sweep of rounds left open", () => {
  it("counts the rounds it closed until none is due", async () => {
    expect(await sweep(["short", "passed", null])).toBe(2);
  });

  it("stops at the first round the database refuses to close", async () => {
    expect(await sweep(["short", pgError({ code: "QC404" }), "short"])).toBe(1);
  });
});
