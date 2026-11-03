import { SouvenirsPanel } from "#src/components/SouvenirsPanel.tsx";
import { SponsorBadgesScope } from "#src/components/SponsorBadge.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;
export default async function SouvenirsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <SponsorBadgesScope organizerId={organizerId} eventId={eventId}>
      <SouvenirsPanel
        key={eventId}
        language={page.language}
        organizerId={organizerId}
        eventId={eventId}
      />
    </SponsorBadgesScope>
  ) : null;
}
