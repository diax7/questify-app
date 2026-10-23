import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { PrizesAndResults } from "#src/components/PrizesAndResults.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's rank prizes, official rules and final results (T-214). */
export default async function PrizesPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/prizes`}>
      {page.kind === "member" ? (
        <PrizesAndResults
          language={page.language}
          organizerId={organizerId}
          eventId={eventId}
          myRole={page.membership.role}
        />
      ) : null}
    </OrganizerShell>
  );
}
