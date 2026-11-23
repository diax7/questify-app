import { describe, expect, it } from "vitest";
import {
  acceptsLocked,
  applyRequired,
  belowGiven,
  boostInUse,
  categoryInUse,
  categoryNotEmpty,
  confirmRequired,
  eventClosed,
  firstBonusPaid,
  goalInUse,
  hasCompletions,
  idempotencyKeyInvalid,
  idempotencyKeyReused,
  imageUnknown,
  invalidCategory,
  invalidFirstBonus,
  invalidItem,
  invalidQuest,
  lastCategory,
  limitReached,
  notFound,
  orderStale,
  overCap,
  pastKeyRequired,
  pastNotLive,
  pointsChoiceRequired,
  pollLocked,
  questLocked,
  rehearsalData,
  resultsFinal,
  souvenirInUse,
  stepInUse,
  submissionKindUnavailable,
  tagsInUse,
} from "#src/auth/http-errors";
import type { HttpError } from "#src/http-error";
import type { BuilderQuest, Done, Refused } from "#src/quests/builder";
import { answer, questView } from "#src/quests/routes";

const thrown = (run: () => unknown): HttpError => {
  try {
    run();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("nothing was thrown");
};

const CASES: ReadonlyArray<[Refused, "quest" | "category", HttpError]> = [
  [{ kind: "not_found" }, "quest", notFound()],
  [{ kind: "event_closed" }, "quest", eventClosed()],
  [{ kind: "confirm_required" }, "quest", confirmRequired()],
  [{ kind: "invalid", field: "title" }, "quest", invalidQuest({ field: "title" })],
  [{ kind: "invalid", field: "name" }, "category", invalidCategory({ field: "name" })],
  [{ kind: "limit_reached", limit: 40 }, "quest", limitReached({ limit: 40 })],
  [{ kind: "order_stale" }, "quest", orderStale()],
  [{ kind: "last_category" }, "category", lastCategory()],
  [{ kind: "category_not_empty", quests: 3 }, "category", categoryNotEmpty({ quests: 3 })],
  [{ kind: "category_in_use", categories: [] }, "category", categoryInUse({ categories: [] })],
  [{ kind: "has_completions" }, "quest", hasCompletions()],
  [{ kind: "rehearsal_data" }, "quest", rehearsalData()],
  [
    { kind: "submission_kind_unavailable", asked: "video" },
    "quest",
    submissionKindUnavailable({ asked: "video" }),
  ],
  [{ kind: "quest_locked" }, "quest", questLocked()],
  [{ kind: "step_in_use" }, "quest", stepInUse()],
  [{ kind: "goal_in_use" }, "quest", goalInUse()],
  [{ kind: "boost_in_use" }, "quest", boostInUse()],
  [{ kind: "tags_in_use" }, "quest", tagsInUse()],
  [{ kind: "souvenir_in_use", what: "quest" }, "quest", souvenirInUse("quest", "quest")],
  [{ kind: "souvenir_in_use", what: "quest" }, "category", souvenirInUse("quest", "category")],
  [
    { kind: "souvenir_in_use", what: "category" },
    "category",
    souvenirInUse("category", "category"),
  ],
  [{ kind: "invalid_item" }, "quest", invalidItem()],
  [{ kind: "poll_locked", field: "live" }, "quest", pollLocked({ field: "live" })],
  [{ kind: "first_bonus_paid" }, "quest", firstBonusPaid()],
  [{ kind: "below_given", given: 4 }, "quest", belowGiven({ given: 4 })],
  [{ kind: "invalid_first_bonus", field: "slots" }, "quest", invalidFirstBonus({ field: "slots" })],
  [{ kind: "accepts_locked" }, "quest", acceptsLocked()],
  [{ kind: "apply_required" }, "quest", applyRequired()],
  [{ kind: "points_choice_required" }, "quest", pointsChoiceRequired()],
  [{ kind: "key_required" }, "quest", pastKeyRequired()],
  [{ kind: "key_invalid" }, "quest", idempotencyKeyInvalid()],
  [{ kind: "event_not_live" }, "quest", pastNotLive()],
  [{ kind: "results_final" }, "quest", resultsFinal()],
  [{ kind: "key_reused" }, "quest", idempotencyKeyReused()],
  [{ kind: "over_cap", limit: 9 }, "quest", overCap({ cap: "each", limit: 9 })],
  [{ kind: "image_unknown", field: "image" }, "quest", imageUnknown({ field: "image" })],
];

describe("answer", () => {
  it("hands a done answer's value to ok", () => {
    const result: Done<number> = { kind: "done", value: 7 };
    expect(answer(result, (value) => value + 1)).toBe(8);
  });

  it.each(CASES)("throws the answer for %j as the %s's", (refusal, subject, expected) => {
    const error = thrown(() => answer(refusal, () => "never", subject));
    expect(error.status).toBe(expected.status);
    expect(error.envelope).toEqual(expected.envelope);
  });

  it("names the quest by default", () => {
    const error = thrown(() => answer({ kind: "invalid", field: "title" }, () => "never"));
    expect(error.envelope).toEqual(invalidQuest({ field: "title" }).envelope);
  });
});

const quest = (over: Partial<BuilderQuest>): BuilderQuest =>
  ({
    id: "q1",
    categoryId: "c1",
    type: "location",
    title: { ar: "ا", en: "A" },
    description: { ar: "", en: "" },
    points: 5,
    repeatCap: 1,
    opensAt: null,
    closesAt: null,
    visible: true,
    position: 0,
    config: {},
    verification: [],
    itemId: null,
    place: null,
    pollSentAt: null,
    flash: false,
    flashLaunchedAt: null,
    paused: false,
    skipped: false,
    firstBonus: null,
    steps: [],
    ...over,
  }) as unknown as BuilderQuest;

describe("questView", () => {
  it("shows empty dates as null and no steps for a plain quest", () => {
    const view = questView(quest({}));
    expect(view).toMatchObject({
      opensAt: null,
      closesAt: null,
      pollSentAt: null,
      flashLaunchedAt: null,
    });
    expect("steps" in view).toBe(false);
  });

  it("shows each date as ISO text", () => {
    const at = new Date("2026-11-23T10:00:00.000Z");
    const view = questView(
      quest({ opensAt: at, closesAt: at, pollSentAt: at, flashLaunchedAt: at }),
    );
    expect(view).toMatchObject({
      opensAt: "2026-11-23T10:00:00.000Z",
      closesAt: "2026-11-23T10:00:00.000Z",
      pollSentAt: "2026-11-23T10:00:00.000Z",
      flashLaunchedAt: "2026-11-23T10:00:00.000Z",
    });
  });

  it("lists a passport's steps by id, name and position", () => {
    const view = questView(
      quest({
        type: "passport",
        steps: [{ id: "s1", name: { ar: "ا", en: "A" }, position: 1, extra: 1 }],
      } as unknown as Partial<BuilderQuest>),
    );
    expect(view).toMatchObject({ steps: [{ id: "s1", name: { ar: "ا", en: "A" }, position: 1 }] });
    expect(JSON.stringify((view as { steps: unknown }).steps)).not.toContain("extra");
  });
});
