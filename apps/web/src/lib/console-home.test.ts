import {
  DEFAULT_QUESTIFY_HOME,
  QUESTIFY_HOME_KEYS,
  type QuestifyHome,
  type TapAction,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { homeProblem, readHomeLayout } from "#src/lib/console-home.ts";

const slide = (title: string, action: TapAction = { type: "none" }) => ({
  title: { ar: "", en: title },
  subtitle: { ar: "", en: "" },
  action,
});
const draft = (banner: QuestifyHome["banner"]): QuestifyHome => ({
  ...DEFAULT_QUESTIFY_HOME,
  banner,
});

describe("the console's reading of Questify home's layout (T-713)", () => {
  it("reads the listed layout and whether it can be reverted", () => {
    const body = {
      order: [...QUESTIFY_HOME_KEYS].toReversed(),
      hidden: ["quests"],
      banner: [slide("A")],
      revertible: true,
    };
    const row = readHomeLayout(body);
    expect(row?.revertible).toBe(true);
    expect(row?.layout.order[0]).toBe("quests");
    expect(row?.layout.hidden).toEqual(["quests"]);
    expect(row?.layout.banner).toHaveLength(1);
  });

  it("makes a layout whole when a block is missing, and drops one that is not a block", () => {
    const row = readHomeLayout({
      order: ["quests", "ghost"],
      hidden: ["ghost"],
      banner: [],
      revertible: false,
    });
    expect(row?.layout.order).toHaveLength(QUESTIFY_HOME_KEYS.length);
    expect(row?.layout.order[0]).toBe("quests");
    expect(row?.layout.hidden).toEqual([]);
  });

  it("answers undefined for a body that is not the listed shape, so the page shows its error", () => {
    for (const body of [
      null,
      "x",
      {},
      { order: [], hidden: [], banner: [] },
      { order: 1, hidden: [], banner: [], revertible: true },
    ]) {
      expect(readHomeLayout(body)).toBeUndefined();
    }
  });
});

describe("what is wrong with a draft, in the admin's words", () => {
  it("is nothing for a layout that can be saved", () => {
    expect(homeProblem(DEFAULT_QUESTIFY_HOME)).toBeNull();
    expect(
      homeProblem(
        draft([slide("A"), slide("B", { type: "link", url: "https://questify.example/b" })]),
      ),
    ).toBeNull();
  });

  it("names the slide that has no title", () => {
    expect(homeProblem(draft([slide("A"), slide("")]))).toEqual({
      key: "layout.problem.slideTitle",
      n: 2,
    });
  });

  it("asks for an https link when the link is not one", () => {
    expect(
      homeProblem(draft([slide("A", { type: "link", url: "http://questify.example" })])),
    ).toEqual({
      key: "layout.problem.url",
      n: 1,
    });
  });
});
