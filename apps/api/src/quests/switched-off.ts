import { QUEST_TYPE_SWITCHES } from "@questify/shared";
import type { SettingsService } from "#src/settings/service";

/**
 * The quest types the event's composed configuration switches off: a share quest while `shareQuests` is off,
 * a meet quest while `meetSomeone` is off, a game quest while `miniGames` is off. Every
 * player quest read goes through `withoutSwitchedOff`, so a switched-off quest is never shown, counted or offered.
 */
export async function switchedOffTypes(
  settings: SettingsService,
  eventId: string,
  playerId: string | undefined,
): Promise<ReadonlySet<string>> {
  const config = await settings.forEvent(eventId, playerId);
  const features = config.kind === "ok" ? config.config.features : {};
  return new Set(
    Object.entries(QUEST_TYPE_SWITCHES)
      .filter(([, feature]) => features[feature]?.enabled === false)
      .map(([type]) => type),
  );
}

/** The quests whose type is not switched off. */
export function withoutSwitchedOff<T extends Readonly<{ type: string }>>(
  quests: readonly T[],
  off: ReadonlySet<string>,
): T[] {
  return quests.filter((quest) => !off.has(quest.type));
}

/** Categories with their switched-off quests dropped, and a category left with none dropped too. */
export function categoriesWithoutSwitchedOff<
  C extends Readonly<{ quests: readonly Readonly<{ type: string }>[] }>,
>(categories: readonly C[], off: ReadonlySet<string>): C[] {
  return categories
    .map((category) => ({ ...category, quests: withoutSwitchedOff(category.quests, off) }))
    .filter((category) => category.quests.length > 0);
}
