import {
  QUEST_TYPES,
  REVIEW_VERSION_MAX,
  REVIEW_WINDOW_DAYS,
  reviewDemoAnswerSchema,
  reviewDemoPreparedSchema,
  type MessageKey,
  type QuestType,
  type ReviewDemoPrepared,
  type ReviewDemoView,
  type ReviewReadinessItem,
} from "@questify/shared";

/** The console's App Review demo (T-710, FR-1406, FR-1407, FR-1736). */
export const REVIEW_DEMO_API = "/v1/admin/review-demo";
export const REVIEW_DEMO_CONTACT_API = `${REVIEW_DEMO_API}/contact`;
export const REVIEW_DEMO_PREPARE_API = `${REVIEW_DEMO_API}/prepare`;
export const REVIEW_DEMO_CLOSE_API = `${REVIEW_DEMO_API}/close`;

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readReviewDemo(body: unknown): ReviewDemoView | undefined {
  const parsed = reviewDemoAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data.demo : undefined;
}

/** Prepare for review's answer: the code to show once, or undefined. */
export function readPrepared(body: unknown): ReviewDemoPrepared | undefined {
  const parsed = reviewDemoPreparedSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The days and version Prepare sends, or undefined while either is not one the API takes. */
export function prepareBody(
  days: string,
  version: string,
): Readonly<{ days: number; version: string }> | undefined {
  const count = Number(days);
  const trimmed = version.trim();
  const daysOk =
    Number.isInteger(count) && count >= REVIEW_WINDOW_DAYS.min && count <= REVIEW_WINDOW_DAYS.max;
  return daysOk && trimmed.length > 0 && trimmed.length <= REVIEW_VERSION_MAX
    ? { days: count, version: trimmed }
    : undefined;
}

const DAY_KEYS: Readonly<Record<string, MessageKey>> = {
  rewards: "console.reviewDemo.item.rewards",
  livePoll: "console.reviewDemo.item.livePoll",
  communityGoal: "console.reviewDemo.item.communityGoal",
  flashQuest: "console.reviewDemo.item.flashQuest",
  boost: "console.reviewDemo.item.boost",
  nfcTag: "console.reviewDemo.item.nfcTag",
  station: "console.reviewDemo.item.station",
  sessions: "console.reviewDemo.item.sessions",
};

const VERIFY_KEYS: Readonly<Record<string, MessageKey>> = {
  quest_qr: "console.reviewDemo.verify.questQr",
  my_qr: "console.reviewDemo.verify.myQr",
  nfc: "console.reviewDemo.verify.nfc",
  screen_qr: "console.reviewDemo.verify.screenQr",
  kiosk: "console.reviewDemo.verify.kiosk",
};

/** The message that names a checklist line, or undefined for a key this build does not know (shown as is). */
export function itemKeyOf(item: ReviewReadinessItem): MessageKey | undefined {
  if (item.kind === "questType") {
    return Object.hasOwn(QUEST_TYPES, item.key)
      ? (QUEST_TYPES[item.key as QuestType].label as MessageKey)
      : undefined;
  }
  const keys = item.kind === "verification" ? VERIFY_KEYS : DAY_KEYS;
  return Object.hasOwn(keys, item.key) ? keys[item.key] : undefined;
}

export const CHECKLIST_GROUPS = [
  { kind: "questType", title: "console.reviewDemo.questTypes" },
  { kind: "verification", title: "console.reviewDemo.verifications" },
  { kind: "reviewDay", title: "console.reviewDemo.reviewDay" },
] as const satisfies readonly { kind: ReviewReadinessItem["kind"]; title: MessageKey }[];
