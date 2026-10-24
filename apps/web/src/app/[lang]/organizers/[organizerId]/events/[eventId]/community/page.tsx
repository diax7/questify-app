import { CommunityPanel } from "#src/components/CommunityPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's community quests (T-306b): the goals, their progress and payouts, and the form. */
export default async function CommunityPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/community`}>
      {page.kind === "member" ? (
        <CommunityPanel language={page.language} organizerId={organizerId} eventId={eventId} />
      ) : null}
    </OrganizerShell>
  );
}
