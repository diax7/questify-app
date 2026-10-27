import {
  MARKETING_TEXT_VERSION,
  MAX_PLAYER_INTERESTS,
  type Marketing,
  type MarketingBody,
  type MarketingChannel,
  type MarketingSummary,
  type MessageKey,
  type Preferences,
} from "@questify/shared";
import type { ConsentOutcome, PreferencesOutcome } from "#src/marketing/marketing-api.ts";

/** The three choices on the sign-up step, all off (FR-735): what the screen starts from. */
export type Ticks = Readonly<Record<MarketingChannel, boolean>>;
export const NO_TICKS: Ticks = { push: false, sms: false, email: false };

/** The text for each channel's title and its one-line description. */
export const CHANNEL_TEXT: Readonly<
  Record<MarketingChannel, Readonly<{ title: MessageKey; about: MessageKey }>>
> = {
  push: { title: "marketing.channel.push", about: "marketing.about.push" },
  sms: { title: "marketing.channel.sms", about: "marketing.about.sms" },
  email: { title: "marketing.channel.email", about: "marketing.about.email" },
};

/** The sign-up step's body: every channel named, so a skip is three recorded opt-outs. */
export const signupBody = (ticks: Ticks): MarketingBody => ({
  textVersion: MARKETING_TEXT_VERSION,
  method: "signup",
  channels: { ...ticks },
});

/** A settings switch's body: only the channel that moved. */
export const switchBody = (channel: MarketingChannel, on: boolean): MarketingBody => ({
  textVersion: MARKETING_TEXT_VERSION,
  method: "settings",
  channels: { [channel]: on },
});

/** The channels as the switches show them. */
export const ticksOf = (marketing: Marketing): Ticks => ({
  push: marketing.channels.push.optedIn,
  sms: marketing.channels.sms.optedIn,
  email: marketing.channels.email.optedIn,
});

/** The line a consent save answers with, or null when nothing needs saying. */
export function consentNotice(outcome: ConsentOutcome): MessageKey | null {
  switch (outcome.kind) {
    case "saved":
      return "marketing.saved";
    case "outdated":
      return "marketing.outdated";
    case "age":
      return "marketing.ageLimited";
    case "limited":
      return "marketing.limited";
    case "failed":
      return "marketing.failed";
    case "network":
      return "join.network";
    case "signed_out":
      return null;
  }
}

const answeredHere = new Set<string>();

/** Remembers, for this run of the app, that the player answered the step, whatever the next profile read says. */
export const rememberAnswer = (playerId: string): void => {
  answeredHere.add(playerId);
};

/**
 * Whether the one-time step is due: never answered (here or on the server), and old enough to be asked (ADR-316,
 * ADR-317). An answer saved just now counts at once, so a profile read that fails afterwards cannot show it again.
 */
export const consentStepDue = (
  me: Readonly<{ id: string; marketing?: MarketingSummary | undefined }> | undefined,
): boolean =>
  me?.marketing !== undefined &&
  !me.marketing.asked &&
  me.marketing.canOptIn &&
  !answeredHere.has(me.id);

/** The routes the step may interrupt: the two places the app lands, never a join, a sign-in or a game in progress. */
export function atLanding(segments: readonly string[]): boolean {
  const first = segments[0];
  return first === undefined || first === "index" || first === "home";
}

/** The chosen interests after one is tapped; a tap beyond the limit changes nothing. */
export function toggleInterest(chosen: readonly string[], id: string): readonly string[] {
  if (chosen.includes(id)) return chosen.filter((one) => one !== id);
  return chosen.length >= MAX_PLAYER_INTERESTS ? chosen : [...chosen, id];
}

/** Whether the screen's choices differ from what is saved. */
export function preferencesChanged(
  saved: Preferences,
  cityId: string | null,
  interests: readonly string[],
): boolean {
  return (
    saved.cityId !== cityId ||
    saved.interests.length !== interests.length ||
    saved.interests.some((id) => !interests.includes(id))
  );
}

/** The line a preferences save answers with. */
export function preferencesNotice(outcome: PreferencesOutcome): MessageKey | null {
  switch (outcome.kind) {
    case "saved":
      return "interests.saved";
    case "invalid":
      return "interests.invalid";
    case "limited":
      return "marketing.limited";
    case "failed":
      return "interests.saveFailed";
    case "network":
      return "join.network";
    case "signed_out":
      return null;
  }
}
