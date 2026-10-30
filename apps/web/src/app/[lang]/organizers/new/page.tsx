import { notFound, redirect } from "next/navigation";
import { NewOrganizerForm } from "#src/components/NewOrganizerForm.tsx";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import { Notice } from "#src/ui/Feedback.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

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
  return (
    <AppShell language={lang} path="/organizers/new" signedIn narrow>
      {staff.kind === "unavailable" ? (
        <Notice tone="danger" role="alert">
          {translatorFor(lang)("error.generic")}
        </Notice>
      ) : (
        <NewOrganizerForm language={lang} />
      )}
    </AppShell>
  );
}
