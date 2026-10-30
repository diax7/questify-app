import { notFound } from "next/navigation";
import { ResetPasswordForm } from "#src/components/ResetPasswordForm.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { AppShell } from "#src/ui/Shell.tsx";

/** Where the emailed link lands (T-020). The token is in the fragment, so the server never sees it. */
export default async function ResetPasswordPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    // No language switch: it would leave the page and lose the link's token, which lives only in memory.
    <AppShell language={lang} path={null} signedIn={false} narrow>
      <ResetPasswordForm language={lang} />
    </AppShell>
  );
}
