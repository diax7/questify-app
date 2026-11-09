import type { MessageKey } from "@questify/shared";

/** The states after a join that put the player in the event (or waiting for it): the form gives way to Open. */
export const isJoinedResult = (result: string | undefined): boolean =>
  result === "active" || result === "pending" || result === "waitlisted" || result === "already";

/** Which parts of the join card show: the welcome reward and the join form with its button. */
export function cardParts(
  joined: boolean,
  ended: boolean,
  welcome: number,
): Readonly<{ welcome: boolean; join: boolean }> {
  return { welcome: joined && welcome > 0, join: !(ended || joined) };
}

/** The join button: the waiting list once the event said it is full (FR-1821), a request for a Private event (FR-1818). */
const joinLabel = (full: boolean, isPrivate: boolean): MessageKey =>
  full ? "join.waitlistJoin" : isPrivate ? "joinCard.request" : "joinCard.join";

/** The join button's words, whether it is off, and whether a tap asks for the waiting list. */
export function joinButton(
  input: Readonly<{
    result: string | undefined;
    isPrivate: boolean;
    busy: boolean;
    cardMissing: boolean;
    playerLoading: boolean;
  }>,
): Readonly<{ label: MessageKey; disabled: boolean; waitlist: boolean }> {
  const waitlist = input.result === "full";
  return {
    label: joinLabel(waitlist, input.isPrivate),
    disabled: input.busy || input.cardMissing || input.playerLoading,
    waitlist,
  };
}
