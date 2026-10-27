import { describe, expect, it, vi } from "vitest";
import type { ApiResult } from "#src/api/client.ts";
import { fetchPublicPage, listedEvents, retryCursor } from "#src/explore/public-events.ts";

const event = (id: string) => ({ id, joinCode: id.toUpperCase(), name: { ar: null, en: id } });
const ok = (body: unknown): ApiResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const clientAnswering = (...answers: ApiResult[]) => {
  const request = vi.fn();
  for (const answer of answers) request.mockResolvedValueOnce(answer);
  return { request };
};

describe("fetchPublicPage", () => {
  it("reads the first page without a cursor and the next one with its cursor encoded", async () => {
    const client = clientAnswering(
      ok({ events: [event("a")], nextCursor: "c/1" }),
      ok({ events: [event("b")], nextCursor: "" }),
    );
    await expect(fetchPublicPage(client, null)).resolves.toEqual({
      kind: "page",
      events: [event("a")],
      next: "c/1",
    });
    await expect(fetchPublicPage(client, "c/1")).resolves.toEqual({
      kind: "page",
      events: [event("b")],
      next: null,
    });
    expect(client.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/v1/public/events",
    });
    expect(client.request).toHaveBeenNthCalledWith(2, {
      method: "GET",
      path: "/v1/public/events?cursor=c%2F1",
    });
  });

  it("answers failed for a network error, an error answer and a body that is not an object", async () => {
    const refused: ApiResult = {
      kind: "error",
      status: 500,
      code: "internal",
      message: null,
      details: {},
      headers: new Headers(),
    };
    for (const answer of [{ kind: "network" } as const, refused, ok(null), ok("text")]) {
      await expect(fetchPublicPage(clientAnswering(answer), null)).resolves.toEqual({
        kind: "failed",
      });
    }
  });
});

describe("a failed later page", () => {
  it("is retried from the cursor of the last good page, then the list carries on", async () => {
    const client = clientAnswering(
      ok({ events: [event("a")], nextCursor: "c1" }),
      { kind: "network" },
      ok({ events: [event("b")], nextCursor: null }),
    );
    const first = await fetchPublicPage(client, null);
    if (first.kind !== "page") throw new Error("the first page should load");
    expect(await fetchPublicPage(client, first.next)).toEqual({ kind: "failed" });
    const cursor = retryCursor(first.events, first.next);
    expect(cursor).toBe("c1");
    expect(await fetchPublicPage(client, cursor)).toMatchObject({
      kind: "page",
      events: [event("b")],
    });
    expect(client.request).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/v1/public/events?cursor=c1",
    });
  });

  it("is a first-page retry while nothing has loaded", () => {
    expect(retryCursor(undefined, null)).toBeNull();
    expect(retryCursor([], null)).toBeNull();
  });
});

describe("listedEvents", () => {
  it("keeps entries with an id, a join code and a name, and drops the rest", () => {
    expect(listedEvents([event("a"), { id: 1 }, null, { ...event("b"), name: "x" }])).toEqual([
      event("a"),
    ]);
    expect(listedEvents("nope")).toEqual([]);
  });
});
