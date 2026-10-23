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

/**
 * Wrong entry codes (FR-322, T-105), counted per player on one quest, per player across events (a player is at one
 * event at a time), and per app install. Correct codes are not counted. With codes of 4+ letters and digits, guessing
 * cannot finish inside an event.
 */
/** An operator's player finds for a manual award (FR-308, T-207): each one can read a phone number's owner. */
export const AWARD_FIND_LIMIT = { max: 30, windowSeconds: 600 } as const;
/** The desk's finds by username or phone when My QR will not scan (FR-1848, T-209): the award find's limit. */
export const DESK_FIND_LIMIT = { max: 30, windowSeconds: 600 } as const;

export const COMPLETION_LIMITS = {
  wrongCodesPerPlayerQuest: { max: 5, windowSeconds: 600 },
  wrongCodesPerPlayer: { max: 20, windowSeconds: 600 },
  wrongCodesPerDevice: { max: 30, windowSeconds: 600 },
  /**
   * Refused location check-ins per player and quest (T-303b): enough for a player walking towards the spot, too few
   * to map the radius by script. Their own bucket: a check-in never touches the wrong-code counts.
   */
  refusedCheckInsPerPlayerQuest: { max: 10, windowSeconds: 600 },
} as const;

/**
 * Player sign-in (T-107), seconds unless the name says otherwise. Every code sent counts, first or resent: SMS costs
 * money (ADR-099) and floods a phone. A client address is only an abuse ceiling: a venue's Wi-Fi or a carrier's NAT
 * puts thousands of players behind one, so the real walls are the contact and the install.
 */
export const PLAYER_SIGN_IN_LIMITS = {
  codeLifetimeSeconds: 300,
  triesPerCode: 3,
  resendSpacingSeconds: 60,
  maxResends: 3,
  emailFallbackAfterSeconds: 30,
  codesPerContactHour: { max: 5, windowSeconds: 3600 },
  codesPerContactDay: { max: 10, windowSeconds: 86_400 },
  codesPerDeviceHour: { max: 10, windowSeconds: 3600 },
  codesPerAddressHour: { max: 200, windowSeconds: 3600 },
  failuresPerContact: { max: 10, windowSeconds: 900 },
  failuresPerContactDay: { max: 30, windowSeconds: 86_400 },
  failuresPerAddress: { max: 100, windowSeconds: 900 },
  /** All login SMS on the platform in an hour: a brake on SMS pumping; a warning at half (Q-093 tunes it). */
  smsPerHour: { max: 5000, windowSeconds: 3600 },
  /** Player email codes a day, below the mailbox's quota, so staff codes always have room (ADR-117). */
  playerEmailsPerDay: { max: 1000, windowSeconds: 86_400 },
  /** Access tokens live 1 hour and refresh tokens 180 days (migration 0013 holds the same numbers). */
  accessTokenSeconds: 3600,
  /** Codes a player may ask for to change or add a contact (T-108): every request counts, even one refused. */
  contactCodesPerPlayerHour: { max: 5, windowSeconds: 3600 },
  contactCodesPerPlayerDay: { max: 10, windowSeconds: 86_400 },
  /** Wrong contact-change codes per player, as sign-in counts them per contact. */
  contactFailuresPerPlayer: { max: 10, windowSeconds: 900 },
  contactFailuresPerPlayerDay: { max: 30, windowSeconds: 86_400 },
} as const;
