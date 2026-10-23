import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TopBar } from "#src/components/TopBar.tsx";
import { webConfig } from "#src/lib/config.ts";
import { fetchRules, organizerTextIn } from "#src/lib/event-rules.ts";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; code: string }> }>;

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * An event's official rules (FR-1707, ADR-165; STORE_COMPLIANCE §1.12): the fixed block Questify writes from the
 * event's data, then the organizer's own text, as plain text. Opens without the app, with the join card's visibility:
 * a draft, an archived event or a wrong code is not found.
 */
export default async function RulesPage({ params }: Props) {
  const { lang, code } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const upper = code.toUpperCase();
  const result = await fetchRules({
    apiOrigin: webConfig().apiOrigin,
    code: upper,
    forwardedFor: (await headers()).get("x-forwarded-for"),
  });
  if (result.kind === "not_found") {
    notFound();
  }
  const t = translatorFor(lang);
  const own = result.kind === "found" ? organizerTextIn(result.rules, lang) : null;
  return (
    <>
      <TopBar language={lang} path={`/e/${upper}/rules`} />
      <main className={styles.page}>
        <article className={styles.panel}>
          <h1 className={styles.title}>{t("rules.title")}</h1>
          {result.kind === "throttled" ? (
            <p role="alert" className={styles.alert}>
              {t("eventPage.throttled")}
            </p>
          ) : null}
          {result.kind === "unavailable" ? (
            <p role="alert" className={styles.alert}>
              {t("eventPage.unavailable")}
            </p>
          ) : null}
          {result.kind === "found" && result.rules.block !== null ? (
            <ol>
              {result.rules.block[lang].map((line) => (
                <li key={line} dir="auto">
                  {line}
                </li>
              ))}
            </ol>
          ) : null}
          {own === null ? null : (
            <section aria-labelledby="own-rules" className={styles.card}>
              <h2 id="own-rules" className={styles.subtitle}>
                {t("rules.organizerText")}
              </h2>
              <p dir="auto" className={styles.prose}>
                {own}
              </p>
            </section>
          )}
          <a className={styles.textLink} href={`/${lang}/e/${upper}`}>
            {t("common.back")}
          </a>
        </article>
      </main>
    </>
  );
}
