"use client";

import type { Language } from "@questify/shared";
import { useRouter } from "next/navigation";
import { Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import type { Membership } from "#src/lib/staff-api.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { BulletList, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const NAMES = {
  organizer_terms: "console.legal.doc.organizerTerms",
  organizer_dpa: "console.legal.doc.organizerDpa",
  organizer_content_rules: "console.legal.doc.organizerContentRules",
} as const;

/**
 * New organizer documents wait for the owner (T-707, FR-1781): every member sees which, with a link to read each; the
 * owner accepts them in one press, and until then the API refuses the team's changes. An editor is told to ask the owner.
 */
export function LegalPendingBanner({
  language,
  membership,
}: Readonly<{ language: Language; membership: Membership }>) {
  const t = translatorFor(language);
  const router = useRouter();
  const write = useWrite(language, () => router.refresh());
  if (membership.legalPending.length === 0) {
    return null;
  }
  const accept = (): void => {
    void write.run(
      () =>
        requestJson(
          "POST",
          `/v1/organizers/${encodeURIComponent(membership.organizerId)}/legal/accept`,
          { documents: membership.legalPending },
          keyed(),
        ),
      t("legalPending.accepted"),
    );
  };
  return (
    <Notice tone="warning" role="note">
      <strong>{t("legalPending.title")}</strong>
      <p>{t(membership.role === "owner" ? "legalPending.owner" : "legalPending.editor")}</p>
      <BulletList>
        {membership.legalPending.map((item) => (
          <li key={item.document}>
            <TextLink href={`/${language}/legal/${item.document}`} target="_blank" rel="noopener">
              {t(NAMES[item.document])}
            </TextLink>{" "}
            <bdi dir="ltr">v{item.version}</bdi>
          </li>
        ))}
      </BulletList>
      <Problem problem={write.problem} />
      {membership.role === "owner" ? (
        <Toolbar>
          <Button variant="primary" disabled={write.busy} onClick={accept}>
            {t("legalPending.accept")}
          </Button>
        </Toolbar>
      ) : null}
    </Notice>
  );
}
