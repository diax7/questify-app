"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { HelpArticles } from "#src/components/HelpArticles.tsx";
import { LegalDocuments } from "#src/components/LegalDocuments.tsx";
import { LEGAL_TABS, type LegalTab } from "#src/lib/console-legal.ts";
import { translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { infoTip } from "#src/ui/info.tsx";

/**
 * The console's legal documents and help articles (T-707, FR-1781, FR-1782), one tab each. Platform admins only. Only the
 * open tab reads from the API: the console answers one read at a time per admin.
 */
export function ConsoleLegal({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [tab, setTab] = useState<LegalTab>("documents");
  return (
    <Stack as="section" aria-labelledby="console-legal-title">
      <PageHeader
        titleId="console-legal-title"
        title={t("console.legal.title")}
        info={infoTip(t, "console.legal.intro")}
      />
      <Tabs
        label={t("console.legal.tabs")}
        items={LEGAL_TABS.map((key) => ({
          key,
          label: t(`console.legal.tab.${key}`),
          current: key === tab,
          select: () => setTab(key),
        }))}
      />
      {tab === "documents" ? (
        <LegalDocuments language={language} />
      ) : (
        <HelpArticles language={language} />
      )}
    </Stack>
  );
}
