import {
  DEFAULT_COMPOSED_QUESTIFY_HOME,
  type ComposedConfig,
  type ComposedQuestifyHome,
  type QuestifyHomeBlock,
  type TapAction,
} from "@questify/shared";
import { tapOutcome, type TapOutcome } from "#src/event/home-content.ts";

/**
 * Questify home's blocks and banner from the configuration the phone holds (T-713, FR-1838): the order the platform chose,
 * or the order Home always had while no configuration has been read (or the copy cannot be read).
 */
export function homeLayoutOf(config: ComposedConfig | undefined): ComposedQuestifyHome {
  return config?.questifyHome ?? DEFAULT_COMPOSED_QUESTIFY_HOME;
}

/** The two daily games share one read, made only while one of them is on the screen. */
export function showsDaily(blocks: readonly QuestifyHomeBlock[]): boolean {
  return blocks.includes("dailyChallenge") || blocks.includes("dailyWord");
}

/** What a tap on a Questify home slide does: only a web link leads anywhere (the other taps belong to an event). */
export function bannerOutcome(action: TapAction): TapOutcome | null {
  return action.type === "link" ? tapOutcome(action, () => false) : null;
}
