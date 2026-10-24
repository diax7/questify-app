import { LEVELS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { AuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { gamesPlatformOn, readGame, sendResult, startRound } from "#src/plays/games";
import { issueMeetPass, meetPassState, meetPlatformOn, meetPlayer } from "#src/plays/meet";
import type { ConfigResult, SettingsService } from "#src/settings/service";
import { fakePool, pgError, type FakeAnswer } from "#test/support/fake-pool";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const QUEST = "22222222-2222-4222-8222-222222222222";
const CODE = "questify/meet/v1/AbCdEfGhIjKlMnOpQr_-12";

const settingsWith = (result: ConfigResult) =>
  ({ forEvent: async () => result }) as unknown as SettingsService;
const featuring = (features: Record<string, { enabled: boolean }>) =>
  settingsWith({ kind: "ok", config: { features }, etag: "x" } as unknown as ConfigResult);
const ON = featuring({});
const keys = { playerKey: () => Buffer.alloc(32) } as unknown as AuthKeys;
const caller: Caller = { address: "127.0.0.1", userAgent: null, log: () => undefined };

/**
 * A database where the player is under every limit and `answer` answers the play's own query. `answer` sees only the
 * play's SQL: the limit's lock, count and record answer as an unlimited player's.
 */
function playDeps(answer: (sql: string) => FakeAnswer, settings = ON) {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("pg_try_advisory_xact_lock")) {
      return { rows: [{ locked: true }] };
    }
    if (sql.includes("FROM auth_throttle")) {
      return { rows: [{ count: 0, retry_after: null }] };
    }
    if (sql.startsWith("INSERT INTO auth_throttle")) {
      return { rows: [{ at: "now" }] };
    }
    return answer(sql);
  });
  return { deps: { pool, keys, settings }, queries };
}

const nothingAsked = (sql: string): FakeAnswer => {
  throw new Error(`unexpected query: ${sql}`);
};

describe("the platform's meet-someone and mini-games switches", () => {
  it("is on unless the platform switched it off, and off when the configuration cannot be read", async () => {
    for (const isOn of [meetPlatformOn, gamesPlatformOn]) {
      expect(await isOn(ON)).toBe(true);
      expect(
        await isOn(featuring({ meetSomeone: { enabled: true }, miniGames: { enabled: true } })),
      ).toBe(true);
      expect(await isOn(settingsWith({ kind: "event_not_found" }))).toBe(false);
    }
    expect(await meetPlatformOn(featuring({ meetSomeone: { enabled: false } }))).toBe(false);
    expect(await meetPlatformOn(featuring({ miniGames: { enabled: false } }))).toBe(true);
    expect(await gamesPlatformOn(featuring({ miniGames: { enabled: false } }))).toBe(false);
    expect(await gamesPlatformOn(featuring({ meetSomeone: { enabled: false } }))).toBe(true);
  });

  it("refuses a meet code, a meeting and a round while switched off, before reading anything", async () => {
    const off = featuring({ meetSomeone: { enabled: false }, miniGames: { enabled: false } });
    const { deps, queries } = playDeps(nothingAsked, off);
    const device = { deviceId: undefined };
    expect(await issueMeetPass(deps, { playerId: PLAYER, questId: QUEST, ...device })).toEqual({
      kind: "feature_off",
    });
    const scan = { code: CODE, idempotencyKey: "k", position: null, ...device };
    expect(await meetPlayer(deps, { playerId: PLAYER, ...scan }, caller)).toEqual({
      kind: "feature_off",
    });
    const round = { idempotencyKey: "k", engineVersions: {}, ...device };
    expect(await startRound(deps, { playerId: PLAYER, questId: QUEST, ...round })).toEqual({
      kind: "feature_off",
    });
    expect(queries).toEqual([]);
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
    playDeps((sql) => (sql.includes("member_game") ? { rows: [viewRow] } : nothingAsked(sql))).deps,
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
