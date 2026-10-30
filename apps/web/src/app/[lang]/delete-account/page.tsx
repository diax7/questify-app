import { notFound } from "next/navigation";
import { DeleteAccountForm } from "#src/components/DeleteAccountForm.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { AppShell } from "#src/ui/Shell.tsx";

/**
 * The account deletion page (T-217, FR-127): open to anyone, no app needed. The stores' deletion URL points here.
 */
export default async function DeleteAccountPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    <AppShell area="public" language={lang} path="/delete-account" signedIn={false} narrow>
      <DeleteAccountForm language={lang} />
    </AppShell>
  );
}
