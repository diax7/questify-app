import { describe, expect, it } from "vitest";
import { FEATURES } from "#src/config/registry";
import { playerTabs } from "#src/event/player-view";
import {
  BAR_KEYS,
  BAR_PROTECTED,
  DEFAULT_COMPOSED_LAYOUT,
  DEFAULT_LAYOUT,
  HOME_BLOCKS,
  HOME_KEYS,
  HOME_PROTECTED,
  barScreenOrder,
  composedLayoutOf,
  homeBlocks,
  readComposedLayout,
  readEventLayout,
  sameLayout,
} from "#src/layout/layout";

describe("the default layout", () => {
  it("keeps the bar and Home in the order the app has always drawn", () => {
    expect(DEFAULT_LAYOUT.bar.order).toEqual(["index", "quests", "scan", "rewards", "profile"]);
    expect(HOME_KEYS.join()).toBe(
      "countdown,standing,streak,announcements,sponsors,prizes,live,goal,ranking,upNext,links",
    );
    expect(DEFAULT_LAYOUT.bar.hidden).toEqual([]);
    expect(DEFAULT_LAYOUT.home.hidden).toEqual([]);
  });

  it("protects Home, the scan button and Profile, and the blocks that hold a status, a prize or help", () => {
    expect([...BAR_PROTECTED].sort()).toEqual(["index", "profile", "scan"]);
    expect([...HOME_PROTECTED].sort()).toEqual(["links", "prizes", "standing"]);
  });

  it("only names switches the app has", () => {
    for (const block of HOME_BLOCKS) {
      for (const feature of block.features) {
        expect(feature in FEATURES, `${block.block}: ${feature}`).toBe(true);
      }
    }
  });
});

describe("readEventLayout", () => {
  it.each([undefined, null, "layout", 7, [], {}, { bar: "x", home: 3 }])(
    "gives the default layout for %j",
    (stored) => {
      expect(readEventLayout(stored)).toEqual(DEFAULT_LAYOUT);
    },
  );

  it("keeps a saved order and a hidden item", () => {
    const read = readEventLayout({
      bar: { order: ["rewards", "index", "scan", "quests", "profile"], hidden: ["quests"] },
      home: { order: HOME_KEYS.toReversed(), hidden: ["sponsors"] },
    });
    expect(read.bar).toEqual({
      order: ["rewards", "index", "scan", "quests", "profile"],
      hidden: ["quests"],
    });
    expect(read.home.order[0]).toBe("links");
    expect(read.home.hidden).toEqual(["sponsors"]);
  });

  it("drops an unknown item, counts a repeat once and adds a missing item at the end", () => {
    const read = readEventLayout({
      bar: { order: ["scan", "map", "scan", "index"], hidden: ["map", "quests", "quests"] },
    });
    expect(read.bar.order).toEqual(["scan", "index", "quests", "rewards", "profile"]);
    expect(read.bar.hidden).toEqual(["quests"]);
  });

  it.each([...BAR_PROTECTED])(
    "never hides the protected bar item %s, whatever is stored",
    (tab) => {
      expect(readEventLayout({ bar: { order: BAR_KEYS, hidden: [tab] } }).bar.hidden).toEqual([]);
    },
  );

  it.each([...HOME_PROTECTED])("never hides the protected Home block %s", (block) => {
    expect(readEventLayout({ home: { order: HOME_KEYS, hidden: [block] } }).home.hidden).toEqual(
      [],
    );
  });
});

describe("composedLayoutOf", () => {
  it("lists only what is shown, in order", () => {
    const layout = readEventLayout({
      bar: { order: ["index", "rewards", "scan", "quests", "profile"], hidden: ["quests"] },
      home: { order: ["goal", ...HOME_KEYS.filter((key) => key !== "goal")], hidden: ["streak"] },
    });
    const composed = composedLayoutOf(layout);
    expect(composed.bar).toEqual(["index", "rewards", "scan", "profile"]);
    expect(composed.home[0]).toBe("goal");
    expect(composed.home).not.toContain("streak");
  });

  it("is the default for the default layout", () => {
    expect(composedLayoutOf(DEFAULT_LAYOUT)).toEqual(DEFAULT_COMPOSED_LAYOUT);
  });
});

