import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The pairing code rides in the fragment of this page's address: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What a phone camera opens when it scans a pairing page's QR outside the app (T-309): it reads nothing and calls
 * nothing; it says to pair from staff mode, which reads the code from the same QR.
 */
export default async function PairPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  return (
    <AppShell area="public" language={lang} path={"/pair"} signedIn={false} narrow>
      <Card as="section" aria-labelledby="pair-title">
        <PageHeader titleId="pair-title" title={t("pair.landing.title")} />
        <p>{t("pair.landing")}</p>
      </Card>
    </AppShell>
  );
}
