/**
 * Limits on starting an export or the report (T-608, FR-1206): an export reads every row of an event and each start
 * writes an audit entry, so one event runs one export at a time and one staff member starts only so many in a window.
 * The state lives in this process: a second instance has its own counts, which only makes the limit looser, never wrong.
 */
export const EXPORT_LIMITS = {
  /** Starts one staff member may make in {@link EXPORT_LIMITS.windowMs}. */
  perStaff: 30,
  windowMs: 10 * 60 * 1000,
  /** A running export that never reports its end frees its event after this long. */
  claimMs: 15 * 60 * 1000,
} as const;

export type ExportGate = Readonly<{
  /** Takes the event's one export slot; the function it answers gives the slot back. Undefined when it is taken. */
  claim: (organizerId: string, eventId: string) => (() => void) | undefined;
  /**
   * Counts a start against the staff member and answers how to take it back (a start for an event they cannot reach
   * wrote no audit entry and should not use up their allowance), or the seconds to wait when the window is full.
   */
  admit: (staffUserId: string) => Admission;
}>;

export type Admission =
  | Readonly<{ admitted: true; refund: () => void }>
  | Readonly<{ admitted: false; retryAfterSeconds: number }>;

export function createExportGate(now: () => number = Date.now): ExportGate {
  const claims = new Map<string, number>();
  const starts = new Map<string, number[]>();
  return {
    claim(organizerId, eventId) {
      const key = `${organizerId}:${eventId}`;
      const expires = claims.get(key);
      if (expires !== undefined && expires > now()) {
        return undefined;
      }
      const mine = now() + EXPORT_LIMITS.claimMs;
      claims.set(key, mine);
      return () => {
        if (claims.get(key) === mine) {
          claims.delete(key);
        }
      };
    },
    admit(staffUserId) {
      const since = now() - EXPORT_LIMITS.windowMs;
      const recent = (starts.get(staffUserId) ?? []).filter((at) => at > since);
      const oldest = recent[0];
      if (oldest !== undefined && recent.length >= EXPORT_LIMITS.perStaff) {
        starts.set(staffUserId, recent);
        return { admitted: false, retryAfterSeconds: Math.ceil((oldest - since) / 1000) };
      }
      const at = now();
      recent.push(at);
      starts.set(staffUserId, recent);
      let refunded = false;
      return {
        admitted: true,
        refund: () => {
          const held = starts.get(staffUserId) ?? [];
          const index = held.lastIndexOf(at);
          if (!refunded && index >= 0) {
            held.splice(index, 1);
          }
          refunded = true;
        },
      };
    },
  };
}
