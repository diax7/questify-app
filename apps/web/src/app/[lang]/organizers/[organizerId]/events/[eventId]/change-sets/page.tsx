import { ChangeSetsPanel } from "#src/components/ChangeSetsPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

export default async function ChangeSetsPage({
  params,
}: Readonly<{
  params: Promise<{ lang: string; organizerId: string; eventId: string }>;
}>) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <ChangeSetsPanel language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
