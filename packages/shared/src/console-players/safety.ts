import { z } from "zod";

/**
 * The safety tools (T-705): the platform ban and its lift (FR-1416, FR-1417, FR-1606), a player's block list
 * (FR-1415) and the console's editor of the username word lists and retired names (FR-1779). The database doors
 * (migration 0120) answer these shapes.
 */

/** What `POST /v1/admin/players/:playerId/ban` and `.../lift-ban` answer. */
export const banAnswerSchema = z.strictObject({ actionId: z.uuid() });
export type BanAnswer = z.infer<typeof banAnswerSchema>;

/** How a list word matches a name: as a whole word, or anywhere inside it. */
export const WORD_MATCHES = ["word", "part"] as const;
export type WordMatch = (typeof WORD_MATCHES)[number];
export const WORD_LANGUAGES = ["ar", "en"] as const;
export type WordLanguage = (typeof WORD_LANGUAGES)[number];
/** One page of the word lists. */
export const WORDS_PAGE = 50;

const instant = z.string().min(1);

export const listWordSchema = z.strictObject({
  word: z.string().min(2),
  match: z.enum(WORD_MATCHES),
  language: z.enum(WORD_LANGUAGES),
  addedAt: instant,
});
export type ListWord = z.infer<typeof listWordSchema>;
/** What `GET /v1/admin/words` answers: a page in word order, and how many words the filter matches. */
export const wordsPageSchema = z.strictObject({
  words: z.array(listWordSchema).max(WORDS_PAGE),
  total: z.number().int().min(0),
});
export type WordsPage = z.infer<typeof wordsPageSchema>;

/**
 * A word of a real name the full-name check skips (`full_name_allow`, FR-1779, ADR-817), stored as the check folds a
 * name; its language is its letters'.
 */
export const allowWordSchema = z.strictObject({
  word: z.string().min(2),
  language: z.enum(WORD_LANGUAGES),
  addedAt: instant,
});
export type AllowWord = z.infer<typeof allowWordSchema>;
/** What `GET /v1/admin/name-allow` answers: a page in word order, and how many words the filter matches. */
export const allowPageSchema = z.strictObject({
  words: z.array(allowWordSchema).max(WORDS_PAGE),
  total: z.number().int().min(0),
});
export type AllowPage = z.infer<typeof allowPageSchema>;

export const retiredNameSchema = z.strictObject({ fold: z.string().min(3), retiredAt: instant });
export type RetiredName = z.infer<typeof retiredNameSchema>;
/** What `GET /v1/admin/retired-usernames` answers. */
export const retiredPageSchema = z.array(retiredNameSchema).max(WORDS_PAGE);

/** A blocked player as the blocker's list shows it: the current username and avatar, and when. */
export const blockedPlayerSchema = z.strictObject({
  username: z.string(),
  avatar: z.string(),
  blockedAt: instant,
});
export type BlockedPlayer = z.infer<typeof blockedPlayerSchema>;
/** What `GET /v1/me/blocks` answers. */
export const blocksAnswerSchema = z.strictObject({ blocks: z.array(blockedPlayerSchema).max(500) });
export type BlocksAnswer = z.infer<typeof blocksAnswerSchema>;
/** At most this many blocks per player (FR-1415). */
export const BLOCKS_MAX = 500;
