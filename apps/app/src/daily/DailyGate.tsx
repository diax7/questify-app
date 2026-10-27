import type { OwnDaily, Theme } from "@questify/shared";
import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { readView } from "#src/daily/daily-state.ts";
import type { DailyRead } from "#src/daily/use-daily.ts";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * What a game screen shows around its game. No game held: a loading line, or the error with a retry. A game held: the
 * game itself, with a small error banner above it when the latest read failed, so a failed read never takes a game
 * away from a player who is in the middle of it.
 */
export function DailyGate({
  read,
  children,
}: Readonly<{ read: DailyRead; children: (daily: OwnDaily) => ReactNode }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const view = readView(read.daily, read.failed);
  if (read.daily === null) {
    if (view.screen === "loading") return <AppText muted>{t("common.loading")}</AppText>;
    return (
      <>
        <AppText accessibilityRole="alert">{t("daily.failed")}</AppText>
        <Button kind="quiet" label={t("common.retry")} onPress={() => void read.load()} />
      </>
    );
  }
  return (
    <>
      {view.banner ? (
        <View accessibilityRole="alert" style={styles.banner}>
          <AppText>{t("daily.failed")}</AppText>
          <Button kind="quiet" label={t("common.retry")} onPress={() => void read.load()} />
        </View>
      ) : null}
      {children(read.daily)}
    </>
  );
}

const makeStyles = (theme: Theme) => ({
  banner: {
    gap: theme.spacing.sm,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.hot,
    backgroundColor: theme.colors.dangerSurface,
  },
});
