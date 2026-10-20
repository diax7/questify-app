import { notFound, redirect } from "next/navigation";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage, isolate, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import styles from "#src/components/layout.module.css";

/** The signed-in home: who you are and the organizers you belong to. The dashboard grows from here (T-101). */
export default async function HomePage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  const staff = await currentStaff();
  if (staff.kind === "signed_out") {
    redirect(`/${lang}/sign-in${staff.ended ? "?ended=1" : ""}`);
  }
  if (staff.kind === "unavailable") {
    return (
      <>
        <TopBar language={lang} path="" />
        <main className={styles.page}>
          <p role="alert" className={styles.alert}>
            {t("error.generic")}
          </p>
          <a className={styles.button} href={`/${lang}`}>
            {t("common.retry")}
          </a>
        </main>
      </>
    );
  }
  const { me } = staff;
  return (
    <>
      <TopBar language={lang} path="">
        <a className={styles.link} href={`/${lang}/account`}>
          {t("staff.account")}
        </a>
        <SignOutButton language={lang} />
      </TopBar>
      <main className={styles.page}>
        <h1 className={styles.title}>{t("nav.home")}</h1>
        <p>{t("staff.signedInAs", { email: isolate(me.email) })}</p>
        <h2 className={styles.subtitle}>{t("staff.organizers")}</h2>
        {me.memberships.length === 0 ? (
          <p className={styles.muted}>{t("staff.noOrganizers")}</p>
        ) : (
          <ul className={styles.list}>
            {me.memberships.map((membership) => (
              <li key={membership.organizerId} className={styles.card}>
                <span>{membership.organizerName}</span>
                <span className={styles.badge}>{t(`staff.role.${membership.role}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
