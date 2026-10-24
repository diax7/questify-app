import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PairedPlaceholder } from "#src/components/PairedPlaceholder.tsx";
import { isLanguage } from "#src/lib/language.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** The big-screen link holds nothing (ADR-241): never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * The big screen (T-309 up to "paired", ADR-241; its scenes are T-504's): the plain address shows a pairing code until
 * the event team pairs it from the dashboard. "Revoke all big screens" is its "regenerate the link".
 */
export default async function BigScreenPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return <PairedPlaceholder kind="screen" language={lang} />;
}
