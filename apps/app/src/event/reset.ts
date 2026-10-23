import type { Language } from "@questify/shared";
import { spanText } from "#src/event/countdown.ts";

type ResetKey =
  | "questsTab.category.resetsDaily"
  | "questsTab.category.resetsWeekly"
  | "questsTab.category.resetsDailySoon"
  | "questsTab.category.resetsWeeklySoon";

/**
 * A refreshing category's header note (T-304c, FR-236): "Resets daily, in 5 hours", from the server's next reset on
 * the phone's clock; under a minute (or past it, before the tab reads again) says "in under a minute".
 */
export function resetLabel(
  note: Readonly<{ refresh: "daily" | "weekly"; at: string }>,
  now: number,
  language: Language,
): Readonly<{ key: ResetKey; values: Readonly<{ span: string }> | undefined }> {
  const span = spanText(Math.max(0, Date.parse(note.at) - now), language);
  if (span === null) {
    return {
      key:
        note.refresh === "daily"
          ? "questsTab.category.resetsDailySoon"
          : "questsTab.category.resetsWeeklySoon",
      values: undefined,
    };
  }
  return {
    key:
      note.refresh === "daily"
        ? "questsTab.category.resetsDaily"
        : "questsTab.category.resetsWeekly",
    values: { span },
  };
}
