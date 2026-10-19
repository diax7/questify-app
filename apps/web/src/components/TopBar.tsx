import type { Language } from "@questify/shared";
import type { ReactNode } from "react";
import { LANGUAGE_NAMES, otherLanguage, translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

/** The bar on every page: the product name, the other language, and whatever the page adds (sign out). */
export function TopBar({
  language,
  path,
  children,
}: Readonly<{ language: Language; path: string; children?: ReactNode }>) {
  const other = otherLanguage(language);
  return (
    <header className={styles.bar}>
      <span className={styles.brand}>{translatorFor(language)("staff.dashboard")}</span>
      <nav className={styles.actions}>
        <a className={styles.link} href={`/${other}${path}`} lang={other} hrefLang={other}>
          {LANGUAGE_NAMES[other]}
        </a>
        {children}
      </nav>
    </header>
  );
}
