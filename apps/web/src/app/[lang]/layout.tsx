import type { Metadata } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { directionOf, isLanguage, translatorFor } from "#src/lib/language.ts";
import { DEFAULT_THEME } from "@questify/shared";
import { themeVariables } from "#src/lib/theme.ts";
// oxlint-disable-next-line import/no-unassigned-import -- Next loads global CSS only through a side-effect import.
import "#src/app/globals.css";

// The same font files the app ships (ADR-017), served from our own origin; both cover Arabic and Latin.
// `next/font/local` needs a relative path literal here, so these are the one place the absolute-imports rule cannot apply.
const display = localFont({
  src: [
    {
      path: "../../../node_modules/@expo-google-fonts/baloo-bhaijaan-2/700Bold/BalooBhaijaan2_700Bold.ttf",
      weight: "700",
    },
    {
      path: "../../../node_modules/@expo-google-fonts/baloo-bhaijaan-2/800ExtraBold/BalooBhaijaan2_800ExtraBold.ttf",
      weight: "800",
    },
  ],
  variable: "--font-display",
  display: "swap",
});

const body = localFont({
  src: [
    {
      path: "../../../node_modules/@expo-google-fonts/rubik/400Regular/Rubik_400Regular.ttf",
      weight: "400",
    },
    {
      path: "../../../node_modules/@expo-google-fonts/rubik/500Medium/Rubik_500Medium.ttf",
      weight: "500",
    },
    {
      path: "../../../node_modules/@expo-google-fonts/rubik/600SemiBold/Rubik_600SemiBold.ttf",
      weight: "600",
    },
  ],
  variable: "--font-body",
  display: "swap",
});

type Props = Readonly<{ children: ReactNode; params: Promise<{ lang: string }> }>;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang } = await params;
  return { title: isLanguage(lang) ? translatorFor(lang)("staff.dashboard") : "Questify" };
}

/** The root of every page: the language and its direction are on `<html>` from the first byte (FR-1506). */
export default async function LanguageLayout({ children, params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  return (
    <html
      lang={lang}
      dir={directionOf(lang)}
      className={`${display.variable} ${body.variable}`}
      style={themeVariables(DEFAULT_THEME)}
    >
      <body>{children}</body>
    </html>
  );
}
