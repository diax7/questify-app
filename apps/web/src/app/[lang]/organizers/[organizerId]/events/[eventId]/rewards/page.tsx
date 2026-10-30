import { RewardsPanel } from "#src/components/RewardsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's rewards and shop settings. An event out of reach shows the API's answer. */
export default async function RewardsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <RewardsPanel
      language={page.language}
      organizerId={organizerId}
      eventId={eventId}
      role={page.membership.role}
    />
  ) : null;
}
