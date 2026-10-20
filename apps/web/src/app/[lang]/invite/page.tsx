import { notFound } from "next/navigation";
import { InviteFlow } from "#src/components/InviteFlow.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import styles from "#src/components/layout.module.css";

/** Where an invite link lands (FR-1012, FR-1723). The token is in the fragment, so the server never sees it. */
export default async function InvitePage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const staff = await currentStaff();
  return (
    <>
      {/* No language switch: it would leave the page and lose the link's token, which lives only in memory. */}
      <TopBar language={lang} path={null} />
      <main className={styles.page}>
        <InviteFlow
          language={lang}
          signedInEmail={staff.kind === "signed_in" ? staff.me.email : null}
        />
      </main>
    </>
  );
}
