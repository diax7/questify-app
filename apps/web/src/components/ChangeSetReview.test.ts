import { afterEach, describe, expect, it, vi } from "vitest";
import { sendReviewCall } from "#src/components/ChangeSetReview.tsx";
import { APPLY_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS } from "#src/lib/post-json.ts";
import { createRequestKeys } from "#src/lib/use-request-key.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SET_A = "/v1/organizers/o1/events/e1/change-sets/a";
const SET_B = "/v1/organizers/o1/events/e1/change-sets/b";

/** Stubs fetch with these statuses in order and lists each call's path and key. */
function answers(...statuses: number[]): { path: string; key: string }[] {
  const sent: { path: string; key: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init: RequestInit) => {
      sent.push({ path, key: new Headers(init.headers).get("idempotency-key") ?? "" });
      return new Response("{}", { status: statuses.shift() ?? 500 });
    }),
  );
  return sent;
}

describe("sendReviewCall", () => {
  it("sends each call to its own path with its own key slot", async () => {
    const sent = answers(502, 200, 200);
    const keys = createRequestKeys(["apply", "close"]);
    await sendReviewCall(keys, SET_A, "apply", { itemIds: ["i1"] });
    await sendReviewCall(keys, SET_A, "close", {});
    await sendReviewCall(keys, SET_A, "apply", { itemIds: ["i1"] });
    expect(sent.map((call) => call.path)).toEqual([
      `${SET_A}/apply`,
      `${SET_A}/close`,
      `${SET_A}/apply`,
    ]);
    expect(sent[2]?.key).toBe(sent[0]?.key);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
  });

  it("takes a new key when the same call goes to another set", async () => {
    const sent = answers(502, 502, 502);
    const keys = createRequestKeys(["apply", "close"]);
    await sendReviewCall(keys, SET_A, "close", {});
    await sendReviewCall(keys, SET_B, "close", {});
    await sendReviewCall(keys, SET_B, "close", {});
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
    expect(sent[2]?.key).toBe(sent[1]?.key);
  });

  it("gives an apply the apply timeout and a close the default", async () => {
    answers(200, 200);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const keys = createRequestKeys(["apply", "close"]);
    await sendReviewCall(keys, SET_A, "apply", { itemIds: ["i1"] });
    expect(timer.mock.lastCall?.[1]).toBe(APPLY_REQUEST_TIMEOUT_MS);
    await sendReviewCall(keys, SET_A, "close", {});
    expect(timer.mock.lastCall?.[1]).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });
});
