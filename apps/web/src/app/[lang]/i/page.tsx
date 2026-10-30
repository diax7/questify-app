import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InvitationLanding } from "#src/components/InvitationLanding.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The recipient's token rides in the fragment and identifies them: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * Where a Questify invitation SMS opens (T-409b, ADR-332). The page is the same for everyone and reads nothing about
 * the player; the token is in the fragment, so the server never sees it.
 */
export default async function InvitationPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    // No language switch: it would leave the page and lose the token of the link, which lives only in memory.
    <AppShell language={lang} path={null} signedIn={false} narrow>
      <InvitationLanding language={lang} />
    </AppShell>
  );
}
