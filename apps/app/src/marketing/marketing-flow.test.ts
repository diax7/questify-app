import { MARKETING_TEXT_VERSION, MESSAGES, type Marketing } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { eventTitle } from "#src/marketing/for-you.ts";
import {
  CHANNEL_TEXT,
  NO_TICKS,
  atLanding,
  consentNotice,
  consentStepDue,
  preferencesChanged,
  preferencesNotice,
  rememberAnswer,
  signupBody,
  switchBody,
  ticksOf,
  toggleInterest,
} from "#src/marketing/marketing-flow.ts";

const STATE = (optedIn: boolean) => ({
  optedIn,
  changedAt: optedIn ? "2030-01-01T00:00:00Z" : null,
});

describe("the bodies", () => {
  it("name every channel on the sign-up step, so a skip is three recorded opt-outs", () => {
    expect(signupBody(NO_TICKS)).toEqual({
      textVersion: MARKETING_TEXT_VERSION,
      method: "signup",
      channels: { push: false, sms: false, email: false },
    });
    expect(signupBody({ push: true, sms: false, email: true }).channels).toEqual({
      push: true,
      sms: false,
      email: true,
    });
  });

  it("name only the channel that moved in settings", () => {
    expect(switchBody("sms", true)).toEqual({
      textVersion: MARKETING_TEXT_VERSION,
      method: "settings",
      channels: { sms: true },
    });
    expect(switchBody("email", false).channels).toEqual({ email: false });
  });

  it("start with every channel off", () => {
    expect(Object.values(NO_TICKS)).toEqual([false, false, false]);
  });
});

describe("ticksOf", () => {
  it("reads the switches from the server's state", () => {
    const marketing: Marketing = {
      channels: { push: STATE(false), sms: STATE(true), email: STATE(false) },
      asked: true,
      canOptIn: true,
    };
    expect(ticksOf(marketing)).toEqual({ push: false, sms: true, email: false });
  });
});

describe("the text", () => {
  it("has a title and a description for each channel in both languages", () => {
    for (const text of Object.values(CHANNEL_TEXT)) {
      for (const key of [text.title, text.about]) {
        expect(MESSAGES[key].ar.length, key).toBeGreaterThan(0);
        expect(MESSAGES[key].en.length, key).toBeGreaterThan(0);
      }
    }
  });
});

describe("consentNotice", () => {
  it.each([
    ["saved", "marketing.saved"],
    ["outdated", "marketing.outdated"],
    ["age", "marketing.ageLimited"],
    ["limited", "marketing.limited"],
    ["failed", "marketing.failed"],
    ["network", "join.network"],
    ["signed_out", null],
  ] as const)("says %s with %s", (kind, key) => {
    const outcome =
      kind === "saved"
        ? ({
            kind,
            marketing: { channels: {}, asked: true, canOptIn: true },
          } as unknown as Parameters<typeof consentNotice>[0])
        : ({ kind } as Parameters<typeof consentNotice>[0]);
    expect(consentNotice(outcome)).toBe(key);
  });
});

const me = (asked: boolean, canOptIn: boolean, id = "p1") => ({
  id,
  marketing: { asked, canOptIn },
});

describe("consentStepDue", () => {
  it("is due only for a player who never answered and may opt in", () => {
    expect(consentStepDue(me(false, true, "due-1"))).toBe(true);
    expect(consentStepDue(me(true, true))).toBe(false);
    expect(consentStepDue(me(false, false))).toBe(false);
    expect(consentStepDue({ id: "p1" })).toBe(false);
    expect(consentStepDue(undefined)).toBe(false);
  });

  it("is not due again in this run once the player answered, even if the profile read fails to say so", () => {
    expect(consentStepDue(me(false, true, "answered-1"))).toBe(true);
    rememberAnswer("answered-1");
    expect(consentStepDue(me(false, true, "answered-1"))).toBe(false);
    expect(consentStepDue(me(false, true, "someone-else"))).toBe(true);
  });
});

describe("atLanding", () => {
  it("lets the step interrupt the launch screen and Questify home only", () => {
    expect(atLanding([])).toBe(true);
    expect(atLanding(["index"])).toBe(true);
    expect(atLanding(["home"])).toBe(true);
    for (const route of [
      "join",
      "sign-in",
      "reaccept",
      "marketing-consent",
      "event",
      "daily-word",
    ]) {
      expect(atLanding([route]), route).toBe(false);
    }
  });
});

describe("toggleInterest", () => {
  it("adds and removes one, and stops at eight", () => {
    expect(toggleInterest([], "sport")).toEqual(["sport"]);
    expect(toggleInterest(["sport", "music"], "sport")).toEqual(["music"]);
    const full = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(toggleInterest(full, "i")).toBe(full);
    expect(toggleInterest(full, "h")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});

describe("preferencesChanged", () => {
  const saved = { cityId: "sa-riyadh", interests: ["sport", "music"] };

  it("is false for the same city and the same interests in any order", () => {
    expect(preferencesChanged(saved, "sa-riyadh", ["music", "sport"])).toBe(false);
  });

  it("is true for another city, a missing city, an added, removed or swapped interest", () => {
    expect(preferencesChanged(saved, "sa-jeddah", ["sport", "music"])).toBe(true);
    expect(preferencesChanged(saved, null, ["sport", "music"])).toBe(true);
    expect(preferencesChanged(saved, "sa-riyadh", ["sport"])).toBe(true);
    expect(preferencesChanged(saved, "sa-riyadh", ["sport", "music", "art"])).toBe(true);
    expect(preferencesChanged(saved, "sa-riyadh", ["sport", "art"])).toBe(true);
  });

  it("is true when the last interest is cleared (the change is kept, FR-733)", () => {
    expect(preferencesChanged({ cityId: null, interests: ["sport"] }, null, [])).toBe(true);
  });
});

describe("preferencesNotice", () => {
  it.each([
    ["invalid", "interests.invalid"],
    ["limited", "marketing.limited"],
    ["failed", "interests.saveFailed"],
    ["network", "join.network"],
    ["signed_out", null],
  ] as const)("says %s with %s", (kind, key) => {
    expect(preferencesNotice({ kind } as Parameters<typeof preferencesNotice>[0])).toBe(key);
  });

  it("says saved", () => {
    expect(preferencesNotice({ kind: "saved", preferences: { cityId: null, interests: [] } })).toBe(
      "interests.saved",
    );
  });
});

describe("eventTitle", () => {
  it("uses the screen's language, else the other, else the join code", () => {
    const named = { joinCode: "ABC234", name: { ar: "ملتقى", en: "Meetup" } };
    expect(eventTitle(named, "ar")).toBe("ملتقى");
    expect(eventTitle(named, "en")).toBe("Meetup");
    expect(eventTitle({ joinCode: "ABC234", name: { ar: null, en: "Meetup" } }, "ar")).toBe(
      "Meetup",
    );
    expect(eventTitle({ joinCode: "ABC234", name: { ar: null, en: null } }, "en")).toBe("ABC234");
  });
});
