"use client";

import type { Language } from "@questify/shared";
import { usePathname } from "next/navigation";
import {
  LANGUAGE_NAMES,
  otherLanguage,
  pathAfterLanguage,
  translatorFor,
} from "#src/lib/language.ts";
import { IconLink } from "#src/ui/IconControl.tsx";

/**
 * The top bar's language switch: a globe icon whose name and tooltip say which language it switches to. Without a
 * `path` it opens the same page in the other language, read from the open address, so it stays right while the pages
 * beside a persistent shell change.
 */
export function LanguageSwitch({
  language,
  path,
}: Readonly<{ language: Language; path: string | undefined }>) {
  const open = pathAfterLanguage(usePathname());
  const other = otherLanguage(language);
  return (
    <IconLink
      icon="globe"
      label={translatorFor(language)("shell.switchLanguage", { language: LANGUAGE_NAMES[other] })}
      href={`/${other}${path ?? open}`}
      hrefLang={other}
    />
  );
}
