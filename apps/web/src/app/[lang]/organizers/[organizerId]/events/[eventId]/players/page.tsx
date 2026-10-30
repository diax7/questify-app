import { ExclusionsPanel } from "#src/components/ExclusionsPanel.tsx";
import { JoinRequestsPanel } from "#src/components/JoinRequestsPanel.tsx";
import { PlayersPanel } from "#src/components/PlayersPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's join requests (T-218), its players and its exclusion list (T-208). An event out of reach shows the API's answer. */
export default async function PlayersPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <>
      <PlayersPanel
        language={page.language}
        organizerId={organizerId}
        eventId={eventId}
        myRole={page.membership.role}
      >
        <JoinRequestsPanel language={page.language} organizerId={organizerId} eventId={eventId} />
      </PlayersPanel>
      <ExclusionsPanel
        language={page.language}
        organizerId={organizerId}
        eventId={eventId}
        myRole={page.membership.role}
      />
    </>
  ) : null;
}
