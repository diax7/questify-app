import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** T-114 lists the event's quests here (`GET /v1/events/{id}/quests`). */
export default function QuestsScreen() {
  const { t } = useI18n();
  return (
    <Screen title={t("nav.quests")} header={<EventPill />}>
      <AppText muted>{t("common.comingSoon")}</AppText>
    </Screen>
  );
}
