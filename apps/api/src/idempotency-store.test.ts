import { describe, expect, it } from "vitest";
import { MemoryIdempotencyStore } from "#src/idempotency-store";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A finished answer for one key. */
const started = async (store: MemoryIdempotencyStore, scope: string, key = "k") => {
  await store.begin(scope, key, "h");
  await store.finish(scope, key, 201, '{"ok":true}', "application/json");
};

/** The in-memory idempotency store: first answer kept 24 hours, a retry replays it, a principal's answers forgotten. */
describe("MemoryIdempotencyStore", () => {
  it("answers new, then in progress, then the finished answer for the same request", async () => {
    const store = new MemoryIdempotencyStore();
    expect(await store.begin("player:a", "k", "h")).toEqual({ kind: "new" });
    expect(await store.begin("player:a", "k", "h")).toEqual({ kind: "in_progress" });
    await store.finish("player:a", "k", 201, '{"ok":true}', "application/json");
    expect(await store.begin("player:a", "k", "h")).toEqual({
      kind: "replay",
      status: 201,
      payload: '{"ok":true}',
      contentType: "application/json",
    });
    expect(await store.begin("player:a", "k", "other")).toEqual({ kind: "mismatch" });
  });

  it("ignores a finish for a key never begun, and forgets an aborted one", async () => {
    const store = new MemoryIdempotencyStore();
    await expect(store.finish("player:a", "k", 200, "{}", "application/json")).resolves.toBe(
      undefined,
    );
    expect(await store.begin("player:a", "k", "h")).toEqual({ kind: "new" });
    await store.abort("player:a", "k");
    expect(await store.begin("player:a", "k", "h")).toEqual({ kind: "new" });
  });

  it("starts over after 24 hours", async () => {
    let now = 0;
    const store = new MemoryIdempotencyStore(() => now);
    await started(store, "player:a");
    now = DAY_MS - 1;
    expect(await store.begin("player:a", "k", "h")).toMatchObject({ kind: "replay" });
    now = DAY_MS;
    expect(await store.begin("player:a", "k", "h")).toEqual({ kind: "new" });
  });

  it("forgets every answer of one scope and only that scope's", async () => {
    const store = new MemoryIdempotencyStore();
    await started(store, "player:a", "k1");
    await started(store, "player:a", "k2");
    await started(store, "player:ab");
    await started(store, "staff:a");
    await store.forget("player:a");
    expect(await store.begin("player:a", "k1", "h")).toEqual({ kind: "new" });
    expect(await store.begin("player:a", "k2", "h")).toEqual({ kind: "new" });
    expect(await store.begin("player:ab", "k", "h")).toMatchObject({ kind: "replay" });
    expect(await store.begin("staff:a", "k", "h")).toMatchObject({ kind: "replay" });
  });
});
