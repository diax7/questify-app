import { useFocusEffect, router } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { OwnAchievements } from "#src/questify/AchievementsSection.tsx";
import { OwnPassport } from "#src/questify/PassportSection.tsx";
import { useQuestifySync } from "#src/questify/QuestifySyncProvider.tsx";

/**
 * The Questify part of your own profile (T-403): achievements, the Event Passport, and the doors to your event history
 * and the Questify quests. Opening the profile asks the server to credit what you earned, so the badges are current.
 */
export function ProfileQuestify() {
  const { t } = useI18n();
  const { syncNow } = useQuestifySync();
  useFocusEffect(
    useCallback(() => {
      syncNow();
    }, [syncNow]),
  );
  return (
    <View style={{ gap: 16 }}>
      <OwnAchievements />
      <OwnPassport />
      <Button
        kind="quiet"
        label={t("questifyQuests.title")}
        onPress={() => router.push("/questify-quests")}
      />
      <Button
        kind="quiet"
        label={t("eventHistory.title")}
        onPress={() => router.push("/event-history")}
      />
    </View>
  );
}
