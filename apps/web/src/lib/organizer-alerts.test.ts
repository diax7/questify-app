import { MESSAGES, ORGANIZER_ALERT_TYPES } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  ALERT_LABELS,
  ALERT_ORDER,
  readAlertSwitches,
  withAlertSwitch,
} from "#src/lib/organizer-alerts.ts";

const allOn = Object.fromEntries(ORGANIZER_ALERT_TYPES.map((type) => [type, true]));

describe("the organizer alert switches on the team page", () => {
  it("words every type in both languages and lists all seven", () => {
    expect([...ALERT_ORDER].toSorted()).toEqual([...ORGANIZER_ALERT_TYPES].toSorted());
    for (const type of ORGANIZER_ALERT_TYPES) {
      const words = MESSAGES[ALERT_LABELS[type]];
      expect(words.ar.trim(), type).not.toBe("");
      expect(words.en.trim(), type).not.toBe("");
    }
  });

  it("reads an answer only when it is exactly the seven booleans", () => {
    expect(readAlertSwitches(allOn)).toEqual(allOn);
    expect(readAlertSwitches({ ...allOn, size_limit: "yes" })).toBeUndefined();
    expect(readAlertSwitches({ ...allOn, extra: true })).toBeUndefined();
    expect(readAlertSwitches(undefined)).toBeUndefined();
    expect(readAlertSwitches({ code: "not_found" })).toBeUndefined();
  });

  it("changes one type and leaves the rest, without touching the original", () => {
    const before = readAlertSwitches(allOn);
    if (before === undefined) throw new Error("the fixture is not valid");
    const after = withAlertSwitch(before, "new_flags", false);
    expect(after).toEqual({ ...allOn, new_flags: false });
    expect(before.new_flags).toBe(true);
  });
});
