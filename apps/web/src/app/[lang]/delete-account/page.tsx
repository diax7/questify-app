import { notFound } from "next/navigation";
import { DeleteAccountForm } from "#src/components/DeleteAccountForm.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

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
    <>
      <TopBar language={lang} path="/delete-account" />
      <main className={styles.page}>
        <DeleteAccountForm language={lang} />
      </main>
    </>
  );
}
