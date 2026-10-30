import { notFound } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

type Props = Readonly<{ params: Promise<{ lang: string }> }>;

/**
 * The contact page the app's Settings opens (FR-1707). It shows no address, email or company details until the real
 * ones exist: they are a release gate in STORE_COMPLIANCE §4 (T-706, T-807).
 */
export default async function ContactPage({ params }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const t = translatorFor(lang);
  return (
    <AppShell area="public" language={lang} path="/contact" signedIn={false} narrow>
      <Card as="article">
        <PageHeader title={t("contact.title")} />
        <p>{t("contact.pending")}</p>
      </Card>
    </AppShell>
  );
}
