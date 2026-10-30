import { FlagsPanel } from "#src/components/FlagsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's flagged activity (T-209): cases with their evidence and the team's actions. */
export default async function FlagsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <FlagsPanel
      language={page.language}
      organizerId={organizerId}
      eventId={eventId}
      myRole={page.membership.role}
    />
  ) : null;
}
