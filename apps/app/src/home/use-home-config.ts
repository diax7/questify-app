import type { ComposedConfig } from "@questify/shared";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { api, keyValueStore } from "#src/api/app-session.ts";
import { loadHomeConfig } from "#src/config/remote.ts";

/**
 * The platform's configuration for Questify home: the last working copy at once, the fresh one when it arrives, and again
 * each time Home gains focus (the tabs stay mounted). Undefined until a copy exists, so Home draws its default order.
 */
export function useHomeConfig(): ComposedConfig | undefined {
  const [config, setConfig] = useState<ComposedConfig | undefined>(undefined);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void loadHomeConfig({ client: api.client, store: keyValueStore }, (shown) => {
        if (current) setConfig(shown);
      });
      return () => {
        current = false;
      };
    }, []),
  );
  return config;
}
