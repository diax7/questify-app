/** A team member's view of a Draft or Scheduled event is a rehearsal (operators use the same screens, ADR-080). */
export const isRehearsalStatus = (statusNow: string | undefined): boolean =>
  statusNow === "draft" || statusNow === "scheduled";
