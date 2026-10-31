import {
  DEFAULT_TERMS,
  type AccentKey,
  type ComposedConfig,
  type EventTerms,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { helpDeskOn, loadEventConfig, locationQuestsOn, nfcTagsOn } from "#src/config/remote.ts";
import { livePollSecondsOf } from "#src/event/polls.ts";

export type EventSettings = Readonly<{
  terms: EventTerms;
  locationOn: boolean;
  nfcOn: boolean;
  helpOn: boolean;
  livePollSeconds: number;
  /** Whether an event feature is on: until the configuration says off, so nothing flashes away while it loads. */
  featureOn: (feature: string) => boolean;
  /** The event's accent colour (T-602, FR-1023), or null for Questify green. */
  accent: AccentKey | null;
}>;

/**
 * The event's configuration for the screens (its words, FR-404, FR-940; its switches; its accent): the event's cached copy
 * first, so nothing flashes, then the fresh one. With neither, the screens keep Questify's defaults (every switch read as
 * off where off is the safe side, such as location).
 */
export function useEventConfig(eventId: string): EventSettings {
  const [terms, setTerms] = useState<EventTerms>(DEFAULT_TERMS);
  const [locationOn, setLocationOn] = useState(false);
  const [nfcOn, setNfcOn] = useState(true);
  const [helpOn, setHelpOn] = useState(true);
  const [livePollSeconds, setLivePollSeconds] = useState(() => livePollSecondsOf(undefined));
  const [config, setConfig] = useState<ComposedConfig | undefined>(undefined);
  useEffect(() => {
    // Another event never keeps the last one's words, even for the moment before its own load.
    setTerms(DEFAULT_TERMS);
    setLocationOn(false);
    setConfig(undefined);
    let current = true;
    void loadEventConfig({ client: api.session, store: keyValueStore }, eventId, (loaded) => {
      if (current) {
        setTerms(loaded.terms);
        setConfig(loaded);
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
  const featureOn = useCallback(
    (feature: string) => config?.features[feature]?.enabled !== false,
    [config],
  );
  return {
    terms,
    locationOn,
    nfcOn,
    helpOn,
    livePollSeconds,
    featureOn,
    accent: config?.branding.accent ?? null,
  };
}
