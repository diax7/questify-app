import { notFound } from "next/navigation";
import { ResetPasswordForm } from "#src/components/ResetPasswordForm.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

/** Where the emailed link lands (T-020). The token is in the fragment, so the server never sees it. */
export default async function ResetPasswordPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    <>
      {/* No language switch: it would leave the page and lose the link's token, which lives only in memory. */}
      <TopBar language={lang} path={null} />
      <main className={styles.page}>
        <ResetPasswordForm language={lang} />
      </main>
    </>
  );
}
