/** Every number that shapes staff sign-in, in one place. Seconds unless the name says otherwise. */
export const AUTH_LIMITS = {
  /** Failed password or code attempts per email in the window, counted across challenges. */
  failuresPerEmail: { max: 8, windowSeconds: 900 },
  /** Failed attempts per client address (an IPv6 /64 counts as one address). */
  failuresPerAddress: { max: 30, windowSeconds: 900 },
  /** Challenges (emailed codes) a user can start per hour, however they are used. */
  challengesPerUser: { max: 5, windowSeconds: 3600 },
  challengeValiditySeconds: 600,
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
