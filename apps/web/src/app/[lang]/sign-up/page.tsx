import { notFound, redirect } from "next/navigation";
import { SignUpForm } from "#src/components/SignUpForm.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import { AppShell } from "#src/ui/Shell.tsx";

/** Organizer sign-up (FR-1401). Someone already signed in creates another organizer from their account instead. */
export default async function SignUpPage({
  params,
}: Readonly<{ params: Promise<{ lang: string }> }>) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  if ((await currentStaff()).kind === "signed_in") {
    redirect(`/${lang}/organizers/new`);
  }
  return (
    <AppShell language={lang} path="/sign-up" signedIn={false} narrow>
      <SignUpForm language={lang} />
    </AppShell>
  );
}
