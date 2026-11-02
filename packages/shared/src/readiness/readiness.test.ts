import { describe, expect, it } from "vitest";
import {
  READINESS_KEYS,
  READINESS_LINES,
  evaluateReadiness,
  readinessFactsSchema,
  readinessItemSchema,
  readinessSchema,
  type ReadinessFacts,
  type ReadinessLine,
} from "./readiness";

/** An event with everything in place and nothing that needs an extra item. */
const READY: ReadinessFacts = {
  status: "draft",
  dates: "set",
  activation: "active",
  quests: { total: 4, playable: 3, operatorOnly: 0, deviceOnly: 0, deviceUnserved: 0 },
  rewards: { active: 2, inStock: 2, items: 0, experiences: 0 },
  shop: true,
  desk: { place: false },
  operators: 0,
  devices: { stations: 0, kiosks: 0, bigScreens: 0 },
  join: { access: "public", guestListOnly: false, guests: 0 },
  rules: true,
  bigScreen: false,
  rehearsed: true,
  branding: true,
  setup: { decided: 10, finished: true },
};

const lineOf = (facts: ReadinessFacts, key: string) =>
  evaluateReadiness(facts).items.find((entry) => entry.key === key);

describe("the readiness checklist", () => {
  it("lists only the items that apply, all done for a complete event", () => {
    const { items, counts } = evaluateReadiness(READY);
    expect(items.map((entry) => entry.key)).toEqual([
      "dates",
      "activation",
      "quests",
      "rewards",
      "join",
      "rules",
      "rehearsal",
      "branding",
      "setup",
    ]);
    expect(counts).toEqual({ done: 9, warning: 0, blocking: 0 });
  });

  it("lists the items in the order of READINESS_KEYS and every line under its own item", () => {
    const everything: ReadinessFacts = {
      ...READY,
      quests: { total: 4, playable: 3, operatorOnly: 1, deviceOnly: 1, deviceUnserved: 0 },
      rewards: { active: 2, inStock: 2, items: 1, experiences: 0 },
      desk: { place: true },
      operators: 2,
      devices: { stations: 1, kiosks: 1, bigScreens: 1 },
      bigScreen: true,
    };
    const { items } = evaluateReadiness(everything);
    expect(items.map((entry) => entry.key)).toEqual(READINESS_KEYS);
    for (const entry of items) {
      expect(entry.line.startsWith(`${entry.key}.`)).toBe(true);
    }
  });

  it("shows a missing rehearsal as missing, a warning, and never blocks", () => {
    const entry = lineOf({ ...READY, rehearsed: false }, "rehearsal");
    expect(entry).toEqual({
      key: "rehearsal",
      line: "rehearsal.missing",
      status: "warning",
      count: 0,
    });
    expect(evaluateReadiness({ ...READY, rehearsed: false }).counts.blocking).toBe(0);
  });

  it("leaves the rehearsal out once the event has gone live without one", () => {
    expect(lineOf({ ...READY, rehearsed: false, status: "live" }, "rehearsal")).toBeUndefined();
    expect(lineOf({ ...READY, rehearsed: true, status: "live" }, "rehearsal")?.status).toBe("done");
  });

  it("blocks on missing or past dates, and on an activation that was not asked for or was declined", () => {
    expect(lineOf({ ...READY, dates: "missing" }, "dates")?.status).toBe("blocking");
    expect(lineOf({ ...READY, dates: "past" }, "dates")?.line).toBe("dates.past");
    expect(lineOf({ ...READY, activation: "none" }, "activation")?.status).toBe("blocking");
    expect(lineOf({ ...READY, activation: "rejected" }, "activation")?.status).toBe("blocking");
    expect(lineOf({ ...READY, activation: "pending" }, "activation")?.status).toBe("warning");
  });

  it("blocks on no quests or none that can be played, and counts what can", () => {
    expect(
      lineOf({ ...READY, quests: { ...READY.quests, total: 0, playable: 0 } }, "quests"),
    ).toMatchObject({
      line: "quests.none",
      status: "blocking",
    });
    expect(
      lineOf({ ...READY, quests: { ...READY.quests, total: 5, playable: 0 } }, "quests"),
    ).toMatchObject({
      line: "quests.unplayable",
      status: "blocking",
      count: 5,
    });
    expect(lineOf(READY, "quests")).toMatchObject({
      line: "quests.ready",
      status: "done",
      count: 3,
    });
  });

  it("warns about no rewards and sold-out rewards, and counts those in stock", () => {
    expect(
      lineOf({ ...READY, rewards: { ...READY.rewards, active: 0, inStock: 0 } }, "rewards")?.line,
    ).toBe("rewards.none");
    expect(
      lineOf({ ...READY, rewards: { ...READY.rewards, active: 3, inStock: 0 } }, "rewards"),
    ).toMatchObject({
      line: "rewards.soldOut",
      status: "warning",
      count: 3,
    });
    expect(lineOf(READY, "rewards")).toMatchObject({ line: "rewards.ready", count: 2 });
  });

  it("needs a prize desk place for an item reward (blocking) and for an experience (a warning), nothing for digital", () => {
    const withItem = { ...READY, rewards: { active: 1, inStock: 1, items: 1, experiences: 0 } };
    expect(lineOf(withItem, "desk")).toMatchObject({ line: "desk.missing", status: "blocking" });
    expect(lineOf({ ...withItem, desk: { place: true } }, "desk")).toMatchObject({
      line: "desk.set",
      status: "done",
    });
    const withExperience = {
      ...READY,
      rewards: { active: 1, inStock: 1, items: 0, experiences: 1 },
    };
    expect(lineOf(withExperience, "desk")).toMatchObject({
      line: "desk.missing",
      status: "warning",
    });
    expect(lineOf(READY, "desk")).toBeUndefined();
  });

  it("asks for operators only where one would work: a station quest or device, or a prize to hand over", () => {
    expect(lineOf(READY, "operators")).toBeUndefined();
    const station = { ...READY, quests: { ...READY.quests, operatorOnly: 1 } };
    expect(lineOf(station, "operators")).toMatchObject({
      line: "operators.none",
      status: "blocking",
    });
    expect(lineOf({ ...station, operators: 1 }, "operators")).toMatchObject({
      line: "operators.one",
      status: "warning",
      count: 1,
    });
    expect(lineOf({ ...station, operators: 2 }, "operators")).toMatchObject({
      line: "operators.ready",
      status: "done",
      count: 2,
    });
    const device = { ...READY, devices: { stations: 1, kiosks: 0, bigScreens: 0 } };
    expect(lineOf(device, "operators")).toMatchObject({
      line: "operators.none",
      status: "warning",
    });
    const prize = { ...READY, rewards: { active: 1, inStock: 1, items: 0, experiences: 1 } };
    expect(lineOf(prize, "operators")?.line).toBe("operators.none");
  });

  it("blocks a guest list nobody is on and says how the others join", () => {
    expect(
      lineOf({ ...READY, join: { access: "private", guestListOnly: true, guests: 0 } }, "join"),
    ).toMatchObject({
      line: "join.emptyGuests",
      status: "blocking",
    });
    expect(
      lineOf({ ...READY, join: { access: "public", guestListOnly: true, guests: 12 } }, "join"),
    ).toMatchObject({
      line: "join.guestList",
      count: 12,
    });
    expect(
      lineOf({ ...READY, join: { access: "private", guestListOnly: false, guests: 0 } }, "join")
        ?.line,
    ).toBe("join.private");
    expect(
      lineOf({ ...READY, join: { access: "unlisted", guestListOnly: false, guests: 0 } }, "join")
        ?.line,
    ).toBe("join.open");
  });

  it("warns about missing rules text and the default look", () => {
    expect(lineOf({ ...READY, rules: false }, "rules")).toMatchObject({
      line: "rules.missing",
      status: "warning",
    });
    expect(lineOf({ ...READY, branding: false }, "branding")).toMatchObject({
      line: "branding.default",
      status: "warning",
    });
  });

  it("asks for a paired screen only while the big screen add-on is on", () => {
    expect(lineOf(READY, "bigScreen")).toBeUndefined();
    expect(lineOf({ ...READY, bigScreen: true }, "bigScreen")?.line).toBe("bigScreen.unpaired");
    expect(
      lineOf(
        { ...READY, bigScreen: true, devices: { stations: 0, kiosks: 0, bigScreens: 2 } },
        "bigScreen",
      ),
    ).toMatchObject({ line: "bigScreen.paired", status: "done", count: 2 });
  });

  it("asks for a device only when a quest cannot be finished without one, and clears it when each has its own", () => {
    expect(lineOf(READY, "devices")).toBeUndefined();
    const needs = {
      ...READY,
      quests: { ...READY.quests, deviceOnly: 2, deviceUnserved: 2 },
      devices: { stations: 0, kiosks: 0, bigScreens: 1 },
    };
    expect(lineOf(needs, "devices")).toMatchObject({
      line: "devices.none",
      status: "warning",
      count: 2,
    });
    expect(
      lineOf(
        {
          ...needs,
          quests: { ...needs.quests, deviceUnserved: 1 },
          devices: { stations: 1, kiosks: 0, bigScreens: 1 },
        },
        "devices",
      ),
    ).toMatchObject({ line: "devices.none", count: 1 });
    expect(
      lineOf(
        {
          ...needs,
          quests: { ...needs.quests, deviceUnserved: 0 },
          devices: { stations: 1, kiosks: 1, bigScreens: 1 },
        },
        "devices",
      ),
    ).toMatchObject({ line: "devices.paired", status: "done", count: 2 });
  });

  it("leaves the shop's items out while the shop is off, and its prizes ask for no operator", () => {
    const prizes = {
      ...READY,
      rewards: { active: 2, inStock: 0, items: 1, experiences: 1 },
    };
    expect(lineOf(prizes, "rewards")?.line).toBe("rewards.soldOut");
    expect(lineOf(prizes, "desk")?.line).toBe("desk.missing");
    expect(lineOf(prizes, "operators")?.line).toBe("operators.none");
    const closed = { ...prizes, shop: false };
    expect(lineOf(closed, "rewards")).toBeUndefined();
    expect(lineOf(closed, "desk")).toBeUndefined();
    expect(lineOf(closed, "operators")).toBeUndefined();
    expect(evaluateReadiness(closed).items.map((entry) => entry.key)).not.toContain("desk");
  });

  it("reads the guided setup as finished, partly decided or not started, never worse than a warning", () => {
    expect(lineOf({ ...READY, setup: { decided: 3, finished: false } }, "setup")).toMatchObject({
      line: "setup.partial",
      status: "warning",
      count: 3,
    });
    expect(lineOf({ ...READY, setup: { decided: 0, finished: false } }, "setup")?.line).toBe(
      "setup.notStarted",
    );
    expect(lineOf(READY, "setup")?.line).toBe("setup.finished");
  });

  it("counts the statuses and carries the event's status", () => {
    const worst: ReadinessFacts = {
      ...READY,
      status: "scheduled",
      dates: "missing",
      activation: "pending",
      rehearsed: false,
    };
    const result = evaluateReadiness(worst);
    expect(result.status).toBe("scheduled");
    expect(result.counts).toEqual({ done: 6, warning: 2, blocking: 1 });
    expect(readinessSchema.safeParse(result).success).toBe(true);
  });
});

