import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createAuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import {
  operatorDevices,
  previewDevice,
  viewOf,
  type Actor,
  type ClaimDeps,
} from "#src/devices/claims";

const keys = createAuthKeys("k".repeat(40));
const EVENT = "11111111-1111-4111-8111-111111111111";
const ORGANIZER = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const PLAYER = "44444444-4444-4444-8444-444444444444";
const team: Actor = { type: "team", organizerId: ORGANIZER, staffUserId: STAFF };
const operator: Actor = { type: "operator", playerId: PLAYER };
const reply = { header: () => undefined };

type Refusal = Readonly<{ code: string; detail?: string }>;
type Count = Readonly<{ bucket: string; key: Buffer; count: number }>;

/**
 * A pool whose door (`preview_device`, `operator_devices`) answers `door`, and whose throttle counts answer `counts`
 * for a matching bucket and key (0 for any other). Every recorded attempt is kept in `recorded`.
 */
function fakePool(door: Refusal | object, counts: Count[] = []) {
  const recorded: Array<Readonly<{ bucket: string; key: Buffer }>> = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("preview_device") || sql.includes("operator_devices")) {
        if ("code" in door) {
          throw Object.assign(new Error("refused"), door);
        }
        return { rows: [door] };
      }
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked: true }] };
      }
      if (sql.includes("FROM auth_throttle")) {
        const [bucket, key] = values as [string, Buffer];
        const match = counts.find((one) => one.bucket === bucket && one.key.equals(key));
        return { rows: [{ count: match?.count ?? 0, retry_after: 30 }] };
      }
      if (sql.includes("INSERT INTO auth_throttle")) {
        recorded.push({ bucket: values[0] as string, key: values[1] as Buffer });
        return { rows: [{ at: "now" }] };
      }
      return { rows: [] };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as Pool, recorded };
}

const depsOf = (pool: Pool, alarm = vi.fn()): ClaimDeps => ({ pool, keys, alarm });
const preview = (deps: ClaimDeps, actor: Actor = team) =>
  previewDevice(deps, { actor, eventId: EVENT, code: "ABCD-EFGH" }, reply);
const platformMisses = (count: number): Count => ({
  bucket: BUCKETS.deviceMissPlatform,
  key: keys.eventKey("platform"),
  count,
});

describe("an unknown pairing code (T-309, CTO 8)", () => {
  it("alerts ops once the platform holds more than 200 unknown codes this hour", async () => {
    const alarm = vi.fn();
    const { pool } = fakePool({ code: "DV404", detail: ORGANIZER }, [platformMisses(201)]);
    await expect(preview(depsOf(pool, alarm))).rejects.toMatchObject({ status: 404 });
    expect(alarm).toHaveBeenCalledWith("device.claim_misses_high", { lastHour: 201 });
  });

  it("does not alert at 200", async () => {
    const alarm = vi.fn();
    const { pool } = fakePool({ code: "DV404", detail: ORGANIZER }, [platformMisses(200)]);
    await expect(preview(depsOf(pool, alarm))).rejects.toMatchObject({ status: 404 });
    expect(alarm).not.toHaveBeenCalled();
  });

  it("is counted against its event, the organizer the door named and the platform", async () => {
    const { pool, recorded } = fakePool({ code: "DV404", detail: ORGANIZER });
    await expect(preview(depsOf(pool))).rejects.toMatchObject({ status: 404 });
    const misses = recorded.filter((one) => one.bucket !== BUCKETS.deviceClaim);
    expect(misses).toEqual([
      { bucket: BUCKETS.deviceMissEvent, key: keys.eventKey(EVENT) },
      { bucket: BUCKETS.deviceMissOrganizer, key: keys.organizerKey(ORGANIZER) },
      { bucket: BUCKETS.deviceMissPlatform, key: keys.eventKey("platform") },
    ]);
  });

  it("counts no miss for another refusal, or an unknown code without its organizer", async () => {
    for (const refusal of [{ code: "DV409", detail: "not_kiosk" }, { code: "DV404" }]) {
      const { pool, recorded } = fakePool(refusal);
      await expect(preview(depsOf(pool))).rejects.toMatchObject({
        envelope: { code: refusal.code === "DV404" ? "unknown_code" : "not_kiosk" },
      });
      expect(recorded.map((one) => one.bucket)).toEqual([BUCKETS.deviceClaim]);
    }
  });
});

