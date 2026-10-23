import type { ReactNode } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import type { Language, Theme } from "@questify/shared";
import { router } from "expo-router";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import type { Channel } from "#src/auth/sign-in-flow.ts";
import { usePlayer, type Me } from "#src/auth/player.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import { useThemedStyles } from "#src/theme/theme.tsx";

// Each language is named in itself, so a player can find their own whatever language the screen is in.
const LANGUAGES: ReadonlyArray<{ code: Language; name: string }> = [
  { code: "ar", name: "العربية" },
  { code: "en", name: "English" },
];

/** Settings → My account (FR-125, FR-139): each sign-in identifier, masked, with Change or Add. */
function MyAccount({ me }: Readonly<{ me: Me }>) {
  const { t } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const rows: ReadonlyArray<{ channel: Channel; label: string }> = [
    { channel: "phone", label: t("signIn.phone") },
    { channel: "email", label: t("signIn.email") },
  ];
  return (
    <>
      <AppText variant="title">{t("account.title")}</AppText>
      {rows.map(({ channel, label }) => {
        const value = me.identifiers[channel];
        return (
          <View key={channel} style={styles.identifier}>
            <View style={styles.identifierText}>
              <AppText variant="label">{label}</AppText>
              <AppText muted>{value === null ? t("account.notAdded") : isolatedLtr(value)}</AppText>
            </View>
            <Button
              kind="quiet"
              label={t(value === null ? "account.add" : "account.change")}
              onPress={() => router.push({ pathname: "/account", params: { channel } })}
            />
          </View>
        );
      })}
    </>
  );
}

/** The player's own profile: the language and sign-out; the same screen inside an event and from Questify home. */
export function ProfileScreen({ header }: Readonly<{ header?: ReactNode }>) {
  const { t, language, switchLanguage } = useI18n();
  const { state, signOut } = usePlayer();
  const styles = useThemedStyles(makeStyles);

  // FR-124: the confirmation says what signing out does; cancelling keeps the player signed in.
  const confirmSignOut = (): void => {
    Alert.alert(t("signOut.title"), t("signOut.body"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("signOut.confirm"),
        style: "destructive",
        onPress: () => void signOut().then(() => router.replace("/home")),
      },
    ]);
  };

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
    <Screen title={t("nav.profile")} header={header}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
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
        {state.status === "signed_in" ? (
          <>
            {state.me === undefined ? null : (
              <>
                <AppText variant="title">@{state.me.username}</AppText>
                <MyAccount me={state.me} />
              </>
            )}
            <Button kind="quiet" label={t("signOut.confirm")} onPress={confirmSignOut} />
            <Button
              kind="quiet"
              label={t("deletion.title")}
              onPress={() => router.push("/delete-account")}
            />
          </>
        ) : null}
        {state.status === "signed_out" ? (
          <Button label={t("signIn.start")} onPress={() => router.push("/sign-in")} />
        ) : null}
      </ScrollView>
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
  identifier: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: theme.spacing.md,
  },
  identifierText: { flex: 1, gap: theme.spacing.xs },
});
