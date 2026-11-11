import { describe, expect, it } from "vitest";
import {
  deliveredPercent,
  evaluateHealth,
  HEALTH_LIMITS,
  healthFactsSchema,
  healthViewSchema,
  type HealthFacts,
  type HealthTileKey,
  type Transports,
} from "#src/platform/platform";

const QUIET: HealthFacts = {
  events: { live: 2, scheduled: 1, suspended: 0, overdue: 0, busiest: [] },
  push: { queued: 0, oldestSeconds: null, stuck: 0, failedDay: 0 },
  alerts: { queued: 0, oldestSeconds: null, stuck: 0, failedDay: 0 },
  fanOut: { waiting: 0, failing: 0, oldestSeconds: null },
  souvenirs: { waiting: 0, failing: 0, stuck: 0, held: 0 },
  invitations: { sending: 0, stuck: 0, sentWeek: 0, failedWeek: 0, unknownWeek: 0 },
  holds: [],
};
const ALL_SET: Transports = {
  sms: true,
  promoSms: true,
  emailBackup: true,
  alertEmail: true,
  pushIos: true,
  pushAndroid: true,
};
const AT = new Date("2026-11-02T12:00:00Z");

const view = (facts: Partial<HealthFacts> = {}, transports: Partial<Transports> = {}, ms = 5) =>
  evaluateHealth({ ...QUIET, ...facts }, { ...ALL_SET, ...transports }, ms, AT);
const pushTile = (oldestSeconds: number | null, stuck = 0) =>
  tile(view({ push: { queued: 5, oldestSeconds, stuck, failedDay: 0 } }), "push");
const smsTile = (sentWeek: number, failedWeek: number, unknownWeek = 0) =>
  tile(view({ invitations: { ...QUIET.invitations, sentWeek, failedWeek, unknownWeek } }), "sms");
const tile = (v: ReturnType<typeof view>, key: HealthTileKey) => {
  const found = v.tiles.find((candidate) => candidate.key === key);
  if (found === undefined) {
    throw new Error(`no ${key} tile`);
  }
  return found;
};

