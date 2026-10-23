import { z } from "zod";
import { toWesternDigits } from "#src/i18n/digits";

/** An entry code: ASCII letters and digits only, so an Arabic or an English keyboard types the same thing. */
const ENTRY_CODE = /^[A-Za-z0-9]{4,32}$/;

const hintText = z.string().trim().min(1).max(200).optional();
/** An id the dashboard makes for an option, a question or a choice; stable once players answered (ADR-194). */
const itemId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
/** Organizer text of at most `max` characters, in at least one language (FR-1008). */
const organizerText = (max: number) =>
  z
    .strictObject({
      ar: z.string().trim().min(1).max(max).optional(),
      en: z.string().trim().min(1).max(max).optional(),
    })
    .refine((text) => text.ar !== undefined || text.en !== undefined);
const distinctIds = (items: readonly Readonly<{ id: string }>[]): boolean =>
  new Set(items.map((item) => item.id)).size === items.length;
const quizQuestion = z
  .strictObject({
    id: itemId,
    text: organizerText(300),
    choices: z
      .array(z.strictObject({ id: itemId, text: organizerText(120) }))
      .min(2)
      .max(6),
    right: itemId,
  })
  .refine(
    (question) =>
      distinctIds(question.choices) &&
      question.choices.some((choice) => choice.id === question.right),
  );
/** One survey question (ADR-198): a choice (2 to 10), a rating from 1 to 5, or short text; required unless said not. */
const surveyQuestion = z.discriminatedUnion("kind", [
  z.strictObject({
    id: itemId,
    text: organizerText(300),
    kind: z.literal("choice"),
    required: z.boolean().default(true),
    choices: z
      .array(z.strictObject({ id: itemId, text: organizerText(120) }))
      .min(2)
      .max(10)
      .refine(distinctIds),
  }),
  z.strictObject({
    id: itemId,
    text: organizerText(300),
    kind: z.literal("rating"),
    required: z.boolean().default(true),
  }),
  z.strictObject({
    id: itemId,
    text: organizerText(300),
    kind: z.literal("text"),
    required: z.boolean().default(true),
  }),
]);
/** A link a share quest adds to its message: https only, so no other scheme reaches the share sheet. */
const shareLink = z
  .url({ protocol: /^https$/, normalize: false })
  .max(300)
  .regex(/^https:\/\/\S+$/);
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
    oneTry: false,
    usesQuestQr: true,
    verifications: ["quest_qr", "my_qr"],
    config: z.strictObject({}),
  },
  /** The player types a code shown at the venue (T-105). The code is a secret: never shown to players. */
  enter_code: {
    label: "quests.type.enterCode",
    oneTry: false,
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
  /**
   * The player sends text; the team reviews it, or it is approved at once (T-301, ADR-184). Photos are T-301b and
   * video is never in v1 (FR-1006): `accepts` holds text only, and `unavailableSubmissionKind` names what was asked for.
   */
  submission: {
    label: "quests.type.submission",
    oneTry: false,
    usesQuestQr: false,
    verifications: [],
    config: z.strictObject({
      accepts: z.tuple([z.literal("text")]).default(["text"]),
      autoApprove: z.boolean().default(false),
      resubmit: z.boolean().default(false),
    }),
  },
  /**
   * The player picks one of the organizer's options (T-302, FR-207). Options are the organizer's own text, never a
   * player's submission (FR-1629); images wait for storage (ADR-190). One vote per player.
   */
  vote: {
    label: "quests.type.vote",
    oneTry: true,
    usesQuestQr: false,
    verifications: [],
    config: z.strictObject({
      options: z
        .array(z.strictObject({ id: itemId, text: organizerText(120) }))
        .min(2)
        .max(10)
        .refine(distinctIds),
    }),
  },
  /**
   * Multiple-choice questions served one at a time, one try each, points per right answer, an optional timer for every
   * question (T-302, FR-208 to FR-210, ADR-191, ADR-192). One attempt per player. The right answers never reach a
   * player before they answer.
   */
  quiz: {
    label: "quests.type.quiz",
    oneTry: true,
    usesQuestQr: false,
    verifications: [],
    config: z.strictObject({
      questions: z.array(quizQuestion).min(1).max(20).refine(distinctIds),
      timerSeconds: z.number().int().min(5).max(300).nullable().default(null),
    }),
  },
  /**
   * A task done in front of staff (T-303, FR-203, ADR-197): only an operator's station scan of the player's My QR, or a
   * manual award, completes it. The quest's description says what to do; the player has nothing to scan.
   */
  challenge: {
    label: "quests.type.challenge",
    oneTry: false,
    usesQuestQr: false,
    verifications: ["my_qr"],
    config: z.strictObject({}),
  },
  /**
   * Questions with no right answer (T-303, FR-214, ADR-198), paid on submit, one response per player. The answers
   * reach only the event's owners and editors, names not shown.
   */
  survey: {
    label: "quests.type.survey",
    oneTry: true,
    usesQuestQr: false,
    verifications: [],
    config: z.strictObject({
      questions: z.array(surveyQuestion).min(1).max(20).refine(distinctIds),
    }),
  },
  /**
   * The player shares the organizer's message through the phone's share sheet and is paid once, with no proof step
   * (T-303, FR-219, FR-220, ADR-034, ADR-199). The event's `shareQuests` switch hides them all.
   */
  share: {
    label: "quests.type.share",
    oneTry: true,
    usesQuestQr: false,
    verifications: [],
    config: z.strictObject({
      message: organizerText(500),
      link: shareLink.optional(),
    }),
  },
} as const;

/** The longest text a player may write for one survey answer (ADR-198). */
export const SURVEY_TEXT_MAX = 500;

/** The seconds a quiz answer is still taken after its question's time ran out, for the network (ADR-192, Q-157). */
export const QUIZ_GRACE_SECONDS = 2;

/** The longest text a player may send for a submission quest (Q-150). */
export const SUBMISSION_TEXT_MAX = 1000;

/**
 * The submission kind a config asks for that this version cannot take (FR-1006): `video` (never in v1) or `photo`
 * (T-301b); undefined when it asks for neither.
 */
export function unavailableSubmissionKind(config: unknown): "photo" | "video" | undefined {
  const accepts =
    typeof config === "object" && config !== null
      ? (config as { accepts?: unknown }).accepts
      : undefined;
  if (!Array.isArray(accepts)) {
    return undefined;
  }
  if (accepts.includes("video")) {
    return "video";
  }
  return accepts.includes("photo") ? "photo" : undefined;
}

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
