import { notFound, redirect } from "next/navigation";
import { ChangePasswordForm } from "#src/components/ChangePasswordForm.tsx";
import { isLanguage, isolate, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

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
      <AppShell language={lang} path="/account" signedIn={false}>
        <Notice tone="danger" role="alert">
          {t("error.generic")}
        </Notice>
        <ButtonLink variant="primary" href={`/${lang}/account`}>
          {t("common.retry")}
        </ButtonLink>
      </AppShell>
    );
  }
  return (
    <AppShell language={lang} path="/account" signedIn>
      <PageHeader
        title={t("staff.account")}
        description={t("staff.signedInAs", { email: isolate(staff.me.email) })}
      />
      <ChangePasswordForm language={lang} email={staff.me.email} />
    </AppShell>
  );
}
