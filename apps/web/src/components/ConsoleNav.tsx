"use client";

import type { Language } from "@questify/shared";
import { ConsoleContentLink } from "#src/components/ConsoleContent.tsx";
import { ConsoleInvitationsLink } from "#src/components/ConsoleInvitations.tsx";
import { ConsoleQuestifyLink } from "#src/components/ConsoleQuestify.tsx";
import { ConsoleSeasonsLink } from "#src/components/ConsoleSeasons.tsx";
import { ConsoleTicketsLink } from "#src/components/ConsoleTickets.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { NavGroup, NavItem } from "#src/ui/Nav.tsx";

/** The console's navigation: the activation queue and each of its pages, the open one marked. */
export function ConsoleNav({ language, path }: Readonly<{ language: Language; path: string }>) {
  const t = translatorFor(language);
  const on = (page: string): boolean => path === page || path.startsWith(`${page}/`);
  return (
    <NavGroup label={t("console.title")}>
      <NavItem href={`/${language}/console`} current={path === "/console"}>
        {t("console.queue")}
      </NavItem>
      <ConsoleTicketsLink language={language} current={on("/console/tickets")} />
      <ConsoleQuestifyLink language={language} current={on("/console/questify")} />
      <ConsoleContentLink language={language} current={on("/console/content")} />
      <ConsoleSeasonsLink language={language} current={on("/console/seasons")} />
      <ConsoleInvitationsLink language={language} current={on("/console/invitations")} />
    </NavGroup>
  );
}
