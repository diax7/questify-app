import type { SmsResult } from "#src/players/sms";

/**
 * What one invitation message's send means for its row (ADR-333 (3)). A refusal for the account (Msegat's balance
 * `1060`, sender `1110`, a sender without the `AD` ending `M0030`, a template mismatch `M0090`, the static-IP check
 * `M0037`, or the gateway unreachable twice) holds the whole SMS channel and puts the message back: no account problem
 * ever fails a message. Any other refusal is about the number and fails that message. A timeout or an unreadable
 * answer is `unknown` and is never sent again (Msegat has no idempotency key).
 */
export type InvitationOutcome = Readonly<{
  outcome: "sent" | "unknown" | "failed" | "hold";
  /** The provider's code or the sender's reason, never contact or text. */
  code: string | null;
}>;

export const ACCOUNT_REFUSALS: ReadonlySet<string> = new Set([
  "1060",
  "1110",
  "M0030",
  "M0037",
  "M0090",
  "unreachable",
]);

const CODE = /^[A-Za-z0-9_]{1,40}$/;
const codeOf = (reason: string): string => (CODE.test(reason) ? reason : "other");

export function invitationOutcome(result: SmsResult): InvitationOutcome {
  switch (result.kind) {
    case "sent":
      return { outcome: "sent", code: null };
    case "unknown":
      return { outcome: "unknown", code: codeOf(result.reason) };
    case "refused":
      return {
        outcome: ACCOUNT_REFUSALS.has(result.reason) ? "hold" : "failed",
        code: codeOf(result.reason),
      };
  }
}
