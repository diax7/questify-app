import { ConsoleQueue } from "#src/components/ConsoleQueue.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's home: the activation queue and the lookup by join code (T-210); its other pages are in the navigation (T-312, T-403c, T-406c, T-408c, T-409b). Platform admins only. */
export default async function ConsoleHome({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path="/console">
      <ConsoleQueue language={page.language} />
    </ConsoleShell>
  );
}
