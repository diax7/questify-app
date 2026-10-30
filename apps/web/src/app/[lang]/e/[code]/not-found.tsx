import { MESSAGES } from "@questify/shared";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card } from "#src/ui/Section.tsx";
import { AppShell } from "#src/ui/Shell.tsx";

/**
 * An unknown, draft or archived event's page (FR-103). A segment's not-found gets no params, so it cannot know the
 * page's language: it says it in both, each block in its own language and direction.
 */
export default function EventNotFound() {
  const text = MESSAGES["eventPage.notAvailable"];
  return (
    <AppShell language="en" path={null} signedIn={false} title="Questify" narrow>
      <Card as="article">
        <PageHeader
          title={
            <>
              <span lang="ar" dir="rtl">
                {text.ar}
              </span>
              <br />
              <span lang="en" dir="ltr">
                {text.en}
              </span>
            </>
          }
        />
      </Card>
    </AppShell>
  );
}
