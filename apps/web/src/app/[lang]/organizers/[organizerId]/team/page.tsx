import { notFound, redirect } from "next/navigation";
import { SignOutButton } from "#src/components/SignOutButton.tsx";
import { TeamPanel } from "#src/components/TeamPanel.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; organizerId: string }> }>;

/** An organizer's team. A person who is not a member sees "not found", as the API answers. */
export default async function TeamPage({ params }: Props) {
  const { lang, organizerId } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const staff = await currentStaff();
  if (staff.kind === "signed_out") {
    redirect(`/${lang}/sign-in${staff.ended ? "?ended=1" : ""}`);
  }
  const t = translatorFor(lang);
  if (staff.kind === "unavailable") {
    return (
      <main className={styles.page}>
        <p role="alert" className={styles.alert}>
          {t("error.generic")}
        </p>
      </main>
    );
  }
  const membership = staff.me.memberships.find((item) => item.organizerId === organizerId);
  if (membership === undefined) {
    notFound();
  }
  return (
    <>
      <TopBar language={lang} path={`/organizers/${organizerId}/team`}>
        <a className={styles.link} href={`/${lang}`}>
          {t("nav.home")}
        </a>
        <SignOutButton language={lang} />
      </TopBar>
      <main className={styles.page}>
        <p className={styles.muted}>{membership.organizerName}</p>
        <TeamPanel language={lang} organizerId={organizerId} myRole={membership.role} />
      </main>
    </>
  );
}
