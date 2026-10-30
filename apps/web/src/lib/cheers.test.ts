import { describe, expect, it } from "vitest";
import {
  floatersFor,
  freshCheers,
  isEmpty,
  runningOf,
  sceneAnswerOf,
} from "#src/lib/big-screen.ts";
import { canStartCheers, cheersReadingOf, type CheersReading } from "#src/lib/cheers.ts";

const ENDS = "2030-11-01T07:30:00.000Z";
const NOW = Date.parse("2030-11-01T07:25:00.000Z");

describe("the Cheers scene's answer", () => {
  it("reads the end, the five counts and the newest cheers, and the server's clock offset", () => {
    const answer = sceneAnswerOf(
      "cheers",
      {
        shut: null,
        serverNow: "2030-11-01T07:25:02.000Z",
        cheers: {
          endsAt: ENDS,
          totals: { heart: 4, applause: 1, fire: 0, star: "x" },
          recent: [
            { seq: 7, reaction: "heart" },
            { seq: 8, reaction: "fire" },
          ],
        },
      },
      NOW,
    );
    expect(answer).toEqual({
      scene: "cheers",
      shut: null,
      clockOffset: 2000,
      cheers: {
        endsAt: Date.parse(ENDS),
        totals: { heart: 4, applause: 1, fire: 0, star: 0, party: 0 },
        recent: [
          { seq: 7, reaction: "heart" },
          { seq: 8, reaction: "fire" },
        ],
      },
    });
  });

  it("drops a cheer it cannot place, and treats a bad end or no moment as empty", () => {
    const view = (cheers: unknown) => sceneAnswerOf("cheers", { shut: null, cheers }, NOW);
    expect(
      view({
        endsAt: ENDS,
        totals: {},
        recent: [
          { seq: 1, reaction: "poop" },
          { seq: "2", reaction: "heart" },
          "x",
          { seq: 3, reaction: "star" },
        ],
      }),
    ).toMatchObject({ cheers: { recent: [{ seq: 3, reaction: "star" }] } });
    for (const empty of [null, {}, { endsAt: "soon", totals: {}, recent: [] }, "now"]) {
      const answer = view(empty);
      expect(answer && isEmpty(answer), JSON.stringify(empty)).toBe(true);
    }
    expect(sceneAnswerOf("cheers", { shut: "feature_off", cheers: null }, NOW)).toMatchObject({
      shut: "feature_off",
    });
    expect(sceneAnswerOf("cheers", "nothing", NOW)).toBeUndefined();
  });

  it("is a scene the screen can run, and never empty while a moment is live", () => {
    expect(runningOf(["cheers"])).toEqual(["cheers"]);
    const answer = sceneAnswerOf(
      "cheers",
      { shut: null, cheers: { endsAt: ENDS, totals: {}, recent: [] } },
      NOW,
    );
    expect(answer && isEmpty(answer)).toBe(false);
  });
});

describe("floating the cheers", () => {
  const recent = [
    { seq: 5, reaction: "star" },
    { seq: 3, reaction: "heart" },
    { seq: 4, reaction: "fire" },
  ] as const;

  it("floats only the cheers newer than the last one shown, oldest first", () => {
    expect(freshCheers(recent, -1).map((cheer) => cheer.seq)).toEqual([3, 4, 5]);
    expect(freshCheers(recent, 4).map((cheer) => cheer.seq)).toEqual([5]);
    expect(freshCheers(recent, 5)).toEqual([]);
  });

  it("spreads the starts over the interval and places each across the width", () => {
    const floaters = floatersFor(freshCheers(recent, -1), 3000, () => 0.5);
    expect(floaters.map((floater) => floater.delay)).toEqual([0, 1000, 2000]);
    expect(floaters.map((floater) => floater.key)).toEqual([3, 4, 5]);
    expect(floaters.every((floater) => floater.left === 48)).toBe(true);
    const edges = [
      ...floatersFor(recent, 3000, () => 0),
      ...floatersFor(recent, 3000, () => 0.999),
    ].map((floater) => floater.left);
    expect(Math.min(...edges)).toBe(5);
    expect(Math.max(...edges)).toBe(90);
    expect(floatersFor([], 3000)).toEqual([]);
  });
});

describe("the dashboard's reading", () => {
  const body = { enabled: true, switch: true, platformOn: true, live: null };

  it("reads the add-on, both switches and the live end", () => {
    expect(cheersReadingOf(body)).toEqual({
      enabled: true,
      switchOn: true,
      platformOn: true,
      endsAt: null,
    });
    expect(cheersReadingOf({ ...body, switch: false, live: { endsAt: ENDS } })).toEqual({
      enabled: true,
      switchOn: false,
      platformOn: true,
      endsAt: ENDS,
    });
    expect(cheersReadingOf({ ...body, enabled: "yes" })).toBeUndefined();
    expect(cheersReadingOf(null)).toBeUndefined();
  });

  it("lets the owner start only with the add-on and both switches on and no moment live", () => {
    const ready: CheersReading = { enabled: true, switchOn: true, platformOn: true, endsAt: null };
    expect(canStartCheers(ready)).toBe(true);
    for (const change of [
      { enabled: false },
      { switchOn: false },
      { platformOn: false },
      { endsAt: ENDS },
    ]) {
      expect(canStartCheers({ ...ready, ...change }), JSON.stringify(change)).toBe(false);
    }
  });
});
