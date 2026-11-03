import { REGISTRIES } from "@questify/shared";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { firstSwitchOnRefused, platformOnFor, readEventLayerInputs } from "#src/settings/layers";

const EVENT = "33333333-3333-4333-8333-333333333333";
const ORGANIZER = "44444444-4444-4444-8444-444444444444";

type Stored = Readonly<{
  /** The event's stored config, or undefined when the caller cannot see the event. */
  config?: unknown;
  /** The platform's `features` block, or undefined when the platform set no switch. */
  features?: Readonly<Record<string, { enabled: boolean }>>;
}>;

/** A connection answering the layer reads from `stored`: the event, its organizer, the platform, no overrides. */
function db(stored: Stored): PoolClient {
  const query = async (sql: string) => {
    if (sql === "SELECT config FROM event WHERE id = $1") {
      return { rows: stored.config === undefined ? [] : [{ config: stored.config }] };
    }
    if (sql === "SELECT organizer_id FROM event WHERE id = $1") {
      return { rows: stored.config === undefined ? [] : [{ organizer_id: ORGANIZER }] };
    }
    if (sql.includes("FROM platform_setting")) {
      return {
        rows: stored.features === undefined ? [] : [{ key: "features", value: stored.features }],
      };
    }
    if (sql.includes("organizer_feature_override") || sql.includes("event_entitlement")) {
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query } as unknown as PoolClient;
}

const unreachable = {
  query: async () => {
    throw new Error("the database is down");
  },
} as unknown as PoolClient;

describe("readEventLayerInputs", () => {
  it("is undefined for an event the caller cannot see", async () => {
    expect(await readEventLayerInputs(db({}), REGISTRIES, EVENT)).toBeUndefined();
  });

  it("reads the platform and the event's own switches for a visible event", async () => {
    const inputs = await readEventLayerInputs(
      db({ config: {}, features: { boosts: { enabled: false } } }),
      REGISTRIES,
      EVENT,
    );
    expect(inputs).toMatchObject({
      platform: { features: { boosts: { enabled: false } } },
      event: { unlocked: [] },
    });
  });
});

describe("firstSwitchOnRefused", () => {
  it("allows switching everything off without reading the event's layers", async () => {
    expect(
      await firstSwitchOnRefused(unreachable, REGISTRIES, EVENT, { boosts: false }),
    ).toBeUndefined();
    expect(await firstSwitchOnRefused(unreachable, REGISTRIES, EVENT, {})).toBeUndefined();
  });

  it("leaves an event the caller cannot see to the door behind", async () => {
    expect(await firstSwitchOnRefused(db({}), REGISTRIES, EVENT, { boosts: true })).toBeUndefined();
  });

  it("names the feature the platform has off, and nothing when the platform leaves it on", async () => {
    const off = db({ config: {}, features: { boosts: { enabled: false } } });
    expect(await firstSwitchOnRefused(off, REGISTRIES, EVENT, { boosts: true })).toBe("boosts");
    expect(
      await firstSwitchOnRefused(db({ config: {} }), REGISTRIES, EVENT, { boosts: true }),
    ).toBe(undefined);
  });
});

describe("platformOnFor", () => {
  const target = { eventId: EVENT, organizerId: ORGANIZER };

  it("takes the app's own default when the platform set no switch for the feature", async () => {
    const unset = db({ config: {} });
    expect(await platformOnFor(unset, REGISTRIES, target, "boosts")).toBe(true);
    expect(await platformOnFor(unset, REGISTRIES, target, "invitationCampaigns")).toBe(false);
    expect(await platformOnFor(unset, REGISTRIES, target, "no_such_feature")).toBe(true);
  });

  it("follows the platform's switch over the default, both ways", async () => {
    const on = db({ config: {}, features: { invitationCampaigns: { enabled: true } } });
    expect(await platformOnFor(on, REGISTRIES, target, "invitationCampaigns")).toBe(true);
    const off = db({ config: {}, features: { boosts: { enabled: false } } });
    expect(await platformOnFor(off, REGISTRIES, target, "boosts")).toBe(false);
  });

  it("is undefined for an event that is not the organizer's", async () => {
    const other = { eventId: EVENT, organizerId: "55555555-5555-4555-8555-555555555555" };
    expect(await platformOnFor(db({ config: {} }), REGISTRIES, other, "boosts")).toBeUndefined();
  });
});