describe("the health view", () => {
  it("is all OK with nothing waiting and every transport set up", () => {
    const result = view();
    expect(result.tiles.map((t) => [t.key, t.state])).toEqual([
      ["database", "ok"],
      ["events", "ok"],
      ["push", "ok"],
      ["sms", "ok"],
      ["email", "ok"],
      ["background", "ok"],
    ]);
    expect(healthViewSchema.safeParse(result).success).toBe(true);
    expect(result.at).toBe("2026-11-02T12:00:00.000Z");
  });

  it("warns when the database answers slowly and not at the limit itself", () => {
    expect(tile(view({}, {}, HEALTH_LIMITS.databaseSlowMs), "database").state).toBe("ok");
    const slow = tile(view({}, {}, HEALTH_LIMITS.databaseSlowMs + 1), "database");
    expect(slow.state).toBe("warning");
    expect(slow.reasons).toEqual(["slow"]);
  });

  it("warns for an event past its start or end, and shows live, scheduled and suspended counts", () => {
    const events = tile(view({ events: { ...QUIET.events, overdue: 1, suspended: 3 } }), "events");
    expect(events.state).toBe("warning");
    expect(events.reasons).toEqual(["overdue"]);
    expect(events.figure).toEqual({ key: "eventsLive", kind: "count", value: 2 });
    expect(events.facts.map((f) => [f.key, f.value])).toEqual([
      ["eventsScheduled", 1],
      ["eventsSuspended", 3],
      ["eventsOverdue", 1],
    ]);
  });

  it("judges the push queue by its oldest item and stuck leases: late is a warning, an hour or stuck is down", () => {
    expect(pushTile(HEALTH_LIMITS.queueWarnSeconds).state).toBe("ok");
    expect(pushTile(HEALTH_LIMITS.queueWarnSeconds + 1).state).toBe("warning");
    expect(pushTile(HEALTH_LIMITS.queueDownSeconds).state).toBe("warning");
    expect(pushTile(HEALTH_LIMITS.queueDownSeconds + 1).state).toBe("down");
    const stuck = pushTile(10, 2);
    expect(stuck.state).toBe("down");
    expect(stuck.reasons).toEqual(["stuck"]);
  });

  it("does not turn a long queue into a warning on its size alone", () => {
    const busy = tile(
      view({ push: { queued: 10_001, oldestSeconds: 30, stuck: 0, failedDay: 4 } }),
      "push",
    );
    expect(busy.state).toBe("ok");
    expect(busy.figure.value).toBe(10_001);
  });

  it("warns about a platform whose push providers are not both set up", () => {
    const missing = tile(view({}, { pushAndroid: false }), "push");
    expect(missing.state).toBe("warning");
    expect(missing.reasons).toEqual(["notSetUp"]);
    expect(missing.facts.filter((f) => f.kind === "setup").map((f) => f.value)).toEqual([1, 0]);
  });

  it("marks a paused channel down with the time it is paused until", () => {
    const hold = { channel: "sms", until: "2026-11-02T12:15:00+00:00", code: "M0037" } as const;
    const sms = tile(view({ holds: [hold] }), "sms");
    expect(sms.state).toBe("down");
    expect(sms.reasons).toEqual(["paused"]);
    expect(sms.facts.find((f) => f.key === "paused")?.value).toBe("2026-11-02T12:15:00.000Z");
    expect(tile(view({ holds: [hold] }), "email").state).toBe("ok");
  });

  it("marks the SMS delivery rate below the thresholds, only once enough messages were tried", () => {
    expect(smsTile(0, 0).figure.value).toBeNull();
    expect(smsTile(1, 18).state).toBe("ok");
    expect(smsTile(18, 2).state).toBe("ok");
    expect(smsTile(17, 3).state).toBe("warning");
    const low = smsTile(9, 10, 1);
    expect(low.state).toBe("down");
    expect(low.reasons).toEqual(["lowDelivery"]);
    expect(low.figure).toEqual({ key: "deliveredPercent", kind: "percent", value: 45 });
  });

  it("counts a message with no known result as not delivered", () => {
    const facts = { ...QUIET, invitations: { ...QUIET.invitations, sentWeek: 1, unknownWeek: 2 } };
    expect(deliveredPercent(facts)).toBe(33);
    expect(deliveredPercent(QUIET)).toBeNull();
  });

  it("warns for an alert email transport that is off, and for a queue older than 15 minutes", () => {
    expect(tile(view({}, { alertEmail: false }), "email").reasons).toEqual(["notSetUp"]);
    const late = view({
      alerts: {
        queued: 2,
        oldestSeconds: HEALTH_LIMITS.mailWarnSeconds + 1,
        stuck: 0,
        failedDay: 0,
      },
    });
    expect(tile(late, "email").state).toBe("warning");
    expect(tile(view({}, { emailBackup: false }), "email").state).toBe("ok");
  });

  it("rolls the background work up to its worst verdict with each reason once", () => {
    const failing = tile(
      view({
        fanOut: { waiting: 4, failing: 1, oldestSeconds: 20 },
        souvenirs: { waiting: 0, failing: 2, stuck: 0, held: 0 },
      }),
      "background",
    );
    expect(failing.state).toBe("warning");
    expect(failing.reasons).toEqual(["failing"]);
    const stuck = tile(
      view({
        souvenirs: { waiting: 1, failing: 1, stuck: 1, held: 0 },
        invitations: { ...QUIET.invitations, stuck: 3 },
      }),
      "background",
    );
    expect(stuck.state).toBe("down");
    expect(stuck.reasons).toEqual(["stuck", "failing"]);
  });

  it("keeps the busiest events beside the tiles", () => {
    const busiest = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: { ar: null, en: "Expo" },
        organizer: "Najd",
        entries: 40,
      },
    ];
    const result = view({ events: { ...QUIET.events, busiest } });
    expect(result.busiest).toEqual(busiest);
  });
});

describe("the health door's answer", () => {
  it("is checked against a strict shape", () => {
    expect(healthFactsSchema.safeParse(QUIET).success).toBe(true);
    expect(healthFactsSchema.safeParse({ ...QUIET, extra: 1 }).success).toBe(false);
    expect(
      healthFactsSchema.safeParse({ ...QUIET, push: { ...QUIET.push, queued: -1 } }).success,
    ).toBe(false);
  });
});
