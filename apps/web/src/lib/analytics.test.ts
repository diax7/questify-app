import type { QuestsAnalytics } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  PANEL_ROWS,
  axisTicks,
  bucketLabel,
  funnelOf,
  percentOf,
  popularity,
  seriesPoints,
  sourceRows,
  stopsOf,
} from "#src/lib/analytics.ts";

type Category = QuestsAnalytics["categories"][number];
type Step = Category["quests"][number];

const text = (en: string) => ({ ar: null, en });
const step = (id: string, done: number, extra: Partial<Step> = {}): Step => ({
  id,
  title: text(id),
  done,
  step: true,
  skipped: false,
  ...extra,
});
const category = (id: string, inOrder: boolean, quests: Step[]): Category => ({
  id,
  name: text(id),
  inOrder,
  quests,
});

describe("percentOf", () => {
  it("rounds to a whole percent, caps at 100 and gives no value without a whole", () => {
    expect(percentOf(640, 1000)).toBe(64);
    expect(percentOf(1, 3)).toBe(33);
    expect(percentOf(5, 3)).toBe(100);
    expect(percentOf(0, 10)).toBe(0);
    expect(percentOf(0, 0)).toBeNull();
  });
});

describe("sourceRows", () => {
  it("lists the five sources and folds the rest into one row, so the rows add up", () => {
    const rows = sourceRows({
      code: 4,
      qr: 3,
      link: 2,
      public_list: 1,
      invite: 5,
      operator: 6,
      rehearsal: 7,
      other: 8,
    });
    expect(rows.map((row) => row.key)).toEqual([
      "code",
      "qr",
      "link",
      "publicList",
      "invite",
      "other",
    ]);
    expect(rows.at(-1)?.count).toBe(21);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(36);
  });
});

describe("funnelOf", () => {
  it("shows what each step lost and marks the largest drop", () => {
    const steps = funnelOf(
      category("trail", true, [step("a", 100), step("b", 80), step("c", 30), step("d", 25)]),
      200,
    );
    expect(steps.map((one) => one.lost)).toEqual([null, 20, 50, 5]);
    expect(steps.map((one) => one.lostPercent)).toEqual([null, 20, 63, 17]);
    expect(steps.map((one) => one.largest)).toEqual([false, false, true, false]);
    expect(steps.map((one) => one.percent)).toEqual([50, 40, 15, 13]);
  });

  it("marks the first of two equal drops", () => {
    const steps = funnelOf(
      category("tie", true, [step("a", 90), step("b", 60), step("c", 30)]),
      90,
    );
    expect(steps.map((one) => one.largest)).toEqual([false, true, false]);
  });

  it("shows zero at every step and no largest drop for a category nobody completed", () => {
    const steps = funnelOf(category("empty", true, [step("a", 0), step("b", 0)]), 10);
    expect(steps.map((one) => one.done)).toEqual([0, 0]);
    expect(steps.some((one) => one.largest)).toBe(false);
  });

  it("passes over a skipped step and leaves out a flash quest", () => {
    const steps = funnelOf(
      category("skip", true, [
        step("a", 100),
        step("broken", 0, { skipped: true }),
        step("flash", 3, { step: false }),
        step("b", 70),
      ]),
      100,
    );
    expect(steps.map((one) => one.id)).toEqual(["a", "broken", "b"]);
    expect(steps.map((one) => one.lost)).toEqual([null, null, 30]);
    expect(steps.at(-1)?.largest).toBe(true);
  });

  it("gives an unordered category its counts and no drops", () => {
    const steps = funnelOf(category("free", false, [step("a", 10), step("b", 4)]), 20);
    expect(steps.map((one) => one.lost)).toEqual([null, null]);
    expect(steps.some((one) => one.largest)).toBe(false);
  });

  it("never reports a negative drop when a later step has more players", () => {
    const steps = funnelOf(category("odd", true, [step("a", 5), step("b", 9)]), 10);
    expect(steps.map((one) => one.lost)).toEqual([null, 0]);
  });
});

