import { InboxPage } from "#src/components/InboxPage.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** The owner's Inbox (T-616): what waits for the team, with counts that open the list they count. */
export default async function InboxRoute({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <InboxPage language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
