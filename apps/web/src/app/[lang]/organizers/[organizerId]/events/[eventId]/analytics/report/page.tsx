import { AnalyticsReport } from "#src/components/AnalyticsReport.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** The event's one-page report (T-608, FR-1208): the page the browser prints or saves as a PDF. */
export default async function AnalyticsReportRoute({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <AnalyticsReport language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
