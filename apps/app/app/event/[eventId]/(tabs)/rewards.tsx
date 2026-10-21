import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { EventPill } from "#src/event/EventPill.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** The event's rewards and shop arrive with T-201. */
export default function RewardsScreen() {
  const { t } = useI18n();
  return (
    <Screen title={t("nav.rewards")} header={<EventPill />}>
      <AppText muted>{t("common.comingSoon")}</AppText>
    </Screen>
  );
}
