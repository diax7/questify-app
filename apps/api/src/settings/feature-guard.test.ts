import { describe, expect, it } from "vitest";
import { eventFeatureOn, requireEventFeature } from "#src/settings/feature-guard";

type Answer = Awaited<ReturnType<Parameters<typeof eventFeatureOn>[0]["forEvent"]>>;

const settings = (answer: Answer) => ({ forEvent: () => Promise.resolve(answer) });
const composed = (enabled: boolean | undefined): Answer =>
  ({
    kind: "ok",
    etag: "x",
    config: { features: enabled === undefined ? {} : { maps: { enabled } } },
  }) as unknown as Answer;

describe("eventFeatureOn", () => {
  it("is off only when the composed configuration says off", async () => {
    expect(await eventFeatureOn(settings(composed(false)), "e", "p", "maps")).toBe(false);
    expect(await eventFeatureOn(settings(composed(true)), "e", "p", "maps")).toBe(true);
    expect(await eventFeatureOn(settings(composed(undefined)), "e", "p", "maps")).toBe(true);
  });

  it("leaves an event the player cannot see to the door behind", async () => {
    expect(await eventFeatureOn(settings({ kind: "event_not_found" }), "e", "p", "maps")).toBe(
      true,
    );
  });
});

describe("requireEventFeature", () => {
  it("refuses with 403 feature_off while the switch is off, and passes while it is on", async () => {
    await expect(
      requireEventFeature(settings(composed(false)), "e", "p", "maps"),
    ).rejects.toMatchObject({ status: 403, envelope: { code: "feature_off" } });
    await expect(
      requireEventFeature(settings(composed(true)), "e", "p", "maps"),
    ).resolves.toBeUndefined();
  });
});
