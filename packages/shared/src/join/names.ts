import type { MessageKey } from "#src/i18n/messages";

/**
 * How an event names its players (FR-1842, ADR-400): by username, by full name or by both. The full name is the answer
 * to the event's "Full name" join field; nothing else ever stands in for it.
 */
export const NAME_DISPLAYS = ["username", "full_name", "both"] as const;
export type NameDisplay = (typeof NAME_DISPLAYS)[number];

/** Who sees the full name: the event's staff alone, or every player in the event too. */
export const NAME_AUDIENCES = ["staff", "everyone"] as const;
export type NameAudience = (typeof NAME_AUDIENCES)[number];

export const isNameDisplay = (value: unknown): value is NameDisplay =>
  NAME_DISPLAYS.includes(value as NameDisplay);

export const isNameAudience = (value: unknown): value is NameAudience =>
  NAME_AUDIENCES.includes(value as NameAudience);

/**
 * Who a joining player is told will see their full name: nobody when the event shows usernames only. What the card shows
 * is what the join records (`enrollment.name_notice`), and a player's full name reaches other players only when this
 * was `everyone` for them.
 */
export function nameNoticeOf(display: NameDisplay, audience: NameAudience): NameAudience | null {
  return display === "username" ? null : audience;
}

/** How other players are named in the event: the display when everyone sees it, else usernames. */
export function playerNameDisplay(display: NameDisplay, audience: NameAudience): NameDisplay {
  return audience === "everyone" ? display : "username";
}

/** The card's sentence about the full name, or null when the event shows usernames only. */
export function nameNoticeKey(display: NameDisplay, audience: NameAudience): MessageKey | null {
  if (display === "username") {
    return null;
  }
  if (audience === "staff") {
    return "joinCard.nameStaff";
  }
  return display === "both" ? "joinCard.nameEveryoneBoth" : "joinCard.nameEveryoneFull";
}

/** What a row draws for a player: the full name when it is shown, and whether the username is drawn with it. */
export type ShownName = Readonly<{ fullName: string | null; showUsername: boolean }>;

/**
 * How a row names a player under a display. A player without a full name (or one the server did not send) is named by
 * username, so a row is never empty.
 */
export function shownName(fullName: string | null, display: NameDisplay): ShownName {
  const name = fullName === null || fullName.trim() === "" ? null : fullName;
  if (display === "username" || name === null) {
    return { fullName: null, showUsername: true };
  }
  return { fullName: name, showUsername: display === "both" };
}

/** A player's name as plain text, for a screen reader or a label: `Sara Ahmed (@sara_q)`, `Sara Ahmed` or `@sara_q`. */
export function nameText(username: string, fullName: string | null, display: NameDisplay): string {
  const shown = shownName(fullName, display);
  if (shown.fullName === null) {
    return `@${username}`;
  }
  return shown.showUsername ? `${shown.fullName} (@${username})` : shown.fullName;
}
