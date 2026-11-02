import { ConsoleNumbers } from "#src/components/ConsoleNumbers.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's platform numbers: events, players and activity as counts (T-709, FR-1419). Platform admins only. */
export default async function ConsoleNumbersPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleNumbers language={page.language} />;
}
