"use client";

import type { FeatureRequestState, Language, MessageKey } from "@questify/shared";
import type { ReactNode } from "react";
import { AddonAsk } from "#src/components/AddonAsk.tsx";
import { addonName } from "#src/lib/activation.ts";
import type { Translate } from "#src/lib/language.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Badge, Muted } from "#src/ui/Feedback.tsx";
import { Switch } from "#src/ui/Field.tsx";
import { Row, SubHeading } from "#src/ui/Section.tsx";

/** Where an organizer goes for the rest of a step: a page of the event, opened from a row. */
export function DoorRow({
  t,
  title,
  href,
}: Readonly<{ t: Translate; title: string; href: string }>) {
  return (
    <Row as="div" main={<SubHeading>{title}</SubHeading>}>
      <ButtonLink
        href={href}
        variant="secondary"
        aria-label={t("setup.openNamed", { name: title })}
      >
        {t("setup.open")}
      </ButtonLink>
    </Row>
  );
}

/** The one line each add-on card says about what it adds; a gated feature added later gets its line here. */
const ADDON_SUMMARY: Readonly<Record<string, MessageKey>> = { bigScreen: "wizard.addon.bigScreen" };

/** The pages an unlocked add-on is set up on. */
const ADDON_PAGE: Readonly<Record<string, string>> = { bigScreen: "big-screen" };

/**
 * An add-on's card (FR-1755). Locked, it explains the add-on, shows a switch that cannot be ticked and offers "Ask
 * Questify" (a recorded request, T-711b, FR-1827; the Contact page stays: nothing is bought in the app). Unlocked, it
 * opens the page where the add-on is used.
 */
export function AddonCard({
  t,
  language,
  feature,
  unlocked,
  eventPages,
  request,
  askTarget,
}: Readonly<{
  t: Translate;
  language: Language;
  feature: string;
  unlocked: boolean;
  /** The address of the event's pages, without a trailing slash. */
  eventPages: string;
  /** The owner's latest Ask Questify request for the add-on. */
  request: FeatureRequestState | null;
  /** The event the owner asks for; absent for an editor (Q-502). */
  askTarget?: Readonly<{ organizerId: string; eventId: string }> | undefined;
}>) {
  const name = addonName(feature, t);
  const summary = ADDON_SUMMARY[feature];
  const page = ADDON_PAGE[feature];
  const lead: ReactNode = unlocked ? (
    <SubHeading>
      {name} <Badge tone="success">{t("wizard.addon.unlocked")}</Badge>
    </SubHeading>
  ) : (
    <Switch label={name} checked={false} readOnly disabled />
  );
  return (
    <Row
      as="div"
      main={
        <>
          {lead}
          {summary === undefined ? null : <Muted>{t(summary)}</Muted>}
          {unlocked ? null : <Muted>{t("wizard.addon.locked")}</Muted>}
        </>
      }
    >
      {unlocked ? (
        page === undefined ? null : (
          <ButtonLink
            href={`${eventPages}/${page}`}
            variant="secondary"
            aria-label={t("setup.openNamed", { name })}
          >
            {t("setup.open")}
          </ButtonLink>
        )
      ) : (
        <AddonAsk
          t={t}
          language={language}
          feature={feature}
          request={request}
          target={askTarget}
        />
      )}
    </Row>
  );
}
