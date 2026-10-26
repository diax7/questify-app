import { describe, expect, it } from "vitest";
import type { OwnEvent } from "@questify/shared";
import { appendPage, createSingleFlight } from "#src/questify/event-pages.ts";

const row = (eventId: string) => ({ eventId }) as OwnEvent;
const ids = (rows: readonly OwnEvent[]) => rows.map((event) => event.eventId);

describe("appendPage", () => {
  it("adds a page after the rows already shown", () => {
    expect(ids(appendPage([row("a")], [row("b"), row("c")]))).toEqual(["a", "b", "c"]);
  });

  it("drops an event that is already shown, so a repeated page adds nothing", () => {
    const shown = appendPage([row("a")], [row("b")]);
    expect(ids(appendPage(shown, [row("b")]))).toEqual(["a", "b"]);
  });

  it("keeps the order of the new events and ignores an empty page", () => {
    expect(ids(appendPage([row("a")], [row("c"), row("a"), row("b")]))).toEqual(["a", "c", "b"]);
    expect(ids(appendPage([row("a")], []))).toEqual(["a"]);
  });
});

/** A piece of work the test finishes by hand. */
function slowWork() {
  const state = { calls: 0, finish: () => {} };
  const work = () =>
    new Promise<void>((resolve) => {
      state.calls += 1;
      state.finish = resolve;
    });
  return { state, work };
}

describe("createSingleFlight", () => {
  it("ignores a second tap while the first page is loading", async () => {
    const flight = createSingleFlight();
    const { state, work } = slowWork();
    const first = flight(work);
    await flight(work);
    expect(state.calls).toBe(1);
    state.finish();
    await first;
    const again = flight(work);
    expect(state.calls).toBe(2);
    state.finish();
    await again;
  });

  it("lets the next tap through after a load that threw", async () => {
    const flight = createSingleFlight();
    await expect(
      flight(() => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    let ran = false;
    await flight(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
