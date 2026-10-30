import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { momentIsOn, secondsToWait, sendCheer } from "#src/event/cheers.ts";
import { NOTHING_LIVE, liveStateOf } from "#src/event/polls.ts";

const answering = (result: AuthedResult) => {
  const asked: unknown[] = [];
  return {
    asked,
    session: {
      request: async (request: unknown) => {
        asked.push(request);
        return result;
      },
    },
  };
};
const refused = (status: number, code: string, headers = new Headers()): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: null,
  details: {},
  headers,
});

const slow = (headers?: Headers) =>
  sendCheer(answering(refused(429, "too_many_attempts", headers)).session, "e1", "heart");
const asked = (result: AuthedResult) => sendCheer(answering(result).session, "e1", "star");

describe("sending a cheer (T-509)", () => {
  it("posts the reaction and answers sent", async () => {
    const fake = answering({
      kind: "ok",
      status: 201,
      body: { sent: true },
      headers: new Headers(),
    });
    expect(await sendCheer(fake.session, "e 1", "fire")).toEqual({ kind: "sent" });
    expect(fake.asked).toEqual([
      { method: "POST", path: "/v1/events/e%201/cheers", body: { reaction: "fire" } },
    ]);
  });

  it("reads the wait from a 429, with a default when it names none", async () => {
    expect(await slow(new Headers({ "retry-after": "7" }))).toEqual({ kind: "slow", seconds: 7 });
    expect(await slow(new Headers({ "retry-after": "2.2" }))).toEqual({ kind: "slow", seconds: 3 });
    expect(await slow()).toEqual({ kind: "slow", seconds: 10 });
    expect(await slow(new Headers({ "retry-after": "0" }))).toEqual({ kind: "slow", seconds: 10 });
  });

  it("says over when the moment is gone, and a lost connection for anything else", async () => {
    expect(await asked(refused(409, "cheers_not_live"))).toEqual({ kind: "over" });
    expect(await asked(refused(404, "not_found"))).toEqual({ kind: "over" });
    expect(await asked(refused(422, "invalid_cheer"))).toEqual({ kind: "network" });
    expect(await asked(refused(500, "internal"))).toEqual({ kind: "network" });
    expect(await asked({ kind: "network" })).toEqual({ kind: "network" });
    expect(await asked({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });

  it("counts a wait down to zero and a moment out by the phone's clock", () => {
    expect(secondsToWait(10_000, 7_500)).toBe(3);
    expect(secondsToWait(10_000, 10_000)).toBe(0);
    expect(secondsToWait(10_000, 99_000)).toBe(0);
    expect(momentIsOn("2030-01-01T10:00:00.000Z", Date.parse("2030-01-01T09:59:59.000Z"))).toBe(
      true,
    );
    expect(momentIsOn("2030-01-01T10:00:00.000Z", Date.parse("2030-01-01T10:00:00.000Z"))).toBe(
      false,
    );
  });
});

describe("the live state's cheers moment", () => {
  it("reads the end, and nothing for an older API or an unreadable moment", () => {
    const base = { polls: [], closed: [] };
    expect(
      liveStateOf({ ...base, cheers: { endsAt: "2030-01-01T10:00:00.000Z" } })?.cheers,
    ).toEqual({
      endsAt: "2030-01-01T10:00:00.000Z",
    });
    for (const cheers of [undefined, null, {}, { endsAt: "soon" }, { endsAt: 5 }, "now"]) {
      expect(liveStateOf({ ...base, cheers })?.cheers, String(cheers)).toBeNull();
    }
    expect(NOTHING_LIVE.cheers).toBeNull();
  });
});
