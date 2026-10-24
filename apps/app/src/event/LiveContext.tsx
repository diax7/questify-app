import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { reachedUnlocks, unlockedSince } from "#src/event/community.ts";
import { useEvent } from "#src/event/EventContext.tsx";
import { NOTHING_LIVE, type LiveState } from "#src/event/polls.ts";
import { useLiveState } from "#src/event/useLive.ts";

const LiveContext = createContext<LiveState>(NOTHING_LIVE);

/**
 * One read of what is live for the event's tabs (ADR-221): the poll card and the community bar on Home share it, so
 * the app polls once whichever of them shows.
 */
export function LiveProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { eventId, livePollSeconds, notePaid } = useEvent();
  const live = useLiveState(eventId, livePollSeconds);
  // A step that unlocks a quest, a category or a reward was just reached (T-306c): Home, Quests and the shop read
  // again (they are not cached on the server), as after a payment made outside their own flow.
  const seen = useRef<readonly string[] | undefined>(undefined);
  useEffect(() => {
    seen.current = undefined;
  }, [eventId]);
  useEffect(() => {
    if (live.community === null) {
      return;
    }
    if (unlockedSince(seen.current, live.community)) {
      notePaid();
    }
    seen.current = reachedUnlocks(live.community);
  }, [live.community, notePaid]);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

/** What is live now, as the tabs' provider last read it; nothing outside it. */
export const useLive = (): LiveState => useContext(LiveContext);
