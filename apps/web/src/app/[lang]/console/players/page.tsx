import { ConsolePlayers } from "#src/components/ConsolePlayers.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's player search (T-704, FR-1774). Platform admins only. */
export default async function ConsolePlayersPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsolePlayers language={page.language} />;
}
