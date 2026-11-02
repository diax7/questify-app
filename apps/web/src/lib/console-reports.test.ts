import { describe, expect, it } from "vitest";
import {
  inLanguage,
  outcomesFor,
  queuePath,
  readDetail,
  readFlags,
  readQueue,
  resolvePath,
  snapshotLabel,
  targetPage,
} from "#src/lib/console-reports.ts";

const ID = "6f1f8a3e-58f4-4b55-9f0c-3a3a8c6f2f10";

describe("console reports helpers (T-705b)", () => {
  it("builds the queue, target and resolve paths", () => {
    expect(queuePath("")).toBe("/v1/admin/reports");
    expect(queuePath("quest")).toBe("/v1/admin/reports?kind=quest");
    expect(resolvePath("username", ID)).toBe(`/v1/admin/reports/username/${ID}/resolve`);
    expect(targetPage("ar", "reward", ID)).toBe(`/ar/console/reports/reward/${ID}`);
  });

  it("labels a snapshot in the reader's language, the other one, or as a username", () => {
    expect(snapshotLabel({ title: { ar: "مهمة", en: "Quest" } }, "ar")).toBe("مهمة");
    expect(snapshotLabel({ title: { en: "Quest" } }, "ar")).toBe("Quest");
    expect(snapshotLabel({ username: "rude_name" }, "en")).toBe("@rude_name");
    expect(snapshotLabel(null, "en")).toBe("");
    expect(inLanguage(undefined, "en")).toBe("");
  });

  it("offers the outcomes that fit each kind", () => {
    expect(outcomesFor("username")).toEqual(["username_changed", "player_banned", "dismissed"]);
    expect(outcomesFor("quest")).toEqual(["dismissed"]);
    expect(outcomesFor("sponsor")).toEqual(["event_suspended", "dismissed"]);
  });

  it("reads only the expected shapes", () => {
    expect(readQueue({ targets: [], total: 0 })).toEqual({ targets: [], total: 0 });
    expect(readQueue({ targets: "x" })).toBeUndefined();
    expect(readFlags({ events: [], total: 2 })).toEqual({ events: [], total: 2 });
    expect(readFlags(null)).toBeUndefined();
    expect(readDetail({})).toBeUndefined();
    const detail = {
      kind: "quest",
      targetId: ID,
      current: null,
      player: null,
      event: null,
      hold: null,
      reports: [],
    };
    expect(readDetail(detail)).toEqual(detail);
  });
});
