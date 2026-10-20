import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { organizerDocuments } from "@questify/shared";
import { notFound } from "next/navigation";
import { TopBar } from "#src/components/TopBar.tsx";
import { isLanguage } from "#src/lib/language.ts";
import { legalBlocks } from "#src/lib/legal.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ params: Promise<{ lang: string; document: string }> }>;

/**
 * An organizer document, in the page's language, from `docs/legal/` (the drafts awaiting counsel, T-807). Only the
 * three known ids are served, so no other file can be read through this page.
 */
export default async function LegalPage({ params }: Props) {
  const { lang, document } = await params;
  const known = organizerDocuments().find((item) => item.id === document);
  if (!isLanguage(lang) || known === undefined) {
    notFound();
  }
  // Next's standalone server runs from its own folder, so the repository's docs sit two levels up in both cases.
  const file = join(
    process.cwd(),
    "..",
    "..",
    "docs",
    "legal",
    `${known.id.replaceAll("_", "-")}.md`,
  );
  const blocks = legalBlocks(await readFile(file, "utf8"), lang);
  return (
    <>
      <TopBar language={lang} path={`/legal/${known.id}`} />
      <main className={styles.page}>
        <article className={styles.panel}>
          <p className={styles.muted}>v{known.version}</p>
          {blocks.map((block, index) => {
            const key = `${block.kind}-${index}`;
            if (block.kind === "heading") {
              return block.level === 2 ? (
                <h1 key={key} className={styles.title}>
                  {block.text}
                </h1>
              ) : (
                <h2 key={key} className={styles.subtitle}>
                  {block.text}
                </h2>
              );
            }
            if (block.kind === "list") {
              return (
                <ul key={key}>
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              );
            }
            return <p key={key}>{block.text}</p>;
          })}
        </article>
      </main>
    </>
  );
}
