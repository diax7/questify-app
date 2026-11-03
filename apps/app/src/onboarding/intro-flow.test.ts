import { DEFAULT_COMPOSED_PLAYER_INTRO, MESSAGES, type IntroCardKey } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  afterJoinRoute,
  destinationFor,
  hasLanguageStep,
  introCards,
  variantFromParams,
  type IntroVariant,
} from "#src/onboarding/intro-flow.ts";

type Pair = Readonly<Record<"ar" | "en", string>>;

/** The shipped texts by plain key, so a missing key is a failed expectation and not a type error. */
const TEXTS: Readonly<Record<string, Pair>> = MESSAGES;
const textOf = (key: string): Pair => TEXTS[key] ?? { ar: "", en: "" };

const FIRST: IntroVariant = { kind: "first" };
const REPLAY: IntroVariant = { kind: "replay" };
const JOINED: IntroVariant = { kind: "joined", eventId: "evt_1", eventName: "Riyadh Fest" };
const SHIPPED = DEFAULT_COMPOSED_PLAYER_INTRO.cards;
const titlesOf = (variant: IntroVariant, order: readonly IntroCardKey[]) =>
  introCards(variant, order).map((card) => card.title);

describe("the story cards", () => {
  it("are four, in the order of FR-1798, on the first launch and on a replay", () => {
    for (const variant of [FIRST, REPLAY]) {
      expect(titlesOf(variant, SHIPPED)).toEqual([
        "onboarding.card1.title",
        "onboarding.card2.title",
        "onboarding.card3.title",
        "onboarding.card4.title",
      ]);
    }
  });

  it("name the event in the first card after a join and keep the other three", () => {
    const cards = introCards(JOINED, SHIPPED);
    expect(cards).toHaveLength(4);
    expect(cards[0]).toMatchObject({
      title: "onboarding.joined.title",
      params: { event: "Riyadh Fest" },
    });
    expect(cards.slice(1)).toEqual(introCards(FIRST, SHIPPED).slice(1));
  });

  it("use texts that exist in both languages, with Western digits and the same placeholders", () => {
    const keys = new Set(
      [FIRST, JOINED].flatMap((variant) =>
        introCards(variant, SHIPPED).flatMap((card) => [card.title, card.body]),
      ),
    );
    expect(keys.size).toBe(10);
    for (const key of keys) {
      const text = textOf(key);
      expect(text.ar.trim(), key).not.toBe("");
      expect(text.en.trim(), key).not.toBe("");
      expect(`${text.ar}${text.en}`, key).not.toMatch(/[٠-٩۰-۹]/);
      expect(text.ar.match(/\{\w+\}/g), key).toEqual(text.en.match(/\{\w+\}/g));
    }
  });

  it("hold exactly the placeholders the card's params fill, in both languages", () => {
    const welcome = introCards(JOINED, SHIPPED)[0];
    const texts = welcome === undefined ? [] : [textOf(welcome.title), textOf(welcome.body)];
    const names = texts.flatMap((text) =>
      [...text.ar.matchAll(/\{(\w+)\}/g), ...text.en.matchAll(/\{(\w+)\}/g)].map(
        (match) => match[1],
      ),
    );
    expect([...new Set(names)]).toEqual(Object.keys(welcome?.params ?? {}));
  });
});

describe("the story cards in the platform's order (T-802b, FR-1803)", () => {
  it("play in the order given, so a reorder reaches every variant", () => {
    const order = ["prizes", "points", "quests", "join"] as const;
    for (const variant of [FIRST, REPLAY]) {
      expect(titlesOf(variant, order)).toEqual([
        "onboarding.card4.title",
        "onboarding.card3.title",
        "onboarding.card2.title",
        "onboarding.card1.title",
      ]);
    }
  });

  it("play three cards when the platform hid one", () => {
    expect(titlesOf(FIRST, ["join", "quests", "prizes"])).toEqual([
      "onboarding.card1.title",
      "onboarding.card2.title",
      "onboarding.card4.title",
    ]);
  });

  it("play a single card when the platform left one", () => {
    expect(titlesOf(REPLAY, ["points"])).toEqual(["onboarding.card3.title"]);
  });

  it("put the event's welcome where the join card stands", () => {
    expect(titlesOf(JOINED, ["quests", "join", "prizes"])).toEqual([
      "onboarding.card2.title",
      "onboarding.joined.title",
      "onboarding.card4.title",
    ]);
  });

  it("leave out the welcome when the platform hid the join card", () => {
    expect(titlesOf(JOINED, ["quests", "points", "prizes"])).toEqual([
      "onboarding.card2.title",
      "onboarding.card3.title",
      "onboarding.card4.title",
    ]);
  });

  it("give every card of the shared list its own title, body and picture", () => {
    const cards = introCards(FIRST, SHIPPED);
    expect(cards).toHaveLength(SHIPPED.length);
    expect(new Set(cards.map((card) => card.title)).size).toBe(SHIPPED.length);
    expect(new Set(cards.map((card) => card.body)).size).toBe(SHIPPED.length);
    expect(new Set(cards.map((card) => card.art)).size).toBe(SHIPPED.length);
  });
});

