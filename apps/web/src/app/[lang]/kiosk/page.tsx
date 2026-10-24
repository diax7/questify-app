import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PairedPlaceholder } from "#src/components/PairedPlaceholder.tsx";
import { isLanguage } from "#src/lib/language.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** A kiosk page holds nothing in its address: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A kiosk (T-309's pairing; its camera and scans are T-309b's, FR-315): the plain address shows a pairing code until
 * staff pair it for a quest with the kiosk method.
 */
export default async function KioskPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return <PairedPlaceholder kind="kiosk" language={lang} />;
}
