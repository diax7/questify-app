import { router } from "expo-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { fetchOperatorEvents, type OperatorEvent } from "#src/operator/operator-api.ts";

/** The station an operator picked, by quest, with its title for the scanner's header. */
export type PickedStation = Readonly<{ questId: string; title: string }>;

type OperatorValue = Readonly<{
  eventId: string;
  /** This event as the operator's list gives it; undefined while loading or when it could not be read. */
  event: OperatorEvent | undefined;
  station: PickedStation | null;
  pickStation: (station: PickedStation | null) => void;
  /** FR-905: the owner removed this operator; leave operator mode with a note. */
  removed: () => void;
}>;

const OperatorContext = createContext<OperatorValue | undefined>(undefined);

const stationKey = (eventId: string) => `questify.station.${eventId}`;

/** Operator mode inside one event (FR-907): the event, and the station kept on this phone between scans (FR-923). */
export function OperatorProvider({
  eventId,
  children,
}: Readonly<{ eventId: string; children: ReactNode }>) {
  const [event, setEvent] = useState<OperatorEvent | undefined>(undefined);
  const [station, setStation] = useState<PickedStation | null>(null);

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
    () => ({ eventId, event, station, pickStation, removed }),
    [eventId, event, station, pickStation, removed],
  );
  return <OperatorContext.Provider value={value}>{children}</OperatorContext.Provider>;
}

export function useOperator(): OperatorValue {
  const value = useContext(OperatorContext);
  if (value === undefined) {
    throw new Error("useOperator must be used inside OperatorProvider.");
  }
  return value;
}
