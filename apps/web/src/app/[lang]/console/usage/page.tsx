import { ConsoleUsage } from "#src/components/ConsoleUsage.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's usage view: counts per organizer and per event (T-609, FR-1730). Platform admins only. */
export default async function ConsoleUsagePage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleUsage language={page.language} />;
}
