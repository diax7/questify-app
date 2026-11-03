import { router } from "expo-router";
import { keyValueStore } from "#src/api/app-session.ts";
import { afterJoinRoute } from "#src/onboarding/intro-flow.ts";
import { introDue, readIntroState } from "#src/onboarding/intro-state.ts";

/**
 * "Go to the event" after a join (FR-1801): the intro first, once per install, naming the event; otherwise straight into
 * the event. The join card and the invitation both end here. A request still waiting for approval, or a place on the
 * waiting list, is not "you're in": it goes straight to the event and the intro waits for the next launch.
 */
export async function openJoinedEvent(
  eventId: string,
  eventName: string,
  isMember: boolean,
): Promise<void> {
  const due = isMember && introDue(await readIntroState(keyValueStore));
  router.replace(afterJoinRoute(due, eventId, eventName));
}
