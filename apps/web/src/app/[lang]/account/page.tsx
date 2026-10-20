import { notFound, redirect } from "next/navigation";
import { ChangePasswordForm } from "#src/components/ChangePasswordForm.tsx";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage, isolate, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import styles from "#src/components/layout.module.css";

/** The signed-in person's own account: who they are and a password change (T-020). */
export default async function AccountPage({
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
        <TopBar language={lang} path="/account" />
        <main className={styles.page}>
          <p role="alert" className={styles.alert}>
            {t("error.generic")}
          </p>
          <a className={styles.button} href={`/${lang}/account`}>
            {t("common.retry")}
          </a>
        </main>
      </>
    );
  }
  return (
    <>
      <TopBar language={lang} path="/account">
        <a className={styles.link} href={`/${lang}`}>
          {t("nav.home")}
        </a>
        <SignOutButton language={lang} />
      </TopBar>
      <main className={styles.page}>
        <h1 className={styles.title}>{t("staff.account")}</h1>
        <p>{t("staff.signedInAs", { email: isolate(staff.me.email) })}</p>
        <ChangePasswordForm language={lang} email={staff.me.email} />
      </main>
    </>
  );
}
