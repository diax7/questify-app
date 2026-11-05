import { describe, expect, it, vi } from "vitest";
import { REWARD_CODES_USAGE, runRewardCodesCommand } from "#src/rewards/reward-codes-command";

const R = "r".repeat(32);
const S = "s".repeat(32);
const ROTATION = {
  DATABASE_ADMIN_URL: "postgres://owner@db/questify",
  REWARD_CODE_SECRET: S,
  REWARD_CODE_KEY_ID: "2",
  REWARD_CODE_PREVIOUS_SECRET: R,
  REWARD_CODE_PREVIOUS_KEY_ID: "1",
};

/** Runs the command with a connection that must never be opened. */
async function refusalOf(argv: string[], env: Record<string, string | undefined>) {
  const connect = vi.fn(() => Promise.reject(new Error("connected")));
  const print = vi.fn();
  const error = await runRewardCodesCommand(argv, env, { print, connect }).then(
    () => undefined,
    (thrown: unknown) => (thrown as Error).message,
  );
  expect(connect).not.toHaveBeenCalled();
  expect(print).not.toHaveBeenCalled();
  return error;
}

describe("reward-codes command", () => {
  it.each([[[]], [["rotate"]], [["RESEAL"]]])("answers the usage for %j", async (argv) => {
    expect(await refusalOf(argv, ROTATION)).toBe(REWARD_CODES_USAGE);
  });

  it.each([
    [{ REWARD_CODE_PREVIOUS_KEY_ID: undefined }, /go together/],
    [{ REWARD_CODE_PREVIOUS_KEY_ID: "2" }, /must differ from REWARD_CODE_KEY_ID/],
    [{ REWARD_CODE_PREVIOUS_SECRET: S }, /PREVIOUS_SECRET must differ from REWARD_CODE_SECRET/],
    [{ REWARD_CODE_KEY_ID: "300" }, /REWARD_CODE_KEY_ID must be a whole number from 1 to 255/],
    [{ REWARD_CODE_SECRET: "short" }, /REWARD_CODE_SECRET must be at least 32/],
    [{ REWARD_CODE_SECRET: undefined }, /REWARD_CODE_SECRET is required/],
  ])("refuses the settings the API refuses (%j) before connecting", async (change, message) => {
    for (const command of ["reseal", "check"]) {
      const error = await refusalOf([command], { ...ROTATION, ...change });
      expect(error).toMatch(message);
      expect(error).not.toContain(R);
      expect(error).not.toContain(S);
    }
  });

  it("needs the owner connection and a named operator", async () => {
    expect(await refusalOf(["check"], { ...ROTATION, DATABASE_ADMIN_URL: " " })).toMatch(
      /DATABASE_ADMIN_URL is not set/,
    );
    expect(await refusalOf(["reseal", "--by", " "], ROTATION)).toMatch(/pass --by <name>/);
    expect(await refusalOf(["reseal", "--by"], ROTATION)).toMatch(/pass --by <name>/);
  });
});
