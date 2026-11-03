import {
  DEFAULT_COMPOSED_PLAYER_INTRO,
  type ComposedConfig,
  type IntroCardKey,
} from "@questify/shared";
import { loadPlatformConfig } from "#src/config/remote.ts";

type Deps = Parameters<typeof loadPlatformConfig>[0];

/** How long the intro waits for a configuration before it plays the shipped order (FR-1800: it never blocks). */
export const ORDER_WAIT_MS = 1500;

/**
 * The cards to play, in order, from a configuration the phone holds (T-802b, FR-1803). Without one, or with a list that
 * names nothing, it is the shipped order; the shared reader has already dropped a card this app does not have.
 */
export function introOrderOf(config: ComposedConfig | undefined): readonly IntroCardKey[] {
  const { cards } = config?.playerIntro ?? DEFAULT_COMPOSED_PLAYER_INTRO;
  return cards.length === 0 ? DEFAULT_COMPOSED_PLAYER_INTRO.cards : cards;
}

/**
 * The order the intro plays this time. The first answer wins: the last working copy at once, else the fresh configuration
 * if it arrives within `waitMs`, else the shipped order. Later answers only refresh the stored copy for the next time, so
 * the cards never change under the player. Never rejects.
 */
export function resolveIntroOrder(
  deps: Deps,
  waitMs: number = ORDER_WAIT_MS,
): Promise<readonly IntroCardKey[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(DEFAULT_COMPOSED_PLAYER_INTRO.cards), waitMs);
    const answer = (cards: readonly IntroCardKey[]): void => {
      clearTimeout(timer);
      resolve(cards);
    };
    const shipped = (): void => answer(DEFAULT_COMPOSED_PLAYER_INTRO.cards);
    loadPlatformConfig(deps, (config) => answer(introOrderOf(config))).then(shipped, shipped);
  });
}
