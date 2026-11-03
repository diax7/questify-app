import { ConsoleHome } from "#src/components/ConsoleHome.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** Questify home's layout: the order and visibility of its blocks and its banner (T-713, FR-1838). Platform admins only. */
export default async function ConsoleHomePage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleHome language={page.language} />;
}
