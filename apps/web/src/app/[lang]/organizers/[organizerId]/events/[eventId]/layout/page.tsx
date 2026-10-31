import { EventLayoutEditor } from "#src/components/EventLayoutEditor.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's bottom bar and Home layout (FR-1749, FR-1764, T-606): presets, reorder, show and hide, with a live preview. */
export default async function LayoutPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <EventLayoutEditor language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
