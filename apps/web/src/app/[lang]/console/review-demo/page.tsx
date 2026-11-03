import { ConsoleReviewDemo } from "#src/components/ConsoleReviewDemo.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The App Review demo: the demo tenant, the reviewer's fixed code and the readiness list (T-710). Platform admins only. */
export default async function ConsoleReviewDemoPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleReviewDemo language={page.language} />;
}
