import { describe, expect, it } from "vitest";
import { joinPath, landingOf, textIn, tokenFromHash } from "#src/lib/invitation-landing.ts";

const TOKEN = "AAAAAAAAAAAAAAAAAAAAAA";

const event = {
  id: "44444444-4444-4444-8444-444444444444",
  joinCode: "QFY1",
  name: { ar: "مهرجان", en: "Festival" },
  venue: { ar: null, en: "Riyadh Hall" },
  kind: "in_person",
  timezone: "Asia/Riyadh",
  startsAt: "2026-11-05T09:00:00+00:00",
  endsAt: null,
  statusNow: "scheduled",
};

describe("tokenFromHash", () => {
  it("reads the 22 characters after the #", () => {
    expect(tokenFromHash(`#${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromHash("#Ab-_Ab-_Ab-_Ab-_Ab-_Ab")).toBe("Ab-_Ab-_Ab-_Ab-_Ab-_Ab");
  });

  it.each([
    "",
    "#",
    `#${TOKEN}x`,
    `#${TOKEN.slice(1)}`,
    `#token=${TOKEN}`,
    "#AAAAAAAAAAAAAAAAAAAA!A",
  ])("finds no token in %j", (hash) => {
    expect(tokenFromHash(hash)).toBeUndefined();
  });
});

describe("landingOf", () => {
  it("shows the public event card of an open that worked", () => {
    expect(landingOf({ ok: true, status: 200, body: { event } })).toEqual({
      kind: "found",
      event,
    });
  });

  it("does not trust an answer with anything about a player in it", () => {
    expect(landingOf({ ok: true, status: 200, body: { event, player: "x" } })).toEqual({
      kind: "unavailable",
    });
    expect(landingOf({ ok: true, status: 200, body: undefined })).toEqual({ kind: "unavailable" });
  });

  it.each([
    [404, "ended"],
    [400, "missing"],
    [429, "throttled"],
    [500, "unavailable"],
    [0, "unavailable"],
  ])("reads the status %d as %s", (status, kind) => {
    expect(landingOf({ ok: false, status, body: undefined })).toEqual({ kind });
  });
});

describe("joinPath", () => {
  it("is the plain join link, in the page's language", () => {
    expect(joinPath("ar", "QFY1")).toBe("/ar/e/QFY1");
    expect(joinPath("en", "a/b")).toBe("/en/e/a%2Fb");
  });
});

describe("textIn", () => {
  it("prefers the page's language, then the other, then nothing", () => {
    expect(textIn({ ar: "ا", en: "A" }, "ar")).toBe("ا");
    expect(textIn({ ar: null, en: "A" }, "ar")).toBe("A");
    expect(textIn({ ar: "ا", en: null }, "en")).toBe("ا");
    expect(textIn({ ar: null, en: null }, "en")).toBe("");
  });
});
