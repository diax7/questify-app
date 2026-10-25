import { Avatar } from "#src/components/Avatar.tsx";
import { RewardNotices } from "#src/questify/RewardNotices.tsx";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import type { Language, Theme } from "@questify/shared";
import { router } from "expo-router";
import { api } from "#src/api/app-session.ts";
import { fetchMyTickets } from "#src/event/help.ts";
import { AppText } from "#src/components/AppText.tsx";
import { Button } from "#src/components/Controls.tsx";
import { isolatedLtr } from "#src/auth/sign-in-api.ts";
import type { Channel } from "#src/auth/sign-in-flow.ts";
import { usePlayer, type Me } from "#src/auth/player.tsx";
import { levelProgress, type QuestifyLevel } from "#src/questify/level.ts";
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

/** The lifetime Questify level (FR-416, FR-706): the number, its title, and a bar towards the next level. */
function LevelCard({ level }: Readonly<{ level: QuestifyLevel }>) {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const progress = levelProgress(level);
  return (
    <View style={styles.level}>
      <AppText variant="title">{t("level.number", { level: level.level })}</AppText>
      <AppText muted>{t("locker.levelTitle")}</AppText>
      <AppText variant="label">{level.title[language]}</AppText>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={t("level.progress")}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
        style={styles.track}
      >
        <View style={[styles.fill, { width: `${progress * 100}%` }]} />
      </View>
      {level.nextReward == null ? null : (
        <AppText>{t("locker.next", { item: level.nextReward.name[language] })}</AppText>
      )}
      <AppText muted>
        {level.nextLevelAt === null ? t("level.top") : t("level.next", { next: level.level + 1 })}
      </AppText>
    </View>
  );
}

/** Whether the player has sent any help-desk request (T-310): the profile then shows Your requests. */
function useHasRequests(signedIn: boolean): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!signedIn) {
      return;
    }
    let current = true;
    void fetchMyTickets(api.session, null).then((tickets) => {
      if (current) {
        setHas((tickets?.length ?? 0) > 0);
      }
    });
    return () => {
      current = false;
    };
  }, [signedIn]);
  return has;
}

/**
 * The player's own profile: the language and sign-out; the same screen inside an event and from Questify home. Inside
 * an event it opens that event's Get help, elsewhere the ticket center (T-312); anywhere, Your requests once the player
 * has sent one, with a dot while an answer waits unseen in any queue.
 */
export function ProfileScreen({
  header,
  eventId,
}: Readonly<{ header?: ReactNode; eventId?: string }>) {
  const { t, language, switchLanguage } = useI18n();
  const { state, signOut } = usePlayer();
  const styles = useThemedStyles(makeStyles);
  const hasRequests = useHasRequests(state.status === "signed_in");
  const unread = state.status === "signed_in" ? (state.me?.help?.unread ?? 0) : 0;

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
                <Avatar
                  name={state.me.avatar}
                  username={state.me.username}
                  equipment={state.me.equipment}
                  size={96}
                />
                <AppText variant="title">@{state.me.username}</AppText>
                {state.me.equipment?.title == null ? null : (
                  <>
                    <AppText variant="label">{t("locker.equippedTitle")}</AppText>
                    <AppText>{state.me.equipment.title.name[language]}</AppText>
                  </>
                )}
                <Button
                  label={t("profile.edit")}
                  kind="quiet"
                  onPress={() => router.push("/edit-profile")}
                />
                <Button
                  label={t("locker.title")}
                  kind="quiet"
                  onPress={() => router.push("/locker")}
                />
                <RewardNotices />
                {state.me.questify === undefined ? null : <LevelCard level={state.me.questify} />}
                <MyAccount me={state.me} />
              </>
            )}
            <Button
              kind="quiet"
              label={t("help.open")}
              onPress={() =>
                router.push(eventId === undefined ? "/help" : `/event/${eventId}/help`)
              }
            />
            {hasRequests || unread > 0 ? (
              <View style={styles.identifier}>
                {unread > 0 ? (
                  <View accessible accessibilityLabel={t("help.unread")} style={styles.dot} />
                ) : null}
                <View style={styles.identifierText}>
                  <Button
                    kind="quiet"
                    label={t("profile.requests")}
                    onPress={() => router.push("/requests")}
                  />
                </View>
              </View>
            ) : null}
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
  level: { gap: theme.spacing.xs },
  // The bar fills from the start of the reading direction: right in Arabic, left in English (RTL layout flips it).
  track: {
    height: 12,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.border,
    overflow: "hidden" as const,
    flexDirection: "row" as const,
  },
  fill: { height: 12, backgroundColor: theme.colors.primaryAction },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: theme.colors.primaryAction },
});
