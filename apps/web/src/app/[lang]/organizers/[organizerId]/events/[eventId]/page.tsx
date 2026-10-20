import { EventForm } from "#src/components/EventForm.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** One event: edit it; delete a draft; the owner ends a live one. An event out of reach shows the API's answer. */
export default async function EventPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}`}>
      {page.kind === "member" ? (
        <EventForm
          language={page.language}
          organizerId={organizerId}
          eventId={eventId}
          myRole={page.membership.role}
        />
      ) : null}
    </OrganizerShell>
  );
}
