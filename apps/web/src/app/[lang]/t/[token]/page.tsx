import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

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
  return (
    <AppShell area="public" language={lang} path={`/t/${token}`} signedIn={false} narrow>
      <Card as="section" aria-labelledby="tag-title">
        <PageHeader titleId="tag-title" title={t("tag.landing.title")} />
        <p>{t("tag.landing")}</p>
        <Muted>{t("scan.noApp")}</Muted>
      </Card>
    </AppShell>
  );
}
