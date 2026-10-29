import { notFound, redirect } from "next/navigation";
import { SignInForm } from "#src/components/SignInForm.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { currentStaff } from "#src/lib/session.ts";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

/** Staff sign-in. Someone whose session the API confirms goes straight home; anything else sees the form. */
export default async function SignInPage({ params, searchParams }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  if ((await currentStaff()).kind === "signed_in") {
    redirect(`/${lang}`);
  }
  const ended = (await searchParams)["ended"] === "1";
  return (
    <AppShell language={lang} path="/sign-in" signedIn={false} narrow>
      <SignInForm language={lang} sessionEnded={ended} />
    </AppShell>
  );
}
