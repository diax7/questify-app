import { z } from "zod";
import { toWesternDigits } from "#src/i18n/digits";

/** An entry code: ASCII letters and digits only, so an Arabic or an English keyboard types the same thing. */
const ENTRY_CODE = /^[A-Za-z0-9]{4,32}$/;

const hintText = z.string().trim().min(1).max(200).optional();
/** Organizer text: at least one language when given (FR-1008). */
const bilingualHint = z
  .strictObject({ ar: hintText, en: hintText })
  .refine((hint) => hint.ar !== undefined || hint.en !== undefined)
  .optional();

/**
 * The quest types the reviewed app can complete (FR-1505: a quest is a type plus a reward plus rules). Each quest task
 * adds its type here, with its config schema and its messages, in the same change that builds the player's side, and
 * widens the database's `quest_type_known` check. Rewards, rules and text stay organizer data; a type never arrives
 * by configuration (ADR-004, ADR-007).
 */
export const QUEST_TYPES = {
  /** The player scans the quest's QR code (T-104 signs it; T-105 completes it). */
  scan_qr: {
    label: "quests.type.scanQr",
    usesQuestQr: true,
    verifications: ["quest_qr", "my_qr"],
    config: z.strictObject({}),
  },
  /** The player types a code shown at the venue (T-105). The code is a secret: never shown to players. */
  enter_code: {
    label: "quests.type.enterCode",
    usesQuestQr: false,
    verifications: [],
    config: z.strictObject({
      code: z
        .string()
        .trim()
        .regex(ENTRY_CODE)
        .transform((code) => code.toUpperCase()),
      /** Where the code is shown, for the organizer's team; optional. */
      hint: bilingualHint,
    }),
  },
} as const;

export type QuestType = keyof typeof QUEST_TYPES;

/**
 * How a quest may be verified (FR-301): the player scans the quest's printed QR, or staff scan the player's My QR
 * (T-205). A type lists the methods it offers; a quest keeps at least one of them (none for a type that offers none,
 * such as a typed code). The database's `quest_verification_known` check holds the same rule.
 */
export type QuestVerification = "quest_qr" | "my_qr";

export const QUEST_TYPE_NAMES = Object.keys(QUEST_TYPES) as QuestType[];

/**
 * The hosts whose `/q/{token}` links are printed quest codes (ADR-116: the dashboard's address). A build may read one
 * more, staging for a demo (the app's `EXPO_PUBLIC_QUEST_CODE_ORIGIN`).
 */
export const QUEST_CODE_HOSTS: readonly string[] = ["questify.nafes.com"];

/** The types whose quests carry a printed quest QR (FR-305): scanned to complete, or as a fallback (FR-216). */
export const QR_QUEST_TYPES = QUEST_TYPE_NAMES.filter((type) => QUEST_TYPES[type].usesQuestQr);

export function isQuestType(value: string): value is QuestType {
  return Object.hasOwn(QUEST_TYPES, value);
}

/**
 * A typed entry code as the quest stores it: Arabic-Indic and Persian digits made Western (ADR-018), spaces trimmed,
 * letters upper-case.
 */
export function normalizeEntryCode(typed: string): string {
  return toWesternDigits(typed).trim().toUpperCase();
}

/** A type's config as stored: validated and normalized (an entry code upper-cased), or undefined when it is not one. */
export function parseQuestConfig(
  type: QuestType,
  value: unknown,
): Record<string, unknown> | undefined {
  const result = QUEST_TYPES[type].config.safeParse(value);
  return result.success ? (result.data as Record<string, unknown>) : undefined;
}

/**
 * A quest's verification methods as stored: each one offered by the type, without repeats, in the type's order, and
 * at least one when the type offers any; undefined when the value is not that. Left out (undefined), a new quest gets
 * the type's first method and an existing one keeps its own (`current`).
 */
export function parseVerification(
  type: QuestType,
  value: unknown,
  current?: readonly QuestVerification[],
): QuestVerification[] | undefined {
  const offered: readonly QuestVerification[] = QUEST_TYPES[type].verifications;
  if (value === undefined) {
    return [...(current ?? offered.slice(0, 1))];
  }
  if (
    !Array.isArray(value) ||
    !value.every((item) => offered.includes(item as QuestVerification))
  ) {
    return undefined;
  }
  const chosen = offered.filter((method) => value.includes(method));
  return offered.length > 0 && chosen.length === 0 ? undefined : chosen;
}
