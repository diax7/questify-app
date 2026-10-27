import { notFound } from "next/navigation";
import { OptOutForm } from "#src/components/OptOutForm.tsx";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { channelOfToken } from "#src/lib/opt-out.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

/**
 * Where the opt-out link in a promotional message lands (T-407, FR-1114): open to anyone, no app and no sign-in. The
 * link's token is the proof; the page never shows who it belongs to.
 */
export default async function OptOutPage({ params, searchParams }: Props) {
  const { lang } = await params;
  if (!isLanguage(lang)) {
    notFound();
  }
  const { t: raw } = await searchParams;
  const token = typeof raw === "string" ? raw : null;
  const t = translatorFor(lang);
  return (
    <>
      <TopBar
        language={lang}
        path={token === null ? "/opt-out" : `/opt-out?t=${encodeURIComponent(token)}`}
      />
      <main className={styles.page}>
        <h1 className={styles.title}>{t("optOut.title")}</h1>
        <OptOutForm language={lang} token={token} channel={channelOfToken(token ?? undefined)} />
      </main>
    </>
  );
}
