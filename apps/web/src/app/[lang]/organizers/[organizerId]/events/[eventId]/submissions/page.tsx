import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { SubmissionsPanel } from "#src/components/SubmissionsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's submissions: the review queue, removals and the auto-approved ones to read (T-301). */
export default async function SubmissionsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/submissions`}>
      {page.kind === "member" ? (
        <SubmissionsPanel language={page.language} organizerId={organizerId} eventId={eventId} />
      ) : null}
    </OrganizerShell>
  );
}
