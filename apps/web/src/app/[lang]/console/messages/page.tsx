import { ConsoleMessaging } from "#src/components/ConsoleMessaging.tsx";
import { consolePage } from "#src/lib/console-page.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The message templates and the support contact (T-706, FR-1780, FR-1731). Platform admins only. */
export default async function ConsoleMessagesPage({ params }: Props) {
  const { lang } = await params;
  const page = await consolePage(lang);
  return <ConsoleMessaging language={page.language} />;
}
