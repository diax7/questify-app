import { ConsoleSeasons } from "#src/components/ConsoleSeasons.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The Questify-wide ranking's seasons, one per month, each with its top 10 (T-408c). Platform admins only. */
export default async function ConsoleSeasonsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path="/console/seasons">
      <ConsoleSeasons language={page.language} />
    </ConsoleShell>
  );
}
