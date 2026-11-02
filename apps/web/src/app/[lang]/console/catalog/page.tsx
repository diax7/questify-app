import { ConsoleCatalog } from "#src/components/ConsoleCatalog.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The catalog editors: event templates, achievements, level titles and the gem shop (T-709b, FR-1403). Platform admins only. */
export default async function ConsoleCatalogPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleCatalog language={page.language} />;
}
