import { ConsoleIntroCards } from "#src/components/ConsoleIntroCards.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The player intro's cards: their order and which are shown (T-802b, FR-1803). Platform admins only. */
export default async function ConsoleIntroPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleIntroCards language={page.language} />;
}
