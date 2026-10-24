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
