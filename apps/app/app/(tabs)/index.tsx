import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

export default function HomeScreen() {
  const { t } = useI18n();
  return (
    <Screen title={t("nav.home")}>
      <AppText variant="title">{t("points.balance", { points: 1250, currency: "★" })}</AppText>
      <AppText muted>{t("common.comingSoon")}</AppText>
    </Screen>
  );
}
