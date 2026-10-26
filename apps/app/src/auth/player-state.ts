import type { Equipment } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import { equipmentOf } from "#src/questify/profile-api.ts";
import { levelOf, type QuestifyLevel } from "#src/questify/level.ts";

/** Owner-only profile data stays in memory and belongs to the current load generation. */
export type Me = Readonly<{
  id: string;
  username: string;
  avatar: string;
  equipment?: Equipment;
  usernameChange?: { allowed: boolean; nextChangeAt: string | null };
  legal: Readonly<{ toAccept: readonly string[]; guidelinesAccepted: boolean }>;
  identifiers: Readonly<{ phone: string | null; email: string | null }>;
  questify: QuestifyLevel | undefined;
  /** The player's own gem balance (T-404); absent from an older API. */
  gems?: number;
  help?: Readonly<{ unread: number }> | undefined;
}>;

export type PlayerState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "signed_out"; ended: boolean }>
  | Readonly<{ status: "signed_in"; me: Me | undefined }>;

const isMe = (value: unknown): value is Me =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Me).id === "string" &&
  typeof (value as Me).username === "string" &&
  typeof (value as Me).legal === "object" &&
  Array.isArray((value as Me).legal?.toAccept);

/** The provider's loader, separated from React so delayed account responses are exercised behaviorally. */
export function createPlayerLoader(
  session: Pick<Session, "signedIn" | "request" | "signOut" | "onEnded">,
  publish: (state: PlayerState) => void,
  clear: () => Promise<void>,
) {
  let generation = 0;
  let signingOut = false;
  let disposed = false;

  const reload = async () => {
    if (signingOut || disposed) return;
    const current = ++generation;
    const signedIn = await session.signedIn();
    if (current !== generation) return;
    if (!signedIn) {
      publish({ status: "signed_out", ended: false });
      return;
    }
    const answer = await session.request({ method: "GET", path: "/v1/me" });
    if (current !== generation) return;
    if (answer.kind === "signed_out") {
      publish({ status: "signed_out", ended: true });
      return;
    }
    // Offline: still signed in; the current account's profile comes on its next reload.
    publish({
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
  };

  const signOut = async () => {
    if (signingOut || disposed) return;
    const current = ++generation;
    signingOut = true;
    // Drop private data immediately; wait for logout before offering another sign-in.
    publish({ status: "loading" });
    try {
      await session.signOut();
      await clear();
    } finally {
      signingOut = false;
      if (current === generation) publish({ status: "signed_out", ended: false });
    }
  };

  const watch = () => {
    disposed = false;
    const stop = session.onEnded(() => {
      generation += 1;
      void clear();
      publish({ status: "signed_out", ended: true });
    });
    return () => {
      disposed = true;
      generation += 1;
      stop();
    };
  };
  return { reload, signOut, watch };
}
