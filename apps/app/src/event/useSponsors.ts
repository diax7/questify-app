import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { useEvent } from "#src/event/EventContext.tsx";
import type { SponsorLookup } from "#src/event/sponsors.ts";

/** The event's sponsors, read again each time the screen comes into focus (an organizer may tag mid-event). */
export function useSponsors(): SponsorLookup {
  const { sponsors, refreshSponsors } = useEvent();
  useFocusEffect(
    useCallback(() => {
      refreshSponsors();
    }, [refreshSponsors]),
  );
  return sponsors;
}
