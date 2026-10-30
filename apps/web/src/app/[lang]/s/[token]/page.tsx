import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

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
  return (
    <AppShell area="public" language={lang} path={`/s/${token}`} signedIn={false} narrow>
      <Card as="section" aria-labelledby="screen-code-title">
        <PageHeader titleId="screen-code-title" title={t("screen.landing.title")} />
        <p>{t("screen.landing")}</p>
        <Muted>{t("scan.noApp")}</Muted>
      </Card>
    </AppShell>
  );
}
