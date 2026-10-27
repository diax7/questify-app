import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { RECENT_KEY, type KeyValueStore } from "#src/event/launch.ts";
import { loadInvitations, loadMyEvents } from "#src/home/home-reads.ts";

const ok = (body: unknown): AuthedResult => ({
  kind: "ok",
  status: 200,
  body,
  headers: new Headers(),
});
const sessionAnswering = (...answers: AuthedResult[]) => {
  const request = vi.fn();
  for (const answer of answers) request.mockResolvedValueOnce(answer);
  return { request };
};
const storeHolding = (value: string | null): KeyValueStore => ({
  getItem: async () => value,
  setItem: async () => undefined,
  removeItem: async () => undefined,
});
const event = (id: string) => ({
  id,
  joinCode: id.toUpperCase(),
  name: { ar: null, en: id },
  statusNow: "live",
  status: "active",
});

describe("loadMyEvents", () => {
  it("returns the events and the one opened most recently on this phone", async () => {
    const store = storeHolding(JSON.stringify({ a: 5, b: 9 }));
    const read = await loadMyEvents(
      sessionAnswering(ok({ events: [event("a"), event("b")] })),
      store,
    );
    expect(read?.events.map((one) => one.id)).toEqual(["a", "b"]);
    expect(read?.latest).toBe("b");
    expect(RECENT_KEY).toBe("questify.recentEvents");
  });

  it("returns no latest event when none was opened here", async () => {
    const read = await loadMyEvents(
      sessionAnswering(ok({ events: [event("a")] })),
      storeHolding(null),
    );
    expect(read?.latest).toBeUndefined();
  });

  it("returns an empty list as empty, and a failed or odd read as null", async () => {
    const store = storeHolding(null);
    expect((await loadMyEvents(sessionAnswering(ok({ events: [] })), store))?.events).toEqual([]);
    for (const answer of [{ kind: "network" } as const, { kind: "signed_out" } as const, ok({})]) {
      await expect(loadMyEvents(sessionAnswering(answer), store)).resolves.toBeNull();
    }
  });

  it("reads again on every call, so a later read shows a changed list", async () => {
    const session = sessionAnswering(
      ok({ events: [event("a")] }),
      ok({ events: [event("a"), event("b")] }),
    );
    const store = storeHolding(null);
    expect((await loadMyEvents(session, store))?.events).toHaveLength(1);
    expect((await loadMyEvents(session, store))?.events).toHaveLength(2);
    expect(session.request).toHaveBeenCalledTimes(2);
  });
});

describe("loadInvitations", () => {
  it("returns null when the invitations cannot be read", async () => {
    await expect(loadInvitations(sessionAnswering({ kind: "network" }))).resolves.toBeNull();
    await expect(loadInvitations(sessionAnswering({ kind: "signed_out" }))).resolves.toBeNull();
  });
});
