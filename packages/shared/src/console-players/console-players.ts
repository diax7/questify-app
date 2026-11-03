import { z } from "zod";
import { ACHIEVEMENT_ID } from "#src/catalog/catalog";
import { ACHIEVEMENT_TIERS } from "#src/questify/achievements";
import { legalRequestSchema } from "#src/privacy/data-requests";

/**
 * The console's player tools (T-704, FR-1774, FR-1775, FR-1702): find a player, the read-only record and points
 * record, the contact reveal, the admin rename and the sign-in reset. The database doors (migration 0118) answer these
 * shapes; contacts are masked everywhere except the reveal. Every action takes a reason code from a fixed list and a
 * note, which the database checks again.
 */

/** How the console searches: a username prefix, or a phone or an email matched exactly. */
export const PLAYER_SEARCH_BY = ["username", "phone", "email"] as const;
export type PlayerSearchBy = (typeof PLAYER_SEARCH_BY)[number];

/**
 * The reason codes each action accepts (`player_action_note` in migration 0122 holds the same lists). A ban's code is
 * what the banned player is shown (FR-1417, T-705); every other code is internal.
 */
export const PLAYER_ACTION_REASONS = {
  contact_reveal: ["support_request", "legal_request"],
  rename: ["offensive", "impersonation", "personal_data", "spam", "other"],
  reset_sign_in: ["lost_access", "compromised", "locked_out", "other"],
  ban: ["cheating", "abuse", "spam", "prize_fraud", "terms"],
  lift_ban: ["appeal_upheld", "mistake", "other"],
  revoke_tiers: ["cheating", "prize_fraud", "abuse", "other"],
  restore_tiers: ["appeal_upheld", "mistake", "other"],
} as const;
export const BAN_REASONS = PLAYER_ACTION_REASONS.ban;
export type BanReason = (typeof BAN_REASONS)[number];
export type PlayerActionKind = keyof typeof PLAYER_ACTION_REASONS;
export const PLAYER_ACTION_KINDS = Object.keys(PLAYER_ACTION_REASONS) as PlayerActionKind[];

export const PLAYER_NOTE_MIN = 10;
export const PLAYER_NOTE_MAX = 300;

/** Control and direction characters: a NUL breaks the store and a U+202E would flip the note on the record. */
const UNSAFE_CHARACTER = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/u;

/** Whether a note may be saved: 10 to 300 characters once trimmed, no control or direction character. */
export function isUsableActionNote(note: string): boolean {
  const length = [...note.trim()].length;
  return length >= PLAYER_NOTE_MIN && length <= PLAYER_NOTE_MAX && !UNSAFE_CHARACTER.test(note);
}

/** Whether `code` is one of `kind`'s reason codes. */
export function isActionReason(kind: PlayerActionKind, code: string): boolean {
  return (PLAYER_ACTION_REASONS[kind] as readonly string[]).includes(code);
}

const text = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });
const playerStatus = z.enum(["active", "banned", "deleted"]);
const instant = z.string().min(1);

