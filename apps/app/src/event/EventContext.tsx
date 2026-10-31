import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  themeWithAccent,
  type AccentKey,
  type ComposedLayout,
  type EventTerms,
  type MemberSponsors,
} from "@questify/shared";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { markOpened, readMyEvents, type MyEvent } from "#src/event/launch.ts";
import { useEventConfig } from "#src/event/useEventConfig.ts";
import { fetchSponsors, lookupOf, type SponsorLookup } from "#src/event/sponsors.ts";
import { TermsScope } from "#src/i18n/provider.tsx";
import { ThemeProvider, useTheme } from "#src/theme/theme.tsx";

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
  /**
   * Whether an event feature is on (the shop, maps, agenda; T-602, FR-1009): on until the configuration says off, so
   * nothing flashes away while it loads. A switched-off feature is not drawn at all.
   */
  featureOn: (feature: string) => boolean;
  /** The event's accent colour (T-602, FR-1023), or null for Questify green; the provider applies it to the theme. */
  accent: AccentKey | null;
  /**
   * The bar items and Home blocks to show, in order (T-606, FR-1749). Read with `playerTabs` and `homeBlocks`, which also
   * apply the event's switches: a layout never shows what a switch took away.
   */
  layout: ComposedLayout;
  /** Seconds between reads of what is live (T-306, ADR-221): the configuration's tuning, else the default. */
  livePollSeconds: number;
  /** Counts payments made outside a tab's own flow (the live poll card, T-306): Home and Quests read again on it. */
  paidCount: number;
  notePaid: () => void;
  /** The event's sponsors and who presents what (T-507); empty until read, after a failure, and when there are none. */
  sponsors: SponsorLookup;
  refreshSponsors: () => void;
}>;

const EventContext = createContext<EventValue | undefined>(undefined);

/** The event the screens below are inside, from the route; opening it is noted for the launch choice (FR-1610). */
export function EventProvider({
  eventId,
  children,
}: Readonly<{ eventId: string; children: ReactNode }>) {
  const [events, setEvents] = useState<readonly MyEvent[] | undefined>(undefined);
  const [knownName, rememberName] = useState<string | undefined>(undefined);
  const [paidCount, setPaidCount] = useState(0);
  const notePaid = useCallback(() => setPaidCount((count) => count + 1), []);
  const [sponsorData, setSponsorData] = useState<MemberSponsors | undefined>(undefined);
  const openEvent = useRef(eventId);
  const refreshSponsors = useCallback(() => {
    void fetchSponsors(api.session, eventId).then((read) => {
      // A failed read keeps the last good copy; a member who cannot read them sees no sponsors. A read that was
      // still out when the event changed belongs to the event before and is dropped.
      if (read.kind === "sponsors" && openEvent.current === eventId) setSponsorData(read.data);
    });
  }, [eventId]);
  useEffect(() => {
    // Another event never keeps the last one's sponsors; the screens read them when they come into focus.
    openEvent.current = eventId;
    setSponsorData(undefined);
  }, [eventId]);
  const sponsors = useMemo(() => lookupOf(sponsorData), [sponsorData]);
  const load = useCallback(async () => {
    const answer = await api.session.request({ method: "GET", path: "/v1/me/events" });
    setEvents(answer.kind === "ok" ? readMyEvents(answer.body) : undefined);
  }, []);
  useEffect(() => {
    void markOpened(keyValueStore, eventId, Date.now());
    void load();
  }, [eventId, load]);
  const { terms, locationOn, nfcOn, helpOn, livePollSeconds, featureOn, accent, layout } =
    useEventConfig(eventId);
  const { theme: baseTheme } = useTheme();
  const eventTheme = useMemo(() => themeWithAccent(baseTheme, accent), [baseTheme, accent]);
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
      featureOn,
      accent,
      layout,
      livePollSeconds,
      paidCount,
      notePaid,
      sponsors,
      refreshSponsors,
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
      featureOn,
      accent,
      layout,
      livePollSeconds,
      paidCount,
      notePaid,
      sponsors,
      refreshSponsors,
    ],
  );
  return (
    <EventContext.Provider value={value}>
      <ThemeProvider theme={eventTheme}>
        <TermsScope terms={terms}>{children}</TermsScope>
      </ThemeProvider>
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
