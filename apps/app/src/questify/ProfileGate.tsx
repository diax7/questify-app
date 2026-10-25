import { router } from "expo-router";
import { usePlayer } from "#src/auth/player.tsx";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";

/** A failed owner-profile load is retryable; it must never pretend the current player is signed out. */
export function ProfileGate() {
  const { state, reload } = usePlayer();
  const { t } = useI18n();
  if (state.status === "signed_out")
    return <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />;
  if (state.status === "loading") return <AppText>{t("common.loading")}</AppText>;
  return (
    <>
      <AppText accessibilityRole="alert">{t("profile.failed")}</AppText>
      <Button label={t("common.retry")} onPress={() => void reload()} />
    </>
  );
}
