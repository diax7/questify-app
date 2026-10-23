import { describe, expect, it } from "vitest";
import { canReject, reviewAnswer, reviewQueueOf } from "#src/operator/review.ts";

const ITEM = {
  id: "7",
  questId: "q",
  questTitle: { ar: null, en: "Tell us" },
  enrollmentId: "e",
  username: "sara",
  avatar: "falcon",
  text: "Hello",
  points: 150,
  status: "pending",
  auto: false,
  marked: true,
};

const error = (code: string) => ({
  kind: "error" as const,
  status: 409,
  code,
  message: { ar: "ع", en: "e" },
  details: {},
  headers: new Headers(),
});

describe("reviewQueueOf", () => {
  it("reads the items the screen shows", () => {
    expect(reviewQueueOf({ submissions: [ITEM], nextCursor: null })).toEqual([
      {
        id: "7",
        questTitle: { ar: null, en: "Tell us" },
        username: "sara",
        avatar: "falcon",
        text: "Hello",
        points: 150,
        marked: true,
      },
    ]);
    expect(reviewQueueOf({ submissions: [{ ...ITEM, username: null, text: null }] })).toHaveLength(
      1,
    );
  });

  it.each([
    null,
    {},
    { submissions: [{ ...ITEM, points: "150" }] },
    { submissions: [{ ...ITEM, questTitle: null }] },
    { submissions: [{ ...ITEM, marked: undefined }] },
  ])("reads %j as nothing", (body) => {
    expect(reviewQueueOf(body)).toBeUndefined();
  });
});

describe("reviewAnswer", () => {
  it("moves on when someone else got there first or it can no longer be approved", () => {
    expect(reviewAnswer(error("already_reviewed"))).toMatchObject({ kind: "gone" });
    expect(reviewAnswer(error("not_approvable"))).toMatchObject({ kind: "gone" });
    expect(reviewAnswer(error("not_found"))).toMatchObject({ kind: "gone" });
  });

  it("shows other refusals, and passes the rest through", () => {
    expect(reviewAnswer(error("ability_off"))).toEqual({
      kind: "refused",
      message: { ar: "ع", en: "e" },
    });
    expect(reviewAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(reviewAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(reviewAnswer({ kind: "ok", status: 200, body: {}, headers: new Headers() })).toEqual({
      kind: "done",
    });
  });
});

describe("canReject", () => {
  it("needs a reason of 1 to 300 characters", () => {
    expect(canReject("  ")).toBe(false);
    expect(canReject("No")).toBe(true);
    expect(canReject("x".repeat(300))).toBe(true);
    expect(canReject("x".repeat(301))).toBe(false);
  });
});
