import { describe, expect, it } from "vitest";
import {
  flashAlreadyLaunched,
  flashCommunityLocked,
  flashEventNotLive,
  flashNotStarted,
  flashScheduled,
  flashTooLate,
  notFlashQuest,
  notFound,
  platformFeatureOff,
} from "#src/auth/http-errors";
import type { HttpError } from "#src/http-error";
import { flashValueOf } from "#src/plays/routes";
import type { FlashRefusal } from "#src/quests/flash";

const thrown = (run: () => unknown): HttpError => {
  try {
    run();
  } catch (error) {
    return error as HttpError;
  }
  throw new Error("nothing was thrown");
};

const ANSWERS: ReadonlyArray<[FlashRefusal["kind"], () => HttpError]> = [
  ["not_found", notFound],
  ["not_flash", notFlashQuest],
  ["event_not_live", flashEventNotLive],
  ["feature_off", platformFeatureOff],
  ["already_launched", flashAlreadyLaunched],
  ["scheduled", flashScheduled],
  ["community_locked", flashCommunityLocked],
  ["too_late", flashTooLate],
  ["not_started", flashNotStarted],
];

describe("flashValueOf", () => {
  it("returns the window of a done answer", () => {
    const value = { opensAt: "a", closesAt: "b", replayed: false };
    expect(flashValueOf({ kind: "done", value })).toBe(value);
  });

  it.each(ANSWERS)("throws the answer for %s", (kind, expected) => {
    const error = thrown(() => flashValueOf({ kind }));
    expect(error.status).toBe(expected().status);
    expect(error.envelope).toEqual(expected().envelope);
  });
});