describe("readComposedLayout", () => {
  it.each([undefined, null, "x", 3, [], {}])(
    "falls back to the default layout for %j",
    (received) => {
      expect(readComposedLayout(received)).toEqual(DEFAULT_COMPOSED_LAYOUT);
    },
  );

  it("renders any saved layout that keeps the protected items", () => {
    const received = {
      bar: ["rewards", "index", "scan", "profile"],
      home: HOME_KEYS.toReversed().filter((key) => key !== "sponsors"),
    };
    expect(readComposedLayout(received)).toEqual(received);
  });

  it.each([
    ["Home", ["quests", "scan", "rewards", "profile"]],
    ["the scan button", ["index", "quests", "rewards", "profile"]],
    ["Profile", ["index", "quests", "scan", "rewards"]],
    ["everything", []],
  ])("falls back to the default bar when it leaves out %s", (_name, bar) => {
    expect(readComposedLayout({ bar, home: HOME_KEYS }).bar).toEqual(DEFAULT_COMPOSED_LAYOUT.bar);
  });

  it("falls back to the default Home when a protected block is missing, and keeps the bar it could read", () => {
    const received = {
      bar: ["profile", "scan", "index"],
      home: HOME_KEYS.filter((key) => key !== "prizes"),
    };
    const read = readComposedLayout(received);
    expect(read.home).toEqual(DEFAULT_COMPOSED_LAYOUT.home);
    expect(read.bar).toEqual(["profile", "scan", "index"]);
  });

  it("drops names this app does not know and repeats", () => {
    const read = readComposedLayout({
      bar: ["index", "quests", "map", "scan", "scan", "rewards", "profile", "extra"],
      home: [...HOME_KEYS, "confetti", "standing"],
    });
    expect(read.bar).toEqual(["index", "quests", "scan", "rewards", "profile"]);
    expect(read.home).toEqual(HOME_KEYS);
  });
});

const allOn = () => true;

describe("the layout and the event's switches", () => {
  it("orders the bar by the layout and drops the Rewards tab with the shop switch, whatever the layout says", () => {
    const order = ["rewards", "index", "scan", "quests", "profile"] as const;
    expect(playerTabs(allOn, order).map((entry) => entry.tab)).toEqual(order);
    expect(playerTabs((feature) => feature !== "shop", order).map((entry) => entry.tab)).toEqual([
      "index",
      "scan",
      "quests",
      "profile",
    ]);
  });

  it("keeps a tab the layout hides off the bar even with every switch on", () => {
    expect(playerTabs(allOn, ["index", "scan", "profile"]).map((entry) => entry.tab)).toEqual([
      "index",
      "scan",
      "profile",
    ]);
  });

  it("drops the ranking and goal blocks with their switches, wherever the layout puts them", () => {
    const shown = ["goal", "ranking", "upNext", "standing"] as const;
    expect(homeBlocks(allOn, shown)).toEqual(shown);
    expect(homeBlocks((feature) => feature !== "ranking", shown)).toEqual([
      "goal",
      "upNext",
      "standing",
    ]);
    expect(homeBlocks((feature) => feature !== "shop", shown)).toEqual([
      "ranking",
      "upNext",
      "standing",
    ]);
  });

  it("keeps the live block while either of its switches is on and drops it when both are off", () => {
    const shown = ["live"] as const;
    expect(homeBlocks((feature) => feature !== "community", shown)).toEqual(["live"]);
    expect(homeBlocks((feature) => feature !== "cheers", shown)).toEqual(["live"]);
    expect(homeBlocks((feature) => feature !== "cheers" && feature !== "community", shown)).toEqual(
      [],
    );
  });

  it("shows every default block while every switch is on", () => {
    expect(homeBlocks(allOn)).toEqual(HOME_KEYS);
  });
});

describe("barScreenOrder", () => {
  it("puts the shown tabs first in the layout's order and keeps every other tab registered after them", () => {
    expect(barScreenOrder(["rewards", "index", "scan", "profile"])).toEqual([
      "rewards",
      "index",
      "scan",
      "profile",
      "quests",
    ]);
    expect(barScreenOrder(DEFAULT_COMPOSED_LAYOUT.bar)).toEqual(BAR_KEYS);
  });
});

describe("sameLayout", () => {
  it("ignores the order of the hidden set and sees a moved item", () => {
    const a = readEventLayout({ bar: { order: BAR_KEYS, hidden: ["quests", "rewards"] } });
    const b = readEventLayout({ bar: { order: BAR_KEYS, hidden: ["rewards", "quests"] } });
    expect(sameLayout(a, b)).toBe(true);
    expect(
      sameLayout(a, readEventLayout({ bar: { order: BAR_KEYS.toReversed(), hidden: [] } })),
    ).toBe(false);
  });
});
