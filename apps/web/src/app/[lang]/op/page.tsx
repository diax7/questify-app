import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenInApp, OtherLanguageLink } from "#src/components/OpenInApp.tsx";
import { webConfig } from "#src/lib/config.ts";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

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
    <AppShell area="public" language={lang} path={null} signedIn={false} narrow>
      <OtherLanguageLink language={lang} />
      <Card as="section" aria-labelledby="op-title">
        <PageHeader titleId="op-title" title={t("invitePage.title")} />
        <p>{t("invitePage.body")}</p>
        <OpenInApp language={lang} appStoreUrl={appStoreUrl} playStoreUrl={playStoreUrl} />
      </Card>
    </AppShell>
  );
}
