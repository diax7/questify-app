import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

export default function QuestsScreen() {
  const { t } = useI18n();
  return (
    <Screen title={t("nav.quests")}>
      <AppText muted>{t("common.comingSoon")}</AppText>
    </Screen>
  );
}
