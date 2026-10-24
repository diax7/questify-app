import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AppState } from "react-native";
import { DEFAULT_TERMS, type EventTerms } from "@questify/shared";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { loadEventConfig } from "#src/config/remote.ts";
import { TermsScope } from "#src/i18n/provider.tsx";
import { fetchWaiting, type Waiting } from "#src/operator/inbox.ts";
import { fetchOperatorEvents, type OperatorEvent } from "#src/operator/operator-api.ts";

/** The station an operator picked, by quest, with its title for the scanner's header. */
export type PickedStation = Readonly<{ questId: string; title: string }>;

type OperatorValue = Readonly<{
  eventId: string;
  /** This event as the operator's list gives it; undefined while loading or when it could not be read. */
  event: OperatorEvent | undefined;
  /** The event's words (FR-941, FR-942), read as the player app reads them; Questify's own until they are known. */
  terms: EventTerms;
  station: PickedStation | null;
  pickStation: (station: PickedStation | null) => void;
  /** FR-905: the owner removed this operator; leave operator mode with a note. */
  removed: () => void;
  /** Practice mode (FR-929, ADR-250): in memory only, never stored, so leaving staff mode or a restart turns it off. */
  practice: boolean;
  setPractice: (on: boolean) => void;
  /** What waits in the Inbox (T-310's count), one poll for the tab badge and Home; undefined before the first read. */
  waiting: Waiting | undefined;
  refreshWaiting: () => Promise<void>;
}>;

const OperatorContext = createContext<OperatorValue | undefined>(undefined);

const stationKey = (eventId: string) => `questify.station.${eventId}`;

/** How often the Inbox count is read while staff mode is in the foreground (T-310). */
const WAITING_REFRESH_MS = 30_000;

/**
 * The event's words from its cached configuration, then the fresh one: the same copy and route the player app uses.
 * An operator who never joined a hidden event cannot read it (Q-216) and sees Questify's own words.
 */
function useEventTerms(eventId: string): EventTerms {
  const [terms, setTerms] = useState<EventTerms>(DEFAULT_TERMS);
  useEffect(() => {
    setTerms(DEFAULT_TERMS);
    let current = true;
    void loadEventConfig({ client: api.session, store: keyValueStore }, eventId, (loaded) => {
      if (current) {
        setTerms(loaded.terms);
      }
    });
    return () => {
      current = false;
    };
  }, [eventId]);
  return terms;
}

/** The Inbox count, read at once and every 30 seconds while the app is in the foreground. */
function useWaiting(eventId: string) {
  const [waiting, setWaiting] = useState<Waiting | undefined>(undefined);
  const [active, setActive] = useState(AppState.currentState === "active");
  const refreshWaiting = useCallback(async () => {
    setWaiting(await fetchWaiting(api.session, eventId));
  }, [eventId]);
  useEffect(() => {
    const watcher = AppState.addEventListener("change", (state) => setActive(state === "active"));
    return () => watcher.remove();
  }, []);
  useEffect(() => {
    if (!active) {
      return;
    }
    void refreshWaiting();
    const timer = setInterval(() => void refreshWaiting(), WAITING_REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, refreshWaiting]);
  return { waiting, refreshWaiting };
}

/** Operator mode inside one event (FR-907): the event, and the station kept on this phone between scans (FR-923). */
export function OperatorProvider({
  eventId,
  children,
}: Readonly<{ eventId: string; children: ReactNode }>) {
  const [event, setEvent] = useState<OperatorEvent | undefined>(undefined);
  const [station, setStation] = useState<PickedStation | null>(null);
  const [practice, setPractice] = useState(false);
  const { waiting, refreshWaiting } = useWaiting(eventId);
  const terms = useEventTerms(eventId);

  useEffect(() => {
    let current = true;
    void fetchOperatorEvents(api.session).then((answer) => {
      if (!current || answer.kind !== "events") {
        return;
      }
      const found = answer.events.find((item) => item.eventId === eventId);
      if (found === undefined) {
        router.replace({ pathname: "/home", params: { notice: "operatorRemoved" } });
        return;
      }
      setEvent(found);
    });
    void keyValueStore
      .getItem(stationKey(eventId))
      .then((raw) => {
        const saved = raw === null ? null : (JSON.parse(raw) as unknown);
        if (
          current &&
          typeof saved === "object" &&
          saved !== null &&
          typeof (saved as PickedStation).questId === "string" &&
          typeof (saved as PickedStation).title === "string"
        ) {
          setStation(saved as PickedStation);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [eventId]);

  const pickStation = useCallback(
    (next: PickedStation | null) => {
      setStation(next);
      const write =
        next === null
          ? keyValueStore.removeItem(stationKey(eventId))
          : keyValueStore.setItem(stationKey(eventId), JSON.stringify(next));
      void write.catch(() => undefined);
    },
    [eventId],
  );

  const removed = useCallback(() => {
    router.replace({ pathname: "/home", params: { notice: "operatorRemoved" } });
  }, []);

  const value = useMemo(
    () => ({
      eventId,
      event,
      terms,
      station,
      pickStation,
      removed,
      practice,
      setPractice,
      waiting,
      refreshWaiting,
    }),
    [eventId, event, terms, station, pickStation, removed, practice, waiting, refreshWaiting],
  );
  return (
    <OperatorContext.Provider value={value}>
      <TermsScope terms={terms}>{children}</TermsScope>
    </OperatorContext.Provider>
  );
}

/** The operator inside staff mode, or undefined outside it (the practice strip on the shared screen frame). */
export function useOptionalOperator(): OperatorValue | undefined {
  return useContext(OperatorContext);
}

export function useOperator(): OperatorValue {
  const value = useContext(OperatorContext);
  if (value === undefined) {
    throw new Error("useOperator must be used inside OperatorProvider.");
  }
  return value;
}
