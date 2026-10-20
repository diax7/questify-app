import { notFound, redirect } from "next/navigation";
import { NewOrganizerForm } from "#src/components/NewOrganizerForm.tsx";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import styles from "#src/components/layout.module.css";

/** A signed-in person creates another organizer they own. */
export default async function NewOrganizerPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const staff = await currentStaff();
  if (staff.kind === "signed_out") {
    redirect(`/${lang}/sign-in${staff.ended ? "?ended=1" : ""}`);
  }
  const t = translatorFor(lang);
  return (
    <>
      <TopBar language={lang} path="/organizers/new">
        <a className={styles.link} href={`/${lang}`}>
          {t("nav.home")}
        </a>
        <SignOutButton language={lang} />
      </TopBar>
      <main className={styles.page}>
        {staff.kind === "unavailable" ? (
          <p role="alert" className={styles.alert}>
            {t("error.generic")}
          </p>
        ) : (
          <NewOrganizerForm language={lang} />
        )}
      </main>
    </>
  );
}
