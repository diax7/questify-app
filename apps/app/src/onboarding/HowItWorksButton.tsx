import { router } from "expo-router";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** Settings, "How Questify works" (FR-1802): replays the four story cards, for anyone, signed in or not. */
export function HowItWorksButton() {
  const { t } = useI18n();
  return (
    <Button
      kind="quiet"
      label={t("onboarding.replay")}
      onPress={() => router.push("/intro?replay=1")}
    />
  );
}
