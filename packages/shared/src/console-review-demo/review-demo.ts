import { z } from "zod";
import { QUEST_TYPE_NAMES } from "#src/quests/registry";

/** The review window's bounds in days (T-710, Q-524): 14 by default, 30 at most. */
export const REVIEW_WINDOW_DAYS = { min: 1, max: 30, default: 14 } as const;

/** The longest app version the admin types at Prepare for review. */
export const REVIEW_VERSION_MAX = 20;

/** The quest verifications the readiness list checks beside the types (the printable and the staff ones). */
const READY_VERIFICATIONS = ["quest_qr", "my_qr", "nfc", "screen_qr", "kiosk"] as const;

/** The RUNBOOK's review-day items (ADR-568), in the order the page lists them. */
export const REVIEW_DAY_ITEMS = [
  "rewards",
  "livePoll",
  "communityGoal",
  "flashQuest",
  "boost",
  "nfcTag",
  "station",
  "sessions",
] as const;
export type ReviewDayItem = (typeof REVIEW_DAY_ITEMS)[number];

const iso = z.string().transform((value) => new Date(value).toISOString());

const readinessSchema = z.object({
  questTypes: z.array(z.string()),
  verifications: z.array(z.string()),
  rewards: z.number().int(),
  livePoll: z.boolean(),
  communityGoal: z.boolean(),
  flashQuest: z.boolean(),
  boost: z.boolean(),
  nfcTag: z.boolean(),
  station: z.boolean(),
  sessions: z.boolean(),
  overrides: z.record(z.string(), z.boolean()),
});

/** `console_review_demo()` as the database answers it (migration 0142). */
export const reviewDemoRawSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    organizerId: z.uuid(),
    eventId: z.uuid(),
    joinCode: z.string(),
    eventName: z.object({ ar: z.string().nullable(), en: z.string().nullable() }),
    endsAt: iso,
    contact: z.string(),
    reviewer: z
      .object({
        id: z.uuid(),
        username: z.string(),
        status: z.string(),
        lastSignInAt: iso.nullable(),
      })
      .nullable(),
    windowUntil: iso.nullable(),
    codeSet: z.boolean(),
    preparedFor: z.string().nullable(),
    preparedAt: iso.nullable(),
    fictionalPlayers: z.number().int(),
    readiness: readinessSchema,
  }),
]);
export type ReviewDemoRaw = z.infer<typeof reviewDemoRawSchema>;

/** One line of the readiness checklist: a quest type, a verification, or a review-day item, present or missing. */
export type ReviewReadinessItem = Readonly<{
  kind: "questType" | "verification" | "reviewDay";
  key: string;
  present: boolean;
}>;

const checklistSchema = z.array(
  z.object({
    kind: z.enum(["questType", "verification", "reviewDay"]),
    key: z.string(),
    present: z.boolean(),
  }),
);

/** The console page's answer: the state with the checklist laid over the registries. */
export const reviewDemoViewSchema = z.discriminatedUnion("exists", [
  z.object({ exists: z.literal(false) }),
  z.object({
    exists: z.literal(true),
    organizerId: z.uuid(),
    eventId: z.uuid(),
    joinCode: z.string(),
    eventName: z.object({ ar: z.string().nullable(), en: z.string().nullable() }),
    endsAt: z.string(),
    contact: z.string(),
    reviewer: z
      .object({
        id: z.uuid(),
        username: z.string(),
        status: z.string(),
        lastSignInAt: z.string().nullable(),
      })
      .nullable(),
    windowUntil: z.string().nullable(),
    codeSet: z.boolean(),
    preparedFor: z.string().nullable(),
    preparedAt: z.string().nullable(),
    fictionalPlayers: z.number().int(),
    overrides: z.record(z.string(), z.boolean()),
    checklist: checklistSchema,
  }),
]);
export type ReviewDemoView = z.infer<typeof reviewDemoViewSchema>;

/** A console review demo route's answer (`GET`, Create, Change number, Close). */
export const reviewDemoAnswerSchema = z.object({ demo: reviewDemoViewSchema });

/** Prepare for review's answer: the new fixed code, shown once, and the window's end. */
export const reviewDemoPreparedSchema = z.object({
  code: z.string().regex(/^[0-9]{6}$/),
  windowUntil: z.string(),
  demo: reviewDemoViewSchema,
});
export type ReviewDemoPrepared = z.infer<typeof reviewDemoPreparedSchema>;

/**
 * Lays the registries over what the demo event holds (ADR-568): every quest type and verification the reviewed app
 * offers, then the review-day items, each present or missing.
 */
export function reviewDemoChecklist(
  readiness: ReviewDemoRaw & { exists: true },
): ReviewReadinessItem[] {
  const held = readiness.readiness;
  return [
    ...QUEST_TYPE_NAMES.map((key) => ({
      kind: "questType" as const,
      key,
      present: held.questTypes.includes(key),
    })),
    ...READY_VERIFICATIONS.map((key) => ({
      kind: "verification" as const,
      key,
      present: held.verifications.includes(key),
    })),
    ...REVIEW_DAY_ITEMS.map((key) => ({
      kind: "reviewDay" as const,
      key,
      present: key === "rewards" ? held.rewards > 0 : held[key],
    })),
  ];
}

/** The view of a raw answer: the checklist composed, the readiness counts dropped. */
export function reviewDemoView(raw: ReviewDemoRaw): ReviewDemoView {
  if (!raw.exists) {
    return raw;
  }
  const { readiness, ...rest } = raw;
  return { ...rest, overrides: readiness.overrides, checklist: reviewDemoChecklist(raw) };
}
