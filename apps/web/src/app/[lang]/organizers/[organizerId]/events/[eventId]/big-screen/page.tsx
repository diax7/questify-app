import { BigScreenPanel } from "#src/components/BigScreenPanel.tsx";
import { organizerPage } from "#src/lib/organizer-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string; eventId: string }> }>;

/** An event's Big screen scenes (T-504): pick the scenes the big screen shows and set their order. */
export default async function BigScreenPage({ params }: Props) {
  const { lang, organizerId, eventId } = await params;
  const page = await organizerPage(lang, organizerId);
  return page.kind === "member" ? (
    <BigScreenPanel language={page.language} organizerId={organizerId} eventId={eventId} />
  ) : null;
}
