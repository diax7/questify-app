import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES, type MemberSponsors } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { NO_SPONSORS, fetchSponsors, lookupOf, narrowTo } from "#src/event/sponsors.ts";

const ACME = "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f";
const BETA = "2f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f";
const Q1 = "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f";
const Q2 = "4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f";
const Q3 = "5f5f5f5f-5f5f-4f5f-8f5f-5f5f5f5f5f5f";
const CAT_A = "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f";
const CAT_B = "7f7f7f7f-7f7f-4f7f-8f7f-7f7f7f7f7f7f";
const REWARD = "8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f";
const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const requester = (answer: AuthedResult) => ({
  request: vi.fn(async (_request: unknown) => answer),
});

const data: MemberSponsors = {
  sponsors: [
    { id: ACME, name: { ar: "أكمي", en: "Acme" }, tier: "gold", booth: "B14" },
    { id: BETA, name: { ar: "بيتا", en: "Beta" }, tier: "bronze", booth: null },
  ],
  tags: [
    { kind: "quest", targetId: Q1, sponsorId: ACME },
    { kind: "category", targetId: CAT_B, sponsorId: ACME },
    { kind: "reward", targetId: REWARD, sponsorId: BETA },
  ],
};

describe("reading the sponsors", () => {
  it("reads them from the player's own endpoint", async () => {
    const call = requester(ok(data));
    const read = await fetchSponsors(call, ACME);
    expect(read).toEqual({ kind: "sponsors", data });
    expect(call.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/events/${ACME}/sponsors`,
    });
  });

  it("tells a signed-out player, a failure and a malformed answer apart", async () => {
    expect(await fetchSponsors(requester({ kind: "signed_out" }), ACME)).toEqual({
      kind: "signed_out",
    });
    expect(await fetchSponsors(requester({ kind: "network" }), ACME)).toEqual({ kind: "network" });
    expect(await fetchSponsors(requester(ok({ sponsors: [{}], tags: [] })), ACME)).toEqual({
      kind: "network",
    });
  });
});

describe("who presents what", () => {
  const lookup = lookupOf(data);

  it("finds the sponsor of a quest, a category and a reward, and none for an untagged item", () => {
    expect(lookup.of("quest", Q1)?.id).toBe(ACME);
    expect(lookup.of("category", CAT_B)?.id).toBe(ACME);
    expect(lookup.of("reward", REWARD)?.id).toBe(BETA);
    expect(lookup.of("quest", Q2)).toBeUndefined();
    expect(lookup.of("category", Q1)).toBeUndefined();
  });

  it("lists the sponsors in the order the door gave and finds one by id", () => {
    expect(lookup.sponsors.map((sponsor) => sponsor.id)).toEqual([ACME, BETA]);
    expect(lookup.byId(BETA)?.name.en).toBe("Beta");
    expect(lookup.byId(Q1)).toBeUndefined();
  });

  it("is empty before the read, after a failure and for an event with no sponsors", () => {
    expect(lookupOf(undefined)).toBe(NO_SPONSORS);
    expect(lookupOf({ sponsors: [], tags: [] })).toBe(NO_SPONSORS);
    expect(NO_SPONSORS.of("quest", Q1)).toBeUndefined();
  });
});

describe("one sponsor's quests", () => {
  const categories = [
    { id: CAT_A, quests: [{ id: Q1 }, { id: Q2 }] },
    { id: CAT_B, quests: [{ id: Q3 }] },
    { id: "empty", quests: [] },
  ];
  const lookup = lookupOf(data);

  it("keeps a quest tagged to the sponsor and every quest of a category tagged to it", () => {
    expect(narrowTo(categories, ACME, lookup)).toEqual([
      { id: CAT_A, quests: [{ id: Q1 }] },
      { id: CAT_B, quests: [{ id: Q3 }] },
    ]);
  });

  it("is empty for a sponsor with nothing tagged", () => {
    expect(narrowTo(categories, BETA, lookup)).toEqual([]);
  });
});

describe("the player app and sponsors (FR-1304)", () => {
  it("sends nothing about the player to a sponsor and offers no link out", () => {
    const files = readdirSync(join(__dirname))
      .filter((name) => /^(sponsors|Sponsor|PresentedBy|useSponsors)/.test(name))
      .filter((name) => !name.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const name of files) {
      expect(readFileSync(join(__dirname, name), "utf8"), name).not.toMatch(
        /Linking|openURL|WebBrowser|mailto:|tel:|https?:\/\/|analytics|track/i,
      );
    }
  });

  it("has words in both languages for the strip and the screen", () => {
    for (const key of [
      "sponsors.strip.title",
      "sponsors.strip.open",
      "sponsors.presentedBy",
      "sponsors.screen.empty",
      "sponsors.boothLine",
    ] as const) {
      expect(MESSAGES[key].ar).not.toBe("");
      expect(MESSAGES[key].en).not.toBe("");
    }
  });
});
