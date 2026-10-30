import { ConsoleContent } from "#src/components/ConsoleContent.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The daily challenge and the daily word: schedule, question bank, guess list, period (T-406c). Platform admins only. */
export default async function ConsoleContentPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleContent language={page.language} />;
}
