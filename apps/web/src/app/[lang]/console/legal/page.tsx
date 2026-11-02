import { ConsoleLegal } from "#src/components/ConsoleLegal.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The legal documents and the help articles (T-707, FR-1781, FR-1782). Platform admins only. */
export default async function ConsoleLegalPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleLegal language={page.language} />;
}
