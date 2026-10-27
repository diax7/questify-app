import { MAX_PLAYER_INTERESTS, type MessageKey, type Theme } from "@questify/shared";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { api } from "#src/api/app-session.ts";
import { AppText } from "#src/components/AppText.tsx";
import { BackButton } from "#src/components/BackButton.tsx";
import { Button } from "#src/components/Controls.tsx";
import { Screen } from "#src/components/Screen.tsx";
import { useI18n } from "#src/i18n/provider.tsx";
import {
  fetchCities,
  fetchInterests,
  fetchPreferences,
  savePreferences,
} from "#src/marketing/marketing-api.ts";
import {
  preferencesChanged,
  preferencesNotice,
  toggleInterest,
} from "#src/marketing/marketing-flow.ts";
import { useRead } from "#src/questify/use-read.ts";
import { useThemedStyles } from "#src/theme/theme.tsx";

/** One tappable choice. The chosen ones carry a check mark as well as a border, so the state is never colour alone. */
function Choice({
  label,
  chosen,
  role,
  disabled,
  onPress,
}: Readonly<{
  label: string;
  chosen: boolean;
  role: "checkbox" | "radio";
  disabled: boolean;
  onPress: () => void;
}>) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={{ checked: chosen, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.choice, chosen && styles.chosen, disabled && styles.disabled]}
    >
      <AppText variant="label">{chosen ? `✓ ${label}` : label}</AppText>
    </Pressable>
  );
}

/**
 * Interests and city (FR-733): up to eight interests and one city from the seeded lists, private to the player. Saving
 * replaces both, so clearing every choice and saving clears them (the change is kept).
 */
export function InterestsScreen() {
  const { t, language } = useI18n();
  const styles = useThemedStyles(makeStyles);
  const lists = useRead(async () => {
    const [interests, cities, saved] = await Promise.all([
      fetchInterests(api.session),
      fetchCities(api.session),
      fetchPreferences(api.session),
    ]);
    return interests === null || cities === null || saved === null
      ? null
      : { interests, cities, saved };
  }, []);
  const [cityId, setCityId] = useState<string | null>(null);
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<MessageKey | null>(null);
  const saved = lists.data?.saved;
  useEffect(() => {
    if (saved === undefined) return;
    setCityId(saved.cityId);
    setChosen(saved.interests);
  }, [saved]);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await savePreferences(api.session, { cityId, interests: [...chosen] });
    if (outcome.kind === "invalid") lists.retry();
    if (outcome.kind === "saved") lists.retry();
    setNotice(preferencesNotice(outcome));
    setBusy(false);
  };

  return (
    <Screen title={t("interests.title")} header={<BackButton />}>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <AppText muted>{t("interests.private")}</AppText>
        {lists.failed && lists.data === null ? (
          <>
            <AppText accessibilityRole="alert">{t("interests.loadFailed")}</AppText>
            <Button kind="quiet" label={t("common.retry")} onPress={lists.retry} />
          </>
        ) : null}
        {lists.data === null ? null : (
          <>
            <AppText variant="title">{t("interests.heading")}</AppText>
            <AppText muted>{t("interests.limit", { max: MAX_PLAYER_INTERESTS })}</AppText>
            <View style={styles.wrap}>
              {lists.data.interests.map((interest) => {
                const on = chosen.includes(interest.id);
                return (
                  <Choice
                    key={interest.id}
                    label={interest.name[language]}
                    chosen={on}
                    role="checkbox"
                    disabled={busy || (!on && chosen.length >= MAX_PLAYER_INTERESTS)}
                    onPress={() => setChosen((now) => toggleInterest(now, interest.id))}
                  />
                );
              })}
            </View>
            <AppText variant="title">{t("interests.city")}</AppText>
            <View style={styles.wrap}>
              <Choice
                label={t("interests.noCity")}
                chosen={cityId === null}
                role="radio"
                disabled={busy}
                onPress={() => setCityId(null)}
              />
              {lists.data.cities.map((city) => (
                <Choice
                  key={city.id}
                  label={city.name[language]}
                  chosen={cityId === city.id}
                  role="radio"
                  disabled={busy}
                  onPress={() => setCityId(city.id)}
                />
              ))}
            </View>
            {notice === null ? null : (
              <AppText accessibilityRole="alert" accessibilityLiveRegion="polite">
                {t(notice)}
              </AppText>
            )}
            <Button
              label={t("interests.save")}
              disabled={busy || !preferencesChanged(lists.data.saved, cityId, chosen)}
              onPress={() => void save()}
            />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = (theme: Theme) => ({
  wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: theme.spacing.sm },
  choice: {
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.md,
    borderWidth: 2,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  chosen: { borderColor: theme.colors.primaryAction },
  disabled: { opacity: 0.5 },
});
