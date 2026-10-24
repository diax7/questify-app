import { MESSAGES, createTranslator } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  communityNews,
  communityOf,
  reachedUnlocks,
  rewardText,
  unlockedSince,
} from "#src/event/community.ts";
import { readHome } from "#src/event/home-api.ts";
import {
  categoryNotes,
  completionAnswer,
  ownCommunityLock,
  readQuests,
  type Category,
} from "#src/event/quests-api.ts";
import { readShop, rewardAction, type ShopReward, type ShopView } from "#src/event/shop-api.ts";
import { lockNoteOf, sameLock, unlockLine, type CommunityLock } from "#src/event/unlock.ts";

const NOTE = {
  goalId: "g1",
  title: { ar: "أضيئوا البرج", en: "Light the tower" },
  measure: "points",
  threshold: 5000,
  state: "waiting",
  startsAt: "2030-01-01T10:00:00.000Z",
} as const;
const OTHER: CommunityLock = { ...NOTE, threshold: 9000 };
const translate = createTranslator(MESSAGES);
const tIn =
  (language: "ar" | "en") =>
  (key: Parameters<typeof translate>[0], params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);
const words = (note: CommunityLock, language: "ar" | "en") => {
  const line = unlockLine(note, language, "Asia/Riyadh");
  return tIn(language)(line.key, line.values);
};

const body = (quest: Record<string, unknown>, category: Record<string, unknown> = {}) => ({
  event: { statusNow: "live", timezone: "Asia/Riyadh" },
  categories: [
    {
      id: "c",
      name: { ar: null, en: "Stage" },
      quests: [
        {
          id: "q",
          title: { ar: null, en: "Tower" },
          description: { ar: null, en: null },
          type: "enter_code",
          points: 10,
          repeatCap: 1,
          opensAt: null,
          closesAt: null,
          done: 0,
          earned: 0,
          state: "locked",
          verification: [],
          ...quest,
        },
      ],
      ...category,
    },
  ],
});

const shop = (reward: Record<string, unknown>) =>
  readShop({
    shop: { state: "open", pickupMinutes: 30, rules: null, firstRedemption: false, desk: null },
    balance: 0,
    goalRewardId: null,
    rewards: [{ id: "r1", name: { ar: null, en: "Lantern" }, ...reward }],
    redemptions: [],
  })?.rewards[0]?.communityLock;

const home = (goal: Record<string, unknown>) =>
  readHome({
    event: {
      id: "e",
      name: { ar: null, en: "Fest" },
      venue: { ar: null, en: null },
      startsAt: null,
      endsAt: null,
      timezone: "Asia/Riyadh",
      statusNow: "live",
      rehearsal: false,
    },
    standing: {
      status: "active",
      score: 0,
      balance: 0,
      pendingPoints: 0,
      questsDone: 0,
      questsTotal: 1,
    },
    upNext: null,
    goal: {
      rewardId: "r1",
      name: { ar: null, en: "Lantern" },
      price: 10,
      left: 10,
      pinned: true,
      soldOut: false,
      ...goal,
    },
    win: null,
    rankingOn: true,
  })?.goal?.communityLock;

const card = (reward: Record<string, unknown>, reachedAt: string | null = null) => ({
  goalId: "g1",
  title: { ar: null, en: "Light the tower" },
  measure: "points",
  target: 100,
  progress: 50,
  status: "running",
  endsAt: "2030-01-01T10:10:00.000Z",
  steps: [{ threshold: 50, isGoal: false, reward, reachedAt, mine: null }],
  contributed: false,
});

/** Community unlocks in the app (T-306c, ADR-228): the lock's note and line, the quests, shop, Home and bar. */
describe("the lock's note and line", () => {
  it("reads a well-formed note, and none for anything else (a newer state too)", () => {
    expect(lockNoteOf(NOTE)).toEqual(NOTE);
    expect(lockNoteOf(null)).toBeNull();
    expect(lockNoteOf({ ...NOTE, state: "paused" })).toBeNull();
    expect(lockNoteOf({ ...NOTE, measure: "likes" })).toBeNull();
    expect(lockNoteOf({ ...NOTE, threshold: "5000" })).toBeNull();
    expect(lockNoteOf({ ...NOTE, goalId: 1 })).toBeNull();
    expect(lockNoteOf({ ...NOTE, startsAt: null })).toBeNull();
    expect(lockNoteOf({ ...NOTE, title: "x" })?.title).toEqual({ ar: null, en: null });
    expect(sameLock(NOTE, { ...NOTE })).toBe(true);
    expect(sameLock(NOTE, OTHER)).toBe(false);
    expect(sameLock(NOTE, { ...NOTE, goalId: "g2" })).toBe(false);
    expect(sameLock(null, null)).toBe(false);
  });

  it("says each state in both languages with Western digits and no counted noun after the number", () => {
    expect(words(NOTE, "en")).toBe("Unlocks at 5,000 community points");
    expect(words(NOTE, "ar")).toBe("يُفتح حين تبلغ النقاط الجماعية 5,000");
    expect(words({ ...NOTE, measure: "completions" }, "en")).toBe(
      "Unlocks at 5,000 community completions",
    );
    expect(words({ ...NOTE, measure: "players", threshold: 3 }, "ar")).toBe(
      "يُفتح حين يبلغ عدد المشاركين 3",
    );
    expect(words({ ...NOTE, state: "missed" }, "en")).toBe(
      "Not unlocked: the community goal was missed",
    );
    expect(words({ ...NOTE, state: "scheduled" }, "en")).toMatch(
      /^Unlocks with a community goal that starts .*(13|1):00/,
    );
    expect(words({ ...NOTE, state: "scheduled" }, "ar")).toMatch(/^يُفتح مع هدف جماعي يبدأ .*[0-9]/);
  });
});

