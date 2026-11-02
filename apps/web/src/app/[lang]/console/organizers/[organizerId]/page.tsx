import { notFound } from "next/navigation";
import { ConsoleOrganizer } from "#src/components/ConsoleOrganizers.tsx";
import { isEventId } from "#src/lib/console.ts";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string }> }>;

/** One organizer in the console: suspend or reactivate, team, events, history (T-701). Platform admins only. */
export default async function ConsoleOrganizerPage({ params }: Props) {
  const { lang, organizerId } = await params;
  const page = await consolePage(lang);
  if (!isEventId(organizerId)) {
    notFound();
  }
  return <ConsoleOrganizer language={page.language} organizerId={organizerId} />;
}
