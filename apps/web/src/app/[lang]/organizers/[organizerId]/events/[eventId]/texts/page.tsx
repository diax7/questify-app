import { EventTextsEditor } from "#src/components/EventTextsEditor.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's renamed labels (FR-1843, T-614): the bar's names in Arabic and English, with a live preview. */
export default async function TextsPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <EventTextsEditor language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