describe("the quests tab", () => {
  it("reads the lock and its note; an older app's unknown lock reads as none", () => {
    const read = readQuests(body({ lock: "community_locked", communityLock: NOTE }));
    expect(read?.categories[0]?.quests[0]).toMatchObject({
      lock: "community_locked",
      communityLock: NOTE,
    });
    expect(read?.categories[0]?.communityLock).toBeNull();
    const older = readQuests(body({ lock: "future_lock", communityLock: "x" }));
    expect(older?.categories[0]?.quests[0]).toMatchObject({ lock: null, communityLock: null });
  });

  it("says a whole category's lock once as its first note, and a quest's own lock on the quest", () => {
    const read = readQuests(
      body({ lock: "community_locked", communityLock: NOTE }, { communityLock: NOTE }),
    );
    const category = read?.categories[0] as Category;
    expect(categoryNotes(category)[0]).toEqual({ kind: "community", note: NOTE });
    expect(ownCommunityLock(category.quests[0] ?? { communityLock: null }, category)).toBeNull();
    expect(ownCommunityLock({ communityLock: OTHER }, category)).toEqual(OTHER);
    expect(ownCommunityLock({ communityLock: NOTE }, { communityLock: null })).toEqual(NOTE);
    expect(ownCommunityLock({ communityLock: null }, category)).toBeNull();
  });

  it("reads a completion refused for the lock", () => {
    expect(
      completionAnswer({
        kind: "error",
        status: 403,
        code: "quest_not_open",
        message: null,
        details: { reason: "community_locked" },
        headers: new Headers(),
      }),
    ).toEqual({ kind: "not_open", reason: "community_locked" });
  });
});

describe("the shop and Home's goal", () => {
  const REWARD: ShopReward = {
    id: "r1",
    kind: "item",
    name: { ar: null, en: "Lantern" },
    description: { ar: null, en: null },
    price: 10,
    stockLeft: 3,
    perPlayerLimit: null,
    heldByMe: 0,
    opensAt: null,
    closesAt: null,
    section: null,
    tags: { new: false, limited: false, popular: false },
    communityLock: NOTE,
  };

  it("shows a locked reward's line instead of Redeem, after a closed shop", () => {
    const view = {
      shop: { state: "open", desk: { state: "open" } },
      balance: 100,
    } as unknown as ShopView;
    expect(rewardAction(REWARD, view, Date.now())).toBe("community_locked");
    expect(rewardAction({ ...REWARD, communityLock: null }, view, Date.now())).toBe("redeem");
    const closed = { ...view, shop: { ...view.shop, state: "closed" } } as unknown as ShopView;
    expect(rewardAction(REWARD, closed, Date.now())).toBe("shop_closed");
  });

  it("reads the reward's note, and ignores it from an older API", () => {
    expect(shop({ communityLock: NOTE })).toEqual(NOTE);
    expect(shop({})).toBeNull();
  });

  it("reads a pinned goal's lock on Home, and none from an older API", () => {
    expect(home({ communityLock: NOTE })).toEqual(NOTE);
    expect(home({})).toBeNull();
  });
});

describe("the bar's unlock step", () => {
  const NAMED = {
    kind: "unlock",
    target: { kind: "quest", id: "q", name: { ar: "البرج", en: "Tower" } },
  };

  it("names a target the player sees, a surprise otherwise, and keeps an unknown kind's marker without words", () => {
    const step = (reward: Record<string, unknown>) => communityOf(card(reward))?.steps[0];
    const named = step(NAMED);
    expect(named?.reward.target).toEqual({
      kind: "quest",
      id: "q",
      name: { ar: "البرج", en: "Tower" },
    });
    expect(rewardText(named ?? ({} as never), false, tIn("en"), "en")).toBe("🔒 Unlocks Tower");
    expect(rewardText(named ?? ({} as never), false, tIn("ar"), "ar")).toBe("🔒 يفتح البرج");
    const surprise = step({ kind: "unlock" });
    expect(rewardText(surprise ?? ({} as never), false, tIn("en"), "en")).toBe(
      "🔒 Unlocks a surprise",
    );
    const unknown = step({ kind: "teleport" });
    expect(unknown?.reward.kind).toBe("teleport");
    expect(rewardText(unknown ?? ({} as never), false, tIn("en"), "en")).toBeNull();
    expect(communityOf(card({ kind: 1 }))).toBeNull();
    expect(step({ kind: "unlock", target: { kind: "quest" } })?.reward.target).toBeUndefined();
  });

  it("owes one unlocked card per reached unlock, and says when the lists must be read again", () => {
    const waiting = communityOf(card(NAMED));
    const reached = communityOf(card(NAMED, "2030-01-01T10:05:00.000Z"));
    expect(communityNews(waiting, [])).toEqual([]);
    expect(communityNews(reached, []).map((news) => [news.key, news.kind])).toEqual([
      ["community:g1:50:unlocked", "unlocked"],
    ]);
    expect(reachedUnlocks(reached)).toEqual(["g1:50"]);
    expect(reachedUnlocks(null)).toEqual([]);
    expect(unlockedSince(undefined, reached)).toBe(false);
    expect(unlockedSince(reachedUnlocks(waiting), reached)).toBe(true);
    expect(unlockedSince(reachedUnlocks(reached), reached)).toBe(false);
  });
});
