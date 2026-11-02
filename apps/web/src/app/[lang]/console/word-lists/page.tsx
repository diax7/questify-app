import { ConsoleWordLists } from "#src/components/ConsoleWordLists.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's username word lists and retired names (T-705, FR-1779). Platform admins only. */
export default async function ConsoleWordListsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleWordLists language={page.language} />;
}
