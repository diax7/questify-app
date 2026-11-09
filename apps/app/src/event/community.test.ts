import { describe, expect, it } from "vitest";
import { communityNews, communityOf, fillOf, lineOf, markerOf } from "#src/event/community.ts";
import { liveStateOf } from "#src/event/polls.ts";

const card = {
  goalId: "g1",
  title: { ar: "أضيئوا البرج", en: "Light the tower" },
  measure: "points",
  target: 200,
  progress: 50,
  status: "running",
  paidTo: "everyone",
  endsAt: "2030-01-01T10:10:00.000Z",
  steps: [
    {
      threshold: 40,
      isGoal: false,
      reward: { kind: "moment", moment: { en: "The band plays" } },
      reachedAt: "2030-01-01T10:01:00.000Z",
      mine: null,
    },
    {
      threshold: 100,
      isGoal: false,
      reward: { kind: "points", points: 5 },
      reachedAt: null,
      mine: null,
    },
    {
      threshold: 200,
      isGoal: true,
      reward: { kind: "points", points: 20 },
      reachedAt: null,
      mine: null,
    },
  ],
  contributed: true,
};

describe("the community card (T-306b)", () => {
  it("reads the live answer's card, and null for anything malformed", () => {
    const read = communityOf(card);
    expect(read).toMatchObject({
      goalId: "g1",
      measure: "points",
      paidTo: "everyone",
      contributed: true,
    });
    expect(communityOf({ ...card, paidTo: undefined })?.paidTo).toBe("contributors");
    expect(read?.title).toEqual({ ar: "أضيئوا البرج", en: "Light the tower" });
    expect(read?.steps[0]?.reward).toEqual({
      kind: "moment",
      moment: { ar: null, en: "The band plays" },
    });
    expect(read?.steps[2]).toEqual({
      threshold: 200,
      isGoal: true,
      reward: { kind: "points", points: 20 },
      reachedAt: null,
      mine: null,
    });
    expect(communityOf(null)).toBeNull();
    expect(communityOf({ ...card, status: "paused" })).toBeNull();
    expect(communityOf({ ...card, measure: "likes" })).toBeNull();
    expect(communityOf({ ...card, steps: [{ threshold: 1, reward: { kind: 1 } }] })).toBeNull();
    expect(communityOf({ ...card, steps: [{ reward: { kind: "nothing" } }] })).toBeNull();
    expect(communityOf({ ...card, target: "200" })).toBeNull();
    expect(liveStateOf({ polls: [], closed: [], community: card })?.community?.goalId).toBe("g1");
    expect(liveStateOf({ polls: [], closed: [] })?.community).toBeNull();
  });

  it("fills the bar up to full and places the markers along it", () => {
    expect(fillOf({ progress: 50, target: 200 })).toBe(0.25);
    expect(fillOf({ progress: 300, target: 200 })).toBe(1);
    expect(fillOf({ progress: -5, target: 200 })).toBe(0);
    expect(fillOf({ progress: 5, target: 0 })).toBe(0);
    expect(markerOf({ threshold: 40 }, 200)).toBe(0.2);
    expect(markerOf({ threshold: 400 }, 200)).toBe(1);
    expect(markerOf({ threshold: 40 }, 0)).toBe(0);
  });

  it("says the time left, then counting past the end, or how it finished", () => {
    const now = Date.parse("2030-01-01T10:09:00.000Z");
    expect(lineOf({ status: "running", endsAt: card.endsAt }, now)).toEqual({
      kind: "ends_in",
      seconds: 60,
    });
    expect(lineOf({ status: "running", endsAt: card.endsAt }, now + 60_000)).toEqual({
      kind: "counting",
    });
    expect(lineOf({ status: "reached", endsAt: card.endsAt }, now)).toEqual({ kind: "reached" });
    expect(lineOf({ status: "missed", endsAt: card.endsAt }, now)).toEqual({ kind: "missed" });
  });

  it("owes one card per reached moment and per step that paid the player, once per phone", () => {
    const read = communityOf({
      ...card,
      steps: card.steps.map((step) => (step.threshold === 100 ? { ...step, mine: "paid" } : step)),
    });
    const news = communityNews(read, []);
    expect(news.map((item) => [item.key, item.kind])).toEqual([
      ["community:g1:40:moment", "moment"],
      ["community:g1:100:paid", "paid"],
    ]);
    expect(communityNews(read, ["community:g1:40:moment"]).map((item) => item.key)).toEqual([
      "community:g1:100:paid",
    ]);
    expect(communityNews(null, [])).toEqual([]);
    expect(
      communityNews(communityOf({ ...card, steps: [{ ...card.steps[0], reachedAt: null }] }), []),
    ).toEqual([]);
  });
});

