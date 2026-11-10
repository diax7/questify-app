import * as Haptics from "#src/platform/haptics.ts";
import { isRecordedAgain } from "#src/event/amount.ts";

/** A completion's buzz: Success, but a replay that paid nothing is not a win, so it gets the light tap a scan gives. */
export const completedBuzz = (
  answer: Readonly<{ replayed: boolean; points: number }>,
): Promise<void> =>
  isRecordedAgain(answer)
    ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
