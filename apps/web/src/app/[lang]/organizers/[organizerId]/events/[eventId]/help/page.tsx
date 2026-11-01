import { HelpDeskPanel } from "#src/components/HelpDeskPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";
import { filtersFromQuery } from "#src/lib/tickets.ts";

type Props = Readonly<{
  params: Promise<{ lang: string; organizerId: string; eventId: string }>;
  searchParams: Promise<{ status?: string; kind?: string }>;
}>;

/**
 * An event's Help desk: players' questions and problem reports, answered by the team (T-310). `?status=` and `?kind=`
 * open it on a tab and a kind, the lists the Inbox's counts link to (T-616).
 */
export default async function HelpDeskPage({ params, searchParams }: Props) {
  const { lang, organizerId, eventId } = await params;
  const query = await searchParams;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <HelpDeskPanel
      language={page.language}
      organizerId={organizerId}
      eventId={eventId}
      initial={filtersFromQuery(query)}
    />
  ) : null;
}
