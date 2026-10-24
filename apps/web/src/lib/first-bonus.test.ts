import { describe, expect, it } from "vitest";
import { firstBonusLabel, kindKey, removeBonusHint } from "#src/lib/awards.ts";
import { translatorFor } from "#src/lib/language.ts";
import {
  blankQuest,
  createQuestBody,
  editQuestBody,
  questDraftOf,
  questProblem,
  type QuestView,
} from "#src/lib/quests.ts";

const QUEST: QuestView = {
  id: "q1",
  categoryId: "c1",
  type: "scan_qr",
  title: { ar: null, en: "Gate" },
  description: { ar: null, en: null },
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  visible: true,
  position: 0,
  config: {},
  verification: ["quest_qr"],
  itemId: null,
  place: null,
  pollSentAt: null,
  firstBonus: { points: 25, slots: 50, given: 3, left: 47, locked: true },
};
const t = translatorFor("en");
const plain = (value: number) => String(value);

describe("the builder's first-N bonus (T-313)", () => {
  it("sends the bonus on create only when switched on", () => {
    const draft = { ...blankQuest("c1"), titleEn: "Gate" };
    expect(createQuestBody(draft)).not.toHaveProperty("firstBonus");
    expect(
      createQuestBody({ ...draft, firstBonusOn: true, firstBonusPoints: 25, firstBonusSlots: 50 }),
    ).toMatchObject({ firstBonus: { points: 25, slots: 50 } });
  });

  it("sends a change, a switch off and a stop, and nothing when the bonus is unchanged", () => {
    const before = questDraftOf(QUEST, "Asia/Riyadh");
    expect(before).toMatchObject({ firstBonusOn: true, firstBonusPoints: 25, firstBonusSlots: 50 });
    expect(editQuestBody(before, before)).toEqual({});
    expect(editQuestBody({ ...before, firstBonusSlots: 60 }, before)).toEqual({
      firstBonus: { points: 25, slots: 60 },
    });
    expect(editQuestBody({ ...before, firstBonusOn: false }, before)).toEqual({ firstBonus: null });
    expect(editQuestBody({ ...before, firstBonusStop: true }, before)).toEqual({
      firstBonus: { stop: true },
    });
    const none = questDraftOf({ ...QUEST, firstBonus: null }, "Asia/Riyadh");
    expect(none.firstBonusOn).toBe(false);
    expect(createQuestBody(none)).not.toHaveProperty("firstBonus");
  });

  it("refuses out-of-range values and fewer players than already got it", () => {
    const before = questDraftOf(QUEST, "Asia/Riyadh");
    expect(questProblem(before)).toBeUndefined();
    expect(questProblem({ ...before, firstBonusPoints: 0 })).toBe("firstBonus");
    expect(questProblem({ ...before, firstBonusSlots: 1001 })).toBe("firstBonus");
    expect(questProblem({ ...before, firstBonusSlots: 2 })).toBe("firstBonus");
    expect(questProblem({ ...before, firstBonusSlots: 3 })).toBeUndefined();
    expect(questProblem({ ...before, firstBonusOn: false, firstBonusPoints: 0 })).toBeUndefined();
  });
});

describe("the team's record of a first-N bonus", () => {
  it("names the bonus line with its place, and hints at it on the quest line", () => {
    expect(kindKey("first_bonus")).toBe("awards.kind.firstBonus");
    const bonus = { kind: "first_bonus", firstBonus: { slots: 50, place: 3 } };
    expect(firstBonusLabel(t, bonus, plain)).toBe("First-50 bonus, place 3");
    expect(firstBonusLabel(t, { kind: "quest", firstBonus: null }, plain)).toBeUndefined();
    expect(
      removeBonusHint(t, { kind: "quest", firstBonus: { slots: 50, place: null } }, plain),
    ).toBe("This completion also earned the first-50 bonus. Remove that line too if it should go");
    expect(removeBonusHint(t, bonus, plain)).toBeUndefined();
    expect(removeBonusHint(t, { kind: "quest" }, plain)).toBeUndefined();
    expect(firstBonusLabel(translatorFor("ar"), bonus, plain)).toBe("مكافأة أول 50، المركز 3");
  });
});
