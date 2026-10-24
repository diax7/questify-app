import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LANGUAGE_NAMES, isLanguage, otherLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; token: string }> }>;

/** Its URL holds a station's rotating code (T-309), which completes a quest when scanned in the app: never indexed. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What a phone camera opens when it scans a station's code outside the app (T-309, FR-314). It reads nothing and calls
 * nothing: it says to scan the code from the app's scanner, where the server checks it.
 */
export default async function ScreenCodePage({ params }: Props) {
  const { lang, token } = await params;
  // Only the shape of a signed code gets this page; anything else is not one of ours.
  if (!isLanguage(lang) || !/^[A-Za-z0-9_-]{50}$/.test(token)) {
    notFound();
  }
  const t = translatorFor(lang);
  const other = otherLanguage(lang);
  return (
    <main className={styles.page}>
      <a className={styles.link} href={`/${other}/s/${token}`} lang={other} hrefLang={other}>
        {LANGUAGE_NAMES[other]}
      </a>
      <section className={styles.panel} aria-labelledby="screen-code-title">
        <h1 id="screen-code-title" className={styles.title}>
          {t("screen.landing.title")}
        </h1>
        <p>{t("screen.landing")}</p>
        <p className={styles.muted}>{t("scan.noApp")}</p>
      </section>
    </main>
  );
}
