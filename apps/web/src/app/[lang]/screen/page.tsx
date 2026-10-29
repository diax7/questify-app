import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BigScreen } from "#src/components/BigScreen.tsx";
import { isLanguage } from "#src/lib/language.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The big-screen link holds nothing (ADR-241): never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The big screen (T-309 pairing, ADR-241; T-504 scenes): the plain address shows a pairing code until the event team
 * pairs it from the dashboard, then the scenes the team picked. "Revoke all big screens" is its "regenerate the link".
 */
export default async function BigScreenPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return <BigScreen language={lang} />;
}
