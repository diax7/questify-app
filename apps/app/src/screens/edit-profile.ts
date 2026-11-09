import { MESSAGES } from "@questify/shared";
import type { AuthedResult } from "#src/api/session.ts";
import type { Me, PlayerState } from "#src/auth/player-state.ts";

/** The player once signed in and read; nothing while loading, signed out, or before the profile arrived. */
export const signedInMe = (state: PlayerState): Me | undefined =>
  state.status === "signed_in" ? state.me : undefined;

/** The name the box starts with. */
export const usernameOf = (me: Me | undefined): string => me?.username ?? "";

/** Whether the server lets this player change their name now. */
export const nameChangeAllowed = (me: Me | undefined): boolean =>
  me?.usernameChange?.allowed === true;

/** Save stays off while a save runs, while the name is locked, unchanged or blank. */
export function saveDisabled(
  input: Readonly<{ busy: boolean; allowed: boolean; username: string; current: string }>,
): boolean {
  return (
    input.busy || !input.allowed || input.username === input.current || input.username.trim() === ""
  );
}

/** What the box says under a refused save: the API's own words when it gave them. */
export function saveProblem(answer: AuthedResult): { ar: string; en: string } {
  return answer.kind === "error" && answer.message !== null
    ? answer.message
    : MESSAGES["profile.saveFailed"];
}
