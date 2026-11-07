import { describe, expect, it } from "vitest";
import {
  INTRO_KEY,
  firstStop,
  introDue,
  readIntroState,
  writeIntroState,
  type IntroStore,
} from "#src/onboarding/intro-state.ts";

function memoryStore(initial?: string): IntroStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  if (initial !== undefined) {
    values.set(INTRO_KEY, initial);
  }
  return {
    values,
    getItem: (key) => Promise.resolve(values.get(key) ?? null),
    setItem: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
  };
}

const brokenStore: IntroStore = {
  getItem: () => Promise.reject(new Error("storage unreadable")),
  setItem: () => Promise.reject(new Error("storage full")),
};

describe("the intro's stored step", () => {
  it("is fresh on a new install, and the intro is due", async () => {
    const state = await readIntroState(memoryStore());
    expect(state).toBe("fresh");
    expect(introDue(state)).toBe(true);
  });

  it("is due again after the language step, so the cards follow the restart", async () => {
    const state = await readIntroState(memoryStore("language"));
    expect(state).toBe("language");
    expect(introDue(state)).toBe(true);
  });

  it("is not due once seen", async () => {
    const state = await readIntroState(memoryStore("seen"));
    expect(state).toBe("seen");
    expect(introDue(state)).toBe(false);
  });

  it("treats a value this version does not know as fresh", async () => {
    expect(await readIntroState(memoryStore("3"))).toBe("fresh");
    expect(await readIntroState(memoryStore(""))).toBe("fresh");
  });

  it("never traps a player in the intro when the store cannot be read", async () => {
    const state = await readIntroState(brokenStore);
    expect(introDue(state)).toBe(false);
  });

  it("stores only the step, under one key", async () => {
    const store = memoryStore();
    await writeIntroState(store, "language");
    await writeIntroState(store, "seen");
    expect([...store.values.entries()]).toEqual([[INTRO_KEY, "seen"]]);
  });

  it("does not fail the player when the step cannot be saved", async () => {
    await expect(writeIntroState(brokenStore, "seen")).resolves.toBeUndefined();
  });
});

describe("the first stop of a launch", () => {
  it("is the intro before anything else, signed in or not", () => {
    expect(firstStop("fresh", true)).toBe("intro");
    expect(firstStop("fresh", false)).toBe("intro");
    expect(firstStop("language", true)).toBe("intro");
  });

  it("is Questify home when signed out, and the player's events when signed in, once the intro is seen", () => {
    expect(firstStop("seen", true)).toBe("home");
    expect(firstStop("seen", false)).toBe("events");
  });
});
