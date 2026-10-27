import { describe, expect, it } from "vitest";
import { ACCOUNT_REFUSALS, invitationOutcome } from "#src/invitation-campaigns/sender";

describe("invitationOutcome", () => {
  it("records a message Msegat accepted as sent", () => {
    expect(invitationOutcome({ kind: "sent" })).toEqual({ outcome: "sent", code: null });
  });

  it.each(["timeout", "network", "http_502"])("keeps %s as unknown, never resent", (reason) => {
    expect(invitationOutcome({ kind: "unknown", reason })).toEqual({
      outcome: "unknown",
      code: reason,
    });
  });

  it.each(["1060", "1110", "M0030", "M0037", "M0090", "unreachable"])(
    "holds the channel on the account refusal %s",
    (reason) => {
      expect(invitationOutcome({ kind: "refused", reason })).toEqual({
        outcome: "hold",
        code: reason,
      });
    },
  );

  it.each(["1120", "1061", "M0008", "1140", "not_configured"])(
    "fails the one message on %s",
    (reason) => {
      expect(invitationOutcome({ kind: "refused", reason })).toEqual({
        outcome: "failed",
        code: reason,
      });
    },
  );

  it("never stores a reason that is not a plain code", () => {
    expect(invitationOutcome({ kind: "refused", reason: "+966 50 123 4567" })).toEqual({
      outcome: "failed",
      code: "other",
    });
    expect(invitationOutcome({ kind: "unknown", reason: "x".repeat(41) }).code).toBe("other");
  });

  it("knows exactly the account refusals of INTEGRATIONS.md", () => {
    expect([...ACCOUNT_REFUSALS].toSorted()).toEqual(
      ["1060", "1110", "M0030", "M0037", "M0090", "unreachable"].toSorted(),
    );
  });
});
