/** Every number that shapes staff sign-in, in one place. Seconds unless the name says otherwise. */
export const AUTH_LIMITS = {
  /** Failed password or code attempts per email in the window, counted across challenges. */
  failuresPerEmail: { max: 8, windowSeconds: 900 },
  /** Failed attempts per client address (an IPv6 /64 counts as one address). */
  failuresPerAddress: { max: 30, windowSeconds: 900 },
  /** Challenges (emailed codes) a user can start per hour, however they are used. */
  challengesPerUser: { max: 5, windowSeconds: 3600 },
  challengeValiditySeconds: 600,
  /** Password-reset emails asked for per email and per client address (T-020). */
  resetRequestsPerEmail: { max: 3, windowSeconds: 3600 },
  resetRequestsPerAddress: { max: 10, windowSeconds: 3600 },
  resetValiditySeconds: 1800,
  /** Organizer sign-ups started per email and per client address (T-101). */
  signupsPerEmail: { max: 3, windowSeconds: 3600 },
  signupsPerAddress: { max: 10, windowSeconds: 3600 },
  /** Organizers one signed-in person may create in a day. */
  organizersPerUser: { max: 5, windowSeconds: 86_400 },
  /** Team invites: pending per organizer, sent per day before and after the first event is activated (T-101). */
  invitesPending: 20,
  invitesPerDay: { activated: 30, notActivated: 10, windowSeconds: 86_400 },
  inviteValiditySeconds: 7 * 86_400,
  /** Looking at or accepting an invite link without signing in, per client address. */
  inviteChecksPerAddress: { max: 20, windowSeconds: 3600 },
  /** Sign-up and invite email for the whole platform per day, well under the provider's quota (T-101). */
  outboundMailPerDay: { max: 400, windowSeconds: 86_400 },
  /** The database caps attempts per challenge at 5 and resends at 3; these mirror those checks. */
  maxCodeAttempts: 5,
  maxResends: 3,
  resendSpacingSeconds: 60,
  maxLiveSessions: 10,
  /** Idle limit and maximum age by role. Admins get shorter sessions (ADR-078 risk, R9). */
  session: {
    staff: { idleSeconds: 30 * 60, maxAgeSeconds: 12 * 3600 },
    admin: { idleSeconds: 15 * 60, maxAgeSeconds: 8 * 3600 },
  },
  /** last_seen_at is written at most this often, so a page full of requests is not a page full of writes. */
  touchIntervalSeconds: 60,
  /** The retention sweep runs at most this often per process. */
  sweepIntervalMs: 10 * 60 * 1000,
  /** Password checks that may run at once, and how long another waits for a place. */
  verifyGate: { limit: 4, waitMs: 2000 },
} as const;

export type SessionLimits = Readonly<{ idleSeconds: number; maxAgeSeconds: number }>;

/** The idle and maximum-age limits that apply to a platform role. */
export function sessionLimitsFor(platformRole: "none" | "admin"): SessionLimits {
  return platformRole === "admin" ? AUTH_LIMITS.session.admin : AUTH_LIMITS.session.staff;
}
