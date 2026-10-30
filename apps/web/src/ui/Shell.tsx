import type { Language } from "@questify/shared";
import type { ReactNode } from "react";
import { LanguageSwitch } from "#src/components/LanguageSwitch.tsx";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { AppLink } from "#src/ui/AppLink.tsx";
import { ShellFrame } from "#src/ui/ShellFrame.tsx";
import styles from "#src/ui/shell.module.css";

/** Which part of Questify a page belongs to: the top bar names it beside the logo (a player's page names none). */
export type ShellArea = "dashboard" | "console" | "public";

/**
 * The frame of every dashboard page (ADR-364): the top bar (the Questify logo, the area's name, the other language as
 * an icon, and for a signed-in person Home, My account and the Sign out icon), the navigation column when the page has
 * one, and the content at a readable width. `narrow` is for a single small form (sign-in).
 */
export function AppShell({
  language,
  path,
  signedIn,
  area = "dashboard",
  nav = null,
  narrow = false,
  children,
}: Readonly<{
  language: Language;
  /**
   * The page's path after the language, for the language switch. Left out, the switch follows the open address (a
   * shell that stays while its pages change); null hides the switch (an address that holds a secret).
   */
  path?: string | null | undefined;
  signedIn: boolean;
  area?: ShellArea;
  nav?: ReactNode;
  narrow?: boolean;
  children: ReactNode;
}>) {
  const t = translatorFor(language);
  const areaName = {
    dashboard: t("shell.areaDashboard"),
    console: t("shell.areaConsole"),
    public: null,
  }[area];
  return (
    <ShellFrame
      brand={
        <AppLink className={styles.brand} href={`/${language}`}>
          <img
            className={styles.logo}
            src="/brand/questify-wordmark.png"
            alt="Questify"
            width={122}
            height={32}
          />
          {areaName === null ? null : <span className={styles.area}>{areaName}</span>}
        </AppLink>
      }
      topEnd={path === null ? null : <LanguageSwitch language={language} path={path} />}
      account={
        signedIn ? (
          <>
            <AppLink className={styles.item} href={`/${language}`}>
              {t("nav.home")}
            </AppLink>
            <AppLink className={styles.item} href={`/${language}/account`}>
              {t("staff.account")}
            </AppLink>
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
