import { describe, expect, it } from "vitest";
import { passportViewOf, stampAnswer } from "#src/event/passport.ts";

const ok = (body: unknown) => ({ kind: "ok", status: 200, body, headers: new Headers() }) as const;
const error = (status: number, code: string, details: Record<string, unknown> = {}) =>
  ({ kind: "error", status, code, message: null, details, headers: new Headers() }) as const;

describe("passportViewOf (T-304b)", () => {
  it("reads the steps and how many are needed", () => {
    const view = {
      needed: 2,
      steps: [
        { id: "a", name: { ar: "أ", en: null }, done: true },
        { id: "b", name: { ar: null, en: "B" }, done: false },
      ],
    };
    expect(passportViewOf(view)).toEqual(view);
  });

  it("refuses anything not well formed", () => {
    for (const body of [
      null,
      { needed: "2", steps: [] },
      { needed: 2 },
      { needed: 2, steps: [{ id: "a", name: { en: "A" }, done: true }] },
      { needed: 2, steps: [{ id: "a", name: { ar: null, en: "A" }, done: "yes" }] },
    ]) {
      expect(passportViewOf(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});

describe("stampAnswer (T-304b)", () => {
  it("reads the progress of a stamp that did not finish the passport", () => {
    const body = { questId: "p", stamped: true, done: 4, needed: 5, completed: null, rank: null };
    expect(stampAnswer(ok(body))).toEqual({
      kind: "stamped",
      questId: "p",
      done: 4,
      needed: 5,
      fresh: true,
    });
    expect(stampAnswer(ok({ ...body, stamped: false }))).toMatchObject({ fresh: false });
  });

  it("reads the payment of the stamp that finished it, with its quest", () => {
    const completed = { points: 30, score: 40, replayed: false, levelUp: null, bonus: null };
    expect(
      stampAnswer(ok({ questId: "p", stamped: true, done: 5, needed: 5, completed, rank: 2 })),
    ).toEqual({ kind: "completed", questId: "p", ...completed });
  });

  it("answers a refusal as a completion's, and a broken answer as failed", () => {
    expect(stampAnswer(error(422, "invalid_code"))).toEqual({ kind: "wrong_code", problem: null });
    expect(stampAnswer(error(409, "already_completed"))).toEqual({ kind: "limit" });
    expect(stampAnswer(error(403, "quest_not_open", { reason: "hidden" }))).toEqual({
      kind: "not_open",
      reason: "hidden",
    });
    expect(stampAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(stampAnswer(ok({ questId: "p" }))).toEqual({ kind: "failed" });
    expect(
      stampAnswer(
        ok({ questId: "p", stamped: true, done: 5, needed: 5, completed: { points: 1 } }),
      ),
    ).toEqual({ kind: "failed" });
  });
});
