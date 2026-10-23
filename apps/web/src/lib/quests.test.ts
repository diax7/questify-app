import { describe, expect, it } from "vitest";
import {
  blankQuest,
  categoryBody,
  categoryRuleNotes,
  createQuestBody,
  editQuestBody,
  moved,
  questProblem,
  questDraftOf,
  textFor,
  type CategoryView,
  type QuestView,
} from "#src/lib/quests.ts";

const QUEST: QuestView = {
  id: "q1",
  categoryId: "c1",
  type: "enter_code",
  title: { ar: "الرمز", en: null },
  description: { ar: null, en: null },
  points: 15,
  repeatCap: 2,
  opensAt: "2030-11-01T07:00:00.000Z",
  closesAt: null,
  visible: true,
  position: 0,
  config: { code: "NAJD2030" },
  verification: [],
  itemId: "i1",
};

describe("textFor", () => {
  it("uses the page's language and falls back to the other", () => {
    expect(textFor({ ar: "أ", en: "B" }, "en")).toBe("B");
    expect(textFor({ ar: "أ", en: null }, "en")).toBe("أ");
    expect(textFor({ ar: null, en: "B" }, "ar")).toBe("B");
    expect(textFor({ ar: null, en: null }, "ar")).toBe("");
  });
});

describe("moved", () => {
  it("swaps a row with its neighbour", () => {
    expect(moved(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moved(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("refuses to move past either end", () => {
    expect(moved(["a", "b"], 0, -1)).toBeUndefined();
    expect(moved(["a", "b"], 1, 1)).toBeUndefined();
    expect(moved(["a"], 3, -1)).toBeUndefined();
  });
});

describe("quest bodies", () => {
  const before = questDraftOf(QUEST, "Asia/Riyadh");

  it("shows the times in the event's zone, empty when not set", () => {
    expect(before).toMatchObject({ opensAt: "2030-11-01T10:00", closesAt: "", titleEn: "" });
  });

  it("creates with everything, empty times as none", () => {
    expect(createQuestBody({ ...blankQuest("c1"), titleEn: "Find" })).toEqual({
      type: "scan_qr",
      categoryId: "c1",
      title: { ar: "", en: "Find" },
      description: { ar: "", en: "" },
      points: 10,
      repeatCap: 1,
      opensAt: null,
      closesAt: null,
      visible: true,
      config: {},
      verification: ["quest_qr"],
      itemId: null,
    });
  });

  it("edits with only what changed", () => {
    expect(editQuestBody(before, before)).toEqual({});
    expect(editQuestBody({ ...before, points: 20, opensAt: "", visible: false }, before)).toEqual({
      points: 20,
      opensAt: null,
      visible: false,
    });
    expect(editQuestBody({ ...before, config: { code: "TABUK31" } }, before)).toEqual({
      config: { code: "TABUK31" },
    });
    expect(editQuestBody({ ...before, itemId: "" }, { ...before, itemId: "i1" })).toEqual({
      itemId: null,
    });
    expect(editQuestBody({ ...before, itemId: "i2" }, before)).toEqual({ itemId: "i2" });
  });
});

describe("questProblem", () => {
  const fine = { ...blankQuest("c1"), titleEn: "Find" };

  it("passes a sound draft", () => {
    expect(questProblem(fine)).toBeUndefined();
    expect(
      questProblem({
        ...fine,
        type: "enter_code",
        config: { code: "NAJD2030" },
        verification: [],
      }),
    ).toBeUndefined();
  });

  it.each([
    ["title", { titleEn: "  " }],
    ["points", { points: -1 }],
    ["points", { points: 100_001 }],
    ["points", { points: 1.5 }],
    ["closesAt", { opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T10:00" }],
    ["config", { type: "enter_code", config: { code: "AB" }, verification: [] }],
    ["verification", { verification: [] }],
    ["verification", { type: "enter_code", config: { code: "NAJD2030" } }],
  ] as const)("names %s", (field, change) => {
    expect(questProblem({ ...fine, ...change })).toBe(field);
  });
});

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    data.set(key, value);
  }
  return data;
};

describe("category rules (T-304)", () => {
  it("sends the names and rules, an empty time or unlock as none", () => {
    expect(
      categoryBody(
        form({
          ar: "الأولى",
          en: "",
          orderMode: "in_order",
          opensAt: "2030-11-01T16:00",
          unlockAfter: "c0",
          completionBonus: "250",
          refresh: "weekly",
          hidden: "on",
          itemId: "i1",
        }),
      ),
    ).toEqual({
      name: { ar: "الأولى", en: "" },
      orderMode: "in_order",
      opensAt: "2030-11-01T16:00",
      unlockAfter: "c0",
      completionBonus: 250,
      refresh: "weekly",
      hidden: true,
      itemId: "i1",
    });
    expect(categoryBody(form({ orderMode: "other" }))).toEqual({
      name: { ar: "", en: "" },
      orderMode: "any",
      opensAt: null,
      unlockAfter: null,
      completionBonus: 0,
      refresh: "none",
      hidden: false,
      itemId: null,
    });
    expect(categoryBody(form({ refresh: "hourly" }))).toMatchObject({ refresh: "none" });
    expect(categoryBody(form({ refresh: "daily" }))).toMatchObject({ refresh: "daily" });
  });

  it("notes a category's order, opening, unlock and bonus, and nothing for none", () => {
    const base: CategoryView = {
      id: "c1",
      name: { ar: null, en: "Two" },
      position: 1,
      orderMode: "any",
      opensAt: null,
      unlockAfter: null,
      completionBonus: 0,
      refresh: "none",
      hidden: false,
      itemId: null,
      quests: [],
    };
    const one = { ...base, id: "c0", name: { ar: null, en: "One" } };
    expect(categoryRuleNotes(base, [one, base])).toEqual([]);
    const ruled = {
      ...base,
      orderMode: "in_order" as const,
      opensAt: "2030-11-01T13:00:00.000Z",
      unlockAfter: "c0",
      completionBonus: 50,
    };
    expect(categoryRuleNotes(ruled, [one, ruled])).toEqual([
      { kind: "inOrder" },
      { kind: "opens", at: "2030-11-01T13:00:00.000Z" },
      { kind: "unlockAfter", name: { ar: null, en: "One" } },
      { kind: "bonus", points: 50 },
    ]);
    expect(categoryRuleNotes({ ...ruled, unlockAfter: "gone" }, [ruled])).toHaveLength(3);
    const secret = { ...base, refresh: "daily" as const, hidden: true };
    expect(categoryRuleNotes(secret, [secret])).toEqual([
      { kind: "resets", refresh: "daily" },
      { kind: "hidden" },
    ]);
  });
});

describe("passport quests (T-304b)", () => {
  const PASSPORT: QuestView = {
    ...QUEST,
    type: "passport",
    repeatCap: 1,
    config: { needed: 2 },
    steps: [
      { id: "s1", name: { ar: "أ", en: null }, position: 0 },
      { id: "s2", name: { ar: null, en: "B" }, position: 1 },
    ],
  };

  it("holds the steps in the form and sends them beside the config, saved ones by id", () => {
    const draft = questDraftOf(PASSPORT, "Asia/Riyadh");
    const steps = draft.config["steps"] as { id: string; text: object; saved?: boolean }[];
    expect(steps).toEqual([
      { id: "s1", saved: true, text: { ar: "أ" } },
      { id: "s2", saved: true, text: { en: "B" } },
    ]);
    const added = {
      ...draft,
      config: { ...draft.config, steps: [...steps, { id: "new", text: { en: "C" } }] },
    };
    expect(editQuestBody(added, draft)).toEqual({
      steps: [
        { id: "s1", name: { ar: "أ", en: "" } },
        { id: "s2", name: { ar: "", en: "B" } },
        { name: { ar: "", en: "C" } },
      ],
    });
    expect(createQuestBody(draft)).toMatchObject({ type: "passport", config: { needed: 2 } });
    expect(createQuestBody(draft)["config"]).not.toHaveProperty("steps");
    expect(questProblem(draft)).toBeUndefined();
  });

  it("finds a passport's problems before the API does", () => {
    const draft = questDraftOf(PASSPORT, "Asia/Riyadh");
    const withSteps = (steps: unknown[], needed = 1) => ({ ...draft, config: { needed, steps } });
    expect(questProblem(withSteps([]))).toBe("steps");
    expect(questProblem(withSteps([{ id: "x", text: { en: " " } }]))).toBe("steps");
    expect(questProblem(withSteps([{ id: "x", text: { en: "A" } }], 2))).toBe("needed");
    expect(questProblem(withSteps([{ id: "x", text: { en: "A" } }], 0))).toBe("config");
    expect(
      questProblem(
        withSteps(Array.from({ length: 31 }, (_, i) => ({ id: `${i}`, text: { en: "A" } }))),
      ),
    ).toBe("steps");
  });
});
