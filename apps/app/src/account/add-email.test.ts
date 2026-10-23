import { describe, expect, it } from "vitest";
import { offersAddEmail } from "#src/account/add-email.ts";
import type { Me } from "#src/auth/player.tsx";

const me = (phone: string | null, email: string | null): Me => ({
  id: "p",
  username: "sara",
  avatar: "falcon",
  legal: { toAccept: [], guidelinesAccepted: false },
  identifiers: { phone, email },
  questify: undefined,
});

describe("offersAddEmail", () => {
  it("invites a phone-only player once", () => {
    expect(offersAddEmail(me("•••• 4567", null), false)).toBe(true);
    expect(offersAddEmail(me("•••• 4567", null), true)).toBe(false);
  });

  it("never invites a player who has an email, or no phone", () => {
    expect(offersAddEmail(me("•••• 4567", "s•••@najd.sa"), false)).toBe(false);
    expect(offersAddEmail(me(null, "s•••@najd.sa"), false)).toBe(false);
  });

  it("waits for the profile", () => {
    expect(offersAddEmail(undefined, false)).toBe(false);
  });
});