describe("communityOf, field by field", () => {
  const text = { ar: "ع", en: "en" };
  const step = {
    threshold: 10,
    isGoal: true,
    reward: { kind: "points", points: 5, moment: text, target: { kind: "k", id: "i", name: text } },
    reachedAt: "2030-01-01T00:00:00Z",
    mine: "paid",
  };
  const whole = { ...card, steps: [step] };
  const withStep = (fields: Record<string, unknown>) =>
    communityOf({ ...whole, steps: [{ ...step, ...fields }] });
  const withReward = (fields: Record<string, unknown>) =>
    communityOf({ ...whole, steps: [{ ...step, reward: { ...step.reward, ...fields } }] })?.steps[0]
      ?.reward;

  it("reads a whole card, and nothing from a value that is not one", () => {
    expect(communityOf(whole)).toEqual({
      goalId: "g1",
      title: { ar: "أضيئوا البرج", en: "Light the tower" },
      measure: "points",
      target: 200,
      progress: 50,
      status: "running",
      paidTo: "everyone",
      endsAt: "2030-01-01T10:10:00.000Z",
      steps: [
        {
          threshold: 10,
          isGoal: true,
          reward: {
            kind: "points",
            points: 5,
            moment: text,
            target: { kind: "k", id: "i", name: text },
          },
          reachedAt: "2030-01-01T00:00:00Z",
          mine: "paid",
        },
      ],
      contributed: true,
    });
    for (const junk of [undefined, null, 0, "x", true, []]) {
      expect(communityOf(junk), String(junk)).toBeNull();
    }
  });

  it.each([
    ["goalId", [undefined, null, 7, {}, []]],
    ["measure", [undefined, null, 7, "", "likes", "Points"]],
    ["status", [undefined, null, 7, "", "paused", "Running"]],
    ["target", [undefined, null, "200", "", true, []]],
    ["progress", [undefined, null, "50", "", true, {}]],
    ["endsAt", [undefined, null, 7, true, {}]],
    ["steps", [undefined, null, "x", 7, true, {}]],
  ])("refuses the card when its %s is not the right kind", (key, junk) => {
    for (const value of junk) {
      expect(communityOf({ ...whole, [key]: value }), `${key}=${String(value)}`).toBeNull();
    }
  });

  it("accepts the empty and zero values of the fields it checks", () => {
    expect(
      communityOf({ ...whole, goalId: "", target: 0, progress: 0, endsAt: "", steps: [] }),
    ).toMatchObject({ goalId: "", target: 0, progress: 0, endsAt: "", steps: [] });
    for (const measure of ["points", "completions", "players"]) {
      expect(communityOf({ ...whole, measure })?.measure).toBe(measure);
    }
    for (const status of ["running", "reached", "missed"]) {
      expect(communityOf({ ...whole, status })?.status).toBe(status);
    }
  });

  it("reads the title, payee and contributed flag leniently", () => {
    const empty = { ar: null, en: null };
    for (const junk of [undefined, null, 0, "x", true, [], {}]) {
      expect(communityOf({ ...whole, title: junk })?.title, String(junk)).toEqual(empty);
    }
    expect(communityOf({ ...whole, title: { ar: "ع" } })?.title).toEqual({ ar: "ع", en: null });
    expect(communityOf({ ...whole, title: { ar: 1, en: "e" } })?.title).toEqual({
      ar: null,
      en: "e",
    });
    expect(communityOf({ ...whole, paidTo: "contributors" })?.paidTo).toBe("contributors");
    for (const junk of [undefined, null, 7, "", "all", "Everyone"]) {
      expect(communityOf({ ...whole, paidTo: junk })?.paidTo, String(junk)).toBe("contributors");
    }
    expect(communityOf({ ...whole, contributed: true })?.contributed).toBe(true);
    for (const junk of [undefined, null, 0, 1, "true", [], {}]) {
      expect(communityOf({ ...whole, contributed: junk })?.contributed, String(junk)).toBe(false);
    }
  });

  it("refuses the whole card when any step is not readable", () => {
    expect(communityOf({ ...whole, steps: [step, null, step] })).toBeNull();
    expect(communityOf({ ...whole, steps: [null] })).toBeNull();
    expect(communityOf({ ...whole, steps: [step, "x"] })).toBeNull();
    expect(communityOf({ ...whole, steps: [{ ...step, threshold: undefined }, step] })).toBeNull();
    expect(communityOf({ ...whole, steps: [step, step] })?.steps).toHaveLength(2);
    for (const threshold of [undefined, null, "10", "", true, {}]) {
      expect(withStep({ threshold }), String(threshold)).toBeNull();
    }
    expect(withStep({ threshold: 0 })?.steps[0]?.threshold).toBe(0);
    for (const reward of [undefined, null, 0, "x", true, [], {}, { kind: 7 }, { points: 5 }]) {
      expect(withStep({ reward }), JSON.stringify(reward)).toBeNull();
    }
  });

  it("reads a step's flags, time and payout leniently", () => {
    expect(withStep({ isGoal: false })?.steps[0]?.isGoal).toBe(false);
    for (const junk of [undefined, null, 0, 1, "true", [], {}]) {
      expect(withStep({ isGoal: junk })?.steps[0]?.isGoal, String(junk)).toBe(false);
    }
    expect(withStep({ reachedAt: "" })?.steps[0]?.reachedAt).toBe("");
    for (const junk of [undefined, null, 0, true, [], {}]) {
      expect(withStep({ reachedAt: junk })?.steps[0]?.reachedAt, String(junk)).toBeNull();
    }
    for (const mine of ["due", "paid", "skipped"]) {
      expect(withStep({ mine })?.steps[0]?.mine).toBe(mine);
    }
    for (const junk of [undefined, null, 0, "", "Paid", "owed", true, []]) {
      expect(withStep({ mine: junk })?.steps[0]?.mine, String(junk)).toBeNull();
    }
  });

  it("reads a reward's kind as sent and each extra on its own", () => {
    expect(withReward({})).toEqual(step.reward);
    expect(withReward({ kind: "future" })).toMatchObject({ kind: "future" });
    expect(withReward({ kind: "" })).toMatchObject({ kind: "" });
    expect(withReward({ points: 0 })).toMatchObject({ points: 0 });
    for (const junk of [undefined, null, "5", true, [], {}]) {
      expect(withReward({ points: junk }), String(junk)).not.toHaveProperty("points");
    }
    for (const junk of [undefined, null, 0, "x", true]) {
      expect(withReward({ moment: junk }), String(junk)).not.toHaveProperty("moment");
    }
    for (const junk of [[], {}]) {
      expect(withReward({ moment: junk })?.moment).toEqual({ ar: null, en: null });
    }
    expect(withReward({ moment: { ar: 1, en: "e" } })?.moment).toEqual({ ar: null, en: "e" });
    const named = { kind: "k", id: "i", name: text };
    expect(withReward({ target: named })?.target).toEqual(named);
    expect(withReward({ target: { kind: "k", id: "i" } })?.target).toEqual({
      kind: "k",
      id: "i",
      name: { ar: null, en: null },
    });
    const bad = [undefined, null, 0, "x", [], {}, { kind: "k" }, { id: "i" }, { kind: 1, id: "i" }];
    for (const target of [...bad, { kind: "k", id: 2 }]) {
      expect(withReward({ target }), JSON.stringify(target)).not.toHaveProperty("target");
    }
  });
});
