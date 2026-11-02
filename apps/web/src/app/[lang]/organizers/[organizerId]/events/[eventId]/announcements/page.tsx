import { AnnouncementsPanel } from "#src/components/AnnouncementsPanel.tsx";
import { HoldsScope } from "#src/components/HeldNotice.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

export default async function AnnouncementsPage({
  params,
}: Readonly<{
  params: Promise<{ lang: string; organizerId: string; eventId: string }>;
}>) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <HoldsScope organizerId={organizerId} eventId={eventId}>
      <AnnouncementsPanel language={page.language} organizerId={organizerId} eventId={eventId} />
    </HoldsScope>
  ) : null;
}
