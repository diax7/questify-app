import type { MessageKey } from "@questify/shared";

/** The event page a navigation link opens: its path after the event's own, and its group in the menu. */
export type EventPageLink = Readonly<{
  /** "" is the event's overview. */
  slug: string;
  group: "event" | "setup" | "during" | "review";
  /** The link's words; `players` and `help` and `invitations` have words of their own (an event term, a count). */
  label: MessageKey | "players" | "help" | "invitations";
}>;

/**
 * Every page of one event, in the order the dashboard's menu lists them (ADR-364): what the organizer sets up, what
 * they watch while it runs, and what they review.
 */
export const EVENT_PAGES: readonly EventPageLink[] = [
  { slug: "", group: "event", label: "dashNav.overview" },
  { slug: "quests", group: "setup", label: "quests.title" },
  { slug: "rewards", group: "setup", label: "rewards.title" },
  { slug: "prizes", group: "setup", label: "prizes.link" },
  { slug: "community", group: "setup", label: "community.page.title" },
  { slug: "boosts", group: "setup", label: "boosts.page.title" },
  { slug: "souvenirs", group: "setup", label: "souvenir.title" },
  { slug: "joining", group: "setup", label: "joining.title" },
  { slug: "invitations", group: "setup", label: "invitations" },
  { slug: "players", group: "during", label: "players" },
  { slug: "operators", group: "during", label: "operators.link" },
  { slug: "devices", group: "during", label: "devices.link" },
  { slug: "big-screen", group: "during", label: "bigScreen.link" },
  { slug: "announcements", group: "during", label: "announcements.page.title" },
  { slug: "help", group: "during", label: "help" },
  { slug: "submissions", group: "review", label: "submissions.link" },
  { slug: "flags", group: "review", label: "flags.link" },
  { slug: "awards", group: "review", label: "awards.link" },
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
