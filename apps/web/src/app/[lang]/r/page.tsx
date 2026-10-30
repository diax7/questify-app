import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SharedSurveyResults } from "#src/components/SharedSurveyResults.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The link's token identifies one survey and rides in the fragment: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Where a speaker opens the survey results an organizer shared (T-508, FR-1210, ADR-376). The page is the same for
 * everyone and reads nothing until the browser sends the token it holds in the fragment.
 */
export default async function SharedSurveyPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    // No language switch: it would leave the page and lose the token of the link.
    <AppShell area="public" language={lang} path={null} signedIn={false} narrow>
      <SharedSurveyResults language={lang} />
    </AppShell>
  );
}
