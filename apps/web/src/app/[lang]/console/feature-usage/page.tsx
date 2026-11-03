import { ConsoleFeatureUsage } from "#src/components/ConsoleFeatureUsage.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The console's feature usage: per organizer, which features are on and used (T-714, FR-1839). Platform admins only. */
export default async function ConsoleFeatureUsagePage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleFeatureUsage language={page.language} />;
}
