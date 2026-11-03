"use client";

import type { Language } from "@questify/shared";
import { usePathname } from "next/navigation";
import {
  ConsoleAdminsLink,
  ConsoleCatalogLink,
  ConsoleContentLink,
  ConsoleFlagsLink,
  ConsoleHealthLink,
  ConsoleHomeLink,
  ConsoleInvitationsLink,
  ConsoleLegalLink,
  ConsoleMessagesLink,
  ConsoleNumbersLink,
  ConsoleOrganizersLink,
  ConsolePlayersLink,
  ConsoleQuestifyLink,
  ConsoleReadinessLink,
  ConsoleReportsLink,
  ConsoleSeasonsLink,
  ConsoleSwitchesLink,
  ConsoleTicketsLink,
  ConsoleTranslationsLink,
  ConsoleUsageLink,
  ConsoleWordListsLink,
} from "#src/components/ConsoleNavLinks.tsx";
import { pathAfterLanguage, translatorFor } from "#src/lib/language.ts";
import { NavGroup, NavItem } from "#src/ui/Nav.tsx";

/** The console's navigation: the activation queue and each of its pages, the open one marked from the address. */
export function ConsoleNav({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const path = pathAfterLanguage(usePathname());
  const on = (page: string): boolean => path === page || path.startsWith(`${page}/`);
  return (
    <NavGroup label={t("console.title")}>
      <NavItem href={`/${language}/console`} icon="list" current={path === "/console"}>
        {t("console.queue")}
      </NavItem>
      <ConsoleOrganizersLink language={language} current={on("/console/organizers")} />
      <ConsolePlayersLink language={language} current={on("/console/players")} />
      <ConsoleWordListsLink language={language} current={on("/console/word-lists")} />
      <ConsoleReportsLink language={language} current={on("/console/reports")} />
      <ConsoleFlagsLink language={language} current={on("/console/flags")} />
      <ConsoleTicketsLink language={language} current={on("/console/tickets")} />
      <ConsoleQuestifyLink language={language} current={on("/console/questify")} />
      <ConsoleContentLink language={language} current={on("/console/content")} />
      <ConsoleSeasonsLink language={language} current={on("/console/seasons")} />
      <ConsoleCatalogLink language={language} current={on("/console/catalog")} />
      <ConsoleHomeLink language={language} current={on("/console/home")} />
      <ConsoleLegalLink language={language} current={on("/console/legal")} />
      <ConsoleSwitchesLink language={language} current={on("/console/switches")} />
      <ConsoleMessagesLink language={language} current={on("/console/messages")} />
      <ConsoleTranslationsLink language={language} current={on("/console/translations")} />
      <ConsoleInvitationsLink language={language} current={on("/console/invitations")} />
      <ConsoleReadinessLink language={language} current={on("/console/readiness")} />
      <ConsoleUsageLink language={language} current={on("/console/usage")} />
      <ConsoleHealthLink language={language} current={on("/console/health")} />
      <ConsoleNumbersLink language={language} current={on("/console/numbers")} />
      <ConsoleAdminsLink language={language} current={on("/console/admins")} />
    </NavGroup>
  );
}
