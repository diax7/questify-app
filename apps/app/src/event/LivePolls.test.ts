import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunityCard } from "#src/event/community.ts";
import { NOTHING_LIVE, type LiveState } from "#src/event/polls.ts";

// There is no native renderer in the unit suite, so the two hooks LivePolls uses run on a tiny stand-in: state lives
// in slots, effects run after each render when their dependencies changed, and a state change renders again.
const runtime = vi.hoisted(() => ({
  slots: [] as { value?: unknown; deps?: readonly unknown[] }[],
  cursor: 0,
  effects: [] as (() => void)[],
  dirty: false,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = runtime.cursor++;
    const slot = (runtime.slots[index] ??= { value: initial });
    return [
      slot.value,
      (next: unknown) => {
        const value =
          typeof next === "function" ? (next as (v: unknown) => unknown)(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value;
          runtime.dirty = true;
        }
      },
    ];
  },
  useEffect: (effect: () => void, deps: readonly unknown[]) => {
    const slot = (runtime.slots[runtime.cursor++] ??= {});
    const same =
      slot.deps?.length === deps.length && deps.every((d, i) => Object.is(d, slot.deps?.[i]));
    if (!same) {
      slot.deps = deps;
      runtime.effects.push(effect);
    }
  },
}));

const stores = vi.hoisted(() => ({
  saved: new Map<string, string>(),
  live: undefined as unknown,
  paid: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: "View",
  AccessibilityInfo: { announceForAccessibility: stores.announce },
}));
vi.mock("expo-router", () => ({
  router: { navigate: vi.fn() },
  useSegments: () => ["(tabs)", "index"],
}));
vi.mock("#src/api/app-session.ts", () => ({
  keyValueStore: {
    getItem: async (key: string) => stores.saved.get(key) ?? null,
    setItem: async (key: string, value: string) => void stores.saved.set(key, value),
  },
}));
vi.mock("#src/components/AppText.tsx", () => ({ AppText: "AppText" }));
vi.mock("#src/components/Sheet.tsx", () => ({ Sheet: "Sheet" }));
vi.mock("#src/components/Controls.tsx", () => ({ Button: "Button" }));
vi.mock("#src/components/sheet-count.ts", () => ({ useOpenSheets: () => 0 }));
vi.mock("#src/event/EventContext.tsx", () => ({
  useEvent: () => ({ eventId: "event-1", notePaid: stores.paid, events: undefined }),
}));
vi.mock("#src/event/LiveContext.tsx", () => ({ useLive: () => stores.live }));
vi.mock("#src/event/PollEntry.tsx", () => ({ PollEntry: "PollEntry" }));
vi.mock("#src/i18n/provider.tsx", () => ({
  useI18n: () => ({ t: (key: string) => key, language: "en" }),
}));

const { LivePolls } = await import("#src/event/LivePolls.tsx");

type Shown = Readonly<{ props: Record<string, unknown> }> | null;

/** Renders until nothing changes: effects run, storage reads settle, state changes render again. */
async function render(): Promise<Shown> {
  let output: Shown = null;
  for (let pass = 0; pass < 20; pass += 1) {
    runtime.cursor = 0;
    runtime.dirty = false;
    output = LivePolls() as Shown;
    const effects = runtime.effects.splice(0);
    effects.forEach((effect) => effect());
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (!runtime.dirty) {
      return output;
    }
  }
  throw new Error("LivePolls kept rendering");
}

const community: CommunityCard = {
  goalId: "goal-1",
  title: { ar: null, en: "Goal" },
  measure: "points",
  target: 100,
  progress: 50,
  status: "running",
  paidTo: "everyone",
  endsAt: "2026-11-09T20:00:00Z",
  steps: [
    {
      threshold: 50,
      isGoal: false,
      reward: { kind: "moment", moment: { ar: null, en: "Halfway" } },
      reachedAt: "2026-11-09T19:00:00Z",
      mine: null,
    },
  ],
  contributed: false,
};

const flash = [
  { questId: "flash-1", title: { ar: null, en: "Flash" }, closesAt: "2026-11-09T21:00:00Z" },
];

const everything: LiveState = {
  ...NOTHING_LIVE,
  polls: [{ questId: "poll-1", closesAt: "2026-11-09T21:00:00Z" }],
  closed: [{ questId: "results-1" }],
  community,
  flash,
};

/** Closes the shown sheet the way the player does and reads what comes next. */
async function closeShown(shown: Shown): Promise<Shown> {
  const onClose = shown?.props["onClose"] as (() => void) | undefined;
  onClose?.();
  return render();
}

const titleOf = (shown: Shown) => shown?.props["title"];
const questIdOf = (shown: Shown) =>
  (shown?.props["children"] as { props: { questId: string } } | undefined)?.props.questId;

describe("LivePolls", () => {
  beforeEach(() => {
    runtime.slots = [];
    runtime.effects = [];
    stores.saved.clear();
    stores.paid.mockClear();
    stores.announce.mockClear();
    stores.live = everything;
  });

  it("shows nothing when nothing is live", async () => {
    stores.live = NOTHING_LIVE;
    expect(await render()).toBeNull();
  });

  it("shows the cards in the order poll, results, community, drop, one at a time", async () => {
    const poll = await render();
    expect(titleOf(poll)).toBe("poll.live");
    expect(questIdOf(poll)).toBe("poll-1");
    expect(poll?.props["closeLabel"]).toBe("poll.later");

    const results = await closeShown(poll);
    expect(titleOf(results)).toBe("poll.resultsIn");
    expect(questIdOf(results)).toBe("results-1");

    const news = await closeShown(results);
    expect(titleOf(news)).toBe("community.momentTitle");

    const drop = await closeShown(news);
    expect(titleOf(drop)).toBe("live.flash.title");

    expect(await closeShown(drop)).toBeNull();
    expect(stores.announce.mock.calls.map((call) => call[0])).toEqual([
      "poll.live",
      "poll.resultsIn",
      "community.momentTitle",
      "live.flash.title",
    ]);
  });

  it("remembers each one-time card on the phone as it shows it", async () => {
    await closeShown(await render());
    expect(stores.saved.get("questify.pollResults.event-1")).toContain("results-1");
  });

  it("skips a one-time card this phone already showed", async () => {
    stores.saved.set(
      "questify.pollResults.event-1",
      JSON.stringify(["results-1", "community:goal-1:50:moment"]),
    );
    stores.live = { ...everything, polls: [] };
    expect(titleOf(await render())).toBe("live.flash.title");
    expect(stores.paid).toHaveBeenCalledTimes(1);
  });

  it("shows a boost once the flash quests are shown", async () => {
    stores.saved.set("questify.pollResults.event-1", JSON.stringify(["flash:flash-1"]));
    stores.live = {
      ...NOTHING_LIVE,
      flash,
      boosts: [
        {
          boostId: "boost-1",
          categoryId: "category-1",
          category: { ar: null, en: "Food" },
          multiplier: 2,
          endsAt: "2026-11-09T21:00:00Z",
        },
      ],
    };
    expect(titleOf(await render())).toBe("live.boost.title");
  });
});
