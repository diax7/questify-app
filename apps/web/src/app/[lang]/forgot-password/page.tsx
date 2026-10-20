import { notFound } from "next/navigation";
import { ForgotPasswordForm } from "#src/components/ForgotPasswordForm.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

/** Asks for a password reset link (T-020). Open to anyone; the answer never says whether the email has an account. */
export default async function ForgotPasswordPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    <>
      <TopBar language={lang} path="/forgot-password" />
      <main className={styles.page}>
        <ForgotPasswordForm language={lang} />
      </main>
    </>
  );
}
