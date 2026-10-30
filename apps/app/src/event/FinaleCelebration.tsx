import { formatNumber, type Theme } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { Modal, View } from "react-native";
import { keyValueStore } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { PopIn } from "#src/components/motion.tsx";
import { sheetOpened } from "#src/components/sheet-count.ts";
import { celebrates, finaleSeenKey, type Finale } from "#src/event/finale.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * The full-screen finale celebration (T-307b, FR-407): once per event on this phone, the first time Home reads that the
 * winners are revealed. It names the player's own place when they have one and nobody else's. Closing it records that it
 * was seen and, in memory, that it was closed, so a failed write cannot bring it back on Home's next refetch; it can show
 * once more after a restart. It is the biggest celebration the app plays; the reveal's push is T-501's.
 */
export function FinaleCelebration({
  eventId,
  finale,
}: Readonly<{ eventId: string; finale: Finale | null }>) {
  const { t, language, rtl } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const [shown, setShown] = useState(false);
  const closedFor = useRef<string | null>(null);
  const place = finale?.place ?? null;
  useEffect(() => {
    if (finale === null) {
      return undefined;
    }
    let current = true;
    void (async () => {
      const seen = (await keyValueStore.getItem(finaleSeenKey(eventId)).catch(() => null)) !== null;
      if (current && closedFor.current !== eventId && celebrates(finale, seen)) {
        setShown(true);
      }
    })();
    return () => {
      current = false;
    };
  }, [eventId, finale]);
  // A sheet of its own: the live poll card waits while it is open (T-306).
  useEffect(() => (shown ? sheetOpened() : undefined), [shown]);
  const close = () => {
    closedFor.current = eventId;
    setShown(false);
    void keyValueStore.setItem(finaleSeenKey(eventId), "1").catch(() => undefined);
  };
  return (
    <Modal visible={shown} animationType="fade" onRequestClose={close}>
      <View style={[styles.screen, { direction: rtl ? "rtl" : "ltr" }]}>
        <PopIn>
          <AppText variant="title" accessibilityRole="header" style={styles.centered}>
            {t("finale.celebrate.title")}
          </AppText>
          <AppText style={styles.centered}>
            {place === null
              ? t("finale.celebrate.thanks")
              : t("finale.celebrate.place", { rank: formatNumber(place, language) })}
          </AppText>
        </PopIn>
        <Button label={t("finale.celebrate.close")} onPress={close} />
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) => ({
  screen: {
    flex: 1,
    justifyContent: "center" as const,
    gap: theme.spacing.xl,
    padding: theme.spacing.xl,
    backgroundColor: theme.colors.highlight,
  },
  centered: { textAlign: "center" as const },
});
