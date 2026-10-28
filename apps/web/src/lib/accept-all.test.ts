import { describe, expect, it } from "vitest";
import { ACCEPT_ALL_CALLS, acceptAllInCalls, type AcceptAllProgress } from "#src/lib/accept-all.ts";
import type { PostResult } from "#src/lib/post-json.ts";

/** A fake API answering the scripted results in order, counting the calls. */
function fakeApi(results: readonly PostResult[]) {
  const seen: AcceptAllProgress[] = [];
  let calls = 0;
  const post = () => {
    const result = results[calls] ?? { ok: true, body: { accepted: 0, remaining: 0 }, status: 200 };
    calls += 1;
    return Promise.resolve(result);
  };
  return {
    post,
    progress: (sofar: AcceptAllProgress) => seen.push(sofar),
    seen,
    calls: () => calls,
  };
}

const answer = (accepted: number, remaining: number): PostResult => ({
  ok: true,
  body: { accepted, remaining },
  status: 200,
});

describe("acceptAllInCalls (T-501d, the 1,000-a-call cap)", () => {
  it("calls again while a call accepted some and requests still wait, adding up the accepted", async () => {
    const api = fakeApi([answer(1000, 1500), answer(1000, 500), answer(500, 0)]);
    expect(await acceptAllInCalls(api.post, api.progress)).toEqual({
      kind: "done",
      accepted: 2500,
      remaining: 0,
    });
    expect(api.calls()).toBe(3);
    expect(api.seen).toEqual([
      { accepted: 1000, remaining: 1500 },
      { accepted: 2000, remaining: 500 },
      { accepted: 2500, remaining: 0 },
    ]);
  });

  it("stops after one call when it accepted nothing (no free place) or nothing waits", async () => {
    const full = fakeApi([answer(0, 40), answer(5, 0)]);
    expect(await acceptAllInCalls(full.post, full.progress)).toEqual({
      kind: "done",
      accepted: 0,
      remaining: 40,
    });
    expect(full.calls()).toBe(1);
    const small = fakeApi([answer(3, 0)]);
    expect(await acceptAllInCalls(small.post, small.progress)).toMatchObject({ accepted: 3 });
    expect(small.calls()).toBe(1);
  });

  it("makes at most 10 calls a press and reports what still waits", async () => {
    const api = fakeApi(Array.from({ length: 12 }, () => answer(1000, 50_000)));
    expect(await acceptAllInCalls(api.post, api.progress)).toEqual({
      kind: "done",
      accepted: 10_000,
      remaining: 50_000,
    });
    expect(api.calls()).toBe(ACCEPT_ALL_CALLS);
    expect(ACCEPT_ALL_CALLS).toBe(10);
  });

  it("keeps what earlier calls accepted when a call fails partway, with the failed call's answer", async () => {
    const refusal = { error: { code: "statement_timeout" } };
    const api = fakeApi([answer(1000, 900), { ok: false, body: refusal, status: 503 }]);
    expect(await acceptAllInCalls(api.post, api.progress)).toEqual({
      kind: "failed",
      accepted: 1000,
      body: refusal,
    });
    const first = fakeApi([{ ok: false, body: undefined, status: 0 }]);
    expect(await acceptAllInCalls(first.post, first.progress)).toEqual({
      kind: "failed",
      accepted: 0,
      body: undefined,
    });
    expect(first.seen).toEqual([]);
  });

  it("treats an answer that is not two counts as a failure", async () => {
    for (const body of [
      null,
      {},
      { accepted: -1, remaining: 0 },
      { accepted: 1.5, remaining: 0 },
      { accepted: 1 },
    ]) {
      const api = fakeApi([{ ok: true, body, status: 200 }]);
      expect((await acceptAllInCalls(api.post, api.progress)).kind, JSON.stringify(body)).toBe(
        "failed",
      );
    }
  });
});
