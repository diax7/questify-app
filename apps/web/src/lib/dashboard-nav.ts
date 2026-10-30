import type { MessageKey } from "@questify/shared";
import type { IconName } from "#src/ui/Icon.tsx";

/** The event page a navigation link opens: its path after the event's own, and its group in the menu. */
export type EventPageLink = Readonly<{
  /** "" is the event's overview. */
  slug: string;
  group: "event" | "setup" | "run";
  /** The icon beside the link. */
  icon: IconName;
  /** The link's words; `players` and `help` and `invitations` have words of their own (an event term, a count). */
  label: MessageKey | "players" | "help" | "invitations";
}>;

/**
 * Every page of one event, in the order the dashboard's menu lists them (ADR-364): what the organizer sets up, then what
 * they run and review (two groups, ADR-375: a third label put the desktop menu below a 1280 by 720 screen).
 */
export const EVENT_PAGES: readonly EventPageLink[] = [
  { slug: "", icon: "overview", group: "event", label: "dashNav.overview" },
  { slug: "quests", icon: "compass", group: "setup", label: "quests.title" },
  { slug: "sessions", icon: "calendar", group: "setup", label: "sessions.page.title" },
  { slug: "maps", icon: "map", group: "setup", label: "maps.page.title" },
  { slug: "sponsors", icon: "sponsor", group: "setup", label: "sponsors.page.title" },
  { slug: "rewards", icon: "gift", group: "setup", label: "rewards.title" },
  { slug: "prizes", icon: "trophy", group: "setup", label: "prizes.link" },
  { slug: "community", icon: "heart", group: "setup", label: "community.page.title" },
  { slug: "boosts", icon: "bolt", group: "setup", label: "boosts.page.title" },
  { slug: "souvenirs", icon: "star", group: "setup", label: "souvenir.title" },
  { slug: "joining", icon: "userPlus", group: "setup", label: "joining.title" },
  { slug: "invitations", icon: "mail", group: "setup", label: "invitations" },
  { slug: "players", icon: "users", group: "run", label: "players" },
  { slug: "operators", icon: "shield", group: "run", label: "operators.link" },
  { slug: "devices", icon: "phone", group: "run", label: "devices.link" },
  { slug: "big-screen", icon: "screen", group: "run", label: "bigScreen.link" },
  { slug: "announcements", icon: "megaphone", group: "run", label: "announcements.page.title" },
  { slug: "help", icon: "help", group: "run", label: "help" },
  { slug: "submissions", icon: "inbox", group: "run", label: "submissions.link" },
  { slug: "flags", icon: "alert", group: "run", label: "flags.link" },
  { slug: "awards", icon: "award", group: "run", label: "awards.link" },
];

const EVENT_PATH = /^\/organizers\/[^/]+\/events\/([^/]+)(?:\/([^/]+))?/;

/**
 * Where a dashboard path points inside an organizer: the event's id and the event page's slug ("" for its overview),
 * or null outside an event (the events list, a new event, the team).
 */
export function eventPlaceIn(path: string): Readonly<{ eventId: string; slug: string }> | null {
  const match = EVENT_PATH.exec(path);
  const eventId = match?.[1];
  if (eventId === undefined || eventId === "new") {
    return null;
  }
  return { eventId, slug: match?.[2] ?? "" };
}
