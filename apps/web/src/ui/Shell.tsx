import type { Language } from "@questify/shared";
import type { ReactNode } from "react";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { LANGUAGE_NAMES, otherLanguage, translatorFor } from "#src/lib/language.ts";
import { ShellFrame } from "#src/ui/ShellFrame.tsx";
import styles from "#src/ui/shell.module.css";

/**
 * The frame of every dashboard page (ADR-364): the top bar (product name, the other language, and for a signed-in
 * person Home, My account and Sign out), the navigation column when the page has one, and the content at a readable
 * width. `narrow` is for a single small form (sign-in).
 */
export function AppShell({
  language,
  path,
  signedIn,
  nav = null,
  narrow = false,
  title,
  children,
}: Readonly<{
  language: Language;
  /** The page's path after the language, for the language switch; null hides the switch. */
  path: string | null;
  signedIn: boolean;
  nav?: ReactNode;
  narrow?: boolean;
  /** The product name in the top bar; the dashboard's own when not given (the console names itself). */
  title?: string;
  children: ReactNode;
}>) {
  const t = translatorFor(language);
  const other = otherLanguage(language);
  return (
    <ShellFrame
      brand={
        <a className={styles.brand} href={`/${language}`}>
          {title ?? t("staff.dashboard")}
        </a>
      }
      topEnd={
        path === null ? null : (
          <a href={`/${other}${path}`} lang={other} hrefLang={other}>
            {LANGUAGE_NAMES[other]}
          </a>
        )
      }
      account={
        signedIn ? (
          <>
            <a className={styles.item} href={`/${language}`}>
              {t("nav.home")}
            </a>
            <a className={styles.item} href={`/${language}/account`}>
              {t("staff.account")}
            </a>
            <SignOutButton language={language} />
          </>
        ) : null
      }
      nav={nav}
      labels={{ menu: t("dashNav.menu"), navigation: t("dashNav.main"), skip: t("dashNav.skip") }}
      narrow={narrow}
    >
      {children}
    </ShellFrame>
  );
}
