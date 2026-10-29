import { describe, expect, it } from "vitest";
import { createSceneReader, SCENE_CACHE_MS } from "#src/screen/scenes";
import { fakePool, pgError } from "#test/support/fake-pool";

const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const device = { id: id(1), eventId: id(5) };
const elsewhere = { id: id(3), eventId: id(6) };

describe("the scene reader", () => {
  it("calls the scene's own door and shares one answer per event and scene for two seconds", async () => {
    let clock = 1_000;
    const { pool, queries } = fakePool((sql) => ({ rows: [{ answer: { sql } }] }));
    const reader = createSceneReader({ pool }, () => clock);
    const first = await reader.read(device, "ranking");
    expect(first).toEqual({ sql: "SELECT screen_ranking() AS answer" });
    expect(await reader.read({ id: id(2), eventId: id(5) }, "ranking")).toBe(first);
    expect(queries).toHaveLength(1);
    await reader.read(device, "community");
    await reader.read(device, "poll");
    await reader.read(elsewhere, "ranking");
    expect(queries).toEqual([
      "SELECT screen_ranking() AS answer",
      "SELECT screen_community() AS answer",
      "SELECT screen_poll() AS answer",
      "SELECT screen_ranking() AS answer",
    ]);
    clock += SCENE_CACHE_MS - 1;
    await reader.read(device, "ranking");
    expect(queries).toHaveLength(4);
    clock += 1;
    await reader.read(device, "ranking");
    expect(queries).toHaveLength(5);
  });

  it("shares a read in flight among concurrent screens", async () => {
    const { pool, queries } = fakePool(() => ({ rows: [{ answer: { shut: null } }] }));
    const reader = createSceneReader({ pool });
    const answers = await Promise.all([
      reader.read(device, "poll"),
      reader.read({ id: id(2), eventId: id(5) }, "poll"),
      reader.read({ id: id(3), eventId: id(5) }, "poll"),
    ]);
    expect(answers[1]).toBe(answers[0]);
    expect(queries).toHaveLength(1);
  });

  it("forgets a failed read at once and answers the database's refusal as its HTTP error", async () => {
    let failing = true;
    const { pool, queries } = fakePool(() => {
      if (failing) {
        throw pgError({ code: "DV401" });
      }
      return { rows: [{ answer: { shut: null } }] };
    });
    const reader = createSceneReader({ pool });
    await expect(reader.read(device, "ranking")).rejects.toMatchObject({
      status: 401,
      envelope: { code: "device_unpaired" },
    });
    failing = false;
    expect(await reader.read(device, "ranking")).toEqual({ shut: null });
    expect(queries).toHaveLength(2);
  });
});
