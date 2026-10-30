import { HelpDeskPanel } from "#src/components/HelpDeskPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's Help desk: players' questions and problem reports, answered by the team (T-310). */
export default async function HelpDeskPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <HelpDeskPanel language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
