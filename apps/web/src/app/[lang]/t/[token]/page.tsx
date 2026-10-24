import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LANGUAGE_NAMES, isLanguage, otherLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; token: string }> }>;

/** Its URL holds an NFC tag's code (T-308), which completes a quest when tapped in the app: never indexed or referred. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What a phone opens when it taps a Questify NFC tag outside the app (T-308, ADR-234). It reads nothing and calls
 * nothing: it says to tap the tag from the app's scanner, where the server checks it.
 */
export default async function TagPage({ params }: Props) {
  const { lang, token } = await params;
  // Only the shape of a tag's code gets this page; anything else is not one of ours.
  if (!isLanguage(lang) || !/^[A-Za-z0-9_-]{50}$/.test(token)) {
    notFound();
  }
  const t = translatorFor(lang);
  const other = otherLanguage(lang);
  return (
    <main className={styles.page}>
      <a className={styles.link} href={`/${other}/t/${token}`} lang={other} hrefLang={other}>
        {LANGUAGE_NAMES[other]}
      </a>
      <section className={styles.panel} aria-labelledby="tag-title">
        <h1 id="tag-title" className={styles.title}>
          {t("tag.landing.title")}
        </h1>
        <p>{t("tag.landing")}</p>
        <p className={styles.muted}>{t("scan.noApp")}</p>
      </section>
    </main>
  );
}
