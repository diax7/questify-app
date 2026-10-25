import type { Equipment } from "@questify/shared";
import { equipmentOf } from "#src/questify/profile-api.ts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, deviceId, keyValueStore } from "#src/api/app-session.ts";
import { ADD_EMAIL_SHOWN_KEY } from "#src/account/add-email.ts";
import { RECENT_KEY } from "#src/event/launch.ts";
import { levelOf, type QuestifyLevel } from "#src/questify/level.ts";

/** What the app needs of `GET /v1/me`: held in memory only, never stored (masked contacts included). */
export type Me = Readonly<{
  id: string;
  username: string;
  avatar: string;
  equipment?: Equipment;
  usernameChange?: { allowed: boolean; nextChangeAt: string | null };
  legal: Readonly<{ toAccept: readonly string[]; guidelinesAccepted: boolean }>;
  identifiers: Readonly<{ phone: string | null; email: string | null }>;
  /** The lifetime Questify level (T-401); undefined when the answer has none or a malformed one. */
  questify: QuestifyLevel | undefined;
  /** Unseen answers to the player's requests in every queue (T-312): the profile's dot. */
  help?: Readonly<{ unread: number }> | undefined;
}>;

export type PlayerState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "signed_out"; ended: boolean }>
  | Readonly<{ status: "signed_in"; me: Me | undefined }>;

type PlayerValue = Readonly<{
  state: PlayerState;
  /** Reads the profile again (after sign-in, after accepting a new version). */
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
}>;

/** The per-player things a phone keeps outside the secure store; cleared at every sign-out, chosen or forced. */
export const PLAYER_KEYS = [RECENT_KEY, ADD_EMAIL_SHOWN_KEY] as const;

const isMe = (value: unknown): value is Me =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Me).id === "string" &&
  typeof (value as Me).username === "string" &&
  typeof (value as Me).legal === "object" &&
  Array.isArray((value as Me).legal?.toAccept);

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

  const reload = useCallback(async () => {
    if (!(await api.session.signedIn())) {
      setState({ status: "signed_out", ended: false });
      return;
    }
    const answer = await api.session.request({ method: "GET", path: "/v1/me" });
    if (answer.kind === "signed_out") {
      setState({ status: "signed_out", ended: true });
      return;
    }
    // Offline: still signed in; the profile comes on the next reload.
    setState({
      status: "signed_in",
      me:
        answer.kind === "ok" && isMe(answer.body)
          ? {
              ...answer.body,
              questify: levelOf(answer.body.questify),
              equipment: equipmentOf(answer.body.equipment),
            }
          : undefined,
    });
  }, []);

  useEffect(() => {
    const stop = api.session.onEnded(() => {
      void clearPlayerKeys();
      setState({ status: "signed_out", ended: true });
    });
    void deviceId()
      .catch(() => undefined)
      .then(reload);
    return stop;
  }, [reload]);

  const signOut = useCallback(async () => {
    await api.session.signOut();
    await clearPlayerKeys();
    setState({ status: "signed_out", ended: false });
  }, []);

  const value = useMemo(() => ({ state, reload, signOut }), [state, reload, signOut]);
  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer(): PlayerValue {
  const value = useContext(PlayerContext);
  if (value === undefined) {
    throw new Error("usePlayer needs the PlayerProvider around the app (app/_layout.tsx).");
  }
  return value;
}