describe("the readiness shapes", () => {
  it("has a line for every item and no line without one", () => {
    const keys = new Set(READINESS_KEYS);
    for (const key of READINESS_KEYS) {
      expect(
        READINESS_LINES.some((line) => line.startsWith(`${key}.`)),
        key,
      ).toBe(true);
    }
    for (const line of READINESS_LINES) {
      expect(keys.has(line.slice(0, line.indexOf(".")) as never), line).toBe(true);
    }
  });

  it("refuses a line that belongs to another item, a negative count and an extra field", () => {
    const good = { key: "dates", line: "dates.set" as ReadinessLine, status: "done", count: 0 };
    expect(readinessItemSchema.safeParse(good).success).toBe(true);
    expect(readinessItemSchema.safeParse({ ...good, line: "quests.ready" }).success).toBe(false);
    expect(readinessItemSchema.safeParse({ ...good, count: -1 }).success).toBe(false);
    expect(readinessItemSchema.safeParse({ ...good, name: "x" }).success).toBe(false);
  });

  it("accepts the database's facts and refuses anything it does not know", () => {
    expect(readinessFactsSchema.safeParse(READY).success).toBe(true);
    expect(readinessFactsSchema.safeParse({ ...READY, extra: 1 }).success).toBe(false);
    expect(readinessFactsSchema.safeParse({ ...READY, activation: "approved" }).success).toBe(
      false,
    );
    expect(readinessFactsSchema.safeParse({ ...READY, operators: -1 }).success).toBe(false);
  });
});
