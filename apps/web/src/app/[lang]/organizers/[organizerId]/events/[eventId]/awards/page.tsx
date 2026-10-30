import { AwardsPanel } from "#src/components/AwardsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's manual awards: the caps, bulk awards and the report (T-207). An event out of reach shows the API's answer. */
export default async function AwardsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <AwardsPanel
      language={page.language}
      organizerId={organizerId}
      eventId={eventId}
      myRole={page.membership.role}
    />
  ) : null;
}
