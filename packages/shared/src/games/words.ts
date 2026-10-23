import type { GameTarget } from "#src/games/registry";
import { formatNumber, type Language } from "#src/i18n/digits";
import type { MessageKey } from "#src/i18n/messages";

type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

/** Every game's name, the ones still to come included (the builder shows them as coming soon, ADR-214). */
export const GAME_NAME_KEYS = {
  memory_match: "games.name.memoryMatch",
  slide_puzzle: "games.name.slidePuzzle",
  catch: "games.name.catch",
  tap_rush: "games.name.tapRush",
} as const satisfies Readonly<Record<string, MessageKey>>;

export const GAME_LEVEL_KEYS = {
  easy: "games.level.easy",
  medium: "games.level.medium",
  hard: "games.level.hard",
} as const satisfies Readonly<Record<string, MessageKey>>;

/** A level's pass target in words (FR-1806): "Find all 8 pairs in 20 moves or fewer." Western digits. */
export function targetWords(t: Translate, target: GameTarget, language: Language): string {
  if (target.game === "slide_puzzle") {
    return t("games.target.slide", { seconds: formatNumber(target.seconds, language) });
  }
  const pairs = formatNumber(target.pairs, language);
  return target.maxMoves === null
    ? t("games.target.memoryAll", { pairs })
    : t("games.target.memory", { pairs, moves: formatNumber(target.maxMoves, language) });
}
