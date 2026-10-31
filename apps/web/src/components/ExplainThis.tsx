import type { Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { setupPath, stepOfPage } from "#src/lib/setup.ts";
import { IconLink } from "#src/ui/IconControl.tsx";

/**
 * "Explain this" in the header of a page that has a step of the guided setup (FR-1756): it opens that step alone, and
 * its Done returns to this page. A page with no step shows nothing.
 */
export function ExplainThis({
  language,
  organizerId,
  eventId,
  slug,
}: Readonly<{ language: Language; organizerId: string; eventId: string; slug: string }>) {
  const step = stepOfPage(slug);
  if (step === undefined) {
    return null;
  }
  return (
    <IconLink
      icon="help"
      label={translatorFor(language)("setup.explain")}
      href={setupPath({ language, organizerId, eventId }, { step, only: true, from: slug })}
    />
  );
}
