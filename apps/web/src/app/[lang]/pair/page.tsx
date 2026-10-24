import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LANGUAGE_NAMES, isLanguage, otherLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The pairing code rides in the fragment of this page's address: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What a phone camera opens when it scans a pairing page's QR outside the app (T-309): it reads nothing and calls
 * nothing; it says to pair from staff mode, which reads the code from the same QR.
 */
export default async function PairPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  const other = otherLanguage(lang);
  return (
    <main className={styles.page}>
      <a className={styles.link} href={`/${other}/pair`} lang={other} hrefLang={other}>
        {LANGUAGE_NAMES[other]}
      </a>
      <section className={styles.panel} aria-labelledby="pair-title">
        <h1 id="pair-title" className={styles.title}>
          {t("pair.landing.title")}
        </h1>
        <p>{t("pair.landing")}</p>
      </section>
    </main>
  );
}
