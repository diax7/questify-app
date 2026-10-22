import type { ReactNode } from "react";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import type { ConsolePage } from "#src/lib/console-page.ts";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

/** The frame of a console page: "Questify console" in the top bar, so it is never mistaken for the dashboard. */
export function ConsoleShell({
  page,
  path,
  children,
}: Readonly<{ page: ConsolePage; path: string; children: ReactNode }>) {
  const t = translatorFor(page.language);
  return (
    <>
      <TopBar language={page.language} path={path}>
        <span className={styles.badge}>{t("console.title")}</span>
        <a className={styles.link} href={`/${page.language}`}>
          {t("nav.home")}
        </a>
        <SignOutButton language={page.language} />
      </TopBar>
      <main className={styles.page}>
        {page.kind === "unavailable" ? (
          <p role="alert" className={styles.alert}>
            {t("error.generic")}
          </p>
        ) : (
          children
        )}
      </main>
    </>
  );
}
