import type { MessageKey, Theme } from "@questify/shared";
import type { ReactNode } from "react";
import { View } from "react-native";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useOperator } from "#src/operator/OperatorContext.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

/**
 * A writing tool while practice mode is on (ADR-250): the lock card with Leave practice instead of the tool, so the
 * strip's promise stays true. The tool itself is not mounted, so none of its reads or writes start.
 */
export function PracticeLocked({
  title,
  back,
  children,
}: Readonly<{ title: MessageKey; back: boolean; children: ReactNode }>) {
  const { practice, setPractice } = useOperator();
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  if (!practice) {
    return children;
  }
  return (
    <Screen title={t(title)} header={back ? <BackButton /> : undefined}>
      <View style={styles.card}>
        <AppText accessibilityRole="alert">{t("operator.practice.locked")}</AppText>
        <Button label={t("operator.practice.leave")} onPress={() => setPractice(false)} />
      </View>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  card: {
    gap: theme.spacing.md,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
});