/** A masked phone (`+9665•••••12`) and email (`a•••@gmail.com`); null when the account has none. */
export const maskedContactsSchema = z.strictObject({
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type MaskedContacts = z.infer<typeof maskedContactsSchema>;

export const playerSearchRowSchema = z.strictObject({
  id: z.uuid(),
  username: z.string(),
  avatar: z.string(),
  status: playerStatus,
  createdAt: instant,
  contacts: maskedContactsSchema,
});
export type PlayerSearchRow = z.infer<typeof playerSearchRowSchema>;
export const playerSearchSchema = z.array(playerSearchRowSchema).max(20);

const usernameEntry = z.strictObject({
  username: z.string(),
  reason: z.enum(["signup", "rename", "admin"]),
  changedAt: instant,
});
const eventEntry = z.strictObject({
  eventId: z.uuid(),
  event: text,
  organizer: z.string(),
  status: z.string(),
  score: z.number().int(),
  joinedAt: instant,
  excluded: z.boolean(),
});
const flagEntry = z.strictObject({
  id: z.number().int(),
  eventId: z.uuid(),
  kind: z.string(),
  status: z.string(),
  raisedAt: instant,
});
const reportEntry = z.strictObject({
  eventId: z.uuid(),
  total: z.number().int().min(0),
  open: z.number().int().min(0),
});
const actionEntry = z.strictObject({
  id: z.uuid(),
  kind: z.enum(PLAYER_ACTION_KINDS as [PlayerActionKind, ...PlayerActionKind[]]),
  reasonCode: z.string(),
  note: z.string(),
  fromUsername: z.string().nullable(),
  toUsername: z.string().nullable(),
  by: z.string(),
  at: instant,
});

/** One earned achievement tier of the player, and whether an admin revoked it (T-709c). */
const tierEntry = z.strictObject({
  id: z.string(),
  name: z.strictObject({ ar: z.string(), en: z.string() }),
  tier: z.enum(ACHIEVEMENT_TIERS),
  revoked: z.boolean(),
});
export type PlayerTier = z.infer<typeof tierEntry>;

/** An account that is not erased: everything the record shows, read-only. */
export const playerRecordSchema = z.strictObject({
  player: z.strictObject({
    id: z.uuid(),
    username: z.string(),
    avatar: z.string(),
    status: z.enum(["active", "banned"]),
    createdAt: instant,
    level: z.number().int(),
    xp: z.number().int(),
  }),
  contacts: maskedContactsSchema,
  /** The newest contact change (T-108): when, which channel, added or replaced; never the value. */
  contactsChanged: z
    .strictObject({ at: instant, channel: z.string(), kind: z.string() })
    .nullable(),
  usernames: z.array(usernameEntry),
  events: z.array(eventEntry),
  achievements: z.array(tierEntry),
  flags: z.array(flagEntry),
  reports: z.array(reportEntry),
  sessions: z.number().int().min(0),
  actions: z.array(actionEntry),
  /** Exports and erasures on a legal request or the player's own (T-708), newest first. */
  legalRequests: z.array(legalRequestSchema),
});
export type PlayerRecord = z.infer<typeof playerRecordSchema>;

/** An erased account: its id and dates only. Nothing can be done to it (FR-1776 has no restore). */
export const erasedPlayerSchema = z.strictObject({
  player: z.strictObject({
    id: z.uuid(),
    status: z.literal("deleted"),
    createdAt: instant,
    deletedAt: instant.nullable(),
  }),
  legalRequests: z.array(legalRequestSchema),
});
export type ErasedPlayer = z.infer<typeof erasedPlayerSchema>;
export const playerRecordAnswerSchema = playerRecordSchema.or(erasedPlayerSchema);
export type PlayerRecordAnswer = z.infer<typeof playerRecordAnswerSchema>;

export const ledgerLineSchema = z.strictObject({
  id: z.number().int(),
  eventId: z.uuid(),
  kind: z.string(),
  score: z.number().int(),
  balance: z.number().int(),
  quest: text.nullable(),
  reward: text.nullable(),
  /** Who made the entry, as a kind only (player, system, operator, staff). */
  actor: z.string(),
  rehearsal: z.boolean(),
  at: instant,
});
export type LedgerLine = z.infer<typeof ledgerLineSchema>;
/** One page of the points record, newest first. */
export const PLAYER_LEDGER_PAGE = 50;
export const ledgerPageSchema = z.array(ledgerLineSchema).max(PLAYER_LEDGER_PAGE);

/** The revealed contacts: shown once, never kept by the console. */
export const revealedContactsSchema = z.strictObject({
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type RevealedContacts = z.infer<typeof revealedContactsSchema>;

/** What `POST /v1/admin/players/search` answers. */
export const playerSearchAnswerSchema = z.strictObject({ players: playerSearchSchema });
/** What `GET /v1/admin/players/:playerId/ledger` answers: a page and the cursor of the next, if any. */
export const ledgerAnswerSchema = z.strictObject({
  entries: ledgerPageSchema,
  nextCursor: z.number().int().nullable(),
});
/** The most tiers one revoke or restore names (`tier_list` in migration 0122). */
export const TIER_CHANGE_MAX = 15;
/** The tiers a revoke or a restore names: 1 to 15, none twice. */
export const tierChangeListSchema = z
  .array(
    z.strictObject({
      achievementId: z.string().regex(ACHIEVEMENT_ID),
      tier: z.enum(ACHIEVEMENT_TIERS),
    }),
  )
  .min(1)
  .max(TIER_CHANGE_MAX)
  .refine(
    (tiers) => new Set(tiers.map((t) => `${t.achievementId}:${t.tier}`)).size === tiers.length,
    { message: "a tier is named twice" },
  );
export type TierChange = z.infer<typeof tierChangeListSchema>[number];

/** What `POST /v1/admin/players/:playerId/reset-sign-in` answers. */
export const resetAnswerSchema = z.strictObject({
  actionId: z.uuid(),
  endedSignIns: z.number().int().min(0),
});
