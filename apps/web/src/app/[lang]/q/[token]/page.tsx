import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{ params: Promise<{ lang: string; token: string }> }>;

/**
 * Its URL holds a quest's code, which completes that quest for whoever has it: never indexed, never sent on as a
 * referrer.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * What a phone camera opens when it scans a quest's QR outside the app (T-104). Players see it, not staff, so it has
 * no dashboard bar. It reads nothing and calls nothing: it says to scan the code inside the Questify app, where the
 * server checks it (T-105).
 */
export default async function ScanPage({ params }: Props) {
  const { lang, token } = await params;
  // Only the shape of a quest code gets this page; anything else is not one of ours.
  if (!isLanguage(lang) || !/^[A-Za-z0-9_-]{50}$/.test(token)) {
    notFound();
  }
  const t = translatorFor(lang);
  return (
    <AppShell language={lang} path={`/q/${token}`} signedIn={false} title="Questify" narrow>
      <Card as="section" aria-labelledby="scan-title">
        <PageHeader titleId="scan-title" title={t("scan.title")} />
        <p>{t("scan.body")}</p>
        <Muted>{t("scan.noApp")}</Muted>
      </Card>
    </AppShell>
  );
}
