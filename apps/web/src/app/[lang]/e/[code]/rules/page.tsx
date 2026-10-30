import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { webConfig } from "#src/lib/config.ts";
import { fetchRules, organizerTextIn } from "#src/lib/event-rules.ts";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, Section } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";
import { Prose } from "#src/ui/Text.tsx";

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
    <AppShell language={lang} path={`/e/${upper}/rules`} signedIn={false} narrow>
      <PageHeader
        title={t("rules.title")}
        back={{ href: `/${lang}/e/${upper}`, label: t("common.back") }}
      />
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
      {result.kind === "found" && result.rules.block !== null ? (
        <Card>
          <ol>
            {result.rules.block[lang].map((line) => (
              <li key={line} dir="auto">
                {line}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}
      {own === null ? null : (
        <Section title={t("rules.organizerText")}>
          <Prose dir="auto">{own}</Prose>
        </Section>
      )}
    </AppShell>
  );
}
