"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { MessageTemplates } from "#src/components/MessageTemplates.tsx";
import { SupportContactEditor } from "#src/components/SupportContactEditor.tsx";
import { MESSAGING_TABS, type MessagingTab } from "#src/lib/console-messaging.ts";
import { translatorFor } from "#src/lib/language.ts";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { infoTip } from "#src/ui/info.tsx";

/**
 * The console's message templates and support contact (T-706, FR-1780, FR-1731), one tab each. Platform admins only. Only
 * the open tab reads from the API: the console answers one read at a time per admin.
 */
export function ConsoleMessaging({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [tab, setTab] = useState<MessagingTab>("templates");
  return (
    <Stack as="section" aria-labelledby="console-messages-title">
      <PageHeader
        titleId="console-messages-title"
        title={t("console.messages.title")}
        info={infoTip(t, "console.messages.intro")}
      />
      <Tabs
        label={t("console.messages.tabs")}
        items={MESSAGING_TABS.map((key) => ({
          key,
          label: t(`console.messages.tab.${key}`),
          current: key === tab,
          select: () => setTab(key),
        }))}
      />
      {tab === "templates" ? (
        <MessageTemplates language={language} />
      ) : (
        <SupportContactEditor language={language} />
      )}
    </Stack>
  );
}
