import { describe, expect, it } from "vitest";
import { EVENT_TEXT_KEYS } from "#src/config/texts";
import { isLockedText } from "./locked";
import { MESSAGES } from "./messages";

describe("locked texts", () => {
  it("locks the terms and privacy screens, the acceptances, deletion and the marketing consent", () => {
    for (const key of [
      "signIn.consentBody",
      "signIn.terms",
      "signIn.privacy",
      "signIn.accept",
      "signIn.versionsChanged",
      "submission.guidelinesBody",
      "staff.accept.dpa",
      "deletion.confirm",
      "marketing.intro",
      "optOut.ask",
    ]) {
      expect(key in MESSAGES, key).toBe(true);
      expect(isLockedText(key), key).toBe(true);
    }
  });

  it("leaves ordinary texts and the event's bar labels open", () => {
    for (const key of ["nav.home", "signIn.title", "quests.title", "rewards.priceShort"]) {
      expect(isLockedText(key), key).toBe(false);
    }
    for (const key of EVENT_TEXT_KEYS) {
      expect(isLockedText(key), key).toBe(false);
    }
  });

  it("locks a future key in a legal or consent area as soon as it is added", () => {
    expect(isLockedText("legal.terms.title")).toBe(true);
    expect(isLockedText("consent.body")).toBe(true);
  });

  it("does not lock a key that only shares letters with a locked area", () => {
    expect(isLockedText("marketingTool.title")).toBe(false);
    expect(isLockedText("signInHelp.title")).toBe(false);
  });
});
