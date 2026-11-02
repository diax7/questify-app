import { shownHelp } from "@questify/shared";
import { notFound } from "next/navigation";
import { webConfig } from "#src/lib/config.ts";
import { directionOf, isLanguage, translatorFor } from "#src/lib/language.ts";
import { fetchHelp } from "#src/lib/legal-api.ts";
import { Badge, EmptyState, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, Stack, SubHeading } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/**
 * The help and common questions (FR-1782), the published articles in the reader's language. An article that exists in
 * one language only is shown in that language, marked so, to a reader of the other.
 */
export default async function HelpPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  const help = await fetchHelp({ apiOrigin: webConfig().apiOrigin });
  return (
    <AppShell area="public" language={lang} path="/help" signedIn={false} narrow>
      <Stack>
        <PageHeader title={t("faq.title")} />
        {help === undefined ? (
          <Notice tone="danger" role="alert">
            {t("faq.loadFailed")}
          </Notice>
        ) : null}
        {help?.articles.length === 0 ? <EmptyState>{t("faq.empty")}</EmptyState> : null}
        {help?.articles.map((article) => {
          const shown = shownHelp(article, lang);
          return (
            <Card
              as="article"
              key={article.id}
              lang={shown.language}
              dir={directionOf(shown.language)}
            >
              <SubHeading as="h2">{shown.question}</SubHeading>
              <p>{shown.answer}</p>
              {shown.language === lang ? null : (
                <Badge>{t(shown.language === "ar" ? "faq.onlyIn.ar" : "faq.onlyIn.en")}</Badge>
              )}
            </Card>
          );
        })}
      </Stack>
    </AppShell>
  );
}
