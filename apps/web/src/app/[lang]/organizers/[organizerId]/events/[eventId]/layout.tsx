import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { TermsScope } from "#src/components/TermsScope.tsx";
import { webConfig } from "#src/lib/config.ts";
import { fetchEventTerms } from "#src/lib/event-terms.ts";
import { organizerPage } from "#src/lib/organizer-page.ts";
import { SESSION_COOKIE } from "#src/lib/staff-api.ts";

type Props = Readonly<{
  children: ReactNode;
  params: Promise<{ lang: string; organizerId: string; eventId: string }>;
}>;

/**
 * The frame of every page of one event: the top bar and the navigation stay on screen while the page beside them
 * changes, and they show the event's quest and category words (FR-942). The words are read once here, with the
 * organizer's session; saving them refreshes the layout (`router.refresh()` in the Event words form). Each page still
 * checks the session and the membership itself, since a layout does not run again when a page changes.
 */
export default async function EventLayout({ children, params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const [page, terms] = await Promise.all([
    organizerPage(lang, organizerId),
    fetchEventTerms({
      apiOrigin: webConfig().apiOrigin,
      organizerId,
      eventId,
      sessionToken: jar.get(SESSION_COOKIE)?.value,
      forwardedFor: incoming.get("x-forwarded-for"),
    }),
  ]);
  return (
    <TermsScope terms={terms}>
      <OrganizerShell page={page}>{children}</OrganizerShell>
    </TermsScope>
  );
}
