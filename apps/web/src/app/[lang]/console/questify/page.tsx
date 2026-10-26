import { ConsoleQuestify } from "#src/components/ConsoleQuestify.tsx";
import { ConsoleShell } from "#src/components/ConsoleShell.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** Questify's own quests and campaigns (T-403c). Platform admins only; the API checks again on every call. */
export default async function ConsoleQuestifyPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return (
    <ConsoleShell page={page} path="/console/questify">
      <ConsoleQuestify language={page.language} />
    </ConsoleShell>
  );
}