describe("the claim limits (CTO 8)", () => {
  const organizerFull: Count = {
    bucket: BUCKETS.deviceMissOrganizer,
    key: keys.organizerKey(ORGANIZER),
    count: 30,
  };

  it("holds the team once its organizer has 30 unknown codes this hour", async () => {
    const { pool } = fakePool({ kind: "station" }, [organizerFull]);
    await expect(preview(depsOf(pool), team)).rejects.toMatchObject({
      status: 429,
      envelope: { code: "too_many_attempts" },
    });
  });

  it("never holds an operator by the organizer's count", async () => {
    const { pool } = fakePool(
      { kind: "station", client: "Chrome", expires_at: new Date("2026-10-24T10:00:00Z") },
      [organizerFull],
    );
    await expect(preview(depsOf(pool), operator)).resolves.toEqual({
      kind: "station",
      client: "Chrome",
      expiresAt: "2026-10-24T10:00:00.000Z",
    });
  });
});

describe("viewOf, a device as the lists show it", () => {
  const row = {
    id: "d1",
    kind: "kiosk",
    label: "Gate tablet",
    questId: "q1",
    questTitleAr: "البوابة",
    questTitleEn: "Gate",
    client: "Chrome on Android",
    pairedBy: { type: "operator", name: "sara" },
    pairedAt: "2026-10-24T09:00:00Z",
    lastSeenAt: "2026-10-24T09:05:00Z",
    activated: true,
    status: "revoked",
    paused: true,
    revokedAt: "2026-10-24T10:00:00Z",
    scans: 7,
  };

  it("maps every field of a full row", () => {
    expect(viewOf(row)).toEqual({
      id: "d1",
      kind: "kiosk",
      label: "Gate tablet",
      questId: "q1",
      quest: { ar: "البوابة", en: "Gate" },
      client: "Chrome on Android",
      pairedBy: { type: "operator", name: "sara" },
      pairedAt: "2026-10-24T09:00:00.000Z",
      lastSeenAt: "2026-10-24T09:05:00.000Z",
      activated: true,
      status: "revoked",
      paused: true,
      revokedAt: "2026-10-24T10:00:00.000Z",
      scans: 7,
    });
  });

  it("answers null for what a row leaves out, and false for anything but true", () => {
    const bare = {
      ...row,
      questId: null,
      questTitleAr: undefined,
      questTitleEn: undefined,
      client: undefined,
      pairedBy: null,
      activated: "true",
      paused: 1,
      revokedAt: null,
      scans: "7",
    };
    expect(viewOf(bare)).toMatchObject({
      questId: null,
      quest: null,
      client: "",
      pairedBy: null,
      activated: false,
      paused: false,
      revokedAt: null,
      scans: null,
    });
    expect(viewOf({ ...row, questId: undefined })).toMatchObject({ quest: null });
    expect(viewOf({ ...row, pairedBy: undefined })).toMatchObject({ pairedBy: null });
    expect(viewOf({ ...row, revokedAt: undefined })).toMatchObject({ revokedAt: null });
  });

  it("names the quest's missing title null, and a staff pairer without a name", () => {
    expect(
      viewOf({
        ...row,
        questTitleAr: null,
        questTitleEn: undefined,
        pairedBy: { type: "staff", name: 3 },
      }),
    ).toMatchObject({ quest: { ar: null, en: null }, pairedBy: { type: "staff", name: null } });
  });
});

describe("operatorDevices, staff mode's devices page", () => {
  it("maps its devices and both quest lists, a missing title as null", async () => {
    const quest = { id: "q1", titleAr: "البوابة", titleEn: "Gate", points: "10" };
    const { pool } = fakePool({
      page: {
        devices: [],
        quests: [quest],
        kioskQuests: [{ id: "q2", titleAr: null, points: 5 }],
      },
    });
    await expect(operatorDevices(depsOf(pool), PLAYER, EVENT)).resolves.toEqual({
      devices: [],
      quests: [{ id: "q1", title: { ar: "البوابة", en: "Gate" }, points: 10 }],
      kioskQuests: [{ id: "q2", title: { ar: null, en: null }, points: 5 }],
    });
  });
});
