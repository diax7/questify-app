import { createContext, useContext, type ReactNode } from "react";
import { useEvent } from "#src/event/EventContext.tsx";
import { NOTHING_LIVE, type LiveState } from "#src/event/polls.ts";
import { useLiveState } from "#src/event/useLive.ts";

const LiveContext = createContext<LiveState>(NOTHING_LIVE);

/**
 * One read of what is live for the event's tabs (ADR-221): the poll card and the community bar on Home share it, so
 * the app polls once whichever of them shows.
 */
export function LiveProvider({ children }: Readonly<{ children: ReactNode }>) {
  const { eventId, livePollSeconds } = useEvent();
  const live = useLiveState(eventId, livePollSeconds);
  return <LiveContext.Provider value={live}>{children}</LiveContext.Provider>;
}

/** What is live now, as the tabs' provider last read it; nothing outside it. */
export const useLive = (): LiveState => useContext(LiveContext);
