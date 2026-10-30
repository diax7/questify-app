"use client";

import type { Language } from "@questify/shared";
import { usePathname } from "next/navigation";
import {
  ConsoleContentLink,
  ConsoleInvitationsLink,
  ConsoleQuestifyLink,
  ConsoleSeasonsLink,
  ConsoleTicketsLink,
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
      <ConsoleTicketsLink language={language} current={on("/console/tickets")} />
      <ConsoleQuestifyLink language={language} current={on("/console/questify")} />
      <ConsoleContentLink language={language} current={on("/console/content")} />
      <ConsoleSeasonsLink language={language} current={on("/console/seasons")} />
      <ConsoleInvitationsLink language={language} current={on("/console/invitations")} />
    </NavGroup>
  );
}
