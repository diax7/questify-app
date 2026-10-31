import { AnalyticsPage } from "#src/components/AnalyticsPage.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** The event's analytics (T-607): participation, quests and categories, rewards and points. */
export default async function AnalyticsRoute({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <AnalyticsPage language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
