import { ExclusionsPanel } from "#src/components/ExclusionsPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { PlayersPanel } from "#src/components/PlayersPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's players and its exclusion list (T-208). An event out of reach shows the API's answer. */
export default async function PlayersPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/players`}>
      {page.kind === "member" ? (
        <>
          <PlayersPanel
            language={page.language}
            organizerId={organizerId}
            eventId={eventId}
            myRole={page.membership.role}
          />
          <ExclusionsPanel
            language={page.language}
            organizerId={organizerId}
            eventId={eventId}
            myRole={page.membership.role}
          />
        </>
      ) : null}
    </OrganizerShell>
  );
}
