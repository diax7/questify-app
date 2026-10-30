"use client";

import {
  SPONSOR_TAG_KINDS,
  type Language,
  type MessageKey,
  type SponsorTagKind,
  type TeamSponsor,
} from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { sponsorName, sponsorOf, type TagChoices } from "#src/lib/sponsors.ts";
import { Muted } from "#src/ui/Feedback.tsx";
import { Checkbox, FieldGroup } from "#src/ui/Field.tsx";
import { Section } from "#src/ui/Section.tsx";

export type SponsorWrites = Readonly<{
  busy: boolean;
  failure: string | null;
  clearFailure: () => void;
  run: (
    method: "POST" | "PUT" | "DELETE",
    suffix: string,
    body: unknown,
    done: () => string,
  ) => Promise<boolean>;
}>;

const KIND_TITLES: Readonly<Record<SponsorTagKind, MessageKey>> = {
  quest: "sponsors.tags.quests",
  category: "sponsors.tags.categories",
  reward: "sponsors.tags.rewards",
};

/**
 * The items one sponsor presents (FR-1302): a checkbox for each quest, category and reward of the event, saved as soon
 * as it changes. An item has one sponsor, so ticking one that another sponsor holds moves it, and the other sponsor's
 * name stays beside it until then.
 */
export function SponsorTags({
  language,
  sponsor,
  sponsors,
  choices,
  writes,
}: Readonly<{
  language: Language;
  sponsor: TeamSponsor;
  sponsors: readonly TeamSponsor[];
  choices: TagChoices;
  writes: SponsorWrites;
}>) {
  const t = useTranslator(language);
  const tag = (kind: SponsorTagKind, targetId: string, on: boolean) =>
    writes.run("PUT", "/sponsor-tags", { kind, targetId, sponsorId: on ? sponsor.id : null }, () =>
      t("sponsors.tags.saved"),
    );
  const nothing = SPONSOR_TAG_KINDS.every((kind) => choices[kind].length === 0);
  return (
    <Section title={t("sponsors.tags.title", { name: sponsorName(sponsor, language) })} level={3}>
      {nothing ? <Muted>{t("sponsors.tags.none")}</Muted> : null}
      {SPONSOR_TAG_KINDS.filter((kind) => choices[kind].length > 0).map((kind) => (
        <FieldGroup key={kind} legend={t(KIND_TITLES[kind])} layout="choices">
          {choices[kind].map((choice) => {
            const holder = sponsorOf(sponsors, kind, choice.id);
            const other = holder !== undefined && holder.id !== sponsor.id ? holder : undefined;
            return (
              <Checkbox
                key={choice.id}
                disabled={writes.busy}
                checked={holder?.id === sponsor.id}
                onChange={(event) => void tag(kind, choice.id, event.target.checked)}
                label={
                  <>
                    {choice.label}
                    {other === undefined ? null : (
                      <Muted as="span">
                        {" "}
                        {t("sponsors.tags.current", { sponsor: sponsorName(other, language) })}
                      </Muted>
                    )}
                  </>
                }
              />
            );
          })}
        </FieldGroup>
      ))}
    </Section>
  );
}
