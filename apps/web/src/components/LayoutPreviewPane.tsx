"use client";

import type { Language, MessageKey } from "@questify/shared";
import { ScreenPreview, type PreviewScreen } from "#src/components/PreviewScreens.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { EventPreview } from "#src/lib/preview.ts";
import { Tabs } from "#src/ui/Tabs.tsx";

const TITLES: Readonly<Record<PreviewScreen, MessageKey>> = {
  home: "nav.home",
  info: "eventHome.info",
  page: "layout.block.page",
  ranking: "nav.ranking",
  quests: "nav.quests",
  rewards: "nav.rewards",
};

/** The screens the event has: the ranking and Rewards screens only while their feature is on, as on the phone. */
export function screensOf(preview: EventPreview): readonly PreviewScreen[] {
  return [
    "home",
    "info",
    ...(preview.page === null ? [] : (["page"] as const)),
    ...(preview.ranking === null ? [] : (["ranking"] as const)),
    "quests",
    ...(preview.rewards === null ? [] : (["rewards"] as const)),
  ];
}

/**
 * The phone beside the layout editor, redrawn from the unsaved draft: Home, and the ranking, Quests and Rewards screens in
 * the layouts chosen (T-606, T-611). The screen shown falls back to Home when the event has no such screen.
 */
export function LayoutPreviewPane({
  preview,
  language,
  screen,
  onScreen,
}: Readonly<{
  preview: EventPreview;
  language: Language;
  screen: PreviewScreen;
  onScreen: (screen: PreviewScreen) => void;
}>) {
  const t = useTranslator(language);
  const screens = screensOf(preview);
  const shown = screens.includes(screen) ? screen : "home";
  return (
    <>
      <Tabs
        label={t("preview.title")}
        items={screens.map((key) => ({
          key,
          label: t(TITLES[key]),
          current: key === shown,
          select: () => onScreen(key),
        }))}
      />
      <ScreenPreview preview={preview} language={language} screen={shown} />
    </>
  );
}
