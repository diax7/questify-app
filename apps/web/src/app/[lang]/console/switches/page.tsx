import { ConsoleSwitches } from "#src/components/ConsoleSwitches.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The platform's feature switches and tuning numbers (T-703, FR-1405, FR-1769, FR-1770). Platform admins only. */
export default async function ConsoleSwitchesPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleSwitches language={page.language} />;
}
