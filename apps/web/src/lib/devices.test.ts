import { describe, expect, it } from "vitest";
import {
  devicesOf,
  kioskQuests,
  stationQuests,
  statusOf,
  type DeviceLine,
} from "#src/lib/devices.ts";
import type { CategoryView } from "#src/lib/quests.ts";

const LINE = {
  id: "d1",
  kind: "station",
  label: "Hall B TV",
  questId: "q1",
  quest: { ar: null, en: "Hall B" },
  client: "Chrome on Android",
  pairedBy: { type: "staff", name: "owner@najd.sa" },
  pairedAt: "2026-10-24T10:00:00.000Z",
  lastSeenAt: "2026-10-24T10:05:00.000Z",
  activated: true,
  status: "active",
  paused: false,
  revokedAt: null,
};

const quest = (id: string, type: string, verification: string[]) => ({
  id,
  type,
  verification,
  title: { ar: null, en: id },
});

describe("the Devices page's list (T-309)", () => {
  it("reads every line, and refuses a list with one it cannot read", () => {
    expect(devicesOf({ devices: [LINE] })).toEqual([
      {
        id: "d1",
        kind: "station",
        label: "Hall B TV",
        quest: { ar: null, en: "Hall B" },
        client: "Chrome on Android",
        pairedBy: { type: "staff", name: "owner@najd.sa" },
        pairedAt: LINE.pairedAt,
        lastSeenAt: LINE.lastSeenAt,
        activated: true,
        status: "active",
        paused: false,
        scans: null,
      },
    ]);
    expect(devicesOf({ devices: [{ ...LINE, kind: "kiosk", scans: 7 }] })?.[0]?.scans).toBe(7);
    expect(devicesOf({ devices: [{ ...LINE, quest: null, pairedBy: null }] })?.[0]).toMatchObject({
      quest: null,
      pairedBy: null,
    });
    expect(devicesOf({ devices: [{ ...LINE, kind: "phone" }] })).toBeUndefined();
    expect(devicesOf({ devices: [{ ...LINE, status: "gone" }] })).toBeUndefined();
    expect(devicesOf({})).toBeUndefined();
  });

  it("names a line's state: revoked, ended, waiting, paused or active", () => {
    const line = devicesOf({ devices: [LINE] })?.[0] as DeviceLine;
    expect(statusOf(line)).toBe("active");
    expect(statusOf({ ...line, paused: true })).toBe("paused");
    expect(statusOf({ ...line, activated: false, paused: true })).toBe("waiting");
    expect(statusOf({ ...line, status: "ended" })).toBe("ended");
    expect(statusOf({ ...line, status: "revoked", paused: true })).toBe("revoked");
  });

  it("offers a station only the scan quests with the screen QR", () => {
    const categories = [
      {
        quests: [
          quest("a", "scan_qr", ["screen_qr"]),
          quest("b", "scan_qr", ["quest_qr"]),
          quest("c", "location", ["quest_qr"]),
          quest("d", "scan_qr", ["my_qr", "screen_qr"]),
        ],
      },
    ] as unknown as CategoryView[];
    expect(stationQuests(categories).map((item) => item.id)).toEqual(["a", "d"]);
  });

  it("offers a kiosk only the scan quests with the kiosk (T-309b)", () => {
    const categories = [
      {
        quests: [
          quest("a", "scan_qr", ["kiosk"]),
          quest("b", "scan_qr", ["screen_qr"]),
          quest("c", "location", ["quest_qr"]),
          quest("d", "scan_qr", ["quest_qr", "kiosk"]),
        ],
      },
    ] as unknown as CategoryView[];
    expect(kioskQuests(categories).map((item) => item.id)).toEqual(["a", "d"]);
  });
});
