import { EventsPanel } from "#src/components/EventsPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string }> }>;

/** An organizer's events. A person who is not a member sees "not found", as the API answers. */
export default async function EventsPage({ params }: Props) {
  const { lang, organizerId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events`}>
      {page.kind === "member" ? (
        <EventsPanel language={page.language} organizerId={organizerId} />
      ) : null}
    </OrganizerShell>
  );
}
