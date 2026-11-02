import { ConsoleTranslations } from "#src/components/ConsoleTranslations.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The app's texts in Arabic and English, edited live (T-702). Platform admins only. */
export default async function ConsoleTranslationsPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleTranslations language={page.language} />;
}
