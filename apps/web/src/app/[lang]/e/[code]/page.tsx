import { formatEventTime, joinLink, type Language } from "@questify/shared";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CopyEventLink } from "#src/components/CopyEventLink.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { webConfig } from "#src/lib/config.ts";
import { fetchCard, playStoreLink, type CardEvent, type CardResult } from "#src/lib/event-card.ts";
import { isLanguage, otherLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; code: string }> }>;

/**
 * One lookup per request for the page and its metadata (a wrong code counts once against the visitor, T-111): keyed by
 * the code and the browser's forwarded chain, two strings, so React's cache matches them.
 */
const lookup = cache((code: string, forwardedFor: string | null): Promise<CardResult> =>
  fetchCard({ apiOrigin: webConfig().apiOrigin, code, forwardedFor }),
);

async function cardFor(code: string): Promise<CardResult> {
  return lookup(code.toUpperCase(), (await headers()).get("x-forwarded-for"));
}

/** A name or venue in the page's language, else the other one (an event may be written in one language only). */
const textIn = (text: CardEvent["venue"], language: Language): string =>
  text[language] ?? text[otherLanguage(language)] ?? "";

/** The link preview (FR-116): the event's name and where and when, the share image, the join link as canonical. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, code } = await params;
  if (!isLanguage(lang)) {
    return {};
  }
  const upper = code.toUpperCase();
  const result = await cardFor(code);
  if (result.kind !== "found") {
    return { title: "Questify", robots: { index: false, follow: false } };
  }
  const { event } = result;
  const title = textIn(event.name, lang);
  const description = [
    textIn(event.venue, lang),
    formatEventTime(new Date(event.startsAt), event.timezone, lang),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  const canonical = joinLink(upper, lang);
  return {
    // The share image's absolute URL: crawlers ignore relative ones (on staging it still names questify.sa).
    metadataBase: new URL(new URL(canonical).origin),
    title,
    description,
    alternates: {
      canonical,
      languages: { ar: joinLink(upper, "ar"), en: joinLink(upper, "en") },
    },
    openGraph: {
      title,
      description,
      url: canonical,
      siteName: "Questify",
      locale: lang === "ar" ? "ar_SA" : "en_US",
      type: "website",
    },
    twitter: { card: "summary_large_image", title, description },
    // The code is the secret of an unlisted or private event (FR-105): never indexed.
    robots:
      event.access === "public" ? { index: true, follow: true } : { index: false, follow: false },
  };
}

function Headline({
  event,
  language,
}: Readonly<{ event: CardEvent | undefined; language: Language }>) {
  const t = translatorFor(language);
  if (event?.statusNow === "ended") {
    return <p className={styles.notice}>{t("eventPage.ended")}</p>;
  }
  return (
    <p className={styles.notice}>
      {t(event?.statusNow === "live" ? "eventPage.liveNow" : "eventPage.getReady")}
    </p>
  );
}

function Details({ event, language }: Readonly<{ event: CardEvent; language: Language }>) {
  const t = translatorFor(language);
  const venue = textIn(event.venue, language);
  return (
    <>
      <h1 className={styles.title} dir="auto">
        {textIn(event.name, language)}
      </h1>
      {venue === "" ? null : (
        <p className={styles.muted} dir="auto">
          {venue}
        </p>
      )}
      <p>
        {t("eventPage.starts")}:{" "}
        {formatEventTime(new Date(event.startsAt), event.timezone, language)}
      </p>
      <p>
        {t("eventPage.ends")}: {formatEventTime(new Date(event.endsAt), event.timezone, language)}
      </p>
    </>
  );
}

/**
 * The event's web page (T-112; FR-113 to FR-116, FR-1741): what the join QR and the invite link open on a phone without
 * the app. It shows the event, its code, what the organizer will see, and the way to the stores. Any access type opens
 * by its code (FR-105); an unknown one is not available. When the API cannot answer, the code and the store links still
 * work.
 */
export default async function EventPage({ params }: Props) {
  const { lang, code } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const upper = code.toUpperCase();
  const result = await cardFor(code);
  if (result.kind === "not_found") {
    notFound();
  }
  const t = translatorFor(lang);
  const { appStoreUrl, playStoreUrl } = webConfig();
  const event = result.kind === "found" ? result.event : undefined;
  return (
    <>
      <TopBar language={lang} path={`/e/${upper}`} />
      <main className={styles.page}>
        <article className={styles.panel}>
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
          <Headline event={event} language={lang} />
          {event === undefined ? null : <Details event={event} language={lang} />}
          <section aria-labelledby="code-title" className={styles.card}>
            <h2 id="code-title" className={styles.subtitle}>
              {t("eventPage.code")}
            </h2>
            <p className={styles.code} dir="ltr">
              {upper}
            </p>
            <p className={styles.muted}>{t("eventPage.codeHint")}</p>
          </section>
          {result.kind === "found" ? (
            <section aria-labelledby="receives-title" className={styles.card}>
              <h2 id="receives-title" className={styles.subtitle}>
                {result.card.title[lang]}
              </h2>
              <ul>
                {result.card.receives.map((item) => (
                  <li key={item.en}>{item[lang]}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className={styles.actions}>
            {playStoreUrl === undefined ? null : (
              <a className={styles.button} href={playStoreLink(playStoreUrl, upper)}>
                {t("eventPage.play")}
              </a>
            )}
            {event?.statusNow === "ended" ? null : (
              <CopyEventLink
                language={lang}
                link={joinLink(upper, lang)}
                appStoreUrl={appStoreUrl}
              />
            )}
          </section>
          {appStoreUrl === undefined && playStoreUrl === undefined ? (
            <p className={styles.muted}>{t("eventPage.soon")}</p>
          ) : null}
        </article>
      </main>
    </>
  );
}
