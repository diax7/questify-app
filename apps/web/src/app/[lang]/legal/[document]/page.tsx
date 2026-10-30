import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { organizerDocuments, playerDocuments } from "@questify/shared";
import { notFound } from "next/navigation";
import { isLanguage, translatorFor } from "#src/lib/language.ts";
import { legalBlocks } from "#src/lib/legal.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, SubHeading } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Props = Readonly<{ params: Promise<{ lang: string; document: string }> }>;

/**
 * A legal document, in the page's language, from `docs/legal/` (the drafts awaiting counsel, T-807): the organizer's
 * three and the player's three (the app's Settings → Legal opens these, FR-1707). Only known ids are served, so no
 * other file can be read through this page.
 */
export default async function LegalPage({ params }: Props) {
  const { lang, document } = await params;
  const known = [...organizerDocuments(), ...playerDocuments()].find(
    (item) => item.id === document,
  );
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
    <AppShell area="public" language={lang} path={`/legal/${known.id}`} signedIn={false} narrow>
      <Stack>
        <Muted>v{known.version}</Muted>
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
        {known.id === "privacy_policy" ? (
          <TextLink href={`/${lang}/delete-account`}>
            {translatorFor(lang)("deletion.title")}
          </TextLink>
        ) : null}
      </Stack>
    </AppShell>
  );
}
