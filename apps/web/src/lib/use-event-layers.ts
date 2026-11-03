"use client";

import type { EventLayers } from "@questify/shared";
import { useEffect, useState } from "react";
import { readEventLayers } from "#src/lib/event-layers.ts";
import { requestJson } from "#src/lib/post-json.ts";

export type EventLayersState = Readonly<{
  /** Null until read, and when the read failed. */
  layers: EventLayers | null;
  failed: boolean;
}>;

/**
 * The features an event's owner may see (FR-1826, FR-1827): `GET …/events/{id}/features`. A switch the list does not hold
 * is not shown, so a read that failed shows none (the page says so) rather than offering one the server would refuse.
 */
export function useEventLayers(organizerId: string, eventId: string): EventLayersState {
  const [state, setState] = useState<EventLayersState>({ layers: null, failed: false });
  useEffect(() => {
    let current = true;
    void requestJson("GET", `/v1/organizers/${organizerId}/events/${eventId}/features`).then(
      (result) => {
        if (!current) {
          return;
        }
        const layers = result.ok ? readEventLayers(result.body) : undefined;
        setState(layers === undefined ? { layers: null, failed: true } : { layers, failed: false });
      },
    );
    return () => {
      current = false;
    };
  }, [organizerId, eventId]);
  return state;
}
