import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenInApp, OtherLanguageLink } from "#src/components/OpenInApp.tsx";
import { webConfig } from "#src/lib/config.ts";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The invite token rides in the fragment and makes its holder an operator: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What an operator invite opens outside the app (T-204): a personal QR scanned by a phone camera, or the link in an
 * invite email. The server never sees the token (it is in the fragment); the page offers to open it in the app,
 * where the person signs in and confirms (FR-903).
 */
export default async function OperatorInvitePage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  const { appStoreUrl, playStoreUrl } = webConfig();
  return (
    <main className={styles.page}>
      <OtherLanguageLink language={lang} />
      <section className={styles.panel} aria-labelledby="op-title">
        <h1 id="op-title" className={styles.title}>
          {t("invitePage.title")}
        </h1>
        <p>{t("invitePage.body")}</p>
        <OpenInApp language={lang} appStoreUrl={appStoreUrl} playStoreUrl={playStoreUrl} />
      </section>
    </main>
  );
}
