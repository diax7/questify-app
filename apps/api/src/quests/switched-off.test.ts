import { describe, expect, it } from "vitest";
import {
  categoriesWithoutSwitchedOff,
  switchedOffTypes,
  withoutSwitchedOff,
} from "#src/quests/switched-off";
import type { ConfigResult, SettingsService } from "#src/settings/service";

const settingsWith = (result: ConfigResult, seen: unknown[] = []): SettingsService =>
  ({
    forEvent: async (eventId: string, playerId: string | undefined) => {
      seen.push([eventId, playerId]);
      return result;
    },
  }) as unknown as SettingsService;

const withFeatures = (features: Record<string, { enabled: boolean }>): ConfigResult =>
  ({ kind: "ok", config: { features }, etag: "x" }) as unknown as ConfigResult;

describe("switched-off quest types (T-303, ADR-199)", () => {
  it("names share while shareQuests is off, for the event and player asked about", async () => {
    const seen: unknown[] = [];
    const off = await switchedOffTypes(
      settingsWith(withFeatures({ shareQuests: { enabled: false } }), seen),
      "event-1",
      "player-1",
    );
    expect([...off]).toEqual(["share"]);
    expect(seen).toEqual([["event-1", "player-1"]]);
  });

  it("names nothing while the switch is on, missing, or the event cannot be read", async () => {
    for (const result of [
      withFeatures({ shareQuests: { enabled: true } }),
      withFeatures({ shop: { enabled: false } }),
      { kind: "event_not_found" } as ConfigResult,
    ]) {
      expect([...(await switchedOffTypes(settingsWith(result), "e", undefined))]).toEqual([]);
    }
  });

  it("drops the switched-off quests and the categories they leave empty", () => {
    const off = new Set(["share"]);
    const quests = [
      { id: "a", type: "share" },
      { id: "b", type: "survey" },
    ];
    expect(withoutSwitchedOff(quests, off)).toEqual([{ id: "b", type: "survey" }]);
    expect(withoutSwitchedOff(quests, new Set())).toEqual(quests);
    expect(
      categoriesWithoutSwitchedOff(
        [
          { id: "only-share", quests: [quests[0] as (typeof quests)[number]] },
          { id: "mixed", quests },
        ],
        off,
      ),
    ).toEqual([{ id: "mixed", quests: [{ id: "b", type: "survey" }] }]);
  });
});
