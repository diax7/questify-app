import { OperatorsPanel } from "#src/components/OperatorsPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's operators and their invites (T-204). An event out of reach shows the API's answer. */
export default async function OperatorsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return (
    <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/operators`}>
      {page.kind === "member" ? (
        <OperatorsPanel
          language={page.language}
          organizerId={organizerId}
          eventId={eventId}
          myRole={page.membership.role}
        />
      ) : null}
    </OrganizerShell>
  );
}
