import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { questAvailability } from "#src/quests/web-availability.ts";

const NEEDS_APP = {
  kind: "needs_app",
  text: "quests.needsApp",
  hint: "quests.needsAppHint",
} as const;
const AVAILABLE = { kind: "available" } as const;

describe("questAvailability", () => {
  it("says a quest that only a tag can finish needs the phone app on the web", () => {
    expect(questAvailability("web", { verification: ["nfc"] })).toEqual(NEEDS_APP);
  });

  it("plays that same quest on both phones", () => {
    expect(questAvailability("ios", { verification: ["nfc"] })).toEqual(AVAILABLE);
    expect(questAvailability("android", { verification: ["nfc"] })).toEqual(AVAILABLE);
  });

  it("plays a quest with a QR code on the web even when a tag is also offered", () => {
    expect(questAvailability("web", { verification: ["quest_qr", "nfc"] })).toEqual(AVAILABLE);
    expect(questAvailability("web", { verification: ["nfc", "screen_qr"] })).toEqual(AVAILABLE);
  });

  it("plays a quest shown or typed, or the kiosk's, on the web", () => {
    expect(questAvailability("web", { verification: ["my_qr"] })).toEqual(AVAILABLE);
    expect(questAvailability("web", { verification: ["kiosk", "nfc"] })).toEqual(AVAILABLE);
    expect(questAvailability("web", { verification: ["quest_qr"] })).toEqual(AVAILABLE);
  });

  it("plays a quest with no verification (a quiz, a vote, a code, a location) on the web", () => {
    expect(questAvailability("web", { verification: [] })).toEqual(AVAILABLE);
  });

  it("leaves a method this app does not know to the server", () => {
    expect(questAvailability("web", { verification: ["hologram"] })).toEqual(AVAILABLE);
    expect(questAvailability("web", { verification: ["constructor"] })).toEqual(AVAILABLE);
    expect(questAvailability("web", { verification: ["nfc", "hologram"] })).toEqual(AVAILABLE);
  });
});

describe("the texts of a quest that needs the phone app", () => {
  it("are written in both languages", () => {
    expect(MESSAGES["quests.needsApp"]).toEqual({
      ar: "متاحة في تطبيق Questify فقط",
      en: "Needs the phone app",
    });
    expect(MESSAGES["quests.needsAppHint"]).toEqual({
      ar: "افتح التطبيق على هاتفك لتلعبها",
      en: "Open the Questify app on your phone",
    });
    expect(MESSAGES["dataExport.doneWeb"]).toEqual({
      ar: "جاهز. ستجد الملف في التنزيلات.",
      en: "Done. The file is in your downloads.",
    });
  });
});
