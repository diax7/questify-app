import { ScrollView } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useEvent } from "#src/event/EventContext.tsx";
import { localIn } from "#src/event/home-content.ts";
import { partViews } from "#src/event/info-page.ts";
import { PagePart } from "#src/event/InfoSections.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/**
 * The organizer's one extra page (T-613, FR-1835), opened from Home: a title, then headings, text, lists and links. It reads
 * the page the composed configuration carries, so a page the organizer hid or removed is simply not there.
 */
export default function CustomPageScreen() {
  const { t, language } = useI18n();
  const { layout } = useEvent();
  const page = layout.content.page;
  const parts = page === null ? [] : partViews(page, language);
  if (page === null || parts.length === 0) {
    return (
      <Screen title={t("eventHome.info")} header={<BackButton />}>
        <AppText>{t("customPage.unavailable")}</AppText>
      </Screen>
    );
  }
  return (
    <Screen title={localIn(page.title, language)} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        {parts.map((part, index) => (
          // The parts have no id and keep their order, so the position is their identity.
          // oxlint-disable-next-line react/no-array-index-key
          <PagePart key={`${index}:${part.kind}`} part={part} />
        ))}
      </ScrollView>
    </Screen>
  );
}
