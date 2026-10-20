import { Alert, Pressable, View } from "react-native";
import type { Language, Theme } from "@questify/shared";
import { AppText } from "#src/components/AppText.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

// Each language is named in itself, so a player can find their own whatever language the screen is in.
const LANGUAGES: ReadonlyArray<{ code: Language; name: string }> = [
  { code: "ar", name: "العربية" },
  { code: "en", name: "English" },
];

export default function ProfileScreen() {
  const { t, language, switchLanguage } = useI18n();
  const styles = useThemedStyles(makeStyles);

  const choose = (next: Language): void => {
    if (next === language) {
      return;
    }
    Alert.alert(t("settings.restartTitle"), t("settings.restartBody"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.continue"), onPress: () => void switchLanguage(next) },
    ]);
  };

  return (
    <Screen title={t("nav.profile")}>
      <AppText variant="title">{t("settings.language")}</AppText>
      <View style={styles.row}>
        {LANGUAGES.map((option) => (
          <Pressable
            key={option.code}
            accessibilityRole="button"
            onPress={() => choose(option.code)}
            style={[styles.option, option.code === language && styles.selected]}
          >
            <AppText variant="label">{option.name}</AppText>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  row: { flexDirection: "row" as const, gap: theme.spacing.md },
  option: {
    flex: 1,
    alignItems: "center" as const,
    paddingVertical: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
  },
  selected: { borderColor: theme.colors.primaryAction },
});
