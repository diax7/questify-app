import { formatNumber, type EventTerms, type MessageKey } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { completedOutcome } from "#src/event/amount.ts";
import { spanText } from "#src/event/countdown.ts";
import { meetRefusalText } from "#src/event/meet.ts";
import { outcomeText } from "#src/event/outcome-text.ts";
import type { CompletionAnswer, NotOpenReason, QuestLock } from "#src/event/quests-api.ts";

type Translate = Parameters<typeof completedOutcome>[1];

/** A translator that shows exactly what it was asked for, so any change of key or values shows. */
const t = ((key: MessageKey, values?: Readonly<Record<string, string | number>>) =>
  `${key}|${JSON.stringify(values ?? null)}`) as Translate;

const terms = {
  currency: { ar: "نقطة", en: "point" },
  currencyPlural: { ar: "نقاط", en: "points" },
} as unknown as EventTerms;

// The inline logic as it was before the split, copied unchanged.
const OLD_LOCK_TEXT: Readonly<Record<QuestLock, MessageKey>> = {
  community_locked: "questsTab.notOpen.communityLocked",
  category_not_started: "questsTab.notOpen.categoryNotStarted",
  category_locked: "questsTab.notOpen.categoryLocked",
  order_locked: "questsTab.notOpen.orderLocked",
};
const OLD_NOT_OPEN_TEXT: Readonly<Record<NotOpenReason, MessageKey>> = {
  event_not_live: "questsTab.notOpen.eventNotLive",
  hidden: "questsTab.notOpen.hidden",
  paused: "questsTab.notOpen.paused",
  not_started: "questsTab.notOpen.notStarted",
  ended: "questsTab.notOpen.ended",
  not_for_you: "questsTab.notOpen.notForYou",
  ...OLD_LOCK_TEXT,
};
const OLD_LOCATION_TEXT = {
  no_position: "location.unavailable",
  bad_position: "location.unavailable",
  stale: "location.stale",
  imprecise: "location.imprecise",
} as const;
function oldLocationText(
  answer: Extract<CompletionAnswer, { kind: "location_refused" }>,
  language: "ar" | "en",
): string {
  if (answer.reason === "not_here") {
    return answer.distanceM === null
      ? t("location.notHereYet")
      : t("location.notHere", { distance: formatNumber(answer.distanceM, language) });
  }
  return t(answer.reason === undefined ? "location.unavailable" : OLD_LOCATION_TEXT[answer.reason]);
}
function oldOutcomeText(
  answer: CompletionAnswer,
  language: "ar" | "en",
): string | null | undefined {
  switch (answer.kind) {
    case "completed":
      return completedOutcome(answer, t, language, terms);
    case "wrong_code":
      return answer.problem?.[language] ?? t("questsTab.failed");
    case "location_refused":
      return oldLocationText(answer, language);
    case "location_off":
      return t("location.off");
    case "meet_refused":
      return meetRefusalText(answer, t);
    case "not_open":
      return answer.reason === undefined
        ? t("questsTab.notLive")
        : t(OLD_NOT_OPEN_TEXT[answer.reason]);
    case "limit":
      return t("questsTab.limit");
    case "wait": {
      const span = answer.seconds === null ? null : spanText(answer.seconds * 1000, language);
      return span === null ? t("questsTab.waitSoon") : t("questsTab.wait", { span });
    }
    case "network":
      return t("join.network");
    case "failed":
      return t("questsTab.failed");
    case "reload":
    case "signed_out":
      return null;
  }
}

const completed = (fields: Record<string, unknown>) =>
  ({
    kind: "completed",
    points: 10,
    score: 30,
    replayed: false,
    levelUp: null,
    bonus: null,
    item: null,
    boost: null,
    firstBonus: null,
    streakBonus: null,
    ...fields,
  }) as unknown as CompletionAnswer;

