import { notFound } from "next/navigation";
import { ConsolePlayer } from "#src/components/ConsolePlayer.tsx";
import { isEventId } from "#src/lib/console.ts";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string; playerId: string }> }>;

/** One player in the console: the read-only record and the three actions (T-704). Platform admins only. */
export default async function ConsolePlayerPage({ params }: Props) {
  const { lang, playerId } = await params;
  const page = await consolePage(lang);
  if (!isEventId(playerId)) {
    notFound();
  }
  return <ConsolePlayer language={page.language} playerId={playerId} />;
}
