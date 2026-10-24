import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchLiveCode, liveCodeLifeMs, nextLiveFetchMs } from "#src/event/live-code.ts";

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
const error = (code: string, headers = new Headers()): AuthedResult => ({
  kind: "error",
  status: 400,
  code,
  message: null,
  details: {},
  headers,
});

describe("the live code (T-309b)", () => {
  it("reads the code and when it changes", async () => {
    const fake = answering({
      kind: "ok",
      status: 200,
      body: { code: "A".repeat(50), changesInMs: 12_000 },
      headers: new Headers(),
    });
    expect(await fetchLiveCode(fake.session)).toEqual({
      kind: "code",
      code: "A".repeat(50),
      changesInMs: 12_000,
    });
    expect(fake.asked).toEqual([{ method: "GET", path: "/v1/me/live-code" }]);
  });

  it("says when kiosks are off, how long to wait after a 429, and anything else is a lost connection", async () => {
    expect(await fetchLiveCode(answering(error("feature_off")).session)).toEqual({ kind: "off" });
    expect(
      await fetchLiveCode(
        answering(error("too_many_attempts", new Headers({ "retry-after": "7" }))).session,
      ),
    ).toEqual({ kind: "slowed", waitMs: 7000 });
    expect(await fetchLiveCode(answering(error("too_many_attempts")).session)).toEqual({
      kind: "slowed",
      waitMs: 10_000,
    });
    expect(await fetchLiveCode(answering(error("busy")).session)).toEqual({ kind: "network" });
    expect(await fetchLiveCode(answering({ kind: "network" }).session)).toEqual({
      kind: "network",
    });
    expect(await fetchLiveCode(answering({ kind: "signed_out" }).session)).toEqual({
      kind: "signed_out",
    });
    expect(
      await fetchLiveCode(
        answering({ kind: "ok", status: 200, body: { code: 1 }, headers: new Headers() }).session,
      ),
    ).toEqual({ kind: "network" });
  });

  it("fetches again when the code changes plus up to a second, and drops it 15 s after", () => {
    expect(nextLiveFetchMs(12_000, 0)).toBe(12_000);
    expect(nextLiveFetchMs(12_000, 1)).toBe(13_000);
    expect(nextLiveFetchMs(-5, 2)).toBe(1000);
    expect(liveCodeLifeMs(12_000)).toBe(27_000);
    expect(liveCodeLifeMs(-1)).toBe(15_000);
  });
});
