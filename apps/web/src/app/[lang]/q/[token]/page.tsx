import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LANGUAGE_NAMES, isLanguage, otherLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; token: string }> }>;

/**
 * Its URL holds a quest's code, which completes that quest for whoever has it: never indexed, never sent on as a
 * referrer.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What a phone camera opens when it scans a quest's QR outside the app (T-104). Players see it, not staff, so it has
 * no dashboard bar. It reads nothing and calls nothing: it says to scan the code inside the Questify app, where the
 * server checks it (T-105).
 */
export default async function ScanPage({ params }: Props) {
  const { lang, token } = await params;
  // Only the shape of a quest code gets this page; anything else is not one of ours.
  if (!isLanguage(lang) || !/^[A-Za-z0-9_-]{50}$/.test(token)) {
    notFound();
  }
  const t = translatorFor(lang);
  const other = otherLanguage(lang);
  return (
    <main className={styles.page}>
      <a className={styles.link} href={`/${other}/q/${token}`} lang={other} hrefLang={other}>
        {LANGUAGE_NAMES[other]}
      </a>
      <section className={styles.panel} aria-labelledby="scan-title">
        <h1 id="scan-title" className={styles.title}>
          {t("scan.title")}
        </h1>
        <p>{t("scan.body")}</p>
        <p className={styles.muted}>{t("scan.noApp")}</p>
      </section>
    </main>
  );
}
