import { notFound } from "next/navigation";
import { ForgotPasswordForm } from "#src/components/ForgotPasswordForm.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { AppShell } from "#src/ui/Shell.tsx";

/** Asks for a password reset link (T-020). Open to anyone; the answer never says whether the email has an account. */
export default async function ForgotPasswordPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    <AppShell language={lang} path="/forgot-password" signedIn={false} narrow>
      <ForgotPasswordForm language={lang} />
    </AppShell>
  );
}
