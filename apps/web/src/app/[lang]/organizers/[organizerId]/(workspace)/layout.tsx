import type { ReactNode } from "react";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{
  children: ReactNode;
  params: Promise<{ lang: string; organizerId: string }>;
}>;

/**
 * The frame of an organizer's pages that are not inside an event (its events, a new event, its team): the top bar and
 * the navigation stay on screen while the page beside them changes. The event's own pages have their frame in the
 * event's layout, where the event's words are known. Each page still checks the session and the membership itself.
 */
export default async function OrganizerWorkspaceLayout({ children, params }: Props) {
  const { lang, organizerId } = await params;
  const page = await organizerPage(lang, organizerId);
  return <OrganizerShell page={page}>{children}</OrganizerShell>;
}
