import { EventPreviewPanel } from "#src/components/EventPreviewPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's player screens as players will see them (FR-1022, T-602): read only, in Arabic or English. */
export default async function PreviewPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <EventPreviewPanel language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
