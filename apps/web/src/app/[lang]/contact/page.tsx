import { notFound } from "next/navigation";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/**
 * The contact page the app's Settings opens (FR-1707). It shows no address, email or company details until the real
 * ones exist: they are a release gate in STORE_COMPLIANCE §4 (T-706, T-807).
 */
export default async function ContactPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  return (
    <>
      <TopBar language={lang} path="/contact" />
      <main className={styles.page}>
        <article className={styles.panel}>
          <h1 className={styles.title}>{t("contact.title")}</h1>
          <p>{t("contact.pending")}</p>
        </article>
      </main>
    </>
  );
}
