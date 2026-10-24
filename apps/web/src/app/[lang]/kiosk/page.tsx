import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { KioskScanner } from "#src/components/KioskScanner.tsx";
import { isLanguage } from "#src/lib/language.ts";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/** A kiosk page holds nothing in its address: never indexed, never a referrer. */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A kiosk (T-309b, FR-315): the plain address shows a pairing code until staff pair it for a quest with the kiosk
 * method; then its camera reads players' live codes and pays them with no staff by. This path alone may use the camera
 * and WebAssembly (proxy.ts); every link here is a full page load.
 */
export default async function KioskPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return <KioskScanner language={lang} />;
}
