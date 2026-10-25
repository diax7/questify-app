import { useCallback, useState } from "react";
import { useFocusEffect } from "expo-router";
import { View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { lockerPage, seeItems, type LockerEntry } from "#src/questify/profile-api.ts";

/** Explicit acknowledgment only after the named grants have been displayed; a failed acknowledgment stays retryable. */
export function RewardNotices() {
  const { t, language } = useI18n();
  const [items, setItems] = useState<LockerEntry[]>([]);
  const [busy, setBusy] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void lockerPage(api.session).then((page) => {
        if (current) setItems(page?.items.filter((row) => !row.seen) ?? []);
      });
      const stop = api.session.onEnded(() => setItems([]));
      return () => {
        current = false;
        stop();
      };
    }, []),
  );
  if (items.length === 0) return null;
  const acknowledge = async () => {
    setBusy(true);
    if (
      await seeItems(
        api.session,
        items.map((row) => row.item.id),
      )
    )
      setItems([]);
    setBusy(false);
  };
  return (
    <View style={{ gap: 8 }} accessibilityLiveRegion="polite">
      <AppText variant="title">{t("locker.new")}</AppText>
      {items.map((row) => (
        <AppText key={row.item.id}>{row.item.name[language]}</AppText>
      ))}
      <Button label={t("locker.seen")} disabled={busy} onPress={() => void acknowledge()} />
    </View>
  );
}
