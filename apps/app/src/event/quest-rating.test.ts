import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchRating, ratingViewOf, sendRating } from "#src/event/quest-rating.ts";

const QUEST = "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f";
const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const refused = (status: number): AuthedResult => ({
  kind: "error",
  status,
  code: "x",
  message: null,
  details: {},
  headers,
});
const requester = (answer: AuthedResult) => ({
  request: vi.fn(async (_request: unknown) => answer),
});

describe("reading the rating", () => {
  it("asks the player's own endpoint for the quest", async () => {
    const call = requester(ok({ on: true, thumb: null }));
    expect(await fetchRating(call, QUEST)).toEqual({
      kind: "rating",
      rating: { on: true, thumb: null },
    });
    expect(call.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/quests/${QUEST}/rating`,
    });
  });

  it("tells a missing quest from a network problem, and passes a signed-out session on", async () => {
    expect(await fetchRating(requester(refused(404)), QUEST)).toEqual({ kind: "none" });
    expect(await fetchRating(requester(refused(503)), QUEST)).toEqual({ kind: "network" });
    expect(await fetchRating(requester({ kind: "signed_out" }), QUEST)).toEqual({
      kind: "signed_out",
    });
  });

  it("treats an answer of the wrong shape as a network problem rather than guessing", async () => {
    for (const body of [null, {}, { on: "yes", thumb: null }, { on: true, thumb: "left" }]) {
      expect(await fetchRating(requester(ok(body)), QUEST), JSON.stringify(body)).toEqual({
        kind: "network",
      });
    }
  });
});

describe("sending a rating", () => {
  it("puts the thumb to the quest's rating and reads the stored answer", async () => {
    const call = requester(ok({ on: true, thumb: "up" }));
    expect(await sendRating(call, QUEST, "up")).toEqual({
      kind: "rating",
      rating: { on: true, thumb: "up" },
    });
    expect(call.request).toHaveBeenCalledWith({
      method: "PUT",
      path: `/v1/quests/${QUEST}/rating`,
      body: { thumb: "up" },
    });
  });

  it("shows nothing when the owner has since turned ratings off, and a retry on a network problem", async () => {
    expect(await sendRating(requester(refused(409)), QUEST, "up")).toEqual({ kind: "none" });
    expect(await sendRating(requester(refused(500)), QUEST, "up")).toEqual({ kind: "network" });
  });
});

describe("what the sheet shows", () => {
  it("asks when ratings are on and the player has said nothing", () => {
    expect(ratingViewOf({ kind: "rating", rating: { on: true, thumb: null } })).toBe("ask");
  });

  it("thanks a player who gave a thumb, and never asks again after a skip", () => {
    expect(ratingViewOf({ kind: "rating", rating: { on: true, thumb: "up" } })).toBe("up");
    expect(ratingViewOf({ kind: "rating", rating: { on: true, thumb: "down" } })).toBe("down");
    expect(ratingViewOf({ kind: "rating", rating: { on: true, thumb: "skip" } })).toBe("none");
  });

  it("shows nothing while ratings are off, while loading, or when the read failed", () => {
    expect(ratingViewOf({ kind: "rating", rating: { on: false, thumb: null } })).toBe("none");
    expect(ratingViewOf(undefined)).toBe("none");
    expect(ratingViewOf({ kind: "network" })).toBe("none");
    expect(ratingViewOf({ kind: "none" })).toBe("none");
  });
});

describe("the prompt's words and place", () => {
  const SOURCE = readFileSync(join(__dirname, "QuestRating.tsx"), "utf8");

  it("has every string in Arabic and English", () => {
    for (const key of [
      "rating.prompt",
      "rating.up",
      "rating.down",
      "rating.skip",
      "rating.thanks",
      "rating.failed",
    ] as const) {
      expect(MESSAGES[key].ar, key).not.toBe("");
      expect(MESSAGES[key].en, key).not.toBe("");
    }
  });

  it("names its thumbs for a screen reader and gives the player a skip", () => {
    expect(SOURCE).toContain('label={t("rating.up")}');
    expect(SOURCE).toContain('label={t("rating.down")}');
    expect(SOURCE).toContain('label={t("rating.skip")}');
  });

  it("is asked only for a quest the player completed", () => {
    expect(SOURCE).toContain("quest.done > 0");
  });
});
