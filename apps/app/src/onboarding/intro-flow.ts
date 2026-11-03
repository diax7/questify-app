import type { IntroCardKey, MessageKey } from "@questify/shared";

/**
 * Which intro this is: the first launch (a language step, then the cards), the cards again from Settings, or the cards
 * for a player who has just joined an event from a join QR or link (FR-1801).
 */
export type IntroVariant =
  | Readonly<{ kind: "first" }>
  | Readonly<{ kind: "replay" }>
  | Readonly<{ kind: "joined"; eventId: string; eventName: string }>;

/** The pictures the cards show; `IntroArt` maps each to an image. */
export type CardArt = "compass" | "steps" | "crown" | "gift";

export type IntroCard = Readonly<{
  title: MessageKey;
  body: MessageKey;
  art: CardArt;
  /** Values the card's texts fill in. */
  params?: Readonly<Record<string, string>>;
}>;

/** The four story cards (FR-1798): join an event, do quests, earn points and climb, win prizes and grow a profile. */
const STORY: Readonly<Record<IntroCardKey, IntroCard>> = {
  join: { title: "onboarding.card1.title", body: "onboarding.card1.body", art: "compass" },
  quests: { title: "onboarding.card2.title", body: "onboarding.card2.body", art: "steps" },
  points: { title: "onboarding.card3.title", body: "onboarding.card3.body", art: "crown" },
  prizes: { title: "onboarding.card4.title", body: "onboarding.card4.body", art: "gift" },
};

const welcomeCard = (eventName: string): IntroCard => ({
  title: "onboarding.joined.title",
  body: "onboarding.joined.body",
  art: "compass",
  params: { event: eventName },
});

/**
 * The cards of a variant, in the order the platform chose (`order`, T-802b). For a player who has just joined, the join
 * card (how to join) names the event they are in instead, where it stands; if the platform hid the join card, so is it.
 */
export function introCards(
  variant: IntroVariant,
  order: readonly IntroCardKey[],
): readonly IntroCard[] {
  return order.map((key) =>
    key === "join" && variant.kind === "joined" ? welcomeCard(variant.eventName) : STORY[key],
  );
}

/** Whether the language choice comes first: on the first launch only, and not again after the restart it caused. */
export const hasLanguageStep = (variant: IntroVariant, languageDone: boolean): boolean =>
  variant.kind === "first" && !languageDone;

/** How the intro ended; `event` is the join variant's way into the event they joined. */
export type Ending = "skip" | "scan" | "explore" | "event";

/** Where an ending leads: back where Settings was, or a screen that replaces the intro (and maybe one pushed over it). */
export type Destination = "back" | Readonly<{ replace: string; after?: string }>;

const eventRoute = (eventId: string): string => `/event/${eventId}?joined=1`;

/**
 * Where each ending goes. Skip on the first launch opens Home (FR-1799); the scanner opens over Home so back never
 * leaves the app. A replay's Skip returns to Settings. The join variant ends in the event the player joined.
 */
export function destinationFor(variant: IntroVariant, ending: Ending): Destination {
  if (ending === "explore") {
    return { replace: "/explore" };
  }
  if (ending === "scan") {
    return { replace: "/home", after: "/join-scan" };
  }
  if (variant.kind === "joined") {
    return { replace: eventRoute(variant.eventId) };
  }
  return variant.kind === "replay" ? "back" : { replace: "/home" };
}

const EVENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EVENT_NAME = 80;
// Control and direction characters would reorder or break a line (the same set the translation store refuses).
const UNSAFE_CHARACTER = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;

/** The route params of the intro screen, as the router hands them over. */
export type IntroParams = Readonly<{
  replay?: string | undefined;
  event?: string | undefined;
  name?: string | undefined;
}>;

/**
 * The variant a route asks for. An event id that is not a plain id, or a missing name, gives the first-launch intro: the
 * params only ever come from the app's own join screens, and anything else must not shape a route or a text.
 */
export function variantFromParams(params: IntroParams): IntroVariant {
  if (params.replay === "1") {
    return { kind: "replay" };
  }
  // A repeated query param reaches the screen as a list; only a plain string is read.
  const { event, name } = params;
  const eventName = (typeof name === "string" ? name : "")
    .replace(UNSAFE_CHARACTER, " ")
    .trim()
    .slice(0, MAX_EVENT_NAME);
  if (typeof event === "string" && EVENT_ID.test(event) && eventName !== "") {
    return { kind: "joined", eventId: event, eventName };
  }
  return { kind: "first" };
}

/**
 * Where "Go to the event" leads after a join (FR-1801): the intro first while it is due on this install, then the event,
 * as ADR-096 orders it (the join card came first). The name travels in the route, so the cards name the event.
 */
export function afterJoinRoute(introIsDue: boolean, eventId: string, eventName: string): string {
  return introIsDue
    ? `/intro?event=${encodeURIComponent(eventId)}&name=${encodeURIComponent(eventName)}`
    : eventRoute(eventId);
}
