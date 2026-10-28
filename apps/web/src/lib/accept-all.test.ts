import { describe, expect, it } from "vitest";
import { ACCEPT_ALL_CALLS, acceptAllInCalls, type AcceptAllProgress } from "#src/lib/accept-all.ts";
import type { PostResult } from "#src/lib/post-json.ts";

/** A fake API answering the scripted results in order, counting the calls; `leaveAfter` leaves the page then. */
function fakeApi(results: readonly PostResult[], leaveAfter = Number.POSITIVE_INFINITY) {
  const seen: AcceptAllProgress[] = [];
  let calls = 0;
  const post = () => {
    const result = results[calls] ?? {
      ok: true,
      body: { accepted: 0, remaining: 0 },
      status: 200,
    };
    calls += 1;
    return Promise.resolve(result);
  };
  return {
    deps: {
      post,
      progress: (sofar: AcceptAllProgress) => seen.push(sofar),
      stopped: () => calls >= leaveAfter,
    },
    seen,
    calls: () => calls,
  };
}

const answer = (accepted: number, remaining: number): PostResult => ({
  ok: true,
  body: { accepted, remaining },
  status: 200,
});

describe("acceptAllInCalls (T-501d, the cap per call)", () => {
  it("calls again while a call accepted some and requests still wait, adding up the accepted", async () => {
    const api = fakeApi([answer(1000, 1500), answer(1000, 500), answer(500, 0)]);
    expect(await acceptAllInCalls(api.deps)).toEqual({
      kind: "done",
      accepted: 2500,
      remaining: 0,
      more: false,
    });
    expect(api.calls()).toBe(3);
    expect(api.seen).toEqual([
      { accepted: 1000, remaining: 1500 },
      { accepted: 2000, remaining: 500 },
      { accepted: 2500, remaining: 0 },
    ]);
  });

  it("stops after one call when it accepted nothing (no free place) or nothing waits, with nothing more to press for", async () => {
    const full = fakeApi([answer(0, 40), answer(5, 0)]);
    expect(await acceptAllInCalls(full.deps)).toEqual({
      kind: "done",
      accepted: 0,
      remaining: 40,
      more: false,
    });
    expect(full.calls()).toBe(1);
    const small = fakeApi([answer(3, 0)]);
    expect(await acceptAllInCalls(small.deps)).toMatchObject({ accepted: 3, more: false });
    expect(small.calls()).toBe(1);
  });

  it("makes at most 10 calls a press and says requests still wait for another press", async () => {
    const api = fakeApi(Array.from({ length: 12 }, () => answer(250, 2000)));
    expect(await acceptAllInCalls(api.deps)).toEqual({
      kind: "done",
      accepted: 2500,
      remaining: 2000,
      more: true,
    });
    expect(api.calls()).toBe(ACCEPT_ALL_CALLS);
    expect(ACCEPT_ALL_CALLS).toBe(10);
  });

  it("keeps what earlier calls accepted when a call fails partway, with the failed call's answer", async () => {
    const refusal = { error: { code: "statement_timeout" } };
    const api = fakeApi([answer(1000, 900), { ok: false, body: refusal, status: 503 }]);
    expect(await acceptAllInCalls(api.deps)).toEqual({
      kind: "failed",
      accepted: 1000,
      body: refusal,
    });
    const first = fakeApi([{ ok: false, body: undefined, status: 0 }]);
    expect(await acceptAllInCalls(first.deps)).toEqual({
      kind: "failed",
      accepted: 0,
      body: undefined,
    });
    expect(first.seen).toEqual([]);
  });

  it("makes no further call and tells nothing once the page is left", async () => {
    const left = fakeApi([answer(250, 2000), answer(250, 1750), answer(250, 1500)], 2);
    expect(await acceptAllInCalls(left.deps)).toEqual({ kind: "stopped", accepted: 250 });
    expect(left.calls()).toBe(2);
    expect(left.seen).toEqual([{ accepted: 250, remaining: 2000 }]);
    const before = fakeApi([answer(250, 2000)], 0);
    expect(await acceptAllInCalls(before.deps)).toEqual({ kind: "stopped", accepted: 0 });
    expect(before.calls()).toBe(0);
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
      expect((await acceptAllInCalls(api.deps)).kind, JSON.stringify(body)).toBe("failed");
    }
  });
});
