import {
  MESSAGES,
  consentHistorySchema,
  ledgerAnswerSchema,
  playerRecordAnswerSchema,
  playerSearchAnswerSchema,
  resetAnswerSchema,
  revealedContactsSchema,
  type ConsentHistory,
  type LedgerLine,
  type MessageKey,
  type PlayerRecordAnswer,
  type PlayerSearchRow,
  type RevealedContacts,
} from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

/** The console's player tools (T-704): search, the record and points record, and the three actions. */
export const PLAYERS_SEARCH_API = "/v1/admin/players/search";
/** The API path of one player. The id always comes from a checked answer or a checked address, so it is a UUID. */
export const playerPath = (playerId: string): string => `/v1/admin/players/${playerId}`;
export const contactPath = (playerId: string): string => `${playerPath(playerId)}/contact`;
export const renamePath = (playerId: string): string => `${playerPath(playerId)}/username`;
export const resetPath = (playerId: string): string => `${playerPath(playerId)}/reset-sign-in`;
export const banPath = (playerId: string): string => `${playerPath(playerId)}/ban`;
export const liftBanPath = (playerId: string): string => `${playerPath(playerId)}/lift-ban`;
/** Revoke or restore achievement tiers (T-709c). */
export const tierPath = (playerId: string, action: "revoke" | "restore"): string =>
  `${playerPath(playerId)}/achievement-tiers/${action}`;
/** One earned tier as a key: the achievement and the tier. */
export const tierKey = (tier: Readonly<{ id: string; tier: string }>): string =>
  `${tier.id}:${tier.tier}`;

/** One page of the points record: all events or one, after the last id of the page before. */
export function ledgerPath(
  playerId: string,
  query: Readonly<{ eventId: string | null; before: number | null }>,
): string {
  const params = new URLSearchParams();
  if (query.eventId !== null) {
    params.set("eventId", query.eventId);
  }
  if (query.before !== null) {
    params.set("before", String(query.before));
  }
  const text = params.toString();
  return `${playerPath(playerId)}/ledger${text === "" ? "" : `?${text}`}`;
}

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readSearch(body: unknown): PlayerSearchRow[] | undefined {
  const parsed = playerSearchAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data.players : undefined;
}

export function readRecord(body: unknown): PlayerRecordAnswer | undefined {
  const parsed = playerRecordAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export type LedgerPage = Readonly<{ entries: LedgerLine[]; nextCursor: number | null }>;

export function readLedger(body: unknown): LedgerPage | undefined {
  const parsed = ledgerAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function readRevealed(body: unknown): RevealedContacts | undefined {
  const parsed = revealedContactsSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The player's marketing consent (T-407's read, audited by the API). */
export const consentPath = (playerId: string): string =>
  `${playerPath(playerId)}/marketing-consent`;

export function readConsent(body: unknown): ConsentHistory | undefined {
  const parsed = consentHistorySchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** How many sign-ins a reset ended. */
export function readResetAnswer(body: unknown): number | undefined {
  const parsed = resetAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data.endedSignIns : undefined;
}

/** A code from the API (`support_request`, `far_from_venue`) as the camelCase part of a message key. */
export const camel = (code: string): string =>
  code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/**
 * The words for a code from a fixed set (`console.player.reason.supportRequest`), or the code itself when the catalog
 * has none, so a code a newer API adds still shows something true.
 */
export function codeLabel(t: Translate, prefix: string, code: string): string {
  const key = `${prefix}.${camel(code)}`;
  return Object.hasOwn(MESSAGES, key) ? t(key as MessageKey) : code;
}