const LOCATION_REASONS = [
  undefined,
  "not_here",
  "no_position",
  "bad_position",
  "stale",
  "imprecise",
] as const;
const MEET_REASONS = [
  undefined,
  "bad_code",
  "expired",
  "used",
  "self",
  "same_device",
  "already_met",
  "daily_cap",
  "their_daily_cap",
  "done",
  "their_done",
  "not_in_event",
  "not_for_them",
  "off",
] as const;
const NOT_OPEN_REASONS = [undefined, ...Object.keys(OLD_NOT_OPEN_TEXT)] as readonly (
  | NotOpenReason
  | undefined
)[];

const ANSWERS: readonly CompletionAnswer[] = [
  completed({}),
  completed({ points: 0, replayed: true }),
  completed({ points: 0, replayed: false }),
  completed({
    levelUp: { level: 2, title: { ar: "ج", en: "C" }, items: [{ name: { ar: "د", en: "D" } }] },
  }),
  completed({ levelUp: { level: 3, title: { ar: "ج", en: "C" }, items: [] } }),
  completed({ levelUp: { level: 4, title: { ar: "ج", en: "C" } } }),
  completed({ bonus: { points: 50, category: { ar: "المرحلة", en: "Stage" }, item: null } }),
  completed({
    item: { name: { ar: "قميص", en: "T-shirt" }, outcome: "pending", until: null },
  }),
  completed({
    item: {
      name: { ar: "قميص", en: "T-shirt" },
      outcome: "pending",
      until: { at: "2030-01-01T12:00:00Z", timeZone: "Asia/Riyadh" },
    },
  }),
  completed({
    item: { name: { ar: "قميص", en: "T-shirt" }, outcome: "out_of_stock", until: null },
  }),
  completed({ boost: { multiplier: 2 } }),
  completed({ firstBonus: { points: 20, place: 2, slots: 5 } }),
  completed({ firstBonus: { points: 20, place: null, slots: 5 } }),
  completed({ streakBonus: { points: 25, days: 3 } }),
  completed({
    bonus: { points: 50, category: { ar: "المرحلة", en: "Stage" }, item: null },
    boost: { multiplier: 2 },
    firstBonus: { points: 20, place: 1, slots: 5 },
    streakBonus: { points: 25, days: 3 },
    item: { name: { ar: "قميص", en: "T-shirt" }, outcome: "claim_closed", until: null },
  }),
  ...[null, { ar: "خطأ", en: "Wrong" }, { ar: "", en: "" }].map(
    (problem) => ({ kind: "wrong_code", problem }) as CompletionAnswer,
  ),
  ...LOCATION_REASONS.flatMap((reason) =>
    [null, 0, 250].map(
      (distanceM) => ({ kind: "location_refused", reason, distanceM }) as CompletionAnswer,
    ),
  ),
  { kind: "location_off" },
  ...MEET_REASONS.flatMap((reason) =>
    [null, "sara"].flatMap((name) =>
      [null, 0, 5].map(
        (cap) => ({ kind: "meet_refused", reason, name, cap }) as unknown as CompletionAnswer,
      ),
    ),
  ),
  ...NOT_OPEN_REASONS.map((reason) => ({ kind: "not_open", reason }) as CompletionAnswer),
  { kind: "limit" },
  { kind: "reload" },
  ...[null, 0, 30, 59, 60, 3599, 3600, 86399, 86400, 200000].map(
    (seconds) => ({ kind: "wait", seconds }) as CompletionAnswer,
  ),
  { kind: "failed" },
  { kind: "network" },
  { kind: "signed_out" },
];

describe("outcomeText", () => {
  it("covers every answer kind", () => {
    const kinds = new Set(ANSWERS.map((answer) => answer.kind));
    expect([...kinds].sort()).toEqual(
      [
        "completed",
        "failed",
        "limit",
        "location_off",
        "location_refused",
        "meet_refused",
        "network",
        "not_open",
        "reload",
        "signed_out",
        "wait",
        "wrong_code",
      ].sort(),
    );
  });

  for (const language of ["ar", "en"] as const) {
    it(`says what the inline version said for every answer (${language})`, () => {
      for (const answer of ANSWERS) {
        expect(outcomeText(answer, t, language, terms), JSON.stringify(answer)).toEqual(
          oldOutcomeText(answer, language),
        );
      }
    });
  }
});
