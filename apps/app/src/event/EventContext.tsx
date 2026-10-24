import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { DEFAULT_TERMS, type EventTerms } from "@questify/shared";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { helpDeskOn, loadEventConfig, locationQuestsOn, nfcTagsOn } from "#src/config/remote.ts";
import { markOpened, readMyEvents, type MyEvent } from "#src/event/launch.ts";
import { livePollSecondsOf } from "#src/event/polls.ts";
import { TermsScope } from "#src/i18n/provider.tsx";

type EventValue = Readonly<{
  eventId: string;
  /** The player's events for the pill and its sheet; undefined while loading or after a failure. */
  events: readonly MyEvent[] | undefined;
  /** The event's name as Home last read it, for the pill when the list could not be read. */
  knownName: string | undefined;
  rememberName: (name: string) => void;
  /** The event's words (FR-404, FR-940): its cached copy, then the fresh one; Questify's own until either exists. */
  terms: EventTerms;
  /** The platform's location switch (ADR-208): off until the configuration says on; off, the app never reads location. */
  locationOn: boolean;
  /**
   * Whether a QR scan or typed code may carry the last known position: the switch on and the event in person (never a
   * virtual one, FR-1744; nothing while its kind is unknown).
   */
  scanPositions: boolean;
  /** The platform's NFC switch (ADR-234): on until the configuration says off; off, the app never reads a tag. */
  nfcOn: boolean;
  /** The help desk's switch (T-310): off hides only the send form; Your requests stays. */
  helpOn: boolean;
  /** Seconds between reads of what is live (T-306, ADR-221): the configuration's tuning, else the default. */
  livePollSeconds: number;
  /** Counts payments made outside a tab's own flow (the live poll card, T-306): Home and Quests read again on it. */
  paidCount: number;
  notePaid: () => void;
}>;

const EventContext = createContext<EventValue | undefined>(undefined);

/** The event the screens below are inside, from the route; opening it is noted for the launch choice (FR-1610). */
export function EventProvider({
  eventId,
  children,
}: Readonly<{ eventId: string; children: ReactNode }>) {
  const [events, setEvents] = useState<readonly MyEvent[] | undefined>(undefined);
  const [knownName, rememberName] = useState<string | undefined>(undefined);
  const [terms, setTerms] = useState<EventTerms>(DEFAULT_TERMS);
  const [locationOn, setLocationOn] = useState(false);
  const [nfcOn, setNfcOn] = useState(true);
  const [helpOn, setHelpOn] = useState(true);
  const [livePollSeconds, setLivePollSeconds] = useState(() => livePollSecondsOf(undefined));
  const [paidCount, setPaidCount] = useState(0);
  const notePaid = useCallback(() => setPaidCount((count) => count + 1), []);
  const load = useCallback(async () => {
    const answer = await api.session.request({ method: "GET", path: "/v1/me/events" });
    setEvents(answer.kind === "ok" ? readMyEvents(answer.body) : undefined);
  }, []);
  useEffect(() => {
    void markOpened(keyValueStore, eventId, Date.now());
    void load();
  }, [eventId, load]);
  useEffect(() => {
    // Another event never keeps the last one's words, even for the moment before its own load.
    setTerms(DEFAULT_TERMS);
    setLocationOn(false);
    let current = true;
    void loadEventConfig({ client: api.session, store: keyValueStore }, eventId, (loaded) => {
      if (current) {
        setTerms(loaded.terms);
        setLocationOn(locationQuestsOn(loaded));
        setNfcOn(nfcTagsOn(loaded));
        setHelpOn(helpDeskOn(loaded));
        setLivePollSeconds(livePollSecondsOf(loaded));
      }
    });
    return () => {
      current = false;
    };
  }, [eventId]);
  const kind = events?.find((event) => event.id === eventId)?.kind;
  const scanPositions = locationOn && (kind === "physical" || kind === "workplace");
  const value = useMemo(
    () => ({
      eventId,
      events,
      knownName,
      rememberName,
      terms,
      locationOn,
      scanPositions,
      nfcOn,
      helpOn,
      livePollSeconds,
      paidCount,
      notePaid,
    }),
    [
      eventId,
      events,
      knownName,
      terms,
      locationOn,
      scanPositions,
      nfcOn,
      helpOn,
      livePollSeconds,
      paidCount,
      notePaid,
    ],
  );
  return (
    <EventContext.Provider value={value}>
      <TermsScope terms={terms}>{children}</TermsScope>
    </EventContext.Provider>
  );
}

/** The words of the event the screen is inside. */
export function useTerms(): EventTerms {
  return useEvent().terms;
}

export function useEvent(): EventValue {
  const value = useContext(EventContext);
  if (value === undefined) {
    throw new Error("useEvent needs the EventProvider of app/event/[eventId]/_layout.tsx.");
  }
  return value;
}
