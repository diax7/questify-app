import { notFound } from "next/navigation";
import { EmailChangeStop } from "#src/components/EmailChangeForms.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { AppShell } from "#src/ui/Shell.tsx";

/** Where the old address's Stop link lands (T-701b). The token is in the fragment, so the server never sees it. */
export default async function EmailChangeStopPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    <AppShell language={lang} path={null} signedIn={false} narrow>
      <EmailChangeStop language={lang} />
    </AppShell>
  );
}
