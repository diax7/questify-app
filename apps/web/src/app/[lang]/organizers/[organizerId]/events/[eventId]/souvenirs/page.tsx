import { SouvenirsPanel } from "#src/components/SouvenirsPanel.tsx";
import { OrganizerShell } from "#src/components/OrganizerShell.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;
export default async function SouvenirsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return <OrganizerShell page={page} path={`/organizers/${organizerId}/events/${eventId}/souvenirs`}>
    {page.kind === "member" ? <SouvenirsPanel key={eventId} language={page.language} organizerId={organizerId} eventId={eventId} /> : null}
  </OrganizerShell>;
}
