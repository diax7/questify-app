import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StationScreen } from "#src/components/StationScreen.tsx";
import { isLanguage } from "#src/lib/language.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** A station page holds nothing in its address and shows nothing until paired: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A station (T-309, FR-314, FR-1713): any tablet or TV browser opens this plain address; it shows a pairing code until
 * staff pair it, then its quest's code, which changes every 30 seconds.
 */
export default async function StationPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return <StationScreen language={lang} />;
}
