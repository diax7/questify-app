import { InvitationsPanel } from "#src/components/InvitationsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's Questify invitations (T-409b): the owner's requests and their rounded results. */
export default async function InvitationsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <InvitationsPanel
      key={eventId}
      language={page.language}
      organizerId={organizerId}
      eventId={eventId}
      myRole={page.membership.role}
    />
  ) : null;
}
