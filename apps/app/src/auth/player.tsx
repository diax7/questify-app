import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, deviceId, keyValueStore } from "#src/api/app-session.ts";
import { ADD_EMAIL_SHOWN_KEY } from "#src/account/add-email.ts";
import { RECENT_KEY } from "#src/event/launch.ts";
import { createPlayerLoader, type PlayerState } from "#src/auth/player-state.ts";
export type { Me, PlayerState } from "#src/auth/player-state.ts";

type PlayerValue = Readonly<{
  state: PlayerState;
  /** Reads the profile again (after sign-in, after accepting a new version). */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}>;

/** The per-player things a phone keeps outside the secure store; cleared at every sign-out, chosen or forced. */
export const PLAYER_KEYS = [RECENT_KEY, ADD_EMAIL_SHOWN_KEY] as const;

const PlayerContext = createContext<PlayerValue | undefined>(undefined);

async function clearPlayerKeys(): Promise<void> {
  await Promise.all(PLAYER_KEYS.map((key) => keyValueStore.removeItem(key).catch(() => undefined)));
}

/**
 * The signed-in player for the whole app. At launch it first settles the install (a reinstall starts signed out), then
 * asks the secure store; a session that ends on its own shows sign-in with "your session ended".
 */
export function PlayerProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [state, setState] = useState<PlayerState>({ status: "loading" });

  const loader = useMemo(() => createPlayerLoader(api.session, setState, clearPlayerKeys), []);

  useEffect(() => {
    const stop = loader.watch();
    let current = true;
    void deviceId()
      .catch(() => undefined)
      .then(() => {
        if (current) void loader.reload();
      });
    return () => {
      current = false;
      stop();
    };
  }, [loader]);

  const value = useMemo(
    () => ({ state, reload: loader.reload, signOut: loader.signOut }),
    [state, loader],
  );
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const value = useContext(PlayerContext);
  if (value === undefined) {
    throw new Error("usePlayer needs the PlayerProvider around the app (app/_layout.tsx).");
  }
  return value;
}
