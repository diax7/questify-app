import { formatEventTime, joinLink, type Language } from "@questify/shared";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { CopyEventLink } from "#src/components/CopyEventLink.tsx";
import { webConfig } from "#src/lib/config.ts";
import { fetchCard, playStoreLink, type CardEvent, type CardResult } from "#src/lib/event-card.ts";
import { isLanguage, otherLanguage, translatorFor } from "#src/lib/language.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";
import { CodeText } from "#src/ui/Text.tsx";

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
    return <Notice tone="info">{t("eventPage.ended")}</Notice>;
  }
  return (
    <Notice tone="success">
      {t(event?.statusNow === "live" ? "eventPage.liveNow" : "eventPage.getReady")}
    </Notice>
  );
}

function Details({ event, language }: Readonly<{ event: CardEvent; language: Language }>) {
  const t = translatorFor(language);
  const venue = textIn(event.venue, language);
  return (
    <PageHeader
      title={<span dir="auto">{textIn(event.name, language)}</span>}
      description={venue === "" ? undefined : <span dir="auto">{venue}</span>}
      meta={
        <>
          <span>
            {t("eventPage.starts")}:{" "}
            {formatEventTime(new Date(event.startsAt), event.timezone, language)}
          </span>
          <span>
            {t("eventPage.ends")}:{" "}
            {formatEventTime(new Date(event.endsAt), event.timezone, language)}
          </span>
        </>
      }
    />
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
    <AppShell area="public" language={lang} path={`/e/${upper}`} signedIn={false} narrow>
      {result.kind === "throttled" ? (
        <Notice tone="danger" role="alert">
          {t("eventPage.throttled")}
        </Notice>
      ) : null}
      {result.kind === "unavailable" ? (
        <Notice tone="danger" role="alert">
          {t("eventPage.unavailable")}
        </Notice>
      ) : null}
      <Headline event={event} language={lang} />
      {event === undefined ? null : <Details event={event} language={lang} />}
      <Section
        title={t("eventPage.code")}
        titleId="code-title"
        description={t("eventPage.codeHint")}
      >
        <CodeText dir="ltr">{upper}</CodeText>
      </Section>
      {result.kind === "found" ? (
        <Section title={result.card.title[lang]} titleId="receives-title">
          <ul>
            {result.card.receives.map((item) => (
              <li key={item.en}>{item[lang]}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Toolbar>
        {playStoreUrl === undefined ? null : (
          <ButtonLink variant="primary" href={playStoreLink(playStoreUrl, upper)}>
            {t("eventPage.play")}
          </ButtonLink>
        )}
        {event?.statusNow === "ended" ? null : (
          <CopyEventLink language={lang} link={joinLink(upper, lang)} appStoreUrl={appStoreUrl} />
        )}
      </Toolbar>
      {appStoreUrl === undefined && playStoreUrl === undefined ? (
        <Muted>{t("eventPage.soon")}</Muted>
      ) : null}
    </AppShell>
  );
}
