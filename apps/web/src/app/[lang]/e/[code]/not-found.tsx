import { headers } from "next/headers";
import { LANGUAGE_HEADER, isLanguage, translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

/**
 * An unknown, draft or archived event's page (FR-103). A segment's not-found gets no params, so it reads the page's
 * language from the header the proxy sets on every page request.
 */
export default async function EventNotFound() {
  const requested = (await headers()).get(LANGUAGE_HEADER);
  const language = isLanguage(requested) ? requested : "en";
  return (
    <AppShell area="public" language={language} path={null} signedIn={false} narrow>
      <Card as="article">
        <PageHeader title={translatorFor(language)("eventPage.notAvailable")} />
      </Card>
    </AppShell>
  );
}
