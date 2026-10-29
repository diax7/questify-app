import { describe, expect, it } from "vitest";
import {
  ORGANIZER_ALERT_TYPES,
  organizerAlertSwitchesSchema,
} from "#src/organizer-alerts/organizer-alerts";

const allOn = Object.fromEntries(ORGANIZER_ALERT_TYPES.map((type) => [type, true]));

describe("organizerAlertSwitchesSchema", () => {
  it("names the seven types of FR-1727, size limits as one", () => {
    expect([...ORGANIZER_ALERT_TYPES]).toEqual([
      "activated",
      "stock_low",
      "codes_low",
      "new_flags",
      "content_unpublished",
      "support_access",
      "size_limit",
    ]);
  });

  it("takes the whole set of booleans and nothing else", () => {
    expect(organizerAlertSwitchesSchema.parse(allOn)).toEqual(allOn);
    expect(organizerAlertSwitchesSchema.safeParse({ ...allOn, size_limit: false }).success).toBe(
      true,
    );
  });

  it("refuses a missing type, an unknown key and a value that is not a boolean", () => {
    const { activated: _dropped, ...partial } = allOn;
    expect(organizerAlertSwitchesSchema.safeParse(partial).success).toBe(false);
    expect(organizerAlertSwitchesSchema.safeParse({ ...allOn, marketing: true }).success).toBe(
      false,
    );
    expect(organizerAlertSwitchesSchema.safeParse({ ...allOn, activated: "yes" }).success).toBe(
      false,
    );
    expect(organizerAlertSwitchesSchema.safeParse({ ...allOn, activated: 1 }).success).toBe(false);
    expect(organizerAlertSwitchesSchema.safeParse(null).success).toBe(false);
  });
});
