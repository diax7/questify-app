"use client";

import type { Language, MessageKey } from "@questify/shared";
import { useState } from "react";
import { CatalogAchievements } from "#src/components/CatalogAchievements.tsx";
import { CatalogGemShop } from "#src/components/CatalogGemShop.tsx";
import { CatalogLevelTitles } from "#src/components/CatalogLevelTitles.tsx";
import { CatalogTemplates } from "#src/components/CatalogTemplates.tsx";
import { CATALOG_TABS, type CatalogTab } from "#src/lib/console-catalog.ts";
import { translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, SubHeading } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { infoTip } from "#src/ui/info.tsx";

const TIPS = {
  templates: "console.catalog.templates.intro",
  achievements: "console.catalog.achievements.info",
  levels: "console.catalog.levels.intro",
  shop: "console.catalog.shop.intro",
} as const satisfies Record<CatalogTab, MessageKey>;

function Panel({ tab, language }: Readonly<{ tab: CatalogTab; language: Language }>) {
  switch (tab) {
    case "templates":
      return <CatalogTemplates language={language} />;
    case "achievements":
      return <CatalogAchievements language={language} />;
    case "levels":
      return <CatalogLevelTitles language={language} />;
    default:
      return <CatalogGemShop language={language} />;
  }
}

/**
 * The console's catalog (T-709b, FR-1403): event templates, achievements, level titles and the gem shop, one tab each.
 * Platform admins only. Every change is audited with who, before and after, and can be reverted.
 */
export function ConsoleCatalog({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [tab, setTab] = useState<CatalogTab>("templates");
  return (
    <Stack as="section" aria-labelledby="console-catalog-title">
      <PageHeader
        titleId="console-catalog-title"
        title={t("console.catalog.title")}
        info={infoTip(t, "console.catalog.intro")}
      />
      <Tabs
        label={t("console.catalog.tabs")}
        items={CATALOG_TABS.map((key) => ({
          key,
          label: t(`console.catalog.tab.${key}`),
          current: key === tab,
          select: () => setTab(key),
        }))}
      />
      <SubHeading as="h2">
        {t(`console.catalog.tab.${tab}`)} {infoTip(t, TIPS[tab])}
      </SubHeading>
      <Panel tab={tab} language={language} />
    </Stack>
  );
}