describe("the language step", () => {
  it("opens the first launch, once", () => {
    expect(hasLanguageStep(FIRST, false)).toBe(true);
    expect(hasLanguageStep(FIRST, true)).toBe(false);
  });

  it("is not part of a replay or of the intro after a join", () => {
    expect(hasLanguageStep(REPLAY, false)).toBe(false);
    expect(hasLanguageStep(JOINED, false)).toBe(false);
  });
});

describe("where each ending leads", () => {
  it("opens Home on Skip, and Explore on Explore events (FR-1799)", () => {
    expect(destinationFor(FIRST, "skip")).toEqual({ replace: "/home" });
    expect(destinationFor(FIRST, "explore")).toEqual({ replace: "/explore" });
  });

  it("opens the scanner over Home, so back never leaves the app", () => {
    expect(destinationFor(FIRST, "scan")).toEqual({ replace: "/home", after: "/join-scan" });
    expect(destinationFor(REPLAY, "scan")).toEqual({ replace: "/home", after: "/join-scan" });
  });

  it("returns a replay's Skip to Settings", () => {
    expect(destinationFor(REPLAY, "skip")).toBe("back");
  });

  it("ends the join variant in the event the player joined, on Skip too", () => {
    const event = { replace: "/event/evt_1?joined=1" };
    expect(destinationFor(JOINED, "event")).toEqual(event);
    expect(destinationFor(JOINED, "skip")).toEqual(event);
    expect(destinationFor(JOINED, "explore")).toEqual({ replace: "/explore" });
  });
});

describe("the route after a join", () => {
  it("goes straight to the event once the intro was seen", () => {
    expect(afterJoinRoute(false, "evt_1", "Riyadh Fest")).toBe("/event/evt_1?joined=1");
  });

  it("goes through the intro while it is due, carrying the event and its name", () => {
    expect(afterJoinRoute(true, "evt_1", "Riyadh Fest")).toBe(
      "/intro?event=evt_1&name=Riyadh%20Fest",
    );
  });

  it("encodes a name that would otherwise end the query or add one", () => {
    const route = afterJoinRoute(true, "evt_1", "A&B=C #1 مهرجان");
    expect(route).toBe(`/intro?event=evt_1&name=${encodeURIComponent("A&B=C #1 مهرجان")}`);
    expect(variantFromParams({ event: "evt_1", name: "A&B=C #1 مهرجان" })).toEqual({
      kind: "joined",
      eventId: "evt_1",
      eventName: "A&B=C #1 مهرجان",
    });
  });
});

describe("the variant a route asks for", () => {
  it("is the first launch with no params", () => {
    expect(variantFromParams({})).toEqual(FIRST);
  });

  it("is a replay for replay=1, whatever else is there", () => {
    expect(variantFromParams({ replay: "1" })).toEqual(REPLAY);
    expect(variantFromParams({ replay: "1", event: "evt_1", name: "x" })).toEqual(REPLAY);
    expect(variantFromParams({ replay: "0" })).toEqual(FIRST);
  });

  it("is the join variant for a plain event id with a name", () => {
    expect(variantFromParams({ event: "evt_1", name: "Riyadh Fest" })).toEqual(JOINED);
  });

  it("falls back to the first launch for an event id that is not a plain id", () => {
    for (const event of ["", "../home", "a/b", "evt 1", "e?x=1", "x".repeat(65)]) {
      expect(variantFromParams({ event, name: "Fest" }), event).toEqual(FIRST);
    }
  });

  it("falls back to the first launch for a missing or blank name", () => {
    expect(variantFromParams({ event: "evt_1" })).toEqual(FIRST);
    expect(variantFromParams({ event: "evt_1", name: "   " })).toEqual(FIRST);
  });

  it("cleans the name: control and direction characters go, the length is capped", () => {
    const override = String.fromCodePoint(0x202e);
    const variant = variantFromParams({
      event: "evt_1",
      name: `Fest${override}evil\nline`,
    });
    expect(variant).toEqual({ kind: "joined", eventId: "evt_1", eventName: "Fest evil line" });
    const long = variantFromParams({ event: "evt_1", name: "n".repeat(500) });
    expect(long.kind === "joined" ? long.eventName.length : 0).toBe(80);
  });

  it("reads only plain strings (a repeated param arrives as a list)", () => {
    const repeated = ["a", "b"] as unknown as string;
    expect(variantFromParams({ event: repeated, name: "Fest" })).toEqual(FIRST);
    expect(variantFromParams({ event: "evt_1", name: repeated })).toEqual(FIRST);
  });
});