describe("stopsOf", () => {
  it("names the step each category in order lost the most after, largest first", () => {
    const data: QuestsAnalytics = {
      joined: 100,
      categories: [
        category("small", true, [step("s1", 50), step("s2", 45)]),
        category("big", true, [step("b1", 90), step("b2", 80), step("b3", 20)]),
        category("free", false, [step("f1", 90), step("f2", 1)]),
        category("quiet", true, [step("q1", 0), step("q2", 0)]),
      ],
    };
    const stops = stopsOf(data);
    expect(stops.map((stop) => [stop.categoryId, stop.after.en, stop.lost])).toEqual([
      ["big", "b2", 60],
      ["small", "s1", 5],
    ]);
  });
});

const quests = (count: number) =>
  Array.from({ length: count }, (_, index) => step(`q${index}`, 100 - index * 10));

describe("popularity", () => {
  it("lists the most popular and the least popular among the rest, never the same quest twice", () => {
    const { all, most, least } = popularity({
      joined: 100,
      categories: [category("c", false, quests(8))],
    });
    expect(all).toHaveLength(8);
    expect(most.map((row) => row.id)).toEqual(["q0", "q1", "q2", "q3", "q4"]);
    expect(least.map((row) => row.id)).toEqual(["q7", "q6", "q5"]);
    expect(most.length).toBeLessThanOrEqual(PANEL_ROWS);
  });

  it("has no least popular list while every quest is in the most popular one", () => {
    const { most, least } = popularity({
      joined: 10,
      categories: [category("c", false, quests(4))],
    });
    expect(most).toHaveLength(4);
    expect(least).toEqual([]);
  });

  it("takes each rate over the players joined, and none without players", () => {
    const rows = popularity({ joined: 4, categories: [category("c", false, [step("a", 1)])] }).all;
    expect(rows[0]?.percent).toBe(25);
    expect(
      popularity({ joined: 0, categories: [category("c", false, [step("a", 0)])] }).all[0]?.percent,
    ).toBeNull();
  });
});

describe("axisTicks", () => {
  it("runs from 0 past the largest value in whole numbers, at most five ticks", () => {
    expect(axisTicks(0)).toEqual([0, 1]);
    expect(axisTicks(1)).toEqual([0, 1]);
    expect(axisTicks(3)).toEqual([0, 1, 2, 3]);
    expect(axisTicks(1240)).toEqual([0, 500, 1000, 1500]);
    expect(axisTicks(50_000)).toEqual([0, 20_000, 40_000, 60_000]);
    for (const max of [7, 19, 88, 640, 9_999, 123_456]) {
      const ticks = axisTicks(max);
      expect(ticks.at(-1) ?? 0).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks.every((tick) => Number.isInteger(tick))).toBe(true);
    }
  });
});

describe("the players-over-time line", () => {
  it("labels a bucket in the event's clock with Western digits in both languages", () => {
    expect(bucketLabel("2026-10-31T14:00", "hour", "en", false)).toBe("31 Oct, 14:00");
    expect(bucketLabel("2026-10-31T14:00", "day", "en", true)).toBe("31 Oct 2026");
    expect(bucketLabel("2026-10-31T09:00", "hour", "ar", true)).toMatch(/^31 .+ 2026.*09:00$/u);
    expect(bucketLabel("2026-10-31T09:00", "hour", "ar", true)).not.toMatch(/[٠-٩]/u);
  });

  it("places the points by time and keeps the running count", () => {
    const points = seriesPoints(
      {
        unit: "hour",
        series: [
          { at: "2026-10-31T12:00", joined: 2 },
          { at: "2026-10-31T14:00", joined: 5 },
        ],
      },
      "en",
    );
    expect(points.map((point) => point.value)).toEqual([2, 5]);
    expect((points[1]?.x ?? 0) - (points[0]?.x ?? 0)).toBe(2 * 3600 * 1000);
  });
});
