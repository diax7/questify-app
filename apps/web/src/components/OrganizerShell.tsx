import type { ReactNode } from "react";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { translatorFor } from "#src/lib/language.ts";
import type { OrganizerPage } from "#src/lib/organizer-page.ts";
import styles from "#src/components/layout.module.css";

/** The frame of an organizer page: the top bar, the organizer's name, and the error state when the API is down. */
export function OrganizerShell({
  page,
  path,
  children,
}: Readonly<{ page: OrganizerPage; path: string; children: ReactNode }>) {
  const t = translatorFor(page.language);
  if (page.kind === "unavailable") {
    return (
      <main className={styles.page}>
        <p role="alert" className={styles.alert}>
          {t("error.generic")}
        </p>
      </main>
    );
  }
  return (
    <>
      <TopBar language={page.language} path={path}>
        <a className={styles.link} href={`/${page.language}`}>
          {t("nav.home")}
        </a>
        <SignOutButton language={page.language} />
      </TopBar>
      <main className={styles.page}>
        <p className={styles.muted}>{page.membership.organizerName}</p>
        {children}
      </main>
    </>
  );
}
