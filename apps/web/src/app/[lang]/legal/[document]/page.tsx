import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isLegalDocumentId, type Language, type LegalText } from "@questify/shared";
import { notFound } from "next/navigation";
import { webConfig } from "#src/lib/config.ts";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import {
  fillContactPlaceholders,
  legalBlocks,
  legalTextBlocks,
  type LegalBlock,
} from "#src/lib/legal.ts";
import { fetchLegalText, fetchSupportContact } from "#src/lib/legal-api.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, SubHeading } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Props = Readonly<{ params: Promise<{ lang: string; document: string }> }>;

/**
 * The words of a document in force: the text an admin published (FR-1781) in the page's language, else the draft in
 * `docs/legal/` that the seeded first version stands for (the drafts await counsel, T-807). Next's standalone server
 * runs from its own folder, so the repository's docs sit two levels up in both cases.
 */
async function blocksFor(
  text: LegalText,
  document: string,
  language: Language,
): Promise<LegalBlock[]> {
  const published = text[language] ?? text[language === "ar" ? "en" : "ar"];
  if (published !== null) {
    return legalTextBlocks(published);
  }
  const file = join(
    process.cwd(),
    "..",
    "..",
    "docs",
    "legal",
    `${document.replaceAll("_", "-")}.md`,
  );
  return legalBlocks(await readFile(file, "utf8"), language);
}

/**
 * A legal document in force, in the page's language: the organizer's three and the player's three (the app's Settings →
 * Legal opens these, FR-1707). Only the six known ids are served, so no other file can be read through this page.
 */
export default async function LegalPage({ params }: Props) {
  const { lang, document } = await params;
  if (!isLanguage(lang) || !isLegalDocumentId(document)) {
    notFound();
  }
  const request = { apiOrigin: webConfig().apiOrigin };
  const [text, contact] = await Promise.all([
    fetchLegalText(request, document),
    fetchSupportContact(request),
  ]);
  if (text === undefined) {
    return (
      <AppShell area="public" language={lang} path={`/legal/${document}`} signedIn={false} narrow>
        <Notice tone="danger" role="alert">
          {translatorFor(lang)("error.generic")}
        </Notice>
      </AppShell>
    );
  }
  const blocks = fillContactPlaceholders(
    await blocksFor(text, document, lang),
    contact?.email ?? null,
  );
  return (
    <AppShell area="public" language={lang} path={`/legal/${document}`} signedIn={false} narrow>
      <Stack>
        <Muted>v{text.version}</Muted>
        {blocks.map((block, index) => {
          const key = `${block.kind}-${index}`;
          if (block.kind === "heading") {
            return block.level === 2 ? (
              <PageHeader key={key} title={block.text} />
            ) : (
              <SubHeading key={key} as="h2">
                {block.text}
              </SubHeading>
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
        {document === "privacy_policy" ? (
          <TextLink href={`/${lang}/delete-account`}>
            {translatorFor(lang)("deletion.title")}
          </TextLink>
        ) : null}
      </Stack>
    </AppShell>
  );
}
