import { QUEST_TYPE_NAMES, QUEST_TYPES, type QuestVerification } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  clashes,
  flashPatch,
  listedTypes,
  toggledVerification,
  typeChangePatch,
  typedNumber,
} from "#src/lib/quest-form-rules.ts";

const SCAN_ALL = QUEST_TYPES.scan_qr.verifications;

describe("which verification methods clash (ADR-240)", () => {
  const all: readonly QuestVerification[] = ["quest_qr", "my_qr", "nfc", "screen_qr", "kiosk"];
  const clashing = all.flatMap((method) =>
    all.filter((item) => clashes(method, item)).map((item) => `${method}|${item}`),
  );
  it("only the screen QR against a printed code or its NFC tag, both ways", () => {
    expect(clashing).toEqual([
      "quest_qr|screen_qr",
      "nfc|screen_qr",
      "screen_qr|quest_qr",
      "screen_qr|nfc",
    ]);
  });
});

describe("ticking and unticking a verification method", () => {
  const cases: readonly [string, QuestVerification[], QuestVerification, boolean, string[]][] = [
    ["ticking My QR keeps the others", ["quest_qr"], "my_qr", true, ["quest_qr", "my_qr"]],
    ["unticking My QR", ["quest_qr", "my_qr"], "my_qr", false, ["quest_qr"]],
    ["ticking NFC ticks the quest QR", ["my_qr"], "nfc", true, ["quest_qr", "my_qr", "nfc"]],
    ["unticking NFC leaves the QR", ["quest_qr", "nfc"], "nfc", false, ["quest_qr"]],
    [
      "ticking the screen QR unticks the QR and NFC",
      ["quest_qr", "nfc"],
      "screen_qr",
      true,
      ["screen_qr"],
    ],
    ["the screen QR keeps My QR", ["quest_qr", "my_qr"], "screen_qr", true, ["my_qr", "screen_qr"]],
    [
      "ticking the quest QR unticks the screen QR",
      ["screen_qr", "my_qr"],
      "quest_qr",
      true,
      ["quest_qr", "my_qr"],
    ],
    ["ticking NFC unticks the screen QR", ["screen_qr"], "nfc", true, ["quest_qr", "nfc"]],
    ["unticking the last method leaves none", ["my_qr"], "my_qr", false, []],
    ["ticking the kiosk keeps the quest QR", ["quest_qr"], "kiosk", true, ["quest_qr", "kiosk"]],
  ];
  it.each(cases)("%s", (_name, current, method, on, expected) => {
    expect(toggledVerification(SCAN_ALL, current, method, on)).toEqual(expected);
  });

  it("follows the order the type offers, not the order ticked", () => {
    expect(toggledVerification(SCAN_ALL, ["nfc", "my_qr"], "quest_qr", true)).toEqual([
      "quest_qr",
      "my_qr",
      "nfc",
    ]);
  });
});

describe("the types the Type field lists", () => {
  const without = QUEST_TYPE_NAMES.filter((type) => type !== "location");
  it("hides location while the switch is off", () => {
    expect(listedTypes(QUEST_TYPE_NAMES, false, "scan_qr")).toEqual(without);
  });
  it("shows location while the switch is on", () => {
    expect(listedTypes(QUEST_TYPE_NAMES, true, "scan_qr")).toEqual([...QUEST_TYPE_NAMES]);
  });
  it("keeps location for a quest that is one, switch off", () => {
    expect(listedTypes(QUEST_TYPE_NAMES, false, "location")).toEqual([...QUEST_TYPE_NAMES]);
  });
});

describe("what changing the type resets", () => {
  it("sets the type, the config and the first verification method", () => {
    const config = { a: 1 };
    for (const type of QUEST_TYPE_NAMES) {
      const patch = typeChangePatch(type, config);
      expect(patch.type).toBe(type);
      expect(patch.config).toBe(config);
      expect(patch.verification).toEqual(QUEST_TYPES[type].verifications.slice(0, 1));
      expect("repeatCap" in patch).toBe(type === "meet");
    }
  });
  it("starts a meet quest at its default daily cap", () => {
    expect(typeChangePatch("meet", {}).repeatCap).toBe(10);
  });
});

describe("what ticking Flash changes", () => {
  const cases: readonly [string, boolean, string, string, Record<string, unknown>][] = [
    ["on, no times", true, "", "", { flash: true, visible: false }],
    ["on, only an opening", true, "2026-01-01T10:00", "", { flash: true, visible: false }],
    ["on, only a closing", true, "", "2026-01-01T10:00", { flash: true, visible: false }],
    ["on, both times", true, "2026-01-01T10:00", "2026-01-02T10:00", { flash: true }],
    ["off, no times", false, "", "", { flash: false }],
    ["off, both times", false, "2026-01-01T10:00", "2026-01-02T10:00", { flash: false }],
  ];
  it.each(cases)("%s", (_name, checked, opensAt, closesAt, expected) => {
    expect(flashPatch(checked, { opensAt, closesAt })).toEqual(expected);
  });
});

describe("a number box", () => {
  it.each([
    ["", undefined],
    ["0", 0],
    ["12", 12],
    ["-3", -3],
    ["2.5", 2.5],
  ] as const)("reads %j as %j", (text, expected) => {
    expect(typedNumber(text)).toBe(expected);
  });
});
