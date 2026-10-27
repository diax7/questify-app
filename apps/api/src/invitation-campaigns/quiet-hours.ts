import { isPromoSmsAllowed } from "#src/marketing/send-window";

/**
 * Quiet hours for invitation SMS (FR-1738, ADR-333 (4)), in two bands: the fixed 22:00 to 09:00 Riyadh band, which
 * `invitation_claim` also refuses in SQL whatever the API passes, and CST's Ramadan band (01:00 to 12:00, the send
 * window of T-407). So outside Ramadan nothing goes 22:00 to 09:00, and in Ramadan nothing goes 22:00 to 12:00.
 */

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** The claim's margin: a message claimed now may leave up to its 60-second lease later. */
export const INVITATION_LEASE_MS = 60_000;
/** Far more than the longest quiet stretch (22:00 to 12:00 is 14 hours). */
const SEARCH_HOURS = 72;

const riyadhHour = (at: Date): number =>
  Math.floor(((at.getTime() + RIYADH_OFFSET_MS) % (24 * HOUR_MS)) / HOUR_MS);

/** Whether an invitation SMS may leave at this moment (both bands). */
export function invitationSmsAllowed(at: Date): boolean {
  const hour = riyadhHour(at);
  return hour >= 9 && hour < 22 && isPromoSmsAllowed(at);
}

/** Whether the tick may claim SMS now: allowed now and still allowed when the lease runs out. */
export const invitationSmsClaimable = (at: Date): boolean =>
  invitationSmsAllowed(at) && invitationSmsAllowed(new Date(at.getTime() + INVITATION_LEASE_MS));

/** The send time an approval keeps: `at` when it is allowed, else the first full hour from `at` that is. */
export function invitationSmsTime(at: Date): Date {
  if (invitationSmsAllowed(at)) return at;
  const firstHour = Math.ceil((at.getTime() + 1) / HOUR_MS) * HOUR_MS;
  for (let step = 0; step < SEARCH_HOURS; step += 1) {
    const candidate = new Date(firstHour + step * HOUR_MS);
    if (invitationSmsAllowed(candidate)) return candidate;
  }
  throw new Error(
    "No allowed invitation SMS time within 72 hours: the quiet hours are misconfigured.",
  );
}
